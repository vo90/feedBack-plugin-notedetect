const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { setup, flush } = require('./_guitar-profile-harness');
const fixture = require('./fixtures/input-calibration-v2.json');
let scope;
loadDetectionCore({sandboxBeforeRun(s) { scope = s; }});
const wait = async () => {};
const identity = {generation: 1, channel: 0, epoch: 7};
const tuning = fixture.quality.tuning;
const noise = fixture.quality.capture.noise;
const candidate = {gain: 2.5, silenceThreshold: .002};

// A coherent raw native source: 20 ms buckets and independent 4096 sample
// verification frames, using the same cursor/identity contract as Desktop.
function source(options = {}) {
    let sequence = 0, calls = 0, index = 0;
    const api = {kind: 'noise', mode: 'normal', stalled: false, changed: false, requests: [],
        async getInputCalibrationSnapshot(request = {}) {
            calls++; api.requests.push(request);
            const sr = options.sampleRate || 48000, bucket = sr / 50;
            if (options.warmup && calls <= options.warmup) return {running: true, ...identity, status: 'warming-up', complete: false};
            const windows = [];
            const count = request.verification ? 6 : 4;
            if (!api.stalled) for (let i = 0; i < count; i++) {
                const attack = index++ % 25 < 15;
                const peak = api.kind === 'noise' || options.silence ? .0001
                    : attack ? (api.kind === 'strong' ? .1 : .07) : .0001;
                windows.push({startSequence: sequence, endSequence: sequence + bucket, samples: bucket,
                    peak, rms: peak / 3, clippedSamples: 0, invalidSamples: 0});
                sequence += bucket;
            }
            const result = {version: 1, status: 'ready', running: true, ...identity,
                ...(api.changed ? {generation: 2} : {}), sampleRate: sr, sequence,
                oldestSequence: Math.max(0, sequence - sr * 2), complete: true, windows};
            if (request.verification) {
                const {context, gain, silencePeakThreshold} = request.verification;
                const string = context.notes[0].s, midi = scope._ndStandardMidiFor(context.arrangement, context.stringCount)[string] + context.offsets[string];
                const length = Math.max(4096, 2 ** Math.ceil(Math.log2(sr * .085)));
                if (sequence - (request.afterSequence || 0) < length) result.verification = {status: 'warming-up'};
                else {
                    const adjustedPeak = options.silence ? 0 : api.mode === 'soft' ? .0125 : .025;
                    result.verification = {status: 'ready', startSequence: sequence - length, endSequence: sequence,
                        gain, silencePeakThreshold, adjustedPeak, adjustedRms: adjustedPeak / 3,
                        rawPeak: adjustedPeak / gain, rawRms: adjustedPeak / gain / 3,
                        clippedSamples: 0, invalidSamples: 0, passesSilenceGate: adjustedPeak >= silencePeakThreshold,
                        pitch: {frequency: context.referencePitch * 2 ** ((midi - 69 + (options.semitones || 0)) / 12), confidence: .99},
                        result: {isHit: options.scorerMiss !== true, results: [{hit: options.scorerMiss !== true}]}};
                }
            }
            if (options.transform) options.transform(result, request, calls);
            return result;
        }};
    return api;
}
const summary = (peak, lone = false) => Array.from({length: 250}, (_, i) => ({samples: 960,
    peak: (lone ? i === 0 : i % 25 < 15) ? peak : .0001,
    rms: (lone ? i === 0 : i % 25 < 15) ? peak / 3 : .00003, clippedSamples: 0, invalidSamples: 0}));

test('raw capture waits for warm-up, counts fresh samples, and detects repeated normal attacks', async () => {
    const audio = source({warmup: 3});
    const quiet = await scope._ndCalV2Capture(audio, {kind: 'noise', wait});
    audio.kind = 'normal';
    const take = await scope._ndCalV2Capture(audio, {kind: 'normal', noise: quiet.summary, expected: quiet.identity, wait});
    assert.ok(take.summary.durationMs >= 5000);
    assert.ok(take.summary.attackCount >= 8);
    assert.equal(take.summary.clippedSamples, 0);
    assert.equal(take.summary.invalidSamples, 0);
});

