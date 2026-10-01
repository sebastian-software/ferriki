from pathlib import Path
import subprocess,os,json,shutil,hashlib,sys
root=Path('/private/tmp/ferriki-post-html-base');candidate=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(exist_ok=True)
paths=['node/ferriki/ferriki.node','node/ferriki/dist/ferriki.node','node/ferriki/dist/ferriki.darwin-arm64.node','node/platforms/darwin-arm64/ferriki.node','node/ferriki/.benchmark-build.json'];backup=out/'original-addon';backup.mkdir();hashes=[hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]
for i,p in enumerate(paths):shutil.copy2(root/p,backup/str(i))
steps=[]
assert not {k:v for k,v in os.environ.items() if k.startswith('CARGO_PROFILE_') or k in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','FERRIKI_FERRONI_PATH','CARGO_TARGET_DIR']}
def run(label,args,cwd=root):
 print(label+' started',flush=True)
 with (out/(label+'.log')).open('w') as log:r=subprocess.run(args,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,timeout=900)
 steps.append({'label':label,'command':args,'exitCode':r.returncode});(out/'steps.json').write_text(json.dumps(steps,indent=2)+'\n');assert r.returncode==0,label
 print(label+' complete',flush=True)
try:
 for variant,path in [('control',root),('candidate',candidate)]:
  assert not subprocess.check_output(['git','status','--porcelain'],cwd=path,text=True).strip()
  lock=(path/'Cargo.lock').read_bytes()
  run('build-'+variant,['node','node/ferriki/scripts/build-native.mjs'],path)
  assert (path/'Cargo.lock').read_bytes()==lock
  dest=out/(variant+'-addon');dest.mkdir()
  for i,p in enumerate(paths):shutil.copy2(path/p,dest/str(i));shutil.copy2(path/p,root/p) if path!=root else None
  receipt=json.loads((path/paths[-1]).read_text());assert receipt['ferriki']['status']=='';assert receipt['ferroni']['version']=='1.8.0';assert receipt['ferroni']['source']=='registry+https://github.com/rust-lang/crates.io-index';(out/(variant+'-build.json')).write_text(json.dumps(receipt,indent=2)+'\n')
  run('parity-'+variant,['node','node/scripts/check-bench-curated.mjs'])
 for label in ['control-1','candidate-1','candidate-2','control-2']:
  dest=out/(label.split('-')[0]+'-addon')
  for i,p in enumerate(paths):shutil.copy2(dest/str(i),root/p)
  run('public-'+label,['node','node/scripts/bench-tiobe.mjs','--corpus','curated','--write',str(out/('public-'+label+'.json'))])
finally:
 for i,p in enumerate(paths):shutil.copy2(backup/str(i),root/p)
 assert [hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]==hashes
 (out/'restoration.json').write_text(json.dumps({'restored':True,'paths':paths,'sha256':hashes},indent=2)+'\n')
 print('Original baseline addon restored',flush=True)
