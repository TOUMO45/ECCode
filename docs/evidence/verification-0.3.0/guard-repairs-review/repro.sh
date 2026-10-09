#!/usr/bin/env bash
# Standalone reproductions of the review findings against the worktree guard (commit ffbdc8d).
# Usage: bash repro.sh [worktree] [scratch-dir]. Nothing is written outside the scratch dir.
set -u
WT=${1:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix}
R=${2:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/repro}
GUARD="$WT/scripts/hooks/guard.js"
CLI="$WT/bin/eccode.js"
rm -rf "$R"; mkdir -p "$R"; cd "$R" || exit 1
git init -q
node "$CLI" init --name x --idea y --root "$R" >/dev/null
guard() { # guard <json>; prints the decision or "allow"
  local out
  out=$(printf '%s' "$1" | env CLAUDE_PROJECT_DIR= ECCODE_ACTOR= ECCODE_SEQUENTIAL_ROLES= ECCODE_HOOKS= node "$GUARD")
  if [ -z "$out" ]; then echo "allow"; else echo "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const o=JSON.parse(s).hookSpecificOutput;console.log(o.permissionDecision+": "+o.permissionDecisionReason.slice(0,120))})'; fi
}
bash_json() { # bash_json <agent_type or ""> <command>
  node -e 'const [cwd,agent,cmd]=process.argv.slice(1);const p={cwd,tool_name:"Bash",tool_input:{command:cmd}};if(agent)p.agent_type=agent;process.stdout.write(JSON.stringify(p))' "$R" "$1" "$2"
}
file_json() { # file_json <agent_type or ""> <tool> <file>
  node -e 'const [cwd,agent,tool,file]=process.argv.slice(1);const p={cwd,tool_name:tool,tool_input:{file_path:file}};if(agent)p.agent_type=agent;process.stdout.write(JSON.stringify(p))' "$R" "$1" "$2" "$3"
}

echo "== F1. main session: clobber redirect onto the record (expected deny)"
guard "$(bash_json "" 'echo x >| .eccode/events.jsonl')"
guard "$(bash_json "" 'cat /tmp/forged.jsonl 2>| .eccode/events.jsonl')"
echo "   (same target with a plain > redirect, for contrast)"
guard "$(bash_json "" 'echo x > .eccode/events.jsonl')"

echo "== F2. main session: a record created inside the record unprotects the record for Write/Edit"
echo "   before:"; guard "$(file_json "" Write "$R/.eccode/state.json")"
echo "   guard's answer to the planting command:"; guard "$(bash_json "" 'eccode init --root .eccode --name a --idea b')"
node "$CLI" init --root .eccode --name a --idea b >/dev/null; echo "   planted: $(ls .eccode/.eccode | tr '\n' ' ')"
echo "   after (expected deny):"
guard "$(file_json "" Write "$R/.eccode/state.json")"
guard "$(file_json "" Edit "$R/.eccode/events.jsonl")"
guard "$(file_json "" Write "$R/.eccode/config.json")"
guard "$(file_json "" Write "$R/.eccode/reviews/architecture-1.json")"
rm -rf .eccode/.eccode

echo "== F3. reviewer subagent: wrapper forms the SHELL_WRAPPER regex misses (expected deny)"
REV=eccode:technical-reviewer
guard "$(bash_json "$REV" 'function e() { eccode "$@"; }; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" 'e() ( eccode "$@" ); e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" 'e() if true; then eccode "$@"; fi; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" '  e() { eccode "$@"; }; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" 'if true; then e() { eccode "$@"; }; fi; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" '{ e() { eccode "$@"; }; }; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" "bash -c 'e() { eccode \"\$@\"; }; e task claim api --actor backend-engineer'")"
guard "$(bash_json "" "bash -c 'e() { eccode \"\$@\"; }; e gate reopen design --actor user'")"
guard "$(bash_json "eccode:backend-engineer" "eccode evidence run --actor backend-engineer --label t -- 'e() { eccode \"\$@\"; }; e gate review design --actor technical-reviewer'")"
echo "   (the forms the commit covers, for contrast)"
guard "$(bash_json "$REV" 'e() { eccode "$@"; }; e task claim api --actor backend-engineer')"
guard "$(bash_json "$REV" 'function e { eccode "$@"; }; e task claim api --actor backend-engineer')"

echo "== F4. identity gate skipped when the raw text does not contain 'eccode' (expected deny)"
guard "$(bash_json "$REV" 'node bin/ecc"ode".js task claim api --actor backend-engineer')"
guard "$(bash_json "" "node bin/ecc'ode'.js gate reopen design --actor user")"
guard "$(bash_json "$REV" 'node bin/ecc\ode.js task claim api --actor backend-engineer')"

echo "== F5. NEW-9 through variable indirection of the name (expected deny)"
guard "$(bash_json "eccode:learning-debugger" 'V=ECCODE_SHARED_MEMORY; export $V=/tmp/x; eccode memory search race --actor learning-debugger')"
guard "$(bash_json "eccode:learning-debugger" "export ECC''ODE_SHARED_MEMORY=/tmp/x")"

echo "== F6. pre-existing: main session replaces the whole record directory (expected deny)"
guard "$(bash_json "" 'rsync -a /tmp/forged/ .eccode/')"
guard "$(bash_json "" 'cp -r /tmp/forged/. .eccode')"

echo "== F7. quoted bar: bash writes a file named | in the cwd, the guard judges the next word"
guard "$(bash_json "$REV" 'echo x >"|" src/server.js')"
echo "   (what bash does with it)"; (cd "$R" && bash -c 'echo x >"|" src/server.js'; ls -1 "$R" | grep -c '^|$')

echo "== F8. false positive: an unrelated function next to a comment that mentions the CLI (expected allow)"
guard "$(bash_json "$REV" 'f() { echo hi; }; f # see the eccode docs')"
