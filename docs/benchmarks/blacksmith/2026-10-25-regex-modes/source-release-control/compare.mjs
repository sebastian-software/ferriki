import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const [root,tag,rank]=process.argv.slice(2);
const {loadCorpus,loadCases,statistics}=await import(pathToFileURL(`${root}/node/scripts/tiobe-benchmark.mjs`));
const {standardGrammarRegistrations,standardThemeRegistrations}=await import(pathToFileURL(`${root}/node/scripts/standard-grammar-reference.mjs`));
const oldPath='/private/tmp/ferriki-source-regression-1.1.2/published/package/ferriki.node';
const newPath=`${root}/node/ferriki/ferriki.node`;
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
if(!rank){
 const languages=[];
 for(const language of loadCorpus('curated').languages){
  const child=spawnSync(process.execPath,[process.argv[1],root,tag,String(language.rank)],{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  assert.equal(child.status,0,child.stderr||child.error?.message);
  languages.push(JSON.parse(child.stdout));
  console.error(language.name,'passed');
 }
 const report={purpose:'Local diagnostic of released 1.1.2 versus repository source modes, not a toolchain-controlled Ferroni comparison',tag,measuredAt:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,oldBinarySha256:hash(readFileSync(oldPath)),currentBuild:JSON.parse(readFileSync(`${root}/node/ferriki/.benchmark-build.json`)),languages};
 writeFileSync(`/private/tmp/ferriki-source-regression-1.1.2/${tag}.json`,JSON.stringify(report,null,2));
}else{
 const require=createRequire(import.meta.url),old=require(oldPath),current=require(newPath);
 assert.equal(old.ferrikiVersion(),'1.1.2');
 const language=loadCorpus('curated').languages.find(l=>l.rank===Number(rank));
 const grammars=standardGrammarRegistrations([language.textmate,...(language.embedded??[])]);
 const lanes={oldOff:old.createHighlighter({regexPrefilter:false}),oldAuto:old.createHighlighter({regexPrefilter:true}),currentOff:current.createHighlighter({regexMode:'off'}),currentAuto:current.createHighlighter({regexMode:'auto'}),currentEager:current.createHighlighter({regexMode:'eager'})};
 const options={lang:language.textmate,theme:'github-dark'};
 for(const h of Object.values(lanes)){
  for(const grammar of grammars)h.loadCustomGrammar(JSON.stringify(grammar));
  h.loadCustomTheme(JSON.stringify(standardThemeRegistrations(['github-dark'])[0]));
 }
 const cases=[];
 for(const {code,...identity} of loadCases(language,['example','large'],'curated')){
  const expected=lanes.currentAuto.codeToHtml(code,options);
  for(const h of Object.values(lanes))assert.equal(h.codeToHtml(code,options),expected);
  for(let round=0;round<5;round++)for(const h of Object.values(lanes))h.codeToHtml(code,options);
  const ids=Object.keys(lanes),samples=Object.fromEntries(ids.map(id=>[id,[]])),spent=Object.fromEntries(ids.map(id=>[id,0]));
  let consumed=0;
  for(let round=0;round<1000 && ids.some(id=>samples[id].length<30||spent[id]<300);round++){
   for(let offset=0;offset<ids.length;offset++){
    const id=ids[(round+offset)%ids.length],before=performance.now();
    const html=lanes[id].codeToHtml(code,options),elapsed=performance.now()-before;
    consumed+=html.length;samples[id].push(elapsed);spent[id]+=elapsed;
   }
  }
  cases.push({...identity,htmlSha256:hash(expected),consumed,results:Object.fromEntries(ids.map(id=>[id,statistics(samples[id],identity.bytes)]))});
 }
 const diagnostics=Object.fromEntries(['currentOff','currentAuto','currentEager'].map(id=>[id,JSON.parse(lanes[id].getRegexDiagnosticsJson())]));
 for(const h of Object.values(lanes))h.dispose();
 console.log(JSON.stringify({name:language.name,textmate:language.textmate,grammarSha256:hash(JSON.stringify(grammars)),diagnostics,cases}));
}
