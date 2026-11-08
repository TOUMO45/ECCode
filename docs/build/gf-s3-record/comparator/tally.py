import json, sys, re, xml.etree.ElementTree as ET
junit, cmap = sys.argv[1], json.load(open(sys.argv[2]))
res = {}
for tc in ET.parse(junit).getroot().iter('testcase'):
    name = re.sub(r'\[.*\]$', '', tc.get('name'))
    st = 'fail' if (tc.find('failure') is not None or tc.find('error') is not None) else ('skip' if tc.find('skipped') is not None else 'pass')
    res.setdefault(name, []).append(st)
passed, rows = 0, []
for ac in sorted(cmap, key=lambda k: int(k.split('-')[1])):
    tests = cmap[ac]; sts = [s for t in tests for s in res.get(t, ['missing'])]
    ok = bool(sts) and all(s == 'pass' for s in sts)
    passed += ok
    bad = [t for t in tests if any(s != 'pass' for s in res.get(t, ['missing']))]
    rows.append(f"{ac}: {'PASS' if ok else 'FAIL'} ({sts.count('pass')}/{len(sts)} cases)" + ('' if ok else f"  failing: {', '.join(bad)}"))
cases = [s for v in res.values() for s in v]
print('\n'.join(rows))
print(f"CRITERIA PASSED: {passed} of {len(cmap)} | cases: {cases.count('pass')} pass, {cases.count('fail')} fail, {cases.count('skip')} skip, total {len(cases)}")
