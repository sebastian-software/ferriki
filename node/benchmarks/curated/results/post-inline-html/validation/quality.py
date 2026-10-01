from pathlib import Path
import subprocess,os,json
root=Path('/private/tmp/ferriki-borrow-unescaped-html');out=Path('/private/tmp/ferriki-final-rounds/validation');out.mkdir(exist_ok=True)
steps=[]
commands=[('fmt',['cargo','fmt','--all','--check']),('clippy',['cargo','clippy','--workspace','--all-targets','--all-features','--locked','--','-D','warnings']),('tests',['cargo','test','--workspace','--all-features','--locked']),('rustdoc',['cargo','doc','--workspace','--no-deps','--all-features','--locked']),('deny',['cargo','deny','--all-features','--locked','check']),('adrs',['node','scripts/check-adrs.mjs'])]
for label,args in commands:
 print(label+' started',flush=True)
 extra={'RUSTDOCFLAGS':'-D warnings'} if label=='rustdoc' else {}
 with (out/(label+'.log')).open('w') as log:r=subprocess.run(args,cwd=root,env=os.environ|{'RUST_MIN_STACK':'268435456'}|extra,stdout=log,stderr=subprocess.STDOUT,timeout=900)
 steps.append({'label':label,'command':args,'exitCode':r.returncode,'environment':extra});(out/'checks.json').write_text(json.dumps(steps,indent=2)+'\n');assert r.returncode==0,label
 print(label+' passed',flush=True)
