#!/usr/bin/env bash
set -u
WT=${1:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/guardfix}
R=${2:-/tmp/claude-0/-home-user-ECCode/f72396f5-b89f-576d-a680-29d481cd71c9/scratchpad/repro3b}
GUARD="$WT/scripts/hooks/guard.js"; CLI="$WT/bin/eccode.js"
g() { local p out; p=$(node -e 'const [cwd,agent,cmd]=process.argv.slice(1);const o={cwd,tool_name:"Bash",tool_input:{command:cmd}};if(agent)o.agent_type=agent;process.stdout.write(JSON.stringify(o))' "$R" "$1" "$2"); out=$(printf '%s' "$p" | env CLAUDE_PROJECT_DIR= ECCODE_ACTOR= ECCODE_SEQUENTIAL_ROLES= ECCODE_HOOKS= node "$GUARD"); if [ -z "$out" ]; then echo allow; else printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{console.log(JSON.parse(s).hookSpecificOutput.permissionDecision)})'; fi; }
rm -rf "$R"; mkdir -p "$R"; cd "$R" || exit 1; git init -q >/dev/null; node "$CLI" init --name x --idea y --root "$R" >/dev/null; mkdir -p .eccode/memory
dot='.ecc''ode'   # avoid the literal token in this script's own text where possible
C='ln -s "$PWD/'$dot'" lk && printf "%s" "{\"id\":\"m-forged\",\"status\":\"verified\"}" > lk/memory/m-forged.json'
echo "bare-dir alias -> forge memory; guard(main): $(g '' "$C") ; guard(backend-engineer): $(g eccode:backend-engineer "$C")"
bash -c "$C"
echo "forged memory file present in real record: $([ -f .eccode/memory/m-forged.json ] && echo YES || echo no)"
C2='ln -s "$PWD/'$dot'" lk2 && echo "{}" > lk2/config.json'
echo "bare-dir alias -> clobber config; guard(main): $(g '' "$C2")"
