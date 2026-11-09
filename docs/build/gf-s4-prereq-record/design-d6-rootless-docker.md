# D-6 sketch: docker for arms without the docker socket

Decision in force (owner, D-6): **no arm gets the docker socket.** The operator runs the deployment check
(`tools/deploy-check.sh`) after the arm's final exit. This file sketches the alternative of rootless docker per arm,
for a later decision. Nothing here is built or run.

## Why not the socket
The host daemon's socket is root-equivalent: a container started through it can bind-mount any host path
(`-v /:/host`), including the operator scratchpad, other arms' workspaces and the hidden suite. That defeats the
bubblewrap isolation of the plan (section 3.1) and R12.

## Option A (in force): operator-run check, arms have no docker
- The arm writes `compose.yaml` and Dockerfiles but cannot build or start them; the engine's static checks
  (`eccode-gf stack check`: `docker compose config`, no daemon) are available to it, and to bare equally if the bare
  arm's sandbox has the docker CLI without a socket.
- After the arm exits: `tools/deploy-check.sh --dry-run <tree>` then `tools/deploy-check.sh <tree> --smoke "<adapter
  smoke command>"` on a fresh copy.
- Trade-off: arms cannot self-test deployment, so M7 failures can come from never having run the stack. This hits
  every arm the same way, which keeps the comparison fair, but it lowers absolute M7 pass rates.

## Option B (sketch): rootless docker, one daemon per arm
- One unprivileged user per arm (`arm-a`, `arm-b`, `arm-c`), each with its own rootless dockerd
  (`dockerd-rootless-setuptool.sh install`, needs `uidmap`, `slirp4netns` or `pasta`, and subuid/subgid ranges).
- The arm's bubblewrap sandbox binds only that user's socket (`$XDG_RUNTIME_DIR/docker.sock`) and its workspace.
- Isolation gained: a container can mount only what the arm's user can read. That user must not be able to read
  `/home/user/eccode`, `/root/.cache/s4-hidden/`, other arms' workspaces, or the operator scratchpad (file
  permissions, checked by a canary before each run, the same idea as GF-ISO-0).
- Residuals: rootless docker shares the kernel (a kernel exploit escapes); a container's network egress follows the
  rootless network driver, not the bwrap network namespace, so the package-registry allowlist must also be enforced
  at that layer; image pulls need registry access; build cache and disk are per user, so the token/wall ceilings do
  not cap disk; nested user namespaces must be allowed inside the container that hosts the arms.
- Not checked here: whether this container permits nested user namespaces for rootless dockerd (P-7, the daemon
  question, is still open).

## Recommendation status
None made. Option A is what the code supports today. Option B changes what arms can do (self-test deployment) and
would have to apply to all three arms equally.
