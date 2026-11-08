#!/bin/sh
# Rule-removal battery (P3): remove or weaken one GF-ISO guard at a time and confirm >= 2 tests fail. Operates on a
# throwaway copy of lib/greenfield so the real tree is untouched. Each mutant line: "<id>: <killed|SURVIVED N> tests".
set -eu
ROOT=/home/user/ECCode; WORK=$1; rm -rf "$WORK"; mkdir -p "$WORK"; cp -r "$ROOT" "$WORK/repo"; cd "$WORK/repo"
TESTS="tests/gf-iso-sandbox.test.js tests/gf-iso-run.test.js tests/gf-iso-commit.test.js tests/gf-iso-guards.test.js tests/gf-tool-allowlist.test.js tests/gf-events.test.js"
run() { node --test $TESTS 2>/dev/null | awk '/^# fail/{print $3}'; }
mutate() { # <id> <file> <sed-expr>
  id=$1; file=$2; expr=$3
  git -C "$WORK/repo" checkout -q -- "$file" 2>/dev/null || true
  cp "$ROOT/$file" "$file"
  sed -i "$expr" "$file" || { echo "$id: sed-noop"; return; }
  f=$(run); f=${f:-0}
  if [ "$f" -ge 2 ]; then echo "$id: killed ($f fail)"; else echo "$id: SURVIVED ($f fail)"; fi
  cp "$ROOT/$file" "$file"
}
# GF-ISO-2 ownership check off (always owner===group)
mutate_two() { # id file e1 e2
  id=$1; file=$2; e1=$3; e2=$4; cp "$ROOT/$file" "$file"; sed -i "$e1" "$file"; sed -i "$e2" "$file"
  f=$(run); f=${f:-0}; if [ "$f" -ge 2 ]; then echo "$id: killed ($f fail)"; else echo "$id: SURVIVED ($f fail)"; fi; cp "$ROOT/$file" "$file"; }
mutate_two "iso2-owner-off" lib/greenfield/isolate.js "s/if (owner !== g.group) {/if (false) {/" "s/if (ownership.ownerOfPath(map, rel) !== group) out.push(P('GF-ISO-2', \`\${rel} belongs to/if (false) out.push(P('GF-ISO-2', \`\${rel} belongs to/"
# GF-ISO-2 task-membership check off
mutate "iso2-task-off" lib/greenfield/isolate.js "s#if (!matchesAny(rel, task.files || \[\])) out.push(P('GF-ISO-2'#if (false \&\& !matchesAny(rel, task.files || [])) out.push(P('GF-ISO-2'#"
# GF-ISO-2 symlink resolve check off
mutate "iso2-symlink-off" lib/greenfield/isolate.js "s/if (real.outside || real.rel !== rel)/if (false)/"
# GF-ISO-2 hardlink check off
mutate "iso2-hardlink-off" lib/greenfield/isolate.js "s/else if (st.nlink > 1)/else if (false)/"
# GF-ISO-2 regular-file check off
mutate "iso2-regular-off" lib/greenfield/isolate.js "s/if (!st.isFile()) out.push(P('GF-ISO-2', \`\${rel} is not a regular file/if (false) out.push(P('GF-ISO-2', \`\${rel} is not a regular file/"
# GF-ISO-2 config-include check off
mutate "iso2-config-off" lib/greenfield/isolate.js "s/const bad = names.filter/const bad = [].filter/"
# GF-ISO-0 self-test gate off (groupModeProblems always empty)
mutate "iso0-gate-off" lib/greenfield/sandbox.js "s/if (t.ok) return \[\];/if (true) return [];/"
# GF-ISO-4 whole-project widening allowed
mutate "iso4-widen-off" lib/greenfield/sandbox.js "s/if (p.path === '' || p.path === '.') {/if (false) {/"
# GF-ISO-3 check-passed requirement off
mutate "iso3-check-off" lib/greenfield/isolate.js "s/else if (e.data.status !== 'passed') problems.push(P('GF-ISO-3', \`check/else if (false) problems.push(P('GF-ISO-3', \`check/"
# GF-ISO-3 actor restriction off
mutate "iso3-actor-off" lib/greenfield/isolate.js "s/if (!\['orchestrator', 'user'\].includes(actor)) throw ruleError(\[P('GF-ISO-3'/if (false) throw ruleError([P('GF-ISO-3'/"
# allowlist default-deny off (everything allowed)
mutate "allowlist-off" lib/greenfield/index.js "s/const ALLOWED = new Set(GROUP_ROLE_TOOLS);/const ALLOWED = new Set(require('.\/..\/mcp').tools().map(t=>t.name));/"
