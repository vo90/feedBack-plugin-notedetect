// Scoring must follow the DISPLAYED difficulty, not the 100% chart (feedback#226).
//
// The highway filters the chart by the mastery slider, but getNotes()/getChords()
// still return every note in the full chart. Scoring the raw arrays retires notes
// that were never drawn as misses, so playing a lower difficulty perfectly still
// tanks the score. hw.getFilteredNotes()/getFilteredChords() are the "as drawn"
// view; every scoring path now reads the chart through _ndChartNotes/_ndChartChords,
// which prefer them and fall back to the raw arrays when they're absent (older core)
// or inactive (single-difficulty song, so the highway returns the raw arrays anyway).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Four charted notes; the mastery slider only draws the two on t=1 and t=3.
const FULL = [
    { s: 0, f: 1, t: 1.0, sus: 0 },
    { s: 1, f: 2, t: 2.0, sus: 0 },
    { s: 2, f: 3, t: 3.0, sus: 0 },
    { s: 3, f: 4, t: 4.0, sus: 0 },
];
const DISPLAYED = [FULL[0], FULL[2]];

// `filtered: null` models a core with no getFilteredNotes at all (downlevel).
function engineSandbox({ filtered, stableReferences = false }) {
    const calls = { getNoteVerdicts: 0, getPitchDetection: 0, hashMixes: 0 };
    const charts = [];              // every chart handed to setChart
    const intervalCallbacks = [];
    let live = filtered;            // mutable — tests move the slider mid-session
    let chordsFn = () => [];        // mutable — tests swap chord voicings mid-session

    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => {
            calls.getPitchDetection++;
            return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
        },
        setChart: async (chart) => { charts.push(chart); return true; },
        harmonicTargetVersion: async () => 1,
        whammyVersion: async () => 1,
        getNoteVerdicts: async () => { calls.getNoteVerdicts++; return []; },
    };

    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.Math = Object.create(Math);
            sb.Math.imul = (...args) => { calls.hashMixes++; return Math.imul(...args); };
            sb.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sb.highway.getNotes = () => FULL.map((n) => ({ ...n }));
            sb.highway.getChords = () => chordsFn();
            if (live !== null) {
                sb.highway.getFilteredNotes = () => stableReferences ? live : live.map((n) => ({ ...n }));
                sb.highway.getFilteredChords = () => chordsFn();
            }
            sb.highway.getTime = () => 0;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return {
        createNoteDetector, calls, charts, intervalCallbacks,
        setDisplayed: (notes) => { live = notes; },
        setChords: (fn) => { chordsFn = fn; },
        lastChart: () => charts[charts.length - 1],
    };
}

async function driveDetectTick(intervalCallbacks, calls) {
    for (const cb of intervalCallbacks) {
        const before = calls.getNoteVerdicts + calls.getPitchDetection;
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
        if (calls.getNoteVerdicts + calls.getPitchDetection > before) return cb;
    }
    return null;
}

// Chart notes carry `t`; compare on that. Array.from (not .map) so the result is
// built in THIS realm — an array mapped from the vm's array carries the vm's
// Array.prototype, and deepStrictEqual compares prototypes.
const times = (chart) => Array.from(chart.notes || [], (n) => n.t).sort((a, b) => a - b);

test('engine verifier is given only the notes the highway actually draws', async () => {
    const env = engineSandbox({ filtered: DISPLAYED });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const chart = env.lastChart();
    assert.ok(chart, 'a chart should have been pushed to the engine');
    assert.deepEqual(times(chart), [1.0, 3.0],
        'the engine must score the displayed notes only — not the notes the mastery '
        + 'slider filtered out (feedback#226)');

    det.destroy();
    await flushPendingAsync();
});

test('a single-difficulty song (no filtered getters) still scores the whole chart', async () => {
    const env = engineSandbox({ filtered: null });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 3.0, 4.0],
        'with no difficulty filter available the full chart is the displayed chart');

    det.destroy();
    await flushPendingAsync();
});

