const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {loadDetectionCore}=require('./_loader'),{harmonicMix,midiToFreq}=require('./_signals');
const src=fs.readFileSync(path.join(__dirname,'../screen.js'),'utf8');
function fn(name) {
    const start=src.indexOf('function '+name+'('),open=src.indexOf('{',start);assert.ok(start>=0,name);
    let depth=0;for(let i=open;i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&--depth===0)return src.slice(start,i+1);}
}
const names=['_ndHarmonicContact','_ndContactDeadline','_ndContactSustainFret','_ndFrettedHarmonic','_ndNaturalPitchSemitones','_ndBarPayload'];
const h=new Function(names.map(fn).join('\n')+';return {'+names.map(n=>`${n}:${n}`).join(',')+'};')();
function note(){return {t:1,s:0,f:14,sus:2,harmonic_changes:{version:1,events:[
    {start:.15,end:2,target:{kind:'artificial',node:7,interval:19,policy:'harmonic'},source_id:'tie:1'}]}};}
test('contact has strict time boundary and composes the authored bend, including seeking',()=>{
    const n=note();n.bnv=[{t:.15,v:0},{t:.3,v:2},{t:2,v:2}];
    assert.equal(h._ndContactDeadline(n,1,.2,1),1.15);
    for(const [t,want] of [[0,null],[.15,14+12*Math.log2(3)],[.225,15+12*Math.log2(3)],
        [1,16+12*Math.log2(3)],[2.1,null],[.1,null]]) {
        const got=h._ndContactSustainFret(n,t);
        if(want===null)assert.equal(got,null);else assert.ok(Math.abs(got-want)<1e-9);
    }
    assert.equal(h._ndBarPayload(n,1.12).harmonic_changes,n.harmonic_changes);
    assert.ok(Math.abs(h._ndBarPayload(n,1.12).elapsed-.12)<1e-10);
});
test('actual browser scorer never credits a late contact as the original pick',()=>{
    const core=loadDetectionCore(),n=note();
    for(const elapsed of [.05,.149,.15,.2,1]) {
        n.elapsed=elapsed;
        const ordinary=harmonicMix(midiToFreq(54),[[1,.4],[2,.04]],48000,.35);
        const ah=harmonicMix(midiToFreq(54),[[3,.4],[6,.04]],48000,.35);
        const score=pcm=>core.scoreChord(pcm,48000,[n],'guitar',6,Array(6).fill(0),0,30,1);
        assert.equal(score(ordinary).isHit,elapsed<.15);
        assert.equal(score(ah).isHit,false);
        assert.equal(score(ah).totalStrings,1);
    }
});
test('a later timed slide moves held harmonic feedback without another picked target',()=>{
    const n=note();n.f=4;n.sus=8;n.sl=7;n.slide_interval={start:7.5,end:7.75};
    const e=n.harmonic_changes.events[0];e.start=2;e.end=8;
    e.target={kind:'artificial',node:5,interval:24,policy:'harmonic'};
    // Non-monotonic order covers backward seek/repeat. Elapsed time is chart
    // time, so playback speed does not change the expected fret at that time.
    for(const t of [7.75,2,7.625,7.5,8,7.6,1.99]) {
        const p=Math.max(0,Math.min(1,(t-7.5)/.25));
        const want=t<2?null:28+3*Math.pow(Math.sin(p*Math.PI/2),3);
        assert.equal(h._ndContactSustainFret(n,t),want);
    }
    assert.equal(h._ndContactDeadline(n,1,.2,4),3);
    const core=loadDetectionCore();
    const ordinary=harmonicMix(midiToFreq(44),[[1,.4],[2,.04]],48000,.35);
    const harmonic=harmonicMix(midiToFreq(71),[[1,.4],[2,.04]],48000,.35);
    for(const elapsed of [.05,1.999,2,7.5,7.75]) {
        const score=pcm=>core.scoreChord(pcm,48000,[{...n,elapsed}],'guitar',6,Array(6).fill(0),0,30,1);
        assert.equal(score(ordinary).isHit,elapsed<2);
        assert.equal(score(harmonic).isHit,false);
        assert.equal(score(harmonic).totalStrings,1);
    }
});
test('unsupported or malformed slide combinations do not move the contact target',()=>{
    const n=note();n.f=4;n.sl=7;n.slide_interval={start:1,end:2};
    for(const patch of [{sl:true},{sl:0},{sl:25},{slu:6},{slide_interval:{start:.1,end:2}},
        {slide_interval:{start:1,end:3}},{slide_interval:{start:1,end:2,extra:true}},
        {bnv:[{t:0,v:0}]},{bt:2},{slide_out:'up'},{whammy:{}},{ho:true},{vb:true},{tr:true}]) {
        assert.equal(h._ndContactSustainFret({...n,...patch},1.5),4+12*Math.log2(3));
    }
});
test('early, short and descending contact slides use the same bounded trajectory',()=>{
    for(const [f,sl,start,end] of [[4,7,.2,.201],[12,7,.2,1.9],[7,10,1.99,2]]) {
        const n={...note(),f,sl,slide_interval:{start,end}};
        const half=(start+end)/2,interval=12*Math.log2(3);
        assert.ok(Math.abs(h._ndContactSustainFret(n,half)-(f+(sl-f)*Math.SQRT1_2**3+interval))<1e-9);
        assert.equal(h._ndContactSustainFret(n,start),f+interval);
        assert.equal(h._ndContactSustainFret(n,end),sl+interval);
        assert.equal(h._ndContactSustainFret(n,.15),f+interval);
    }
});
test('sustain grace cannot cross a contact or accept the wrong octave/partial',()=>{
    const helpers=names.concat(['_ndScoringFret','_ndMidiFromStringFret','_ndStandardMidiFor','_ndPreciseHarmonic',
        '_ndNearestOctaveCents','_ndFoldOctaveCents']);
    // Execute the real held-feedback function with controlled detector output.
    const factory=new Function('helpers',`
        const {${names.join(',')}}=helpers;
        const _susActiveUntil=new Map(),NOTE_SUS_GRACE_MS=150,detectionConfidenceMin=.6,pitchTolerance=30;
        const currentArrangement='guitar',currentStringCount=6,tuningOffsets=Array(6).fill(0),capo=0;
        const _ndMidiFromStringFret=(s,f)=>40+f,_ndScoringFret=n=>n.f,_ndNearestOctaveCents=(a,b)=>(a-b)*100;
        let detectedMidi=54,detectedConfidence=1;
        ${fn('_sustainStillHeld')}
        return (n,t,midi)=>{detectedMidi=midi;return _sustainStillHeld('one',n,1,t);};
    `)(h);
    const n=note(),pitch=54+12*Math.log2(3);
    assert.equal(factory(n,1.1,54),true);
    assert.equal(factory(n,1.15,54),false);
    assert.equal(factory(n,1.2,pitch-12),false);
    assert.equal(factory(n,1.2,pitch),true);
    assert.equal(factory(n,1.05,pitch),false); // backwards seek clears grace
    assert.equal(factory(n,1.05,54),true);
});
