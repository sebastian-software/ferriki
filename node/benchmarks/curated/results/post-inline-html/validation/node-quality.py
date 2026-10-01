from pathlib import Path
import subprocess,os,json,hashlib
root=Path('/private/tmp/ferriki-borrow-unescaped-html');out=Path('/private/tmp/ferriki-final-rounds/validation');steps=[]
def run(label,args,cwd=root,extra=None):
 print(label+' started',flush=True)
 with (out/(label+'.log')).open('w') as log:r=subprocess.run(args,cwd=cwd,env=os.environ|(extra or {}),stdout=log,stderr=subprocess.STDOUT,timeout=900)
 steps.append({'label':label,'command':args,'exitCode':r.returncode,'environment':extra or {}});(out/'node-checks.json').write_text(json.dumps(steps,indent=2)+'\n');assert r.returncode==0,label
 print(label+' passed',flush=True)
assert not os.environ.get('CARGO_TARGET_DIR');assert not os.environ.get('FERRIKI_FERRONI_PATH')
extra={'CARGO_TARGET_DIR':'/private/tmp/ferriki-final-rounds/target-directory-check','CARGO_PROFILE_RELEASE_DEBUG':'line-tables-only','CARGO_PROFILE_RELEASE_STRIP':'none'}
run('custom-target',['node','node/ferriki/scripts/build-native.mjs'],extra=extra)
receipt=json.loads((root/'node/ferriki/.benchmark-build.json').read_text());lib=Path(extra['CARGO_TARGET_DIR'])/'release/libferriki_core.dylib';h=hashlib.sha256(lib.read_bytes()).hexdigest();assert receipt['binarySha256']==h;assert receipt['cargoProfileEnv']=={k:v for k,v in extra.items() if k.startswith('CARGO_PROFILE_')};assert receipt['ferriki']['status']==''
for name in ['node/ferriki/ferriki.node','node/ferriki/dist/ferriki.node','node/ferriki/dist/ferriki.darwin-arm64.node','node/platforms/darwin-arm64/ferriki.node']:assert hashlib.sha256((root/name).read_bytes()).hexdigest()==h
(out/'custom-target-build.json').write_text(json.dumps(receipt,indent=2)+'\n')
run('core-compat',['pnpm','run','test:ferriki-compat:core'],root/'node')
receipt=json.loads((root/'node/ferriki/.benchmark-build.json').read_text());measured=json.loads(Path('/private/tmp/ferriki-final-rounds/escaping/candidate-build.json').read_text());assert receipt['cargoProfileEnv']=={};assert receipt['binarySha256']==measured['binarySha256'];assert receipt['rustSourceSha256']==measured['rustSourceSha256'];assert receipt['ferriki']['status']==''
(out/'ordinary-final-build.json').write_text(json.dumps(receipt,indent=2)+'\n');(out/'ordinary-runtime-identity.json').write_text(json.dumps({'sameBinaryAsMeasuredCandidate':True,'sameRustSourceAsMeasuredCandidate':True,'measuredCommit':measured['ferriki']['commit'],'finalCommit':receipt['ferriki']['commit'],'binarySha256':receipt['binarySha256']},indent=2)+'\n')
for label,args in [('curated',['node','scripts/check-bench-curated.mjs']),('format',['pnpm','run','format:check']),('lint',['pnpm','run','lint']),('typecheck',['pnpm','run','typecheck'])]:run(label,args,root/'node')
