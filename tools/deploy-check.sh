#!/usr/bin/env bash
# S4-PREREQ D-6: OPERATOR-RUN deployment check for a docker compose tree. No arm runs this and no arm gets the docker
# socket. Generic: it knows nothing about any product; a product-specific smoke step is passed in with --smoke.
#
# usage:
#   tools/deploy-check.sh --dry-run <tree>                  static checks only; never contacts a docker daemon
#   tools/deploy-check.sh <tree> [--smoke "<command>"] [--timeout <s>]
#                                                           live: fresh copy, up --build --wait, every service healthy,
#                                                           smoke, restart, healthy again, smoke again, down -v
# Exit: 0 PASS, 1 usage or environment error, 2 FAIL.
# Live-mode environment: POSTGRES_PASSWORD (a throwaway value is generated when unset), API_PORT, DASHBOARD_PORT.
# The smoke command runs with DEPLOY_CHECK_DIR (the copy), DEPLOY_CHECK_PROJECT (compose project name) exported.
set -euo pipefail

DRY_RUN=0
TREE=""
SMOKE=""
TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --smoke) SMOKE="${2:?--smoke needs a command}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "deploy-check: unknown option $1" >&2; exit 1 ;;
    *) if [ -z "$TREE" ]; then TREE="$1"; shift; else echo "deploy-check: one tree only" >&2; exit 1; fi ;;
  esac
done
[ -n "$TREE" ] || { echo "deploy-check: a tree is required (see --help)" >&2; exit 1; }
[ -d "$TREE" ] || { echo "deploy-check: $TREE is not a directory" >&2; exit 1; }
case "$TIMEOUT" in ''|*[!0-9]*) echo "deploy-check: --timeout must be whole seconds" >&2; exit 1 ;; esac
command -v docker >/dev/null 2>&1 || { echo "deploy-check: the docker CLI is not installed" >&2; exit 1; }

TREE="$(cd "$TREE" && pwd)"
COMPOSE_FILE=""
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$TREE/$f" ]; then COMPOSE_FILE="$f"; break; fi
done
[ -n "$COMPOSE_FILE" ] || { echo "FAIL: no compose file in $TREE"; exit 2; }

log() { printf '[deploy-check %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 2; }

# Every service of a resolved compose document (JSON on stdin) must declare an enabled healthcheck.
healthchecks_ok() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const doc = JSON.parse(s); const bad = [];
      for (const [name, svc] of Object.entries(doc.services || {})) {
        const hc = svc.healthcheck;
        if (!hc || !hc.test || hc.disable === true || (Array.isArray(hc.test) && (hc.test.length === 0 || hc.test[0] === "NONE"))) bad.push(name);
      }
      if (bad.length) { console.log("services without a healthcheck: " + bad.join(", ")); process.exit(2); }
      console.log("healthchecks: " + Object.keys(doc.services || {}).length + " of " + Object.keys(doc.services || {}).length + " services");
    });'
}

static_checks() {
  local dir="$1"
  log "static: docker compose config on $dir/$COMPOSE_FILE (no daemon)"
  # A dead socket proves the static phase never needs the daemon.
  DOCKER_HOST="unix:///nonexistent/deploy-check-dry-run.sock" \
    POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-dry-run-placeholder}" \
    docker compose -f "$dir/$COMPOSE_FILE" --project-directory "$dir" config -q \
    || fail "the compose file does not validate"
  DOCKER_HOST="unix:///nonexistent/deploy-check-dry-run.sock" \
    docker compose -f "$dir/$COMPOSE_FILE" --project-directory "$dir" config --no-interpolate --format json \
    | healthchecks_ok || fail "a service has no healthcheck"
}

if [ "$DRY_RUN" -eq 1 ]; then
  static_checks "$TREE"
  log "PASS (dry run: static checks only; nothing was built or started)"
  exit 0
fi

# ---------------------------------------------------------------- live mode (operator only)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-check.XXXXXX")"
PROJECT="deploycheck$(date +%s)$$"
export DEPLOY_CHECK_DIR="$WORK/tree" DEPLOY_CHECK_PROJECT="$PROJECT"
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  export POSTGRES_PASSWORD
fi
dc() { docker compose -p "$PROJECT" -f "$WORK/tree/$COMPOSE_FILE" --project-directory "$WORK/tree" "$@"; }
STARTED=0
cleanup() {
  if [ "$STARTED" -eq 1 ]; then
    log "teardown: down -v"
    dc down -v --remove-orphans >/dev/null 2>&1 || log "teardown reported an error (check 'docker ps -a' for project $PROJECT)"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

log "fresh copy of $TREE (without .git, .eccode, .env)"
mkdir -p "$WORK/tree"
tar -C "$TREE" --exclude=./.git --exclude=./.eccode --exclude=./.env -cf - . | tar -C "$WORK/tree" -xf -
static_checks "$WORK/tree"

docker info >/dev/null 2>&1 || { log "the docker daemon is not reachable"; exit 1; }

log "up --build --wait (timeout ${TIMEOUT}s): every service must report healthy"
STARTED=1
dc up -d --build --wait --wait-timeout "$TIMEOUT" || { dc ps -a || true; dc logs --tail 50 || true; fail "the stack did not become healthy within ${TIMEOUT}s"; }
dc ps

if [ -n "$SMOKE" ]; then
  log "smoke: $SMOKE"
  bash -c "$SMOKE" || fail "the smoke step failed"
fi

log "restart, then every service must be healthy again"
dc restart
dc up -d --wait --wait-timeout "$TIMEOUT" || fail "the stack was not healthy after a restart"
if [ -n "$SMOKE" ]; then
  log "smoke after restart: $SMOKE"
  bash -c "$SMOKE" || fail "the smoke step failed after the restart"
fi

log "PASS"
