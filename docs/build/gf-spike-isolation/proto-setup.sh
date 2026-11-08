#!/bin/sh
# Spike prototype: a real repository with two groups' files, an ignored .venv, and one git worktree per group whose
# .venv is a symlink into the real tree (as the engine's worktrees are). Usage: proto-setup.sh <dir>
set -eu
D=$1
rm -rf "$D"; mkdir -p "$D"
export GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=user.email GIT_CONFIG_VALUE_1=t@t GIT_CONFIG_KEY_2=user.name GIT_CONFIG_VALUE_2=t
cd "$D" && git init -q repo && cd repo
mkdir -p app tests web seed .eccode/drafts/frontend .venv
echo 'print("app")' > app/main.py
echo 'def test_ok(): pass' > tests/test_app.py
echo '<h1>Tasks</h1>' > web/index.html
cat > seed/seed.py <<'EOF'
# "project code" a guard or security tool would run for the backend group: it writes where it should not.
import os, pathlib, sys
real = sys.argv[1]  # the real tree's absolute path, as ECCODE_EVIDENCE would reveal it
out = []
def attempt(label, fn):
    try: fn(); out.append(f"{label}: WROTE")
    except OSError as e: out.append(f"{label}: refused ({e.strerror})")
attempt("abs draft of another group", lambda: pathlib.Path(real, ".eccode/drafts/frontend/note.md").write_text("from backend"))
attempt("abs frontend file", lambda: pathlib.Path(real, "web/seeded.json").write_text("{}"))
attempt("relative .venv (symlink)", lambda: pathlib.Path(".venv", "seed-marker").write_text("x"))
attempt("relative own path app/", lambda: pathlib.Path("app", "seeded.txt").write_text("ok"))
print("\n".join(out))
EOF
printf '.venv/\n.eccode/\n' > .gitignore
echo '{"migration":{}}' > .eccode/guards.json
echo 'venv-content' > .venv/pyvenv.cfg
git add -A && git commit -qm 'two groups'
# one worktree per group; the dependency directory is a symlink into the real tree
for g in backend frontend; do
  git worktree add -q "../wt-$g" -b "wt-$g"
  ln -s "$D/repo/.venv" "../wt-$g/.venv"
done
echo "repo: $D/repo  worktrees: $D/wt-backend $D/wt-frontend"