test('moving the mastery slider mid-song re-pushes the reduced chart', async () => {
    const env = engineSandbox({ filtered: FULL });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 3.0, 4.0], 'starts at full difficulty');

    // Slider down: the highway now draws two notes. _ndChartSignature() is built
    // from the filtered chart, so it diverges and the detect loop re-pushes.
    env.setDisplayed(DISPLAYED);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 3.0],
        'lowering the difficulty must re-push the reduced chart, or the engine keeps '
        + 'scoring notes that are no longer on screen');

    det.destroy();
    await flushPendingAsync();
});

test('a difficulty change that keeps the same note COUNT still re-pushes', async () => {
    // The trap: the signature used to be counts + first/last onset. Swap which
    // notes are displayed while holding the count (and the first/last onset)
    // fixed and the signature was identical — so the engine kept scoring notes
    // that were no longer on screen, which is the very bug this PR fixes.
    const before = [FULL[0], FULL[1], FULL[3]];   // t = 1, 2, 4
    const after = [FULL[0], FULL[2], FULL[3]];    // t = 1, 3, 4  — same count, same ends
    const env = engineSandbox({ filtered: before });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 4.0]);

    env.setDisplayed(after);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 3.0, 4.0],
        'the chart signature must hash note identity, not just the note count — '
        + 'a same-count difficulty change still swaps which notes are on screen');

    det.destroy();
    await flushPendingAsync();
});

test('a note that gains a sustain or a technique at the same fret still re-pushes', async () => {
    // Difficulty ladders don't just add notes — they change them. The same note at
    // the same string/fret can become a sustain, or gain a bend, further up. The
    // engine is sent sus + technique flags, so the signature must hash them or it
    // keeps verifying the old ones.
    const plain = [{ s: 0, f: 1, t: 1.0, sus: 0 }];
    const sustained = [{ s: 0, f: 1, t: 1.0, sus: 2.0, b: true }];
    const env = engineSandbox({ filtered: plain });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    assert.equal(env.lastChart().notes[0].sus, 0, 'starts as a staccato note');

    env.setDisplayed(sustained);
    await detectTick();
    await flushPendingAsync();

    const pushed = env.lastChart().notes[0];
    assert.equal(pushed.sus, 2.0, 'the sustain change must re-push');
    assert.equal(pushed.b, true, 'the technique change must re-push');

    det.destroy();
    await flushPendingAsync();
});

test('a chord VOICING swap at the same onset still re-pushes', async () => {
    // Same onset, same member count, different frets — the chord equivalent of
    // the same-count trap above. Hashing only (onset, memberCount) would miss it
    // and leave the engine verifying the old frets.
    const chordAt = (frets) => ({ t: 2.0, notes: frets.map((f, i) => ({ s: i, f, t: 2.0, sus: 0 })) });
    const env = engineSandbox({ filtered: [] });
    let voicing = chordAt([1, 1, 2]);
    env.setChords(() => [voicing]);

    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');

    const frets = () => Array.from(env.lastChart().notes || [], (n) => n.f).sort((a, b) => a - b);
    assert.deepEqual(frets(), [1, 1, 2], 'starts on the first voicing');

    voicing = chordAt([3, 3, 5]);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(frets(), [3, 3, 5],
        'the signature must hash each chord constituent\'s string/fret — a voicing '
        + 'swap at the same onset and member count must still re-push');

    det.destroy();
    await flushPendingAsync();
});

test('unchanged chart values reuse the signature even when getters return copies', async () => {
    const env = engineSandbox({ filtered: FULL });
    env.setChords(() => [{t: 5, notes: [{s: 0, f: 5}, {s: 1, f: 7}]}]);
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    const mixes = env.calls.hashMixes, pushes = env.charts.length;
    assert.ok(mixes > 0, 'the initial chart was hashed');
    for (let i = 0; i < 8; i++) await detectTick();
    assert.equal(env.calls.hashMixes, mixes, 'unchanged ticks do not repeat FNV mixing');
    assert.equal(env.charts.length, pushes, 'unchanged chart is not resent');
    det.destroy();
});

