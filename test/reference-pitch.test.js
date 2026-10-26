const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadDetectionCore} = require('./_loader');
const {sine, harmonicMix} = require('./_signals');

const core = loadDetectionCore();
const offsets = Array(6).fill(0);
const hz = (midi, reference) => reference * 2 ** ((midi - 69) / 12);

test('pitch conversion and string bands use the selected reference', () => {
    for (const reference of [430, 440, 450]) {
        for (const midi of [28, 40, 64, 69, 88]) {
            assert.ok(Math.abs(core.freqToMidi(hz(midi, reference), reference) - midi) < 1e-9);
        }
        const [low, high] = core.stringBandHz(5, 'guitar', 6, offsets, 2, reference);
        assert.ok(Math.abs(low - hz(66, reference) * .9) < 1e-9);
        assert.ok(Math.abs(high - hz(90, reference) * 1.1) < 1e-9);
    }
    assert.equal(core.freqToMidi(440), 69);
});

for (const reference of [430, 450]) {
    test(`ordinary note verification uses A=${reference} without widening pitch tolerance`, () => {
        const pcm = sine(hz(69, reference), 48000, .35);
        const args = [pcm, 48000, 5, 5, 'guitar', 6, offsets, 0, 20, .03, null, null];
        assert.equal(core.constraintCheckString(...args, reference).hit, true);
        assert.equal(core.constraintCheckString(...args, 440).hit, false);
        const score = core.scoreChord(pcm, 48000, [{s: 5, f: 5}], 'guitar', 6, offsets, 0, 20, 1, reference);
        assert.equal(score.isHit, true);
        assert.ok(Math.abs(score.results[0].centsError) < 5);
        assert.equal(core.scoreChord(sine(hz(70, reference), 48000, .35), 48000,
            [{s: 5, f: 5}], 'guitar', 6, offsets, 0, 20, 1, reference).isHit, false);
    });

    test(`natural and fretted harmonics retain their reference at A=${reference}`, () => {
        const cases = [
            {note: {s: 5, f: 12, hm: true, hps: 12}, base: 64},
            {note: {s: 5, f: 5, harmonic_target: {kind: 'tapped', node: 12, interval: 12, policy: 'harmonic'}}, base: 69},
        ];
        for (const {note, base} of cases) {
            const pcm = harmonicMix(hz(base, reference), [[2, .3], [4, .08]], 48000, .35);
            assert.equal(core.scoreChord(pcm, 48000, [note], 'guitar', 6, offsets, 0, 20, 1, reference).isHit, true);
            assert.equal(core.scoreChord(pcm, 48000, [note], 'guitar', 6, offsets, 0, 20, 1, 440).isHit, false);
            assert.equal(core.scoreChord(new Float32Array(pcm.length), 48000, [note], 'guitar', 6, offsets, 0, 20, 1, reference).isHit, false);
        }
    });
}

test('omitting reference pitch preserves the existing A440 scorer results', () => {
    const pcm = harmonicMix(hz(69, 440), [[1, .4], [2, .1]], 48000, .35);
    const args = [pcm, 48000, [{s: 5, f: 5}], 'guitar', 6, offsets, 0, 50, 1];
    assert.deepEqual(core.scoreChord(...args), core.scoreChord(...args, 440));
});
