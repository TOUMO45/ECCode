# mealie: real changes to a real codebase, as work items on one record

The big-project pilot ([spec](../../../docs/specs/2026-10-24-big-project-pilot-design.md)) runs ECCode on [Mealie](https://github.com/mealie-recipes/mealie), a self-hosted recipe manager:
- a Python 3.12 backend (FastAPI, SQLAlchemy, Alembic);
- a Nuxt / TypeScript frontend.

It is about 145k lines in all.

**No Mealie file is in this repository.** Mealie is AGPL-3.0; ECCode is MIT.
- Tasks name upstream commits.
- The harness exports trees and hidden tests from a local mirror when a run happens.
- Reports quote names and counts, never Mealie source.

**Environments** live outside every sandbox, keyed by lockfile (`_tools/env.js`):
- a Python venv per `uv.lock`;
- a `node_modules` per `frontend/yarn.lock`.

The project itself is not installed into the venv: a shared venv must not point into one sandbox, and Mealie runs from its tree.

```
ECCODE_MEALIE_ENVS=$HOME/.cache/eccode/mealie-envs sh bench/suites/mealie/_tools/setup.sh --node v3.20.0
```

**`python-ldap`** needs the OpenLDAP and SASL headers. `setup.sh` installs them with apt (`libldap2-dev`, `libsasl2-dev`) and records the mode in `$ECCODE_MEALIE_ENVS/ldap-mode.txt`. If apt is unavailable it stops: the stub and deselect fallbacks of the spec must then be applied and disclosed.

**Keep `TMPDIR` short and outside any session scratchpad** (register rows 67 and 70).

The first export clones Mealie into `ECCODE_BENCH_CACHE` (default `~/.cache/eccode/bench-repos`), about 450 MB.
