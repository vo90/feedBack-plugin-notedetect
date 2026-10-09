const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function setup({ loaded = false, fetchError = false, loadError = false, deferred = false } = {}) {
    let sb, overlay, resolveFetch;
    const loads = [], commands = [], screens = [];
    const element = () => {
        const children = new Map();
        return {
            style: {}, dataset: {}, innerHTML: '', textContent: '', isConnected: true,
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener() {}, removeEventListener() {}, appendChild() {},
            setAttribute() {}, getAttribute() { return null; }, focus() {},
            remove() { this.isConnected = false; },
            querySelector(s) { if (!children.has(s)) children.set(s, element()); return children.get(s); },
            querySelectorAll() { return []; },
        };
    };
    const core = loadDetectionCore({ sandboxBeforeRun(s) {
        sb = s;
        s.setTimeout = () => 1;
        s.document = {
            querySelector() { return null; }, querySelectorAll() { return []; },
            getElementById() { return null; }, addEventListener() {},
            createElement: element, head: element(), body: element(),
        };
        s.document.body.appendChild = el => { if (el.className === 'nd-cal-wizard') overlay = el; };
        s.fetch = async () => {
            if (deferred) await new Promise(r => { resolveFetch = r; });
            return { ok: !fetchError, json: async () => ({ onboarding: { diagnostic_filename: 'diagnostics/test guitar.sloppak' } }) };
        };
        s.highway.getSongInfo = () => loaded ? { title: 'Current song' } : {};
        s.playSong = async (...args) => { loads.push(args); if (loadError) throw Error('<load failed>'); };
        s.showScreen = name => screens.push(name);
        s.slopsmith.capabilities = { dispatch: async command => { commands.push(command); return { outcome: 'handled' }; } };
    } });
    const det = core.createNoteDetector({ isDefault: false });
    det.openCalibrationWizard();
    for (let step = 0; step < 6; step++) overlay.querySelector('.nd-cal-next').onclick();
    det._harness.setEnabled(true);
    const body = overlay.querySelector('.nd-cal-body');
    return { sb, det, overlay, body, loads, commands, screens, resolveFetch: () => resolveFetch(),
        start: timed => body.querySelector(timed ? '.nd-cal-start-playalong' : '.nd-cal-minimize-play').onclick() };
}

test('timed calibration from Home loads diagnostic and retains wizard until actual playback', async () => {
    const s = setup();
    await s.start(true);
    assert.equal(decodeURIComponent(s.loads[0][0]), 'diagnostics/test guitar.sloppak');
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), true, 'song wrapper must preserve timing wizard');
    assert.equal(s.overlay.querySelector('.nd-cal-return-primary').textContent, 'Waiting for song playback');
    s.sb.slopsmith._fire('song:play');
    assert.equal(s.overlay.querySelector('.nd-cal-return-primary').textContent, 'Timing test: 30s left');
    s.overlay.querySelector('.nd-cal-return-wizard').onclick();
    assert.match(s.body.innerHTML, /Partial window captured/);
    s.det.destroy();
});

test('manual Play Song from Home opens diagnostic and retains return control', async () => {
    const s = setup();
    await s.start(false);
    assert.equal(s.loads.length, 1);
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), true);
    s.overlay.querySelector('.nd-cal-return-wizard').onclick();
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), false);
    assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /Timing/);
    s.det.destroy();
});

test('an existing song is resumed without replacing or reloading it', async () => {
    const s = setup({ loaded: true });
    await s.start(true);
    assert.equal(s.loads.length, 0);
    assert.deepEqual(s.screens, ['player']);
    assert.equal(s.commands[0].command, 'resume');
    s.det.destroy();
});

test('failed diagnostic lookup stays in the wizard with a retry message', async () => {
    const s = setup({ fetchError: true });
    await s.start(true);
    assert.equal(s.loads.length, 0);
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), false);
    assert.match(s.body.innerHTML, /Could not find the built-in test song/);
    s.det.destroy();
});

test('failed song load restores the wizard and escapes error text', async () => {
    const s = setup({ loadError: true });
    await s.start(true);
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), false);
    assert.match(s.body.innerHTML, /&lt;load failed&gt;/);
    s.det.destroy();
});

test('closing during lookup prevents a late song load; repeated clicks do not duplicate it', async () => {
    const s = setup({ deferred: true });
    const pending = s.start(true);
    await s.start(true);
    s.det.closeCalibrationWizard();
    s.resolveFetch();
    await pending;
    assert.equal(s.loads.length, 0);
    s.det.destroy();
});

test('explicit Detect off still closes a minimized calibration wizard', async () => {
    const s = setup({ loaded: true });
    await s.start(false);
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), true);
    s.det.disable({ silent: true });
    assert.equal(s.det._hasCalibrationPlaybackHandoff(), false);
    assert.equal(s.overlay.isConnected, false);
    s.det.destroy();
});