test('same-array note edits, membership swaps and chord member edits invalidate immediately', async () => {
    const notes = [{s: 0, f: 1, t: 1, sus: 0}, {s: 1, f: 2, t: 2, sus: 0}];
    const chords = [{t: 3, notes: [{s: 0, f: 3}, {s: 1, f: 5}]}];
    const env = engineSandbox({filtered: notes, stableReferences: true});
    env.setChords(() => chords);
    const det = env.createNoteDetector({isDefault: false});
    await det.enable();
    await flushPendingAsync();
    const tick = await driveDetectTick(env.intervalCallbacks, env.calls);
    for (const change of [
        () => { notes[0].sus = 2; notes[0].b = true; },
        () => { notes[1] = {s: 2, f: 4, t: 2, sus: 0}; },
        () => { chords[0].notes[1].f = 7; },
        () => { chords[0].t = 3.5; },
        () => { chords[0].notes.push({s: 2, f: 9}); },
        () => { notes.splice(0, 1); },
    ]) {
        const pushes = env.charts.length;
        change();
        await tick();
        assert.equal(env.charts.length, pushes + 1, 'an in-place change repushes on the next tick');
    }
    assert.equal(env.lastChart().notes.find(n => n.s === 1 && n.t === 3.5).f, 7);
    det.destroy();
});

test('deep whammy and harmonic edits cannot hide behind stable object references', async () => {
    const note = {s: 0, f: 7, t: 1, sus: 2, whammy: {version: 1, policy: 'optional',
        segments: [{start: 0, end: 2, curve: [{t: 0, v: 0}, {t: 2, v: -1}]}]}};
    const harmonic = {s: 1, f: 5, t: 4, sus: 1,
        harmonic_target: {node: 12, interval: 12, kind: 'artificial', policy: 'harmonic'}};
    const env = engineSandbox({filtered: [note, harmonic], stableReferences: true});
    const det = env.createNoteDetector({isDefault: false});
    await det.enable();
    await flushPendingAsync();
    const tick = await driveDetectTick(env.intervalCallbacks, env.calls);
    let mixes = env.calls.hashMixes;
    await tick();
    assert.equal(env.calls.hashMixes, mixes, 'unchanged nested payloads reuse the signature');
    for (const change of [
        () => { note.whammy.segments[0].curve[1].v = -2; },
        () => { note.whammy.segments[0].curve.push({t: 1, v: -0.5}); },
        () => { note.whammy = {segments: note.whammy.segments, policy: 'optional', version: 1}; },
        () => { harmonic.harmonic_target.node = 7; harmonic.harmonic_target.interval = 19; },
        () => { note.whammy.segments[0].vibrato = true; },
        () => { delete note.whammy.segments[0].vibrato; },
        () => { note.pick_scrape_marks = [{start: 0, end: 1}]; },
        () => { note.pick_scrape_marks.length = 0; },
    ]) {
        const pushes = env.charts.length;
        change();
        await tick();
        assert.equal(env.charts.length, pushes + 1, 'nested/eligibility edits repush immediately');
    }
    assert.equal(env.lastChart().notes.find(n => n.t === 4).harmonic_target.interval, 19);
    det.destroy();
});

test('a chord-only difficulty falls back to chord constituents for A/V calibration', () => {
    // Filtering to chords-only used to leave the calibration sweep with an empty
    // note list, so _ndRunAutoCalibrate bailed with 'no notes' and never ran. It
    // must fall back to the chord constituents instead of skipping the take.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => ([{ s: 0, f: 1, t: 1.0, sus: 0 }]);
            sb.highway.getChords = () => ([]);
            sb.highway.getFilteredNotes = () => ([]);          // difficulty hides every single
            sb.highway.getFilteredChords = () => ([
                { t: 2.0, notes: [{ s: 0, f: 3 }, { s: 1, f: 3 }, { s: 2, f: 5 }] },
            ]);
        },
    });
    const anchors = core.createNoteDetector()._calibrationNotes();
    assert.equal(anchors.length, 3,
        'the three chord constituents are the only anchors on screen — calibration '
        + 'must use them rather than report an empty chart and skip');
    assert.deepEqual(Array.from(anchors, (n) => n.t), [2.0, 2.0, 2.0],
        'constituents are flattened onto the chord onset');
});

