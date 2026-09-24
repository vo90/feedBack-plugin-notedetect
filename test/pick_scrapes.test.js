const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {loadDetectionCore} = require('./_loader');
const scrape = {t:1, s:0, f:34, mt:true, sus:2,
    pick_scrape_marks:[{direction:'down', start:0, end:2}]};
const ordinary = {t:1, s:1, f:7, sus:.5};

test('visual scrapes create neither success nor failure, including stale or injected judgments', () => {
    const core = loadDetectionCore(), det = core.createNoteDetector();
    const before = JSON.stringify(det.getStats());
    for (const hit of [true,false]) {
        det._recordJudgment('scrape', {note:scrape,hit,noteTime:1});
        det._recordJudgment('scrape_chord', {notes:[scrape,{...scrape,s:1}],chord:true,hit,noteTime:1});
    }
    assert.equal(JSON.stringify(det.getStats()),before);
    det._recordJudgment('normal', {note:ordinary,hit:true,noteTime:1});
    assert.equal(det.getStats().hits,1);
    assert.equal(det.getStats().score,50);
    det.destroy();
});

test('practice denominator ignores scrape-only events but retains a mixed chord once', () => {
    const src=fs.readFileSync(path.join(__dirname,'../screen.js'),'utf8');
    function fn(name) {
        const start=src.indexOf('function '+name+'('), open=src.indexOf('{',start);let depth=0;
        for(let i=open;i<src.length;i++){if(src[i]==='{')depth++;if(src[i]==='}'&&--depth===0)return src.slice(start,i+1);}
        throw Error(name);
    }
    const count=new Function('notes','chords',`
        const resolveHw=()=>({}), _ndChartNotes=()=>notes, _ndChartChords=()=>chords;
        ${fn('_ndIsVisualPickScrape')}${fn('_drillChartedCount')}
        return _drillChartedCount(0,3);`);
    assert.equal(count([scrape],[{t:1,notes:[scrape]}]),0);
    assert.equal(count([scrape,ordinary],[{t:1,notes:[scrape,ordinary]}]),2);
});

test('Desktop chart submission excludes visual scrapes and keeps the pitched mixed member', async () => {
    const charts=[];
    const audio={isAvailable:async()=>true,isAudioRunning:async()=>true,startAudio:async()=>{},
        getLevels:async()=>({inputLevel:0,inputPeak:0,outputLevel:0,outputPeak:0}),getSampleRate:async()=>48000,
        getPitchDetection:async()=>({midiNote:-1,confidence:0,frequency:-1,cents:0,noteName:''}),
        setChart:async chart=>{charts.push(chart);return true;},getNoteVerdicts:async()=>[]};
    const core=loadDetectionCore({sandboxBeforeRun(sb){
        sb.highway.getNotes=()=>[scrape];
        sb.highway.getChords=()=>[{t:2,notes:[scrape,ordinary]},{t:3,notes:[scrape]}];
        sb.highway.getTime=()=>0;sb.highway.getAvOffset=()=>0;
        sb.window.feedBackDesktop={isDesktop:true,platform:'linux',audio};
    }});
    const det=core.createNoteDetector({isDefault:false});
    await det.enable();for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
    assert.ok(charts.length);
    const notes=charts.at(-1).notes;
    assert.equal(notes.length,1);
    assert.equal(notes[0].t,2);
    det.destroy();
});
