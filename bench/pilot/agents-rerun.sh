# The agent commands of the Mealie rerun, one per suite, identical across
# variants (protocol: bench/protocols/2026-10-25-mealie-rerun.md).
#
# Each is run by `eccode bench` through a shell whose working directory is the
# run's sandbox, so `$PWD` (kept literal here by the single quotes) becomes the
# sandbox's absolute path: subagents often address the sandbox by it.
#
# What changed from the pilot's lists (2026-10-24 protocol, "Agent commands"),
# from its 177 refusals labelled harness:
# - read-only commands: ls, cat, head, tail, wc, grep (the pilot's agents could
#   not list the symlinked frontend/node_modules, register row 101);
# - the sandbox by its absolute path: cd, git -C and the CLI under $PWD;
# - git show, and reverting files: git checkout -- <paths>, git restore;
# - planner only: curl, kill <pid> and sleep, to try the service it builds.
# Still refused, for every variant: package installs, uv (it would sync the
# shared venv), find and rm (they could reach the shared environments), pkill
# (it could stop another run's server), the network tools.
export AGENT_B='cat PROMPT.md | claude -p --model sonnet --setting-sources project,local --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(python*) Bash(pytest*) Bash(ruff*) Bash(mypy*) Bash(alembic*) Bash(cd frontend*) Bash(npx vitest*) Bash(npx eslint*) Bash(npx vue-tsc*) Bash(npx nuxi*) Bash(yarn test*) Bash(yarn lint*) Bash(yarn vitest*) Bash(pnpm test*) Bash(pnpm lint*) Bash(pnpm vitest*) Bash(pnpm exec vitest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(node $PWD/.claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*) Bash(git log*) Bash(git show*) Bash(git checkout -- *) Bash(git restore*) Bash(git -C $PWD*) Bash(cd $PWD*) Bash(ls*) Bash(cat*) Bash(head*) Bash(tail*) Bash(wc*) Bash(grep*) mcp__eccode_orchestrator mcp__eccode_product-architect mcp__eccode_architecture-reviewer mcp__eccode_technical-designer mcp__eccode_technical-reviewer mcp__eccode_backend-engineer mcp__eccode_frontend-engineer mcp__eccode_ai-engineer mcp__eccode_devops-engineer mcp__eccode_test-engineer mcp__eccode_security-reviewer mcp__eccode_delivery-lead mcp__eccode_learning-debugger"'
export AGENT_C='cat PROMPT.md | claude -p --model sonnet --setting-sources project,local --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(node*) Bash(npm*) Bash(npx*) Bash(git diff*) Bash(git status*) Bash(git log*) Bash(git show*) Bash(git checkout -- *) Bash(git restore*) Bash(git -C $PWD*) Bash(cd $PWD*) Bash(ls*) Bash(cat*) Bash(head*) Bash(tail*) Bash(wc*) Bash(grep*) Bash(curl*) Bash(kill *) Bash(sleep *)"'
