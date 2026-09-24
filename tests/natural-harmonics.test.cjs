const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../screen.js'),'utf8');
function fn(name){
    const start=source.indexOf('function '+name+'('),open=source.indexOf('{',start);
    assert.ok(start>=0,name);let depth=0;
    for(let i=open;i<source.length;i++){
        if(source[i]==='{')depth++;
        else if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);
    }
    throw Error(name);
}
const names=['_ndStandardMidiFor','_ndNaturalPitchSemitones','_ndPreciseHarmonic','_ndFrettedHarmonic','_ndScoringFret','_ndMidiFromStringFret',
    '_ndNextPow2','_ndFftInPlace','_ndFftMagnitude','_ndParabolicOffset','_ndCheckNaturalHarmonic'];
const h=new Function(source.match(/^const _ND_TUNING_.+$/gm).join('\n')+
    '\nlet _ndFftInterleavedScratch=null,_ndFftMagnitudesScratch=null,_ndFftScratchSize=0;\n'+
    names.map(fn).join('\n')+'\nreturn {'+names.join(',')+'};')();

test('explicit targets leave the identity and legacy fallback untouched',()=>{
    const n=Object.freeze({f:3,hm:true,hn:3.2,hps:31});
    assert.equal(h._ndScoringFret(n),12*Math.log2(6));assert.equal(n.f,3);
    assert.equal(h._ndScoringFret({f:7,hm:true}),7);
    assert.equal(h._ndScoringFret({f:3,hm:false,hps:31}),3);
});
for(const bass of [false,true])for(const capo of [0,2])for(const drop of [0,-2])
test(`synthetic audio: ${bass?'bass':'guitar'}, capo ${capo}, detune ${drop}`,()=>{
    const strings=bass?4:6,arrangement=bass?'bass':'guitar';
    for(const played of [31,34,3,19,43,-1]){
        const midi=(bass?28:40)+capo+drop+played,hz=440*2**((midi-69)/12);
        const samples=Float32Array.from({length:16384},(_,i)=>played<0?0:
            .2*Math.sin(2*Math.PI*hz*i/48000)+.04*Math.sin(4*Math.PI*hz*i/48000));
        const spectrum=h._ndFftMagnitude(samples,48000);
        const total=spectrum.magnitudes.reduce((a,b)=>a+b*b,0);
        const result=h._ndCheckNaturalHarmonic(spectrum,total,{s:0,f:3,hm:true,hps:31},
            arrangement,strings,Array(strings).fill(drop),capo,50);
        assert.equal(result.hit,played===31,JSON.stringify({played,...result}));
    }
});

test('all explicit native chart payloads carry the target',()=>{
    const payloads=source.match(/hm: !!\w+\.hm,[^\n]*/g);
    assert.equal(payloads.length,9);
    assert.ok(payloads.every(p=>p.includes('hps:')));
    assert.match(source,/mix\(_ndPreciseHarmonic\(nn\) \? nn.hps : -1\)/);
});

test('real partial frequencies pass the strict pitch gate on all guitar strings',()=>{
    const offsets=[12,19,24,28,31,34,36],bases=[40,45,50,55,59,64];
    for(let partial=2;partial<=8;partial++)for(let s=0;s<6;s++){
        const hz=partial*440*2**((bases[s]-69)/12);
        const samples=Float32Array.from({length:4096},(_,i)=>.2*Math.sin(2*Math.PI*hz*i/48000));
        const spectrum=h._ndFftMagnitude(samples,48000),total=spectrum.magnitudes.reduce((a,b)=>a+b*b,0);
        const result=h._ndCheckNaturalHarmonic(spectrum,total,{s,f:3,hm:true,hps:offsets[partial-2]},'guitar',6,Array(6).fill(0),0,20);
        assert.equal(result.hit,true,JSON.stringify({partial,s,...result}));
    }
});
