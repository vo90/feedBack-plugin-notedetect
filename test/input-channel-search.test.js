const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../screen.js'), 'utf8');
// Run the actual standalone setup helpers, without booting the plugin UI.
const scope = {};
vm.runInNewContext(source.slice(0, source.indexOf('function _ndPresentationTime')), scope);
const scan = scope._ndScanInputChannels;
function fixture(count = 8, active = [6], opts = {}) {
    let reads = 0, phase = '', sequence = 0;
    const api = { getInputChannelSnapshot: async () => {
        ++reads;
        return { generation: opts.changed && reads > 35 ? 2 : 1,
            running: !(opts.unplug && reads > 35), selected: opts.selectionChanged && reads > 35 ? 0 : 3,
            sequence: opts.stalled ? 0 : ++sequence,
            channels: Array.from({ length: count }, (_, index) => ({ index, name: `Driver ${index + 1}`,
                peak: opts.noise ? 0.2 : phase.startsWith('Play') && active.includes(index) ? (opts.quiet ? 0.006 : 0.2) : 0.0001 })) };
    } };
    return { api, options: { wait: async () => {}, onPhase: p => phase = p }, reads: () => reads };
}
test('signal only on input 7 is found without selecting or saving a channel', async () => {
    const f = fixture(); const result = await scan(f.api, f.options);
    assert.deepEqual(Array.from(result.candidates, c => c.index), [6]);
    assert.equal(result.snapshot.selected, 3);
    assert.equal(scope._ndInputChannelLabel(result.candidates[0]), 'Input 7 — Driver 7');
});
test('last channel of a large interface, mono, stereo, and quiet DI signals', async () => {
    for (const [count, channel] of [[64,63], [1,0], [2,1]]) {
        const f = fixture(count, [channel], { quiet: true });
        assert.deepEqual(Array.from((await scan(f.api, f.options)).candidates, c => c.index), [channel]);
    }
});
test('several active channels remain choices; channel 2 has no special preference', async () => {
    const f = fixture(8, [0,1,6]);
    assert.deepEqual(Array.from((await scan(f.api, f.options)).candidates, c => c.index), [0,1,6]);
});
test('silence and steady noise do not become recommendations', async () => {
    for (const f of [fixture(8, []), fixture(8, [6], { noise: true })])
        assert.equal((await scan(f.api, f.options)).candidates.length, 0);
});
test('disconnect, route replacement, selection change, and stalled callbacks reject the result', async () => {
    for (const opts of [{ unplug: true }, { changed: true }, { selectionChanged: true }, { stalled: true }]) {
        const f = fixture(8, [6], opts);
        await assert.rejects(scan(f.api, f.options), /input changed|fresh input/);
    }
});
test('cancel stops sampling without altering the selected input', async () => {
    const f = fixture();
    await assert.rejects(scan(f.api, { ...f.options, cancelled: () => f.reads() >= 4 }), /cancelled/);
    assert.equal(f.reads(), 4);
});
