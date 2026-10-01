from pathlib import Path
import re,subprocess,json,hashlib
root=Path('/private/tmp/ferriki-final-rounds');lib=root/'profile-target/release/libferriki_core.dylib'
pattern=re.compile(r'\?\?\?  \(in ferriki.node\)  load address 0x[0-9a-f]+ \+ (0x[0-9a-f]+)  \[0x[0-9a-f]+\]')
paths=[root/(x+'.sample.txt') for x in ['cpp','css','toml','tsx']];addresses=sorted({m.group(1) for p in paths for m in pattern.finditer(p.read_text())},key=lambda x:int(x,16))
raw=subprocess.check_output(['atos','-o',str(lib),*addresses],text=True);symbols=subprocess.check_output(['rustfilt'],input=raw,text=True).splitlines();assert len(addresses)==len(symbols)
lookup=dict(zip(addresses,symbols));assert all('0x'!=s[:2] for s in symbols)
for p in paths:(p.parent/(p.stem+'.symbolized.txt')).write_text(pattern.sub(lambda m:lookup[m.group(1)],p.read_text()))
(root/'symbolization.json').write_text(json.dumps({'binarySha256':hashlib.sha256(lib.read_bytes()).hexdigest(),'relativeAddresses':len(addresses),'commands':['atos -o SYMBOLIZED_DYLIB RELATIVE_ADDRESSES','rustfilt'],'unresolved':sum('???' in s for s in symbols)},indent=2)+'\n')
print('Symbolized',len(addresses),'distinct native addresses')
