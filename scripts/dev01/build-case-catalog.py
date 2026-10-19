"""One-off: build test/acceptance/case-catalog.json from the R8 revision text.
Usage: python3 scripts/dev01/build-case-catalog.py <path/to/r8.md>
Procedure/expected text is quoted from R8; nothing is invented. Run from repo root."""
import re, json, sys
from collections import Counter
t=open(sys.argv[1],encoding='utf-8').read()
m=json.load(open('test/milestone-manifest.json'))
entries=[]
def rows(a_marker,b_marker):
    a=t.index(a_marker); b=t.index(b_marker,a)
    out=[]
    for line in t[a:b].split('\n'):
        if line.startswith('|') and not line.startswith('|---'):
            out.append([c.strip() for c in line.strip().strip('|').split('|')])
    return out
def norm(i):
    i=i.split(' ')[0]
    mm=re.match(r'^(M[123])-(\d+)$',i)
    if mm: return f"{mm.group(1)}-{int(mm.group(2)):02d}"
    mm=re.match(r'^([A-Z]+)-?(\d+)$',i)
    if mm: return f"{mm.group(1)}-{int(mm.group(2)):02d}"
    return i
def add(id,family,mandatory,procedure,oracle,source):
    entries.append(dict(id=id,family=family,mandatoryFor=mandatory,procedure=procedure,evidenceOracle=oracle,source=source))
for cells in rows('### 10.6 Acceptance cases','### 10.6.1'):
    cid=cells[0].split(' ')[0]
    if re.match(r'^M[12]-\d\d$',cid):
        ms=cid[:2]
        if len(cells)==5:
            add(cid,ms,[ms],f"Preconditions: {cells[1]}. Steps: {cells[2]}.",f"Expected (exact): {cells[3]}. Bound: {cells[4]}. Evidence per R8 §10.6.",'R8 §10.6')
        else:
            add(cid,ms,[ms],cells[1],f"{cells[2]}. Bound/layer: {cells[3]}.",'R8 §10.6')
add('M2-20','M2',['M2'],'Deployed package downgrade / re-upgrade / restore per the R8 §10.6 M2-20 paragraph.','Fixture table/rollout semantic inventories at every checkpoint, zero resend for old unknown segments, restored chat answers, migration/reconciliation logs; mismatch or missing artifact fails/pends. Bound 30 min.','R8 §10.6 M2-20')
for cells in rows('### 6.3 Real-binary facts','### 6.4'):
    if re.match(r'^SB-\d+$',cells[0]): add(norm(cells[0]),'SB',['M1'],'Real-binary job: pinned codex 0.142.3 + mock Responses + NO_PROXY, isolated CODEX_HOME (test/real-binary/sb.real.test.ts).',f"Pass: {cells[1]}",'R8 §6.3')
add('SP-T1','SP',[],'thread/start.dynamicTools on 0.142.3: callable on turn 1, after thread/resume{config:{}}, after respawn + resume (test/real-binary/sb.real.test.ts#SP-T1).','Outcome A/B/C recorded with raw evidence; consequence per the §6.4 table (gates DEV-14 only).','R8 §6.4')
for cells in rows('### 6.5 Real-model spikes','### 6.6'):
    if re.match(r'^SR-\d+$',cells[0]): add(norm(cells[0]),'SR',['M1'],f"Class {cells[1]}: {cells[2]}",'Real-model evidence on the declared head/provider/model; scrubbed streams committed; missing evidence stays pending.','R8 §6.5')
for cells in rows('### 6.6 Real-Octo spikes','## 7.'):
    if re.match(r'^SO-\d+',cells[0]):
        for i in [norm(x.strip()) for x in cells[0].split('/')]:
            mand=['M1'] if i in m['M1']['requiredSpikes'] else (['M2'] if i in m['M2']['requiredSpikes'] else [])
            add(i,'SO',mand,cells[1],cells[2],'R8 §6.6')
