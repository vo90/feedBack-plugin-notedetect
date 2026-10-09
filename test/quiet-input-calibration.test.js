const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../screen.js'), 'utf8');
const scope = {};
vm.runInNewContext(source.slice(0, source.indexOf('function _ndPresentationTime')), scope);
function fixture(options = {}) {
    let reads = 0;
    return { getInputChannelSnapshot: async () => {
        ++reads;
        return { running: true, generation: options.changed && reads > 5 ? 2 : 1,
            selected: 6, sequence: options.stalled ? 1 : reads,
            channels: Array.from({ length: 8 }, (_, index) => ({ index, name: `USB ${index + 1}`,
                peak: index === 6 ? (typeof options.peak === 'function' ? options.peak(reads) : options.peak ?? 0.012) : 0.8 })) };
    } };
}
const wait = async () => {};
test('quiet input 7 is captured even with loud processed inputs 1/2', async () => {
    const result = await scope._ndCaptureSelectedInput(fixture(), { kind: 'signal', noisePeak: 0.00001, wait });
    assert.equal(result.samples.length, 20);
    assert.equal(result.samples[0].peak, 1.2);
    assert.equal(scope._ndGainForRawPeak(0.012), 5);
});
test('noise is measured without requiring a playing signal', async () => {
    const result = await scope._ndCaptureSelectedInput(fixture({ peak: 0.00001 }), { kind: 'noise', wait });
    assert.equal(result.samples.length, 20);
    assert.equal(result.samples[0].peak, 0.001);
});
test('silence cannot produce a gain recommendation', async () => {
    await assert.rejects(scope._ndCaptureSelectedInput(fixture({ peak: 0.00001 }), { kind: 'signal', wait }), /No clear playing signal/);
    for (const value of [0, 0.00001, NaN, Infinity]) assert.equal(scope._ndGainForRawPeak(value), null);
});
test('steady noise above the absolute floor is not mistaken for playing', async () => {
    await assert.rejects(scope._ndCaptureSelectedInput(fixture({ peak: 0.02 }), { kind: 'signal', noisePeak: 0.02, wait }), /No clear playing signal/);
});
test('device changes and stalled callbacks abort measurement', async () => {
    await assert.rejects(scope._ndCaptureSelectedInput(fixture({ changed: true }), { kind: 'signal', wait }), /input changed/);
    await assert.rejects(scope._ndCaptureSelectedInput(fixture({ stalled: true }), { kind: 'signal', wait }), /readings stopped/);
});
test('cancelling a capture prevents a late result', async () => {
    await assert.rejects(scope._ndCaptureSelectedInput(fixture(), { kind: 'signal', wait, cancelled: () => true }), /cancelled/);
});
test('gain stays within the existing range and lowers hot signals', () => {
    assert.equal(scope._ndGainForRawPeak(0.1), 2.5);
    assert.equal(scope._ndGainForRawPeak(0.5), 0.5);
    assert.equal(scope._ndGainForRawPeak(10), 0.1);
});
test('the initial attack is included rather than boosting against its decay', async () => {
    const result = await scope._ndCaptureSelectedInput(fixture({ peak: n => n === 2 ? 0.2 : 0.01 }), { kind: 'signal', wait });
    assert.equal(Math.max(...result.samples.map(s => s.peak)), 20);
});
