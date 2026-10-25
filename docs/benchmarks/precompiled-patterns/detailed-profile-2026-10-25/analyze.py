import json,gzip,sys,collections
from pathlib import Path
root=Path(__file__).parent
for mode in sys.argv[1:] or ['eager','prepared']:
 d=json.load(gzip.open(root/f'{mode}.json.gz'));sy=json.load(gzip.open(root/f'{mode}.json.syms.json.gz'));t=d['threads'][0]
 w=json.load(gzip.open(root/f'{mode}-workload.json.gz'));st=t['stackTable'];ft=t['frameTable'];func=t['funcTable'];res=t['resourceTable'];strings=t['stringArray']
 libs={l['debug_name']:l for l in sy['data']}
 maps={k:{a:i for a,i in l['known_addresses']} for k,l in libs.items()}
 def name(frame):
  f=ft['func'][frame];r=func['resource'][f]
  if r is None or r<0: return strings[func['name'][f]]
  li=res['lib'][r]
  if li is None: return strings[func['name'][f]]
  ln=d['libs'][li]['debugName'];mp=maps.get(ln,{});a=ft['address'][frame]
  if a in mp and mp[a] is not None:
   return sy['string_table'][libs[ln]['symbol_table'][mp[a]]['symbol']]
  return ln+':'+strings[func['name'][f]]
 names=[name(f) for f in range(ft['length'])]
 flat=collections.Counter();inc=collections.Counter();groups=collections.Counter();ts=0;total=0
 for s,delta in zip(t['samples']['stack'],t['samples']['timeDeltas']):
  ts+=delta
  if d['meta']['startTime']+ts<w['steadyEpochMs'] or s is None: continue
  stack=[]
  while s is not None:
   stack.append(names[st['frame'][s]]);s=st['prefix'][s]
  if not stack:continue
  total+=1;flat[stack[0]]+=1;inc.update(set(stack))
  if any('portable::' in n for n in stack): groups['portable interpreter']+=1
  elif any('regex_automata::hybrid::' in n for n in stack): groups['regex-automata hybrid']+=1
  elif any('ferroni::' in n for n in stack): groups['other Ferroni']+=1
  elif any('ferriki_textmate::' in n for n in stack):groups['other TextMate']+=1
  else:groups['other']+=1
 out={'mode':mode,'samples':total,'groups':dict(groups),'self':[{'name':n,'samples':c,'percent':100*c/total} for n,c in flat.most_common(40)],'inclusive':[{'name':n,'samples':c,'percent':100*c/total} for n,c in inc.most_common(65)]}
 # Original summaries are retained as gzip files; analysis prints to stdout.
 print('\n',mode,total,'GROUPS',dict(groups))
 print('SELF');print('\n'.join(f'{100*c/total:5.1f}% {n}' for n,c in flat.most_common(20)))
 print('INCLUSIVE');print('\n'.join(f'{100*c/total:5.1f}% {n}' for n,c in [(n,c) for n,c in inc.most_common() if any(part in n for part in ['ferroni::','ferriki_','regex_automata::'])][:30]))
