#!/usr/bin/env python3
"""Minimal Landlock wrapper (spike, not engine code): run a command that may read and execute everywhere but write
only under the given paths. No root, no namespaces: the restriction is a property of the process and is inherited by
every child. Usage: landlock-run.py --rw <path> [--rw <path> ...] -- <command...>
Exit 125 when Landlock is unavailable (the kernel facts are printed to stderr)."""
import ctypes, os, sys

SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446  # x86_64
VERSION_FLAG = 1
RULE_PATH_BENEATH = 1
# Filesystem access rights by the ABI that introduced them.
FS = {
    'EXECUTE': 1, 'WRITE_FILE': 2, 'READ_FILE': 4, 'READ_DIR': 8, 'REMOVE_DIR': 16, 'REMOVE_FILE': 32,
    'MAKE_CHAR': 64, 'MAKE_DIR': 128, 'MAKE_REG': 256, 'MAKE_SOCK': 512, 'MAKE_FIFO': 1024, 'MAKE_BLOCK': 2048,
    'MAKE_SYM': 4096, 'REFER': 8192, 'TRUNCATE': 16384, 'IOCTL_DEV': 32768,
}
BY_ABI = {1: 8191, 2: 8191 | FS['REFER'], 3: 8191 | FS['REFER'] | FS['TRUNCATE'], 5: 65535}
READ_ONLY = FS['EXECUTE'] | FS['READ_FILE'] | FS['READ_DIR']

class RulesetAttr(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64), ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]

class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]

def main(argv):
    rw = []
    while argv and argv[0] == '--rw':
        rw.append(argv[1]); argv = argv[2:]
    if not argv or argv[0] != '--':
        print(__doc__, file=sys.stderr); return 2
    cmd = argv[1:]
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(SYS_CREATE, None, 0, VERSION_FLAG)
    if abi < 0:
        print(f'landlock unavailable: landlock_create_ruleset -> {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125
    handled = BY_ABI[max(k for k in BY_ABI if k <= abi)]
    attr = RulesetAttr(handled, 0, 0)
    fd = libc.syscall(SYS_CREATE, ctypes.byref(attr), ctypes.sizeof(RulesetAttr), 0)
    if fd < 0:
        print(f'landlock_create_ruleset -> {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125
    def allow(path, access):
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        rule = PathBeneath(access & handled, pfd)
        if libc.syscall(SYS_ADD_RULE, fd, RULE_PATH_BENEATH, ctypes.byref(rule), 0) < 0:
            raise OSError(ctypes.get_errno(), f'landlock_add_rule({path}): {os.strerror(ctypes.get_errno())}')
        os.close(pfd)
    allow('/', READ_ONLY)
    for p in rw: allow(p, handled)
    libc.prctl(38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
    if libc.syscall(SYS_RESTRICT, fd, 0) < 0:
        print(f'landlock_restrict_self -> {os.strerror(ctypes.get_errno())}', file=sys.stderr); return 125
    os.close(fd)
    os.execvp(cmd[0], cmd)

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
