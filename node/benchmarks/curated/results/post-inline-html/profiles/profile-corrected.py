from pathlib import Path
import subprocess,os,json,time,shutil,hashlib
root=Path('/private/tmp/ferriki-post-html-base');out=Path('/private/tmp/ferriki-final-rounds');paths=['node/ferriki/ferriki.node','node/ferriki/dist/ferriki.node','node/ferriki/dist/ferriki.darwin-arm64.node','node/platforms/darwin-arm64/ferriki.node','node/ferriki/.benchmark-build.json'];backup=out/'corrected-profile-backup';backup.mkdir(exist_ok=False)
def build(label,env):
 print(label+' started',flush=True)
 with (out/(label+'.log')).open('w') as log:r=subprocess.run(['node','node/ferriki/scripts/build-native.mjs'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=900)
 assert r.returncode==0,label
 shutil.copy2(root/paths[-1],out/(label+'-receipt.json'));print(label+' completed',flush=True)
assert not {k:v for k,v in os.environ.items() if k.startswith('CARGO_PROFILE_') or k in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','FERRIKI_FERRONI_PATH']}
for i,p in enumerate(paths):shutil.copy2(root/p,backup/str(i))
hashes=[hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]
try:
 # The existing Node builder selects repoRoot/target even with CARGO_TARGET_DIR.
 # Select the separately compiled profile artifact explicitly and verify every copy.
 lib=out/'profile-target/release/libferriki_core.dylib'
 digest=hashlib.sha256(lib.read_bytes()).hexdigest()
 for target in paths[:-1]:shutil.copy2(lib,root/target)
 receipt=json.loads((root/paths[-1]).read_text())
 receipt['binarySha256']=digest
 receipt['profileEnvironment']={'CARGO_TARGET_DIR':str(out/'profile-target'),'CARGO_PROFILE_RELEASE_DEBUG':'line-tables-only','CARGO_PROFILE_RELEASE_STRIP':'none'}
 receipt['selectedArtifact']=str(lib)
 (root/paths[-1]).write_text(json.dumps(receipt,indent=2)+'\n')
 (out/'corrected-profile-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 for target in paths[:-1]:assert hashlib.sha256((root/target).read_bytes()).hexdigest()==digest
 print('Exact symbol-enabled artifact loaded and verified',flush=True)
 for lang in ['cpp','css','toml','tsx']:
  print(lang+' profile started',flush=True)
  with (out/(lang+'.profile.json')).open('w') as stdout,(out/(lang+'.profile.log')).open('w') as log:
   args=['node','node/scripts/profile-tiobe.mjs','--corpus','curated','--language',lang,'--size','large','--api','html','--seconds','20'];p=subprocess.Popen(args,cwd=root,stdout=stdout,stderr=log)
   try:
    deadline=time.monotonic()+30
    while 'Warm workload ready' not in (out/(lang+'.profile.log')).read_text():
     assert p.poll() is None,'Workload exited before ready'
     assert time.monotonic()<deadline,'Warmup timeout';time.sleep(.1)
    subprocess.run(['sample',str(p.pid),'10','1','-file',str(out/(lang+'.sample.txt'))],stdout=log,stderr=subprocess.STDOUT,timeout=30,check=True)
    assert p.wait(timeout=40)==0
   finally:
    if p.poll() is None:p.terminate();p.wait(timeout=10)
  print(lang+' profile completed',flush=True)
finally:
 for i,p in enumerate(paths):shutil.copy2(backup/str(i),root/p)
 assert [hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths]==hashes
 (out/'profile-restoration.json').write_text(json.dumps({'restored':True,'paths':paths,'sha256':hashes},indent=2)+'\n')
 print('Ordinary baseline addon restored',flush=True)