test('lone attack, steady noise, dominant outlier, clipping and invalid samples are rejected', () => {
    assert.throws(() => scope._ndCalV2Summary(summary(.1, true), 48000, 'normal', noise), /three separate/);
    assert.throws(() => scope._ndCalV2Summary(summary(.0001), 48000, 'normal', noise), /three separate/);
    const outlier = summary(.03); outlier[0].peak = .9;
    assert.throws(() => scope._ndCalV2Summary(outlier, 48000, 'normal', noise), /unusually loud/);
    const clipped = summary(.99);
    assert.throws(() => scope._ndCalV2Summary(clipped, 48000, 'strong', noise), /clipped/);
    const invalid = summary(.1); invalid[0].invalidSamples = 1;
    assert.throws(() => scope._ndCalV2Summary(invalid, 48000, 'normal', noise), /Invalid audio/);
    assert.throws(() => scope._ndCalV2Summary(summary(.015), 48000, 'normal', {...noise, rmsP95: .002}), /close to the background noise/);
});

test('gain cap remains eligible for verification while noisy or inconsistent captures cannot propose gain', () => {
    const capture = JSON.parse(JSON.stringify(fixture.quality.capture));
    capture.normal.peakMax = capture.strong.peakMax = .012;
    assert.equal(scope._ndCalV2Candidate(capture).gain, 5);
    assert.equal(scope._ndCalV2Candidate(capture).capped, true);
    capture.noise.peakMax = .01;
    assert.throws(() => scope._ndCalV2Candidate(capture), /background noise/);
    capture.noise.peakMax = .0001; capture.normal.peakMax = .1;
    assert.throws(() => scope._ndCalV2Candidate(capture), /strong take was quieter/);
});

for (const kind of ['stalled', 'changed', 'gap', 'overflow', 'cancelled']) test(`raw capture rejects ${kind} input`, async () => {
    const audio = source({transform(s, request, calls) {
        if (calls < 3) return;
        if (kind === 'stalled') audio.stalled = true;
        if (kind === 'changed') s.epoch++;
        if (kind === 'gap' && s.windows.length) s.windows[0].startSequence++;
        if (kind === 'overflow') { s.status = 'overflow'; s.complete = false; }
    }});
    await assert.rejects(scope._ndCalV2Capture(audio, {kind: 'noise', wait,
        cancelled: () => kind === 'cancelled'}), /stopped|changed|incomplete|missed|cancelled/);
});

test('every supported string count and drop tuning uses exact integer notes and reference pitch', () => {
    for (const [instrument, counts] of [['guitar', [6, 7, 8]], ['bass', [4, 5, 6]]]) for (const count of counts) {
        const notes = scope._ndStandardMidiFor(instrument, count).slice(); notes[0] -= 2;
        assert.equal(scope._ndCalV2Tuning(instrument, count, notes, 432).openStringMidi[0], notes[0]);
    }
    assert.equal(scope._ndCalV2ParseNote('Db2'), 37);
    assert.ok(Number.isNaN(scope._ndCalV2ParseNote('D2.2')));
    assert.throws(() => scope._ndCalV2Tuning('guitar', 6, [39.5,45,50,55,59,64]), /Check/);
    assert.throws(() => scope._ndCalV2Tuning('guitar', 6, [40,45,50,55,59,64], 451), /Check/);
    assert.throws(() => scope._ndCalV2Tuning('bass', 4, [19,33,38,43]), /25–2000 Hz/);
});