test('calibration still uses singles alone when the chart has them', () => {
    // The fallback must not widen the anchor set on a normal chart: the sweep was
    // tuned on monophonic onsets, and chord constituents are a last resort.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => ([{ s: 0, f: 1, t: 1.0, sus: 0 }]);
            sb.highway.getChords = () => ([
                { t: 2.0, notes: [{ s: 0, f: 3 }, { s: 1, f: 3 }] },
            ]);
        },
    });
    const anchors = core.createNoteDetector()._calibrationNotes();
    assert.deepEqual(Array.from(anchors, (n) => n.t), [1.0],
        'a chart with singles calibrates on the singles only — unchanged behaviour');
});

test('the training bundle labels the WAV with the DRAWN chart, and records the mastery', () => {
    // arrangement.json is the label for the take's audio, and the audio only
    // contains what the highway drew. Shipping the 100% chart asserts notes that
    // are not in the WAV — it teaches the detector to expect notes nobody played.
    // And because the phrase filter lives in the highway and no difficulty was
    // recorded, the drawn subset was NOT recoverable after the fact. It is now.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => FULL.map((n) => ({ ...n }));
            sb.highway.getChords = () => ([]);
            sb.highway.getFilteredNotes = () => DISPLAYED.map((n) => ({ ...n }));
            sb.highway.getFilteredChords = () => ([]);
            sb.highway.getMastery = () => 0.6;
            sb.highway.hasPhraseData = () => true;
        },
    });
    const snap = core.createNoteDetector()._trainingChartSnapshot();

    assert.deepEqual(Array.from(snap.notes, (n) => n.t), [1.0, 3.0],
        'the label must be the chart as DRAWN — the full chart would assert notes '
        + 'that are not in the recorded audio');
    assert.equal(snap.mastery, 0.6,
        'the mastery level must ride along, or a 60% take is indistinguishable from '
        + 'a 100% take of a sparser song and the dataset cannot be segmented');
    assert.equal(snap.hasPhraseData, true);
});

test('a song with no phrase data still ships the full chart as its label', () => {
    // No phrase data => no filtering was possible => the full chart IS the drawn
    // chart. has_phrase_data records that, so a consumer can tell this apart from
    // a filtered take rather than guessing.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => FULL.map((n) => ({ ...n }));
            sb.highway.getChords = () => ([]);
            sb.highway.hasPhraseData = () => false;
        },
    });
    const snap = core.createNoteDetector()._trainingChartSnapshot();
    assert.deepEqual(Array.from(snap.notes, (n) => n.t), [1.0, 2.0, 3.0, 4.0]);
    assert.equal(snap.hasPhraseData, false);
});

// A behavioural test can only cover the paths this vm can drive (no AudioContext
// stub → the browser scoring path can't be enabled here). This guards the rest:
// a scoring path that reads the raw chart directly is the whole bug, so no new
// one may appear. The allowlist is the reads that are deliberately NOT scoring.
test('no scoring path reads the unfiltered chart directly', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    const ALLOWED = [
        // Test hook: reports the RAW chart size, on purpose.
        '_calDebug:',
    ];
    const offenders = [];
    src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');           // strip trailing comments
        if (/^\s*\/\//.test(line)) return;                   // skip comment-only lines
        if (!/\b_?hw\.get(Notes|Chords)\s*\(\s*\)/.test(code)) return;
        // Compare on collapsed whitespace: the allowlist entries carry the source's
        // current double-spacing, and a formatter run that collapsed it would
        // otherwise turn every allowed read into a false offender and redden CI.
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        if (ALLOWED.some((a) => flat(line).includes(flat(a)))) return;
        offenders.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [],
        'read the chart through _ndChartNotes()/_ndChartChords() so scoring follows the '
        + 'displayed difficulty (feedback#226); if this read is genuinely not a scoring '
        + 'path, add it to ALLOWED above with a reason');
});
