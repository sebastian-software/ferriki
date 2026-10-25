"""Controlled native comparison; all timed processes use one private frozen cache.
Arguments: repository frozen-facade inputs transport-cache baseline-addon artifact-directory output [--prepared-only]
"""
import datetime,hashlib,json,os,shutil,statistics,subprocess,sys
from pathlib import Path
repo,facade,inputs,cache,baseline,root,output=map(Path,sys.argv[1:8])
worker=repo/'docs/benchmarks/precompiled-patterns/decoded-cache/reproduce.mjs'
workloads=json.loads(inputs.read_text());release=json.loads((facade/'assets/standard/release-manifest.json').read_text())
addons={'baseline':baseline,**{x:root/(x+'.node') for x in ['legacy','shared','mapped']}}
frozen=root/'frozen-cache';frozen.mkdir(exist_ok=True);(frozen/'decoded').mkdir(exist_ok=True)
# All seeding, integrity checks and receipt migration precede timed processes.
for f in cache.iterdir():
 if len(f.name)==64 and f.is_file() and not(frozen/f.name).exists():os.link(f,frozen/f.name)
roots=sorted({d['lang'] for w in workloads for d in w['documents']})
for lang in roots:
 meta=release['assets'][f'languages/{lang}.fkbc']['decoded'];source=cache/'decoded'/meta['sha256'];target=frozen/'decoded'/meta['sha256']
 data=source.read_bytes();assert len(data)==meta['size'];assert hashlib.sha256(data).hexdigest()==meta['sha256']
 if not target.exists():shutil.copy2(source,target)
 stamp=source.with_suffix('.verified')
 if stamp.exists():shutil.copy2(stamp,target.with_suffix('.verified'))
 target.chmod(0o444)
lanes=[(name,mode) for name in ['baseline','shared'] for mode in ['off','auto','eager','prepared']]+[('legacy','prepared'),('mapped','prepared')]
if '--prepared-only' in sys.argv[8:]: lanes=[(name,'prepared') for name in addons]

def run(scenario,lane):
 label,mode=lane
 child=subprocess.run(['node',str(worker),'--worker',str(facade/'index.mjs'),str(inputs),scenario,mode,str(frozen)],
  env={**os.environ,'FERRIKI_BENCH_ADDON':str(addons[label]),'FERRIKI_BENCH_FROZEN_CACHE':str(frozen)},capture_output=True,text=True,timeout=120,check=True)
 row=json.loads(child.stdout)
 expected=len({d['lang'] for w in workloads if w['id']==scenario for d in w['documents']}) if label=='mapped' and mode=='prepared' else 0
 assert row['diagnostics'].get('mappedPreparedArchives',0)==expected,row['diagnostics']
 return row

for workload in workloads:
 run(workload['id'],('baseline','prepared'))
 run(workload['id'],('mapped','prepared'))
rows=[]
for repeat in range(5):
 for index,w in enumerate(workloads):
  offset=(repeat+index)%len(lanes)
  for label,mode in lanes[offset:]+lanes[:offset]:
   row={'label':label,'repeat':repeat,**run(w['id'],(label,mode))};rows.append(row)
   print(f"{row['scenario']} {label} {mode} #{repeat}: setup={row['setupMs']:.2f} firstHTML={row['startupMs']:.2f} warm={statistics.median(row['warmMs']):.2f}",flush=True)
summary=[]
for w in workloads:
 selected=[r for r in rows if r['scenario']==w['id']];assert all(r['outputHashes']==selected[0]['outputHashes'] for r in selected)
 for label,mode in lanes:
  group=[r for r in selected if r['label']==label and r['mode']==mode]
  summary.append({'scenario':w['id'],'label':label,'mode':mode,'n':len(group),
   **{k:statistics.median(r[k] for r in group) for k in ['importMs','setupMs','firstMs','startupMs']},
   'warmMs':statistics.median(sorted(r['warmMs'])[len(r['warmMs'])//2] for r in group)})
output.write_text(json.dumps({'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'binarySha256':{k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in addons.items()},
 'inputsSha256':hashlib.sha256(inputs.read_bytes()).hexdigest(),
 'releaseManifestSha256':hashlib.sha256((facade/'assets/standard/release-manifest.json').read_bytes()).hexdigest(),
 'frozenRoots':roots,'decodedBytes':sum(release['assets'][f'languages/{x}.fkbc']['decoded']['size'] for x in roots),
 'node':subprocess.check_output(['node','--version'],text=True).strip(),'summary':summary,'rows':rows},indent=2)+'\n')