for (const semitones of [-12, -1, 1, 12, 24]) test(`verification rejects wrong pitch ${semitones} semitones even with scorer hit`, async () => {
    await assert.rejects(scope._ndCalV2Verify(source({semitones}), {identity, tuning, candidate, string: 0, mode: 'normal', wait}), /not detected reliably/);
});
for (const sr of [8000, 16000, 32000, 48000, 96000, 192000]) test(`verification waits for whole independent frames at ${sr} Hz`, async () => {
    const audio = source({sampleRate: sr});
    const result = await scope._ndCalV2Verify(audio, {identity, tuning: {...tuning, referencePitchHz: 432}, candidate, string: 0, mode: 'normal', wait});
    assert.ok(result.frames >= 8); assert.ok(result.spanMs >= 800); assert.equal(result.medianCents, 0);
});
test('silence, phantom scorer miss and insufficient soft margin do not verify', async () => {
    await assert.rejects(scope._ndCalV2Verify(source({silence: true}), {identity, tuning, candidate, string: 0, mode: 'normal', wait}), /No reliable note/);
    await assert.rejects(scope._ndCalV2Verify(source({scorerMiss: true}), {identity, tuning, candidate, string: 0, mode: 'normal', wait}), /not detected reliably/);
    const audio = source(); audio.mode = 'soft';
    await assert.rejects(scope._ndCalV2Verify(audio, {identity, tuning, candidate: {...candidate, silenceThreshold: .01}, string: 0, mode: 'soft', wait}), /noise cutoff/);
});
test('soft playing must be softer than its normal reference and retain noise margin', async () => {
    const audio = source();
    const normal = await scope._ndCalV2Verify(audio, {identity, tuning, candidate, string: 0, mode: 'normal', wait});
    await assert.rejects(scope._ndCalV2Verify(audio, {identity, tuning, candidate, string: 0, mode: 'soft', normalCheck: normal, wait}), /more softly/);
    audio.mode = 'soft';
    const soft = await scope._ndCalV2Verify(audio, {identity, tuning, candidate, string: 0, mode: 'soft', normalCheck: normal, wait});
    assert.ok(soft.softThresholdMargin >= 2);
});
test('metadata matches the shared Core fixture, and incomplete evidence cannot save', () => {
    const q = fixture.quality;
    const m = {tuning: q.tuning, candidate: {gain: q.candidateGain, silenceThreshold: q.silenceThreshold}, capture: q.capture, checks: q.checks};
    assert.deepEqual(JSON.parse(JSON.stringify(scope._ndCalV2Metadata(m))), fixture);
    assert.throws(() => scope._ndCalV2Metadata({...m, checks: m.checks.slice(1)}), /every string/);
});
test('transient native copy contention retries the same freshness cursor for captures and checks', async () => {
    const audio = source(), original = audio.getInputCalibrationSnapshot;
    let count = 0;
    audio.getInputCalibrationSnapshot = async request => {
        if (++count % 4 === 0) return {running: true, ...identity, status: 'busy', complete: false};
        return original(request);
    };
    const quiet = await scope._ndCalV2Capture(audio, {kind: 'noise', wait});
    assert.ok(quiet.summary.durationMs >= 2000);
    const result = await scope._ndCalV2Verify(audio, {identity, tuning, candidate, string: 0, mode: 'normal', wait});
    assert.ok(result.passedFrames >= 6);
});
test('profile silence threshold requires verified matching gain, family and currently applied route', () => {
    const s = {loaded: true, applied: true, calibrated: true, activeType: 'guitar', calibrationStatus: 'verified',
        calibrationQuality: fixture.quality, gain: 2.5, silenceThreshold: .002};
    assert.equal(scope._ndProfileSilenceThreshold(s, 2.5), .002);
    for (const bad of [{loaded: false}, {applied: false}, {busy: true}, {error: 'route'}, {gain: 3},
        {calibrated: false}, {activeType: 'bass'}, {calibrationStatus: 'level-only'}, {silenceThreshold: .001}])
        assert.equal(scope._ndProfileSilenceThreshold({...s, ...bad}, 2.5), .02);
    assert.equal(scope._ndProfileSilenceThreshold(s, 3), .02);
    for (const level of [0, .0001, .00025, .00199])
        assert.equal(scope._ndIsSilentWindow([{songT: 1, level}], 1, .2, .002), true, 'measured noise remains silent at the verified floor');
    assert.equal(scope._ndIsSilentWindow([{songT: 1, level: .004}], 1, .2, .002), false, 'verified soft note clears the peak floor');
});

