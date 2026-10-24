"""Build the realbugs benchmark tasks from BugsInPy metadata.

For each accepted bug (selection.json) this writes bench/suites/realbugs/<id>/:
  task.json            source repo + buggy commit, environment, prompt (from
                       prompts.json), hidden checks
  hidden/files/...     the fixed commit's test files (the agent never sees them)
  reference/fix.patch  the real fix (BugsInPy's source patch), for validation
  fixture/...          overlay files a checkout needs to run (black's version module)

The hidden checks are measured, not guessed: the fixed test files run on the
buggy tree and on the fixed tree; "bug" is every test that fails on the buggy
tree and passes on the fixed one, "regression" every other test of those files
that passes on both (tests that fail on the fixed tree in this environment are
deselected and listed).

usage: python3 -I build.py --bugsinpy <dir> --mirrors <dir of <project>.git> --venvs <dir>
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SUITE = os.path.dirname(HERE)
REPOS = {
    'youtube-dl': 'https://github.com/ytdl-org/youtube-dl',
    'black': 'https://github.com/psf/black',
    'tornado': 'https://github.com/tornadoweb/tornado',
    'thefuck': 'https://github.com/nvbn/thefuck',
    'tqdm': 'https://github.com/tqdm/tqdm',
}
VENV = {'youtube-dl': 'py38', 'tqdm': 'py38', 'tornado': 'py38', 'black': 'black', 'thefuck': 'thefuck'}
OVERLAY = {'black': {'_black_version.py': 'version = "19.10b0"\n'}}
# Where a fix's own test files hold no other test, the regression check runs
# the module that tests the same code instead; projects whose whole offline
# suite takes seconds run all of it.
REGRESSION_FILES = {'tornado-13': ['tornado/test/httpserver_test.py']}
# (tqdm's whole suite includes wall-clock and thread-timing tests that hang
# or fail on a loaded machine: its core test file is added instead.)
REGRESSION_DIRS = {
    'thefuck': lambda tree, own: ['tests'],
    'tqdm': lambda tree, own: sorted(set(own) | {'tqdm/tests/tests_tqdm.py'}),
}
TEST_PATH = re.compile(r'(^|/)tests?/|(^|/)(test_[^/]*|[^/]*_test|tests_[^/]*)\.py$')
PYTEST = 'python -m pytest -q -p no:cacheprovider'


def sh(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout


def info(bugsinpy, project, bug):
    d = os.path.join(bugsinpy, 'projects', project, 'bugs', str(bug))
    kv = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', open(os.path.join(d, 'bug.info')).read()))
    return kv, open(os.path.join(d, 'bug_patch.txt'), errors='replace').read()


def export(mirror, commit, dest, project):
    idx = tempfile.mktemp()
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    sh(['git', '--git-dir', mirror, 'read-tree', commit], env=env)
    sh(['git', '--git-dir', mirror, '--work-tree', dest, 'checkout-index', '-a', '-f'], env=env)
    os.unlink(idx)
    for name, text in OVERLAY.get(project, {}).items():
        open(os.path.join(dest, name), 'w').write(text)


def pytest_outcomes(cwd, files, venv):
    xml = cwd + '.xml'
    env = dict(os.environ, PATH=f'{venv}/bin:' + os.environ['PATH'], PYTHONDONTWRITEBYTECODE='1')
    env.pop('PYTHONPATH', None)
    subprocess.run(f'{PYTEST} --continue-on-collection-errors --junitxml={xml} ' + ' '.join(files), shell=True, cwd=cwd, env=env, capture_output=True, timeout=1200)
    out = {}
    for tc in ET.parse(xml).getroot().iter('testcase'):
        cls, name = tc.get('classname', ''), tc.get('name')
        state = 'passed'
        for child in tc:
            if child.tag in ('failure', 'error'):
                state = 'failed'
            elif child.tag == 'skipped' and state == 'passed':
                state = 'skipped'
        # junit classname: dotted module, then the class if any; the module is
        # the longest dotted prefix that is a file in the tree.
        # A module that fails to collect is reported with an empty classname
        # and the module as its name: it becomes a failed module-level node.
        parts = (cls or name).split('.')
        k = next((k for k in range(len(parts), 0, -1) if os.path.isfile(os.path.join(cwd, *parts[:k]) + '.py')), None)
        if k is None:
            raise SystemExit(f'cannot map junit testcase {cls!r} {name!r} to a test file')
        f = '/'.join(parts[:k]) + '.py'
        rest = '::'.join(parts[k:])
        node = f if not cls else '::'.join([f] + ([rest] if rest else []) + [re.sub(r'\[.*\]$', '', name)])
        # A parametrized test is one node: failed if any case failed, else
        # passed if any case passed, else skipped.
        rank = {'skipped': 0, 'passed': 1, 'failed': 2}
        out[node] = max(out.get(node, 'skipped'), state, key=rank.get)
    return out


def build(args, project, bug, prompts):
    tid = f'{project}-{bug}'
    kv, patch = info(args.bugsinpy, project, bug)
    buggy, fixed = kv['buggy_commit_id'], kv['fixed_commit_id']
    mirror = os.path.join(args.mirrors, f'{project}.git')
    venv = os.path.join(args.venvs, VENV[project])
    fix_files = set(re.findall(r'^diff --git a/(\S+)', patch, re.M))
    changed = [l.split('\t') for l in sh(['git', '--git-dir', mirror, 'diff', '--name-status', '--no-renames', buggy, fixed]).splitlines()]
    test_patch = [f for st, f in changed if st != 'D' and f not in fix_files and TEST_PATH.search(f)]
    test_modules = [f for f in test_patch if f.endswith('.py') and re.search(r'(^|/)(test_[^/]*|[^/]*_test|tests_[^/]*)\.py$', f)]
    tmp = tempfile.mkdtemp(prefix=f'build-{tid}-')
    try:
        b, fx = os.path.join(tmp, 'buggy'), os.path.join(tmp, 'fixed')
        os.makedirs(b); os.makedirs(fx)
        export(mirror, buggy, b, project)
        export(mirror, fixed, fx, project)
        for f in test_patch:
            os.makedirs(os.path.dirname(os.path.join(b, f)) or b, exist_ok=True)
            shutil.copyfile(os.path.join(fx, f), os.path.join(b, f))
        ob = pytest_outcomes(b, test_modules, venv)
        of = pytest_outcomes(fx, test_modules, venv)
        bug_tests = sorted(k for k in of if of[k] == 'passed' and ob.get(k) == 'failed')
        env_failing = sorted(k for k in of if of[k] == 'failed')
        if not bug_tests:
            raise SystemExit(f'{tid}: no test fails on the buggy tree and passes on the fixed one')
        reg_files = REGRESSION_FILES.get(tid) or (REGRESSION_DIRS[project](b, test_modules) if project in REGRESSION_DIRS else test_modules)
        rb, rf = (ob, of) if reg_files is test_modules else (pytest_outcomes(b, reg_files, venv), pytest_outcomes(fx, reg_files, venv))
        env_failing = sorted(set(env_failing) | {k for k in rf if rf[k] == 'failed'})
        # Outside the fix's own tests, a test that only the fix makes pass is
        # not part of this bug's report: neither checked nor required.
        other = sorted(k for k in rf if rf[k] == 'passed' and rb.get(k) == 'failed' and k not in bug_tests)
        regression = [k for k in rf if rf[k] == 'passed' and rb.get(k) == 'passed' and k not in bug_tests]
        out = os.path.join(SUITE, tid)
        shutil.rmtree(out, ignore_errors=True)
        for f in test_patch:
            dst = os.path.join(out, 'hidden', 'files', f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(fx, f), dst)
        os.makedirs(os.path.join(out, 'reference'))
        open(os.path.join(out, 'reference', 'fix.patch'), 'w').write(patch)
        for name, text in OVERLAY.get(project, {}).items():
            os.makedirs(os.path.join(out, 'fixture'), exist_ok=True)
            open(os.path.join(out, 'fixture', name), 'w').write(text)
        deselect = sorted(set(bug_tests) | set(env_failing) | set(other))
        p = prompts[tid]
        task = {
            'id': tid,
            'title': p['title'],
            'source': {'repo': REPOS[project], 'commit': buggy, 'fixedCommit': fixed, 'bugsinpy': f'{project}/{bug}'},
            'env': {'PATH': '${ECCODE_REALBUGS_VENVS}/' + VENV[project] + '/bin:${PATH}', 'PYTHONDONTWRITEBYTECODE': '1'},
            'prompt': p['prompt'],
            'hiddenChecks': [
                {'id': 'bug', 'command': f'node .bench-hidden/place.js && {PYTEST} ' + ' '.join(bug_tests)},
                # A module that fails to collect here is ignored (deselecting it
                # would not stop the collection error); single tests are deselected.
                {'id': 'regression', 'command': f'node .bench-hidden/place.js && {PYTEST} ' + ' '.join(reg_files) + ''.join(f' --ignore={k}' if '::' not in k else f' --deselect {k}' for k in deselect if any(k.split('::')[0] == r or k.startswith(r.rstrip('/') + '/') for r in reg_files))},
            ],
            'measured': {'bugTests': bug_tests, 'regressionTests': len(regression), 'failingOnFixedHere': env_failing, 'passingOnlyWithFixOutsideItsTests': other, 'fixFiles': sorted(fix_files), 'hiddenFiles': test_patch},
        }
        json.dump(task, open(os.path.join(out, 'task.json'), 'w'), indent=2, ensure_ascii=False)
        open(os.path.join(out, 'task.json'), 'a').write('\n')
        return tid, len(bug_tests), len(regression), env_failing, other
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--bugsinpy', required=True)
    ap.add_argument('--mirrors', required=True)
    ap.add_argument('--venvs', required=True)
    ap.add_argument('only', nargs='*')
    args = ap.parse_args()
    sel = json.load(open(os.path.join(HERE, 'selection.json')))
    prompts = json.load(open(os.path.join(HERE, 'prompts.json')))
    for project, bugs in sel['accepted'].items():
        for bug in bugs:
            if args.only and f'{project}-{bug}' not in args.only:
                continue
            print(*build(args, project, bug, prompts), flush=True)
