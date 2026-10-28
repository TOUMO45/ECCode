# The agent command of the delivery run, the same for both variants
# (spec: docs/specs/2026-10-27-delivery-run-design.md, section 4.2).
#
# Run by `eccode bench` through a shell whose working directory is the run's
# sandbox, so `$PWD` (kept literal by the single quotes) becomes the sandbox's
# absolute path, as in bench/pilot/agents-rerun.sh.
#
# What changed from $AGENT_B (agents-rerun.sh): deleting Mealie's test temp
# directory, `rm` of tests/.temp only. In the multi-file run, item 01's run 2
# failed its own test runs on a stale tests/.temp/mealie.db that its tool list
# could not remove. Everything else stays refused as in $AGENT_B: package
# installs, uv, find, any other rm, pkill and the network tools.
export AGENT_D='cat PROMPT.md | claude -p --model sonnet --setting-sources project,local --output-format json --allowedTools "Read Grep Glob Edit Write Agent Task Bash(python*) Bash(pytest*) Bash(ruff*) Bash(mypy*) Bash(alembic*) Bash(cd frontend*) Bash(npx vitest*) Bash(npx eslint*) Bash(npx vue-tsc*) Bash(npx nuxi*) Bash(yarn test*) Bash(yarn lint*) Bash(yarn vitest*) Bash(pnpm test*) Bash(pnpm lint*) Bash(pnpm vitest*) Bash(pnpm exec vitest*) Bash(node .claude/eccode/bin/eccode.js*) Bash(node $PWD/.claude/eccode/bin/eccode.js*) Bash(git diff*) Bash(git status*) Bash(git log*) Bash(git show*) Bash(git checkout -- *) Bash(git restore*) Bash(git -C $PWD*) Bash(cd $PWD*) Bash(ls*) Bash(cat*) Bash(head*) Bash(tail*) Bash(wc*) Bash(grep*) Bash(rm -rf tests/.temp*) Bash(rm -r tests/.temp*) Bash(rm tests/.temp*) mcp__eccode_orchestrator mcp__eccode_product-architect mcp__eccode_architecture-reviewer mcp__eccode_technical-designer mcp__eccode_technical-reviewer mcp__eccode_backend-engineer mcp__eccode_frontend-engineer mcp__eccode_ai-engineer mcp__eccode_devops-engineer mcp__eccode_test-engineer mcp__eccode_security-reviewer mcp__eccode_delivery-lead mcp__eccode_learning-debugger"'