async function captureUi(s, audio) {
    s.overlay.querySelector('.nd-cal-next').onclick();
    for (const kind of ['noise', 'normal', 'strong']) {
        audio.kind = kind;
        await s.body.querySelector('.nd-cal-v2-capture').onclick(); await flush();
    }
    assert.match(s.body.innerHTML, /Check normal note/);
}
async function checkUi(s, audio, count = 6) {
    for (let string = 0; string < count; string++) for (const mode of ['normal', 'soft']) {
        audio.mode = mode;
        const button = s.body.querySelector('.nd-cal-v2-check');
        button.setAttribute('data-string', string); button.setAttribute('data-mode', mode);
        await button.onclick(); await flush();
    }
    assert.match(s.body.innerHTML, /Every string passed/);
}
test('real short wizard handlers verify every string and save only after explicit Save', async () => {
    const audio = source({warmup: 2}), s = setup({nativeV2: audio});
    s.state.activeType = 'guitar';
    await s.open(); assert.match(s.body.innerHTML, /Confirm the notes/);
    if (process.env.CALIBRATION_ARTIFACT_DIR) require('node:fs').writeFileSync(require('node:path').join(process.env.CALIBRATION_ARTIFACT_DIR, 'plugin-tuning.html'), s.body.innerHTML);
    await captureUi(s, audio); await checkUi(s, audio);
    if (process.env.CALIBRATION_ARTIFACT_DIR) require('node:fs').writeFileSync(require('node:path').join(process.env.CALIBRATION_ARTIFACT_DIR, 'plugin-review.html'), s.body.innerHTML);
    assert.equal(s.writes.length, 0); assert.equal(s.state.gain, 1.7); assert.deepEqual(s.nativeWrites, []);
    await s.body.querySelector('.nd-cal-v2-save').onclick();
    assert.equal(s.writes.length, 1); assert.equal(s.writes[0].metadata.quality.checks.length, 12);
    if (process.env.CALIBRATION_ARTIFACT_DIR) require('node:fs').writeFileSync(require('node:path').join(process.env.CALIBRATION_ARTIFACT_DIR, 'plugin-generated-calibration.json'), JSON.stringify(s.writes[0], null, 2));
    assert.match(s.body.innerHTML, /Verified input calibration saved/);
    s.det.destroy();
});
test('new quiet capture invalidates verified proposal, failed retry and stale Save callback cannot save it', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    await s.open(); await captureUi(s, audio); await checkUi(s, audio);
    const oldSave = s.body.querySelector('.nd-cal-v2-save').onclick;
    s.body.querySelector('.nd-cal-v2-restart').onclick(); audio.stalled = true;
    await s.body.querySelector('.nd-cal-v2-capture').onclick();
    await oldSave(); assert.equal(s.writes.length, 0); assert.equal(s.state.gain, 1.7);
    s.det.destroy();
});
test('draft wizard returns verified proposal without saving or changing the active instrument gain', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    const draft = await s.draft('bass');
    await captureUi(s, audio); await checkUi(s, audio, 4);
    await s.body.querySelector('.nd-cal-v2-save').onclick();
    const result = await draft.pending;
    assert.equal(result.metadata.quality.tuning.instrument, 'bass');
    assert.equal(result.metadata.quality.checks.length, 8);
    assert.equal(s.writes.length, 0); assert.equal(s.state.gain, 1.7); assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});
