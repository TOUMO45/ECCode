#!/usr/bin/env python3
"""ECCode Greenfield-Senior sandbox helper (S2.4, design 21): restrict THIS process with Landlock, then exec a command.

    landlock_run.py --probe
        print {"abi": <n>} (or {"abi": 0, "error": ...}) and exit 0; exit 125 when the syscall is missing.
    landlock_run.py [--rw <dir>]... [--rw-file <file>]... [--dev <file>]... [--no-net] -- <command...>
        read and execute everywhere; write only under the --rw directories (no device, socket or fifo creation
        there) and to the named --rw-file and --dev files; with --no-net every TCP bind and connect is refused
        (ABI 4 or later); abstract unix sockets and signals are scoped to the sandbox (ABI 6 or later).

The restriction is a property of the process and of every child it starts, root included; nothing here needs a
privilege or a namespace. Exit 125 when Landlock cannot be applied: the engine then treats the run as unverifiable.
"""
import ctypes, json, os, sys

SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446  # x86_64 and aarch64 share these numbers
VERSION_FLAG = 1
RULE_PATH_BENEATH = 1
FS = {
    'EXECUTE': 1, 'WRITE_FILE': 2, 'READ_FILE': 4, 'READ_DIR': 8, 'REMOVE_DIR': 16, 'REMOVE_FILE': 32,
    'MAKE_CHAR': 64, 'MAKE_DIR': 128, 'MAKE_REG': 256, 'MAKE_SOCK': 512, 'MAKE_FIFO': 1024, 'MAKE_BLOCK': 2048,
    'MAKE_SYM': 4096, 'REFER': 8192, 'TRUNCATE': 16384, 'IOCTL_DEV': 32768,
}
ABI_FS = {1: 8191, 2: 8191 | FS['REFER'], 3: 8191 | FS['REFER'] | FS['TRUNCATE'], 5: 65535}
NET_BIND_TCP, NET_CONNECT_TCP = 1, 2
SCOPE_ABSTRACT_UNIX_SOCKET, SCOPE_SIGNAL = 1, 2
READ_ONLY = FS['EXECUTE'] | FS['READ_FILE'] | FS['READ_DIR']
# A writable directory: everything but the creation of device nodes, sockets and fifos (special files are refused at
# the commit step too), and no device ioctl.
NO_SPECIAL = FS['MAKE_CHAR'] | FS['MAKE_BLOCK'] | FS['MAKE_SOCK'] | FS['MAKE_FIFO'] | FS['IOCTL_DEV']
FILE_RW = FS['READ_FILE'] | FS['WRITE_FILE'] | FS['TRUNCATE']


class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


def abi_version(libc):
    r = libc.syscall(SYS_CREATE, None, 0, VERSION_FLAG)
    return r if r > 0 else 0


def main(argv):
    libc = ctypes.CDLL(None, use_errno=True)
    if argv == ['--probe']:
        abi = abi_version(libc)
        print(json.dumps({'abi': abi, 'error': None if abi else os.strerror(ctypes.get_errno())}))
        return 0 if abi else 125
    rw, rw_files, devs, no_net = [], [], [], False
    while argv and argv[0] != '--':
        flag = argv.pop(0)
        if flag == '--rw': rw.append(argv.pop(0))
        elif flag == '--rw-file': rw_files.append(argv.pop(0))
        elif flag == '--dev': devs.append(argv.pop(0))
        elif flag == '--no-net': no_net = True
        else: print(__doc__, file=sys.stderr); return 2
    if not argv or argv[0] != '--' or len(argv) < 2:
        print(__doc__, file=sys.stderr); return 2
    cmd = argv[1:]
    abi = abi_version(libc)
    if not abi:
        print(f'landlock unavailable: {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125
    handled = ABI_FS[max(k for k in ABI_FS if k <= abi)]
    net = (NET_BIND_TCP | NET_CONNECT_TCP) if (no_net and abi >= 4) else 0
    scoped = (SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL) if abi >= 6 else 0
    attr = RulesetAttr(handled, net, scoped)
    size = ctypes.sizeof(RulesetAttr) if abi >= 6 else (16 if abi >= 4 else 8)
    fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), size, 0)
    if fd < 0:
        print(f'landlock_create_ruleset: {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125

    def allow(path, access):
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathBeneath(access & handled, pfd)
            if libc.syscall(SYS_ADD_RULE, fd, RULE_PATH_BENEATH, ctypes.byref(rule), 0) < 0:
                raise OSError(ctypes.get_errno(), f'landlock_add_rule({path}): {os.strerror(ctypes.get_errno())}')
        finally:
            os.close(pfd)

    try:
        allow('/', READ_ONLY)
        for p in rw: allow(p, handled & ~NO_SPECIAL)
        for p in rw_files: allow(p, FILE_RW)
        for p in devs: allow(p, FILE_RW)
    except OSError as e:
        print(str(e), file=sys.stderr); return 125
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        print('prctl(PR_SET_NO_NEW_PRIVS) failed', file=sys.stderr); return 125
    if libc.syscall(SYS_RESTRICT, fd, 0) < 0:
        print(f'landlock_restrict_self: {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125
    os.close(fd)
    os.execvp(cmd[0], cmd)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
