const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../screen.js'),'utf8');
function fn(name){const start=source.indexOf('function '+name+'('),open=source.indexOf('{',start);assert(start>=0,name);let depth=0;
 for(let i=open;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);}throw Error(name);}
const names=['_ndStandardMidiFor','_ndNaturalPitchSemitones','_ndPreciseHarmonic','_ndFrettedHarmonic','_ndScoringFret','_ndMidiFromStringFret',
 '_ndNextPow2','_ndFftInPlace','_ndFftMagnitude','_ndParabolicOffset','_ndCheckNaturalHarmonic','_ndCheckFrettedHarmonic',
 '_ndTotalEnergy','_ndBarSegment','_ndBarPitch','_ndBarPayload','_ndBarLimitation','_ndBarRangeLimitation','_ndScoreChord'];
const h=new Function(source.match(/^const _ND_TUNING_.+$/gm).join('\n')+
 '\nlet _ndFftInterleavedScratch=null,_ndFftMagnitudesScratch=null,_ndFftScratchSize=0;\n'+
 names.map(fn).join('\n')+'\nreturn {'+names.join(',')+'};')();
const bar=(v,g='beat@0')=>({version:1,policy:'optional',segments:[{start:0,end:2,source_id:'fixture:beat',group:g,curve:[{t:0,v},{t:2,v}]}]});
const signal=midis=>Float32Array.from({length:4096},(_,i)=>midis.reduce((s,m)=>{
 const hz=440*2**((m-69)/12);return s+.2*Math.sin(2*Math.PI*hz*i/48000)+.04*Math.sin(4*Math.PI*hz*i/48000);},0));
for(const bass of [false,true])for(const capo of [0,2])for(const tuning of [0,-2])
test(`bar alternatives ${bass?'bass':'guitar'} capo ${capo} tuning ${tuning}`,()=>{
 for(const fret of [0,7,12,24])for(const shift of [-16,-8,-2,-.5,0,.5,2,8])for(const harmonic of [false,true]) {
  const n={s:0,f:fret,sus:2,elapsed:.05,whammy:bar(shift)};
  if(harmonic)n.harmonic_target={kind:'tapped',node:12,interval:12,policy:'harmonic'};
  const original=(bass?28:40)+capo+tuning+fret+(harmonic?12:0);
  for(const played of [0,shift,shift-12,shift+12,-999]) {
   const result=h._ndScoreChord(signal(played===-999?[]:[original+played]),48000,[n],bass?'bass':'guitar',bass?4:6,Array(bass?4:6).fill(tuning),capo,35,1);
   const excluded=original+Math.min(0,shift)<22;
   assert.equal(result.isHit,!excluded&&(played===0||played===shift),JSON.stringify({fret,shift,harmonic,played,result}));
   assert.equal(result.totalStrings,excluded?0:1);assert.equal(result.results[0].f,fret);
   if(excluded)assert.equal(result.results[0].exclusionReason,'bar_pitch_below_verified_range');
  }
 }
});
test('a shared bar cannot mix incompatible chord states',()=>{
 const a={s:0,f:12,sus:2,whammy:bar(-4)},b={s:2,f:13,sus:2,whammy:bar(-4)};
 for(const [p,expected] of [[[52,63],true],[[48,59],true],[[48,63],false],[[50,61],false],[[],false]]) {
  const r=h._ndScoreChord(signal(p),48000,[a,b],'guitar',6,[0,0,0,0,0,0],0,30,1);assert.equal(r.isHit,expected,JSON.stringify(r));
 }
});
test('source curves, timing and deterministic limitations',()=>{
 const n={whammy:bar(0),t:5,sus:2};n.whammy.segments[0].curve=[{t:0,v:0},{t:1,v:-4},{t:2,v:0}];
 assert.equal(h._ndBarPitch(n,.5),-2);assert.equal(h._ndBarPitch(n,1.5),-2);assert.equal(h._ndBarPitch(n,3),0);
 assert.equal(h._ndBarPayload(n,5.25).elapsed,.25);assert.equal(h._ndBarLimitation(n),null);
 n.whammy.segments[0].vibrato='wide';assert.equal(h._ndBarLimitation(n),'bar_vibrato_without_exact_pitch');
 // No live detector state is part of capability classification.
 assert.equal(h._ndBarLimitation({...n,detectedConfidence:1}),h._ndBarLimitation({...n,detectedConfidence:0}));
});
test('visual-only results keep denominators stable and never earn automatic credit',()=>{
 const n={s:0,f:12,sus:2,whammy:bar(0)};
 n.whammy.segments[0].curve=[];n.whammy.segments[0].vibrato='wide';
 for(const played of [[],[52]]) {
  const r=h._ndScoreChord(signal(played),48000,[n],'guitar',6,[0,0,0,0,0,0],0,30,0);
  assert.equal(r.isHit,false);assert.equal(r.totalStrings,0);assert.equal(r.score,0);
  assert.equal(r.results[0].exclusionReason,'bar_vibrato_without_exact_pitch');
 }
});
