#!/usr/bin/env python3
"""H-G1 selection, cheap gates M1-M5 (bench/protocols/2026-11-03-hg1.md section 4.1), applied in rank order.
usage: mgates.py <query-result.json> <clones dir> <out.jsonl> <rank> [<rank> ...]
No dependency is installed and no candidate code is executed: a blobless clone, git log/ls-tree/grep, line counts.
M3 is a judgement: this script only captures the repository's own words and some structural facts for it."""
import json, os, re, subprocess, sys, datetime

SINCE_ACTIVE = '2026-05-07'
SINCE_AUTHORS = '2025-11-03'
OSI = {'MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'GPL-3.0', 'GPL-2.0', 'LGPL-3.0', 'LGPL-2.1', 'AGPL-3.0', 'MPL-2.0', 'ISC', 'Unlicense', 'EPL-2.0', 'BSL-1.0', 'Zlib', 'GPL-3.0-only', 'AGPL-3.0-only'}
EXCLUDED_NAMES = {'mealie-recipes/mealie', 'ytdl-org/youtube-dl', 'psf/black', 'tornadoweb/tornado', 'nvbn/thefuck', 'tqdm/tqdm'}
SIZE_EXCL = re.compile(r'(^|/)(tests?|migrations?|alembic|docs?|examples?|scripts)/|(^|/)(test_[^/]*|conftest)\.py$')
WORDS = re.compile(r'\b(template|starter|boilerplate|cookiecutter|tutorial|course|example|demo|awesome|library|framework|extension)\b', re.I)
DB = re.compile(r'(DeclarativeBase|declarative_base\(|SQLModel\b.*table\s*=\s*True|tortoise|peewee|beanie|motor\.|pymongo|sqlite3|django\.db|from sqlalchemy|import sqlalchemy|databases\b|asyncpg|psycopg|redis)', re.I)


def run(cmd, cwd=None, timeout=600):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def main():
    qfile, clones, out = sys.argv[1:4]
    ranks = [int(x) for x in sys.argv[4:]]
    items = json.load(open(qfile))['items']
    os.makedirs(clones, exist_ok=True)
    for rank in ranks:
        it = items[rank - 1]
        name = it['full_name']
        rec = {'rank': rank, 'repo': name, 'stars': it['stargazers_count'], 'description': it.get('description'), 'gates': {}}
        d = os.path.join(clones, f'c{rank:02d}')
        try:
            if not os.path.isdir(d):
                rc, _, err = run(['git', 'clone', '-q', '--filter=blob:none', '--no-checkout', f'https://github.com/{name}.git', d])
                if rc != 0:
                    rec['error'] = 'clone failed: ' + err[-200:]
                    open(out, 'a').write(json.dumps(rec) + '\n'); continue
            head = run(['git', 'rev-parse', 'HEAD'], d)[1].strip()
            rec['pinned'] = head
            # M1
            files = run(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], d)[1].splitlines()
            lic_file = [f for f in files if re.match(r'^(LICEN[CS]E|COPYING)(\.[A-Za-z]+)?$', f.split('/')[-1]) and f.count('/') == 0]
            spdx = (it.get('license') or {}).get('spdx_id')
            rec['gates']['M1'] = {'pass': bool(spdx in OSI and lic_file), 'spdx': spdx, 'licenseFile': lic_file[:2], 'archived': it['archived'], 'fork': it['fork']}
            # M2
            last = run(['git', 'log', '-1', '--format=%cI', 'HEAD'], d)[1].strip()
            authors = set(run(['git', 'log', f'--since={SINCE_AUTHORS}', '--format=%aE', 'HEAD'], d)[1].split())
            ncommits = int(run(['git', 'rev-list', '--count', 'HEAD'], d)[1].strip() or 0)
            rec['gates']['M2'] = {'pass': last[:10] >= SINCE_ACTIVE and len(authors) >= 3 and ncommits >= 300, 'lastCommit': last, 'authorsSince': len(authors), 'commits': ncommits}
            # M4
            rec['gates']['M4'] = {'pass': name not in EXCLUDED_NAMES and not name.startswith('TOUMO45/')}
            # M5 (needs .py blobs)
            pyfiles = [f for f in files if f.endswith('.py')]
            nonscaf = [f for f in pyfiles if not SIZE_EXCL.search(f)]
            tests = [f for f in pyfiles if SIZE_EXCL.search(f) and re.search(r'(^|/)tests?/|(^|/)test_[^/]*\.py$|conftest\.py$', f)]
            m1m2m4 = all(rec['gates'][g]['pass'] for g in ('M1', 'M2', 'M4'))
            rec['pyFiles'] = len(pyfiles); rec['testFiles'] = len(tests)
            light = str(rank) in os.environ.get('MG_LIGHT', '').split(',')
            rec['light'] = light
            if m1m2m4 and not light:
                sd = os.path.join(clones, f's{rank:02d}')
                if not os.path.isdir(sd):
                    rc2, _, err2 = run(['git', 'clone', '-q', '--depth', '1', '--single-branch', f'https://github.com/{name}.git', sd], timeout=900)
                    if rc2 != 0:
                        raise RuntimeError('shallow clone failed: ' + err2[-200:])
                d = sd
                lines = 0
                for f in nonscaf:
                    try:
                        with open(os.path.join(d, f), 'rb') as fh:
                            lines += fh.read().count(b'\n')
                    except OSError:
                        pass
                rec['gates']['M5'] = {'pass': 10000 <= lines <= 60000, 'lines': lines}
                # facts for M3
                g = run(['git', 'grep', '-l', '-E', r'FastAPI\(', '--', '*.py'], d)[1].splitlines()
                rec['fastapiAppFiles'] = [x for x in g if not re.search(r'(^|/)(tests?|docs?|examples?)/', x)][:6]
                dbhits = run(['git', 'grep', '-l', '-i', '-E', DB.pattern, '--', '*.py'], d)[1].splitlines()
                rec['dbFiles'] = len([x for x in dbhits if not re.search(r'(^|/)(tests?|docs?|examples?)/', x)])
                readme = next((f for f in files if re.match(r'^README(\.[a-z]+)?$', f, re.I)), None)
                if readme:
                    txt = open(os.path.join(d, readme), encoding='utf-8', errors='replace').read()
                    h1 = next((l.strip() for l in txt.splitlines() if l.startswith('#') or l.strip().startswith('<h1')), '')
                    rec['readmeTitle'] = h1[:160]
                    rec['readmeWords'] = sorted(set(m.group(1).lower() for m in WORDS.finditer(txt[:3000])))
                rec['descriptionWords'] = sorted(set(m.group(1).lower() for m in WORDS.finditer(it.get('description') or '')))
        except Exception as e:  # keep the record, report the error
            rec['error'] = repr(e)[:300]
        open(out, 'a').write(json.dumps(rec, ensure_ascii=False) + '\n')
        g = rec['gates']
        print(f"{rank:2d} {name:48s} " + ' '.join(f"{k}={'ok' if v['pass'] else 'FAIL'}" for k, v in g.items()) + f"  lines={g.get('M5',{}).get('lines','-')} authors={g.get('M2',{}).get('authorsSince','-')} commits={g.get('M2',{}).get('commits','-')} err={rec.get('error','')}")


main()
