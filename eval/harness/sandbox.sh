#!/bin/sh
# Run a command in a sandbox for one evaluation trial.
#
# The command runs in its own mount and PID namespace. It sees:
#   /mnt/sbx/work     the trial's working copy (read-write)
#   /mnt/sbx/state    the condition's state: HOME, config dir, shared memory (read-write)
#   /mnt/sbx/toolkit  the condition's toolkit export (read-only)
#   /mnt/sbx/extra    optional extra directory (read-only), e.g. graders after the session
# /home, /root, /srv, /tmp and /var/tmp are replaced by empty tmpfs mounts,
# except the remote-session credential directory the CLI needs (read-only). The
# evaluation suite, graders, other trials, the operator's session data and the
# host's processes (and their environments) are therefore not visible.
# The network namespace is shared, so the model API stays reachable.
#
# usage: sandbox.sh <work> <state> <toolkit> <extra|-> -- <command> [args...]
set -eu
WORK=$1 STATE=$2 TOOLKIT=$3 EXTRA=$4
shift 4
[ "${1:-}" = "--" ] && shift
exec unshare --mount --pid --fork --mount-proc --propagation private sh -c '
  set -eu
  mount -t tmpfs tmpfs /mnt
  mkdir -p /mnt/sbx/work /mnt/sbx/state /mnt/sbx/toolkit /mnt/sbx/extra
  mount --bind "$1" /mnt/sbx/work
  mount --bind "$2" /mnt/sbx/state
  mount --bind "$3" /mnt/sbx/toolkit
  mount -o remount,bind,ro /mnt/sbx/toolkit
  if [ "$4" != "-" ]; then mount --bind "$4" /mnt/sbx/extra; mount -o remount,bind,ro /mnt/sbx/extra; fi
  # Model access needs the remote-session credentials directory: keep exactly
  # that directory (read-only) and hide everything else under the hidden roots.
  KEEP=${SBX_KEEP:-/home/claude/.claude/remote}
  i=0
  for k in $KEEP; do
    if [ -d "$k" ]; then mkdir -p "/mnt/sbx/.keep$i"; mount --bind "$k" "/mnt/sbx/.keep$i"; fi
    i=$((i + 1))
  done
  for d in ${SBX_HIDE:-/home /root /srv /tmp /var/tmp}; do mount -t tmpfs tmpfs "$d"; done
  i=0
  for k in $KEEP; do
    if [ -d "/mnt/sbx/.keep$i" ]; then mkdir -p "$k"; mount --bind "/mnt/sbx/.keep$i" "$k"; mount -o remount,bind,ro "$k"; umount "/mnt/sbx/.keep$i"; rmdir "/mnt/sbx/.keep$i"; fi
    i=$((i + 1))
  done
  shift 4
  cd /mnt/sbx/work
  exec "$@"
' sandbox "$WORK" "$STATE" "$TOOLKIT" "$EXTRA" "$@"
