from pathlib import Path
import subprocess, os, json, shutil, hashlib
root=Path('/private/tmp/ferriki-remaining-five');out=Path('/private/tmp/ferriki-direct-html-perf')
paths=['Cargo.lock','node/ferriki/ferriki.node','node/ferriki/dist/ferriki.node','node/ferriki/dist/ferriki.darwin-arm64.node','node/platforms/darwin-arm64/ferriki.node','node/ferriki/.benchmark-build.json']
backup=out/'original-addon';backup.mkdir(exist_ok=False)
for i,p in enumerate(paths):shutil.copy2(root/p,backup/str(i))
(backup/'manifest.json').write_text(json.dumps(paths,indent=2)+'\n')
original_hashes=[hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]
roots={'control':'/private/tmp/ferriki-remaining-five','candidate':'/private/tmp/ferriki-direct-html'}
steps=[]
assert not {k:v for k,v in os.environ.items() if k.startswith('CARGO_PROFILE_') or k in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS']},'Unexpected benchmark build flags'
def run(label,args,env=None,public=False):
 print(label+' started',flush=True)
 with (out/(label+'.log')).open('w') as log:
  with (out/(label+'.stdout')).open('w') as stdout:
   result=subprocess.run(args,cwd=root,env=env,stdout=stdout if public else log,stderr=log,timeout=900)
 steps.append({'label':label,'command':args,'exitCode':result.returncode})
 (out/'public-steps.json').write_text(json.dumps(steps,indent=2)+'\n')
 if result.returncode:raise SystemExit(result.returncode)
 print(label+' complete',flush=True)
try:
 for variant,path in roots.items():
  print('build-'+variant+' started',flush=True)
  with (out/('build-'+variant+'-final.log')).open('w') as log:
   result=subprocess.run(['node','node/ferriki/scripts/build-native.mjs'],cwd=path,env=os.environ|{'FERRIKI_FERRONI_PATH':'/private/tmp/ferroni-remaining-five'},stdout=log,stderr=subprocess.STDOUT,timeout=900)
  shutil.copy2(out/(variant+'-original-Cargo.lock'),Path(path)/'Cargo.lock')
  assert result.returncode==0,'build-'+variant
  if Path(path)!=root:
   for p in paths[1:]:shutil.copy2(Path(path)/p,root/p)
  print('build-'+variant+' complete',flush=True)
  dest=out/(variant+'-addon');dest.mkdir()
  for i,p in enumerate(paths):shutil.copy2(root/p,dest/str(i))
  (dest/'manifest.json').write_text(json.dumps(paths,indent=2)+'\n')
  receipt=json.loads((root/paths[-1]).read_text())
  expected=subprocess.check_output(['git','rev-parse','HEAD'],cwd=path,text=True).strip()
  assert receipt['ferriki']['commit']==expected
  assert receipt['ferroni']['revision']['commit']=='e7ca9c42872687d6a0fde82b5a7e0a1c7cc71f13'
  assert receipt['ferroni']['revision']['status']=='',receipt['ferroni']['revision']['status']
  for p in paths[1:5]:assert hashlib.sha256((root/p).read_bytes()).hexdigest()==receipt['binarySha256']
  (out/(variant+'-build.json')).write_text(json.dumps(receipt,indent=2)+'\n')
  run('parity-'+variant,['node','node/scripts/check-bench-curated.mjs'])
 for label in ['control-1','candidate-1','candidate-2','control-2']:
  variant=label.split('-')[0];dest=out/(variant+'-addon')
  for i,p in enumerate(paths):shutil.copy2(dest/str(i),root/p)
  run('public-'+label,['node','node/scripts/bench-tiobe.mjs','--corpus','curated','--write',str(out/('public-'+label+'.json'))],public=True)
finally:
 for i,p in enumerate(paths):shutil.copy2(backup/str(i),root/p)
 assert [hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]==original_hashes
 (out/'addon-restoration.json').write_text(json.dumps({'restored':True,'paths':paths,'sha256':original_hashes},indent=2)+'\n')
 print('Original addon and Cargo.lock restored byte-for-byte',flush=True)
print('All direct HTML public matrices completed',flush=True)