dtext=t[t.index('**Deterministic duplicate/recovery cases'):t.index('**Per-case observability binding')]
for n in range(1,9):
    mm=re.search(rf'D{n} (.*?)(?=; D{n+1} |\. Add retry)',dtext,re.S)
    add(f'D-0{n}','D',['M2'],mm.group(1).strip(),'Deterministic DEV-09/10 CI result bound individually; fake clock; actual DDL; external model/egress attempt counts; expected states per §3.4.','R8 §10.6 D-cases')
mantext=t[t.index('DEV-09/10 golden cases `MAN-01..10`:'):]
for n,d in enumerate([x.strip() for x in mantext[mantext.index(':')+1:mantext.index('. Each asserts')].split(';')],1):
    add(f'MAN-{n:02d}','MAN',['M2'],d,'Asserts admitted fields, authored enabled/next_run_at/watermark/counters, run outcome and at most one consuming receipt across restart/pruning (§3.4.7).','R8 §3.4.7')
stext=t[t.index('DEV-09 `STAG-01..08` compares'):]
stags=[x for x in re.split(r', (?:and )?',stext[len('DEV-09 `STAG-01..08` compares '):stext.index(' against generated')]) if x]
if stags[-1].startswith('DST+offset and '): stags=stags[:-1]+['DST+offset', stags[-1][len('DST+offset and '):]]
assert len(stags)==8, stags
for n,d in enumerate(stags,1): add(f'STAG-{n:02d}','STAG',['M2'],d,'Compared against generated pinned-OC fixtures/checksums (test/goldens/oc/schedule.json).','R8 §3.4.8')
for cells in rows('### 10.6.1 Durable replay','### 10.6.2'):
    if re.match(r'^(REPLAY|BOUNDARY)-\d\d$',cells[0]): add(cells[0],cells[0].split('-')[0],['M2'],cells[1],cells[2],'R8 §10.6.1')
for cells in rows('### 10.6.2 Actual-DDL','**Executable document proof'):
    if re.match(r'^OP-\d\d$',cells[0]): add(cells[0],'OP',['M2'],cells[1],cells[2],'R8 §10.6.2')
otext=t[t.index('DEV-01 tester-rerunnable oracle fixtures `ORACLE-01..08`:'):]
ors=[x.strip() for x in otext[otext.index(':')+1:otext.index('. Negative controls')].split(';')]
assert len(ors)==8, ors
for n,d in enumerate(ors,1): add(f'ORACLE-{n:02d}','ORACLE',['M1','M2'],f"{d} (frozen trace test/oracle/fixtures/ORACLE-{n:02d}.json)",'Independent oracle verdict and violation codes match the fixture; defect fixtures carry a passing control trace (test/oracle/oracle.test.ts).','R8 §10.10')
for cells in rows('| Case | Fixture/steps | Required result |','**Concrete document golden v2'):
    if re.match(r'^RTN-\d\d$',cells[0]): add(cells[0],'RTN',['M3-conditional'],cells[1],cells[2],'R8 §10.11')
kindmap={'requiresGate':'gate','requiredSuites':'suite','requiredDiscoveriesConsumed':'discovery','requiredArtifacts':'artifact','dependencyBuilds':'build'}
seen=set()
for k,kind in kindmap.items():
    for ms in ['M1','M2']:
        for x in m[ms][k]:
            if x in seen: continue
            seen.add(x)
            mand=[q for q in ['M1','M2'] if x in m[q][k]]
            add(x,kind,mand,f'Named {kind} selected by R8 §10.9 ({k}); procedure defined by the R8 section that names it.','Passed only with independently re-runnable evidence on the verified head/profile (§10.8); missing evidence is pending.','R8 §10.9')
ids=[e['id'] for e in entries]
assert len(ids)==len(set(ids)), [i for i in ids if ids.count(i)>1]
print('entries',len(entries),dict(Counter(e['family'] for e in entries)))
json.dump({'revision':'R8','source':'Quoted from R8 §§3.4.7, 3.4.8, 6.3–6.6, 10.6, 10.6.1, 10.6.2, 10.9, 10.10, 10.11 by scripts/dev01/build-case-catalog.py','entries':entries},open('test/acceptance/case-catalog.json','w'),ensure_ascii=False,indent=2)
open('test/acceptance/case-catalog.json','a').write('\n')