test('draft reference comes from its own instrument and cannot change during verified calibration', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    let bassReference = 432;
    s.sb.feedBack.workingTuning = {get: options => options?.instrument === 'bass'
        ? {instrument: 'bass', stringCount: 4, offsets: [0,0,0,0], referencePitch: bassReference}
        : {instrument: 'guitar', stringCount: 6, offsets: [0,0,0,0,0,0], referencePitch: 440}};
    const draft = await s.draft('bass');
    assert.match(s.body.innerHTML, /A4 = 432 Hz/);
    assert.doesNotMatch(s.body.innerHTML, /nd-cal-v2-reference/);
    await captureUi(s, audio); await checkUi(s, audio, 4);
    bassReference = 442;
    await s.body.querySelector('.nd-cal-v2-save').onclick();
    assert.match(s.body.innerHTML, /Reference pitch changed/);
    s.det.closeCalibrationWizard(); assert.equal(await draft.pending, null); assert.equal(s.writes.length, 0);
    s.det.destroy();
});
test('custom drop tuning selected in the real wizard drives native target and saved metadata', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    await s.open();
    const low = s.body.querySelectorAll('.nd-cal-v2-note')[0];
    low.value = 'D2'; low.oninput();
    await captureUi(s, audio); await checkUi(s, audio);
    await s.body.querySelector('.nd-cal-v2-save').onclick();
    assert.equal(s.writes[0].metadata.quality.tuning.openStringMidi[0], 38);
    assert.equal(s.writes[0].metadata.quality.tuning.label, 'Custom tuning');
    assert.ok(audio.requests.filter(r => r.verification?.context.notes[0].s === 0).every(r => r.verification.context.offsets[0] === -2));
    s.det.destroy();
});
test('named tuning chooser prefers Core exact integer MIDI catalog over frequency reconstruction', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    s.sb.feedBack.tunings = {get: () => ({referencePitch: 432,
        tuningMidis: {'guitar-6': {'Drop D': [38,45,50,55,59,64]}},
        tunings: {'guitar-6': {'Drop D': [1,2,3,4,5,6]}}})};
    await s.open();
    const select = s.body.querySelector('.nd-cal-v2-tuning'); select.value = '1'; select.onchange();
    assert.match(s.body.innerHTML, /value="D2"/);
    assert.match(s.body.innerHTML, /Drop D/);
    s.det.destroy();
});
test('route switch after verification blocks Save and closing in-flight capture cannot resurrect it', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    await s.open(); await captureUi(s, audio); await checkUi(s, audio);
    audio.changed = true;
    await s.body.querySelector('.nd-cal-v2-save').onclick();
    assert.equal(s.writes.length, 0); assert.match(s.body.innerHTML, /input changed/);
    s.det.closeCalibrationWizard();
    await s.open(); s.overlay.querySelector('.nd-cal-next').onclick();
    const pending = s.body.querySelector('.nd-cal-v2-capture').onclick(); s.det.closeCalibrationWizard(); await pending;
    assert.equal(s.writes.length, 0); s.det.destroy();
});
test('raw lease is kept alive while reading instructions and review, and changed identity clears evidence', async () => {
    const audio = source(), s = setup({nativeV2: audio});
    let clock = 0, lastRead = 0, epoch = identity.epoch;
    const read = audio.getInputCalibrationSnapshot;
    audio.getInputCalibrationSnapshot = async request => {
        if (clock - lastRead > 2000) epoch++;
        lastRead = clock;
        return {...await read(request), epoch};
    };
    audio.onSleep = async ms => {
        if (ms !== 1000) return;
        for (let i = 0; i < 5; i++) { clock += 200; await s.refreshWizard(); }
    };
    await s.open(); await captureUi(s, audio); await checkUi(s, audio);
    assert.ok(clock >= 45000, 'all three-second countdowns kept the two-second native lease alive');
    const reads = audio.requests.length;
    for (let i = 0; i < 30; i++) { clock += 200; await s.refreshWizard(); }
    assert.equal(audio.requests.length, reads + 30);
    assert.equal(epoch, identity.epoch, 'six seconds reviewing kept the original capture epoch');
    const save = s.body.querySelector('.nd-cal-v2-save').onclick;
    clock += 3000; await s.refreshWizard(); await save();
    assert.equal(s.writes.length, 0); assert.match(s.body.innerHTML, /input changed/);
    s.det.closeCalibrationWizard();
    const closed = audio.requests.length; await s.refreshWizard(); assert.equal(audio.requests.length, closed);
    s.det.destroy();
});
