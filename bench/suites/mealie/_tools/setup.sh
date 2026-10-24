#!/bin/sh
# Build the environments the Mealie pilot needs, outside every sandbox.
#
# usage: ECCODE_MEALIE_ENVS=<dir> sh setup.sh [--node] <ref> [<ref> ...]
#
# For each ref (a tag or a full commit sha of Mealie), the tree is exported from
# the bench mirror and its environments are built: the Python venv for its
# uv.lock and, with --node, node_modules for its frontend/yarn.lock. Prints one
# line per ref. Environments are keyed by lockfile, so refs that share a lock
# share an environment.
#
# python-ldap needs the OpenLDAP and SASL headers. In order of preference
# (spec section 5): install them with apt; otherwise stub the module, only if
# every test that imports it mocks it; otherwise the LDAP tests are deselected.
# The mode used is written to $ECCODE_MEALIE_ENVS/ldap-mode.txt.
set -eu
: "${ECCODE_MEALIE_ENVS:?set ECCODE_MEALIE_ENVS to the directory for environments}"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
node_too=0
if [ "${1:-}" = "--node" ]; then node_too=1; shift; fi
[ $# -gt 0 ] || { echo "usage: setup.sh [--node] <ref> [<ref> ...]" >&2; exit 2; }
mkdir -p "$ECCODE_MEALIE_ENVS"

if [ ! -f /usr/include/ldap.h ] || [ ! -f /usr/include/sasl/sasl.h ]; then
  apt-get install -y -q libldap2-dev libsasl2-dev >/dev/null 2>&1 \
    || { apt-get update -q >/dev/null 2>&1 && apt-get install -y -q libldap2-dev libsasl2-dev >/dev/null 2>&1; } || true
fi
if [ -f /usr/include/ldap.h ] && [ -f /usr/include/sasl/sasl.h ]; then
  echo headers > "$ECCODE_MEALIE_ENVS/ldap-mode.txt"
else
  echo "python-ldap: no OpenLDAP/SASL headers and apt failed; the stub or deselect fallback must be applied and disclosed" >&2
  exit 1
fi
echo "ldap mode: $(cat "$ECCODE_MEALIE_ENVS/ldap-mode.txt")"

for ref in "$@"; do
  tree=$(mktemp -d "${TMPDIR:-/tmp}/mealie-setup-XXXXXX")
  sha=$(git --git-dir "${ECCODE_BENCH_CACHE:-$HOME/.cache/eccode/bench-repos}/github.com-mealie-recipes-mealie.git" rev-parse "$ref^{commit}" 2>/dev/null || echo "$ref")
  node -e '
    const bench = require(process.argv[1] + "/lib/bench");
    bench.exportSource({ repo: "https://github.com/mealie-recipes/mealie.git", commit: process.argv[2] }, process.argv[3]);
  ' "$repo" "$sha" "$tree"
  venv=$(node "$here/env.js" python "$tree")
  line="$ref $sha python=$venv"
  if [ "$node_too" = 1 ]; then line="$line node=$(node "$here/env.js" node "$tree")"; fi
  echo "$line"
  rm -rf "$tree"
done
