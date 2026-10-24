#!/bin/sh
# The Python environments the realbugs tasks run in (Python 3.8, pinned
# packages, no project under test installed). Needs uv (https://docs.astral.sh/uv/).
#   ECCODE_REALBUGS_VENVS=$HOME/.cache/eccode/realbugs-venvs sh bench/suites/realbugs/_tools/setup.sh
# Then run the benchmark with ECCODE_REALBUGS_VENVS set to the same directory.
set -e
: "${ECCODE_REALBUGS_VENVS:?set ECCODE_REALBUGS_VENVS to the directory for the environments}"
here=$(cd "$(dirname "$0")" && pwd)
for env in py38 black thefuck; do
  uv venv -q -p 3.8 "$ECCODE_REALBUGS_VENVS/$env"
  VIRTUAL_ENV="$ECCODE_REALBUGS_VENVS/$env" uv pip install -q -r "$here/requirements/$env.txt"
  echo "realbugs: $ECCODE_REALBUGS_VENVS/$env ready"
done
