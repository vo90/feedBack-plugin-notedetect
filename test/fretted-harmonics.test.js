const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadDetectionCore}=require('./_loader');
const {harmonicMix,midiToFreq}=require('./_signals');
const h=loadDetectionCore();

for(const bass of [false,true]) for(const capo of [0,2]) for(const detune of [0,-2])
for(const [kind,policy] of [['pinch','harmonic'],['artificial','harmonic'],['tapped','harmonic'],['semi','mixed'],['feedback','attack_either']])
test(`${kind}, ${bass?'bass':'guitar'}, capo=${capo}, tuning=${detune}`,()=>{
    const n={s:0,f:7,sus:3,harmonic_target:{kind,node:12,interval:12,policy}};
    const hz=midiToFreq((bass?28:40)+capo+detune+7),count=bass?4:6;
    for(const [label,partials,accept] of [
        ['selected',[[2,.4],[4,.08]],true],
        ['bright selected',[[2,.2],[4,.4]],true],
        ['semi mix',[[1,.4],[2,.3],[4,.05]],policy!=='harmonic'],
        ['ordinary',[[1,.4],[2,.04],[3,.02]],policy==='attack_either'],
        ['bright ordinary',[[1,.4],[2,.22],[3,.18],[4,.12]],policy==='attack_either'],
        ['other partial',[[3,.4],[6,.08]],false],
        ['silence',[],false]]) {
        const pcm=harmonicMix(hz,partials,48000,.35);
        const got=h.scoreChord(pcm,48000,[n],bass?'bass':'guitar',count,Array(count).fill(detune),capo,50,1);
        assert.equal(got.results[0].hit,accept,JSON.stringify({label,got}));
        assert.equal(got.totalStrings,1);
        assert.equal(got.results[0].f,7);
        if (accept && label.includes('ordinary')) assert.equal(got.results[0].targetFret,7);
    }
});

test('explicit target cannot silently use ordinary scoring after malformed metadata',()=>{
    const pcm=harmonicMix(midiToFreq(47),[[1,.4]],48000,.35);
    const n={s:0,f:7,harmonic_target:{kind:'semi',node:12,interval:12,policy:'unscored'}};
    assert.equal(h.scoreChord(pcm,48000,[n],'guitar',6,Array(6).fill(0),0,50,1).isHit,false);
});

test('physical partials retain their own pitch in singles and mixed chords',()=>{
    const nodes=[12,7,5,4,3.2,14.7,2.4],intervals=[12,19,24,28,31,34,36];
    for(let p=2;p<=8;p++)for(const f of [3,12,17])for(const chord of [false,true]) {
        const n={s:0,f,harmonic_target:{kind:'tapped',node:nodes[p-2],interval:intervals[p-2],policy:'harmonic'}};
        const pcm=harmonicMix(midiToFreq(40+f),[[p,.3]],48000,.35);
        if(chord){const other=harmonicMix(midiToFreq(73),[[1,.15]],48000,.35);for(let i=0;i<pcm.length;i++)pcm[i]+=other[i];}
        const got=h.scoreChord(pcm,48000,chord?[n,{s:5,f:9}]:[n],'guitar',6,Array(6).fill(0),0,20,1);
        assert.equal(got.results[0].hit,true,JSON.stringify({p,f,chord,got}));
        assert.equal(got.totalStrings,chord?2:1);
        if(chord) {
            // Ordinary strings retain the existing band-peak scorer. In a
            // mixed spectrum it may hear the louder harmonic; this extension
            // must neither bypass that scorer nor invent another target.
            const baseline=h.scoreChord(pcm,48000,[{s:5,f:9}],'guitar',6,Array(6).fill(0),0,20,1);
            assert.equal(got.results[1].hit,baseline.results[0].hit);
        }
    }
});
