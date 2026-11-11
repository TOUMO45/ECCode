"""Scan the bare session transcript for any reference to the engine, the S3 record, the suite or the seed key."""
import json, re, sys, collections
pat = re.compile(r'(/home/user/ECCode|gf-s3|eccode-gf|review-probes|hidden-suite|s3-held|s3-bare-out|ECCODE_SEED_KEY|greenfield|docs/build|lib/greenfield)', re.I)
hits, tools = collections.Counter(), collections.Counter()
for line in open(sys.argv[1]):
    o = json.loads(line)
    if o.get('type') == 'assistant':
        for c in o['message'].get('content', []):
            if c.get('type') == 'tool_use':
                tools[c['name']] += 1
                for m in pat.findall(json.dumps(c['input'])): hits['tool_input:' + m] += 1
    if o.get('type') == 'user':
        for m in pat.findall(json.dumps(o.get('message', {}))): hits['tool_result:' + m.lower()] += 1
print('tools', dict(tools)); print('hits', dict(hits))
