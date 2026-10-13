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
    '_ndNextPow2','_ndFftInPlace','_ndFftMagnitude','_ndParabolicOffset','_ndCheckNaturalHarmonic','_ndCheckFrettedHarmonic','_ndHarmonicContact'];
const h=new Function(source.match(/^const _ND_TUNING_.+$/gm).join('\n')+
    '\nlet _ndFftInterleavedScratch=null,_ndFftMagnitudesScratch=null,_ndFftScratchSize=0;\n'+
    names.map(fn).join('\n')+'\nreturn {'+names.join(',')+'};')();
const fallback=Object.freeze({kind:'artificial',node:null,interval:24,policy:'harmonic',basis:'source-playback-fallback'});
const canonical={kind:'artificial',node:5,interval:24,policy:'harmonic'};
test('unknown touch position is explicit and does not change the held fret',()=>{
    const n=Object.freeze({s:4,f:10,harmonic_target:fallback});
    assert.equal(h._ndFrettedHarmonic(n),fallback);
    assert.equal(h._ndScoringFret(n),34);
    assert.equal(n.f,10);assert.equal(fallback.node,null);
    assert.equal(h._ndFrettedHarmonic({f:10,harmonic_target:canonical}),canonical);
    const bad=[{...fallback,node:0},{...fallback,node:5},{...fallback,node:undefined},
        {...fallback,kind:'tapped'},{...fallback,interval:12},{...fallback,interval:'24'},
        {...fallback,policy:'mixed'},{...fallback,basis:'unknown'},{...fallback,extra:1},
        {kind:'artificial',node:null,interval:24,policy:'harmonic'}];
    for(const harmonic_target of bad)assert.equal(h._ndFrettedHarmonic({f:10,harmonic_target}),null);
    for(const f of [-1,49,10.5,null,'10'])assert.equal(h._ndFrettedHarmonic({f,harmonic_target:fallback}),null);
    assert.equal(h._ndHarmonicContact({f:10,sus:1,harmonic_changes:{version:1,events:[
        {start:.2,end:1,source_id:'source:tie',target:fallback}]}}),null);
});
test('fallback targets score the known fourth partial, rejecting ordinary pitch, wrong partials and silence',()=>{
    for(const capo of [0,2])for(const drop of [0,-2])for(const played of [-1,0,12,19,24,28,36]){
        const hz=440*2**((59+10+capo+drop+played-69)/12);
        const samples=Float32Array.from({length:16800},(_,i)=>played<0?0:
            .3*Math.sin(2*Math.PI*hz*i/48000)+.03*Math.sin(4*Math.PI*hz*i/48000));
        const spectrum=h._ndFftMagnitude(samples,48000),total=spectrum.magnitudes.reduce((a,b)=>a+b*b,0);
        const n={s:4,f:10,harmonic_target:fallback};
        const result=h._ndCheckFrettedHarmonic(spectrum,total,n,'guitar',6,Array(6).fill(drop),capo,30);
        const known=h._ndCheckFrettedHarmonic(spectrum,total,{...n,harmonic_target:canonical},'guitar',6,Array(6).fill(drop),capo,30);
        assert.equal(result.hit,played===24,JSON.stringify({played,capo,drop,result}));
        assert.deepEqual(result,known);
    }
});
function bridgeHarness(){
    const alerts=[];
    return new Function('instanceRoot','document','const _ndHarmonicBridgeVersions=new WeakMap();let _ndHarmonicSupportBlocked=false;'+
        'async '+fn('_ndRequireHarmonicTargetSupport')+';return _ndRequireHarmonicTargetSupport;')(
        {querySelector:()=>null,appendChild:e=>alerts.push(e)}, {createElement:()=>({setAttribute(){}})});
}
test('old engines accept canonical targets but explicitly stop for the new fallback contract',async()=>{
    const requireSupport=bridgeHarness();
    for(const version of [1,2]){
        let calls=0;const bridge={harmonicTargetVersion:()=>{calls++;return version;}};
        await requireSupport(bridge,[{harmonic_target:canonical}]);
        if(version===1)await assert.rejects(requireSupport(bridge,[{harmonic_target:fallback}]),/updated FeedBack/);
        else await requireSupport(bridge,[{harmonic_target:fallback}]);
        assert.equal(calls,1,'one cached capability lookup per engine');
    }
    for(const version of [0,3,null,'2'])await assert.rejects(
        requireSupport({harmonicTargetVersion:()=>version},[{harmonic_target:fallback}]),/updated FeedBack/);
    await requireSupport({},[{f:10}]);
});
