#!/bin/sh
# NFR1 clean-checkout check. Copies the project's git-tracked and unignored files
# (never .eccode/) into an empty temporary directory, then runs there, in order:
#   npm install   (needs the npm registry; nothing else is downloaded)
#   npm test      (offline suite with the net guard; no browser)
#   npm start     (PORT=0; the port is read from the "listening" log line)
# and asserts GET /api/health answers 200. The temporary directory is removed on exit
# (set RS_KEEP_CLEAN_CHECKOUT=1 to keep it for inspection).
#
# Secrets: this script reads and prints none. It only unsets variables by name (RS_*, PORT,
# HOST and the API-key names) so the copy starts from defaults, and prints no environment.
# Usage: sh scripts/clean-checkout.sh
set -eu

fail() {
  printf 'clean-checkout: FAILED: %s\n' "$1" >&2
  exit 1
}

step() {
  printf '\n==> clean-checkout: %s\n' "$1"
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

command -v git >/dev/null 2>&1 || fail 'git is needed to list the tracked and unignored files'
command -v npm >/dev/null 2>&1 || fail 'npm is needed'
command -v node >/dev/null 2>&1 || fail 'node is needed'

WORK=$(mktemp -d "${TMPDIR:-/tmp}/rs-clean-checkout.XXXXXX")
CHECKOUT="$WORK/checkout"
SERVER_PID=''
SERVER_PGID_KILL=''

# True while the process exists and is not a zombie (a finished child stays a zombie until waited for).
is_running() {
  kill -0 "$1" 2>/dev/null || return 1
  state=$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ') || state=''
  case "$state" in Z*) return 1 ;; esac
  return 0
}

# Sends the signal to the server's process group when it has its own (setsid), else to the process.
signal_server() {
  if [ -n "$SERVER_PGID_KILL" ]; then
    kill "-$1" "-$SERVER_PID" 2>/dev/null || true
  else
    kill "-$1" "$SERVER_PID" 2>/dev/null || true
  fi
}

stop_server() {
  if [ -n "$SERVER_PID" ] && is_running "$SERVER_PID"; then
    signal_server TERM
    # Wait for the exit (bounded), then make sure nothing is left.
    n=0
    while is_running "$SERVER_PID" && [ "$n" -lt 20 ]; do
      sleep 1
      n=$((n + 1))
    done
    if is_running "$SERVER_PID"; then signal_server KILL; fi
  fi
  SERVER_PID=''
}

cleanup() {
  status=$?
  stop_server
  if [ "${RS_KEEP_CLEAN_CHECKOUT:-}" = '1' ]; then
    printf 'clean-checkout: kept %s\n' "$WORK" >&2
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Start from defaults: unset configuration by name only (values are never read or printed).
for name in $(env | sed -n 's/^\(RS_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done
unset PORT HOST ANTHROPIC_API_KEY NODE_TEST_CONTEXT 2>/dev/null || true

step "copy tracked and unignored files (without .eccode/) into an empty directory"
mkdir -p "$CHECKOUT"
cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'the project is not inside a git work tree'
COPIED=0
LIST="$WORK/files.txt"
git -c core.quotepath=off ls-files --cached --others --exclude-standard >"$LIST"
while IFS= read -r file; do
  case "$file" in
    .eccode/* | node_modules/* | data/* | test/.out/*) continue ;;
  esac
  [ -f "$file" ] || continue
  mkdir -p "$CHECKOUT/$(dirname -- "$file")"
  cp -p -- "$file" "$CHECKOUT/$file"
  COPIED=$((COPIED + 1))
done <"$LIST"
[ -f "$CHECKOUT/package.json" ] || fail 'package.json was not copied'
[ ! -e "$CHECKOUT/.eccode" ] || fail '.eccode/ was copied'
printf 'copied %s files\n' "$COPIED"

cd "$CHECKOUT"

step 'npm install (needs the npm registry)'
if ! npm install --no-audit --no-fund; then
  fail 'npm install failed; the npm registry may be unreachable from here (the check cannot continue without it)'
fi
[ -d node_modules/@playwright/test ] || fail 'npm install did not provide the @playwright/test devDependency'

step 'npm test (offline, net guard on, no browser)'
npm test || fail 'npm test failed in the clean checkout'

step 'npm start, then GET /api/health'
START_LOG="$WORK/start.log"
: >"$START_LOG"
if command -v setsid >/dev/null 2>&1; then
  PORT=0 HOST=127.0.0.1 setsid npm start >"$START_LOG" 2>&1 &
  SERVER_PID=$!
  SERVER_PGID_KILL=1
else
  PORT=0 HOST=127.0.0.1 npm start >"$START_LOG" 2>&1 &
  SERVER_PID=$!
fi

PORT_FOUND=''
tries=0
while [ "$tries" -lt 60 ]; do
  PORT_FOUND=$(sed -n 's/.*"msg":"listening".*"port":\([0-9][0-9]*\).*/\1/p' "$START_LOG" | head -n 1)
  [ -n "$PORT_FOUND" ] && break
  is_running "$SERVER_PID" || { cat "$START_LOG" >&2; fail 'npm start exited before it listened'; }
  sleep 1
  tries=$((tries + 1))
done
[ -n "$PORT_FOUND" ] || { cat "$START_LOG" >&2; fail 'npm start did not print a listening line within 60 s'; }

HEALTH=$(node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/api/health").then(function (r) { return r.json().then(function (b) { console.log(r.status + " " + b.status); }); }, function () { console.log("0 unreachable"); });' "$PORT_FOUND")
[ "$HEALTH" = '200 ok' ] || { cat "$START_LOG" >&2; fail "GET /api/health answered '$HEALTH', expected '200 ok'"; }
printf 'GET /api/health -> 200 ok (port %s)\n' "$PORT_FOUND"

stop_server
step 'ok'
printf 'clean-checkout: npm install, npm test and npm start passed in an empty copy\n'
