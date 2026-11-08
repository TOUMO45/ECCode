#!/bin/sh
# The evasion matrix of rounds 4 to 6 and I2-1, run INSIDE the sandbox as the backend group, from its worktree.
# Each row prints "<n> <evasion>: BLOCKED (<error>)" or "<n> <evasion>: PASSED (the write landed)".
# Usage (inside the sandbox): evasions.sh <real repo abs path> <this worktree abs path> <other worktree abs path>
REPO=$1; WT=$2; OTHER=$3
cd "$WT" || exit 9
export GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_3=safe.directory GIT_CONFIG_VALUE_3=* GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=t@t GIT_CONFIG_KEY_2=user.name GIT_CONFIG_VALUE_2=t
row() { # row <n> <label> <command...>: BLOCKED when the command fails, else PASSED
  n=$1; label=$2; shift 2
  if out=$("$@" 2>&1); then echo "$n $label: PASSED (${out:-no output})"; else echo "$n $label: BLOCKED ($(echo "$out" | tail -1 | cut -c1-110))"; fi
}
check() { # check <n> <label> <path>: PASSED when the path now exists (a write landed), else BLOCKED
  if [ -e "$3" ]; then echo "$1 $2: PASSED (exists)"; else echo "$1 $2: BLOCKED (nothing landed)"; fi
}
echo "sandbox identity: $(id -u) cwd $(pwd)"
echo "0 own path write (control, must PASS)" && (echo ok > app/own.txt && echo "0 own path write: PASSED (control)" || echo "0 own path write: BLOCKED (control failed: the sandbox is too tight)")
row 1 "git commit in the worktree (round 6, G2-1)" sh -c 'echo "<!-- backend -->" >> web/index.html 2>/dev/null; git add -A 2>&1; git commit -qam hidden 2>&1'
row 2 "git update-index --assume-unchanged (round 6)" git update-index --assume-unchanged web/index.html
row 3 "append to .git/info/exclude of the common dir (round 6, G2-2)" sh -c 'echo web/ >> "$(git rev-parse --git-common-dir)/info/exclude"'
row 4 "absolute-path write to the other group's file in this worktree" sh -c "echo x > '$WT/web/index.html'"
row 5 "absolute-path write to the real tree (web/)" sh -c "echo x > '$REPO/web/index.html'"
row 6 "absolute-path write to the other group's worktree" sh -c "echo x > '$OTHER/web/index.html'"
row 7 "write through the symlinked .venv into the real tree" sh -c 'echo x > .venv/marker'
row 8 "absolute write to another group's draft under .eccode/" sh -c "echo x > '$REPO/.eccode/drafts/frontend/note.md'"
row 9 "guard-style tool running project code (seed.py, I2-1)" python3 seed/seed.py "$REPO"
row 10 "git -C <real tree> commit (round 6)" git -C "$REPO" commit -q --allow-empty -m hidden
row 11 "hard link of the other group's file into own path (round 4, E2-2)" ln web/index.html app/linked.html
row 12 "rename the other group's file into own path (round 4)" mv web/index.html app/moved.html
row 13 "delete the other group's file" rm -f web/index.html
row 14 "remount own view read-write through a new user namespace" unshare -Urm sh -c "mount -o remount,rw,bind '$WT/web' && echo x > '$WT/web/index.html'"
row 15 "write the guard configuration (GF-CONF-1)" sh -c "echo '{}' > '$REPO/.eccode/guards.json'"
row 16 "write outside the project (home)" sh -c 'echo x > "$HOME/spike-escape"'
echo "--- state after the attempts, read from inside:"
echo "web/index.html: $(cat web/index.html | head -1)"; echo "HEAD: $(git rev-parse --short HEAD 2>&1)"
