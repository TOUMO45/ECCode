import json,sys,glob,os,datetime
label=sys.argv[1]; out=sys.argv[2] if len(sys.argv)>2 else None
SID='e87b51e8-02b7-5a45-b2ca-652e788cc255'
files=glob.glob(f'/root/.claude/projects/*/{SID}.jsonl')+glob.glob(f'/root/.claude/projects/*/{SID}/subagents/*.jsonl')
msgs={}; latest=None
for f in files:
    main=f.endswith(SID+'.jsonl')
    for line in open(f):
        try:o=json.loads(line)
        except: continue
        if not isinstance(o,dict) or o.get('type')!='assistant': continue
        u=(o.get('message') or {}).get('usage')
        if not u: continue
        mid=o['message'].get('id') or o.get('uuid')
        msgs[mid]=u   # last record per message id wins (streamed duplicates)
        if main: latest=(u,o.get('timestamp'))
g=lambda u,k:u.get(k) or 0
t={'input':sum(g(u,'input_tokens') for u in msgs.values()),'cacheRead':sum(g(u,'cache_read_input_tokens') for u in msgs.values()),
   'cacheWrite':sum(g(u,'cache_creation_input_tokens') for u in msgs.values()),'output':sum(g(u,'output_tokens') for u in msgs.values()),'messages':len(msgs)}
t['allProcessed']=t['input']+t['cacheRead']+t['cacheWrite']+t['output']
t['ieq']=round(t['input']+0.1*t['cacheRead']+1.25*t['cacheWrite']+5*t['output'],1)
cr=g(latest[0],'cache_read_input_tokens') if latest else None
ctx=(g(latest[0],'input_tokens')+g(latest[0],'cache_read_input_tokens')+g(latest[0],'cache_creation_input_tokens')) if latest else None
snap={'label':label,'takenAt':datetime.datetime.utcnow().isoformat()+'Z','method':'inline arithmetic (python, read-only transcript parse); helper snapN.js not used','sources':files,
 'unit':'all-processed tokens + IEQ (ratio estimate; input + 0.1*cacheRead + 1.25*cacheWrite + 5*output)','total':t,
 'budget':{'cap':6000000,'pauseAt':4800000,'state':'HARD-STOP' if t['allProcessed']>=6000000 else 'PAUSE' if t['allProcessed']>=4800000 else 'below'},
 'cleanContextTest':{'latestMessageCacheRead':cr,'limit':250000,'result':'PASS' if cr is not None and cr<=250000 else 'FAIL'},
 'perMessageContext':{'latest':ctx,'limit':300000,'result':'PASS' if ctx is not None and ctx<=300000 else 'FAIL'},
 'dollarEstimate':'none','n':1}
s=json.dumps(snap,indent=2)
if out: open(out,'w').write(s+'\n')
print(s)
