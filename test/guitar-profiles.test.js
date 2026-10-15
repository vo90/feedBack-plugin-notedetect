const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup({ profiles = true, browser = false, pendingReady = false, initialRunning = true } = {}) {
    let sb, overlay, panel, peak = 0.001, sequence = 0;
    let inputRunning = initialRunning, selected = initialRunning ? 0 : -1;
    const writes = [], nativeWrites = [], gainNodes = [], timers = new Map(), listeners = new Set(), intervals = [];
    let timerId = 0;
    const state = { activeId: 'default', activeName: 'Default', routeKey: 'interface:0', routeLabel: 'Interface · Input 1', gain: 1.7, revision: 1 };
    if (!initialRunning) { state.routeKey = ''; state.routeLabel = 'Start your audio input'; }
    let resolveReady;
    const service = {
        ready: pendingReady ? new Promise(resolve => { resolveReady = resolve; }) : Promise.resolve(), getSnapshot: () => ({ ...state }),
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        async captureContext() {
            if (!state.routeKey) throw Error('Start and select your audio input before calibrating.');
            return { profileId: state.activeId, activeName: state.activeName, routeKey: state.routeKey, routeLabel: state.routeLabel, revision: state.revision };
        },
        async saveGain(gain, context, metadata) {
            if (context.profileId !== state.activeId || context.routeKey !== state.routeKey || context.revision !== state.revision)
                throw Error('Guitar or input changed');
            writes.push({ gain, context, metadata });
            state.gain = gain; state.revision++;
            for (const listener of listeners) listener({ ...state });
            return { ...state };
        },
    };
    const element = () => {
        const children = new Map();
        return {
            style: {}, dataset: {}, innerHTML: '', textContent: '', isConnected: true, disabled: false,
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener() {}, removeEventListener() {}, appendChild() {}, contains() { return false; },
            setAttribute() {}, getAttribute() { return null; }, focus() {},
            remove() { this.isConnected = false; },
            querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
            querySelectorAll() { return []; },
        };
    };
    const core = loadDetectionCore({ sandboxBeforeRun(s) {
        sb = s;
        s.setTimeout = (fn, ms) => {
            const id = ++timerId;
            timers.set(id, fn);
            if (ms === 80 || ms === 1000) Promise.resolve().then(() => { if (timers.delete(id)) fn(); });
            return id;
        };
        s.clearTimeout = id => timers.delete(id);
        s.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
        s.document = {
            querySelector() { return null; }, querySelectorAll() { return []; },
            getElementById() { return null; }, addEventListener() {},
            createElement: element, head: element(), body: element(),
        };
        s.document.body.appendChild = el => {
            if (el.className === 'nd-cal-wizard') overlay = el;
            if (el.className?.startsWith('nd-settings-panel ')) panel = el;
        };
        s.localStorage.getItem = key => key === 'slopsmith_notedetect' ? JSON.stringify({ inputGain: 4, engineInputGain: 4, detectEnabled: false }) : null;
        if (profiles) s.feedBack = { guitarProfiles: service };
        if (browser) {
            const node = () => ({ connect() {}, disconnect() {}, channelCount: 1, gain: { value: 0 }, getFloatTimeDomainData() {} });
            s.AudioContext = class {
                sampleRate = 48000;
                destination = node();
                createMediaStreamSource() { return node(); }
                createGain() { const n = node(); gainNodes.push(n); return n; }
                createAnalyser() { return node(); }
                createScriptProcessor() { return node(); }
                close() { return Promise.resolve(); }
            };
            s.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [], getAudioTracks: () => [] });
        } else {
            s.feedBackDesktop = { isDesktop: true, audio: {
                isAvailable: async () => true, isAudioRunning: async () => inputRunning,
                getPitchDetection: async () => ({ midiNote: -1, confidence: 0 }),
                getLevels: async () => ({ inputLevel: peak, inputPeak: peak }),
                setGain: async (...args) => nativeWrites.push(args),
                getInputChannelSnapshot: async () => ({ running: inputRunning, generation: 1, selected, sequence: ++sequence,
                    channels: inputRunning ? [{ index: 0, name: 'Instrument', peak }] : [] }),
                confirmInputChannel: async channel => {
                    selected = channel; state.routeKey = `interface:${channel}`; state.revision++;
                    for (const listener of listeners) listener({ ...state });
                    return { ok: true };
                },
            } };
        }
    } });
    const det = sb.noteDetect || core.createNoteDetector({ isDefault: true });
    return {
        sb, det, service, state, writes, nativeWrites, gainNodes, listeners, resolveReady: () => resolveReady(),
        change(next) { Object.assign(state, next); state.revision++; for (const fn of listeners) fn({ ...state }); },
        startInput() { inputRunning = true; this.change({ routeKey: `interface:${selected}`, routeLabel: 'Interface' }); },
        async refreshWizard() { for (const timer of intervals) if (timer.ms === 200) timer.fn(); await flush(); },
        setPeak(value) { peak = value; },
        get overlay() { return overlay; }, get body() { return overlay.querySelector('.nd-cal-body'); },
        async open(short = true) {
            det._harness.setEnabled(true);
            det.openCalibrationWizard({ levelsOnly: short });
            await flush();
        },
        async capture() {
            await this.open();
            await this.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
            overlay.querySelector('.nd-cal-next').onclick();
            peak = 0.1;
            await this.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
        },
        settings() {
            const bar = element(), controls = [];
            bar.appendChild = el => controls.push(el);
            det.injectButton(bar);
            controls.find(el => el.className?.startsWith('nd-gear-btn')).onclick();
            return panel;
        },
    };
}

test('Default guitar gain is awaited, applied to browser node live, and not applied to native tone gain', async () => {
    const s = setup({ browser: true, pendingReady: true });
    let enabled = false;
    const starting = s.det.enable().then(() => { enabled = true; });
    await flush();
    assert.equal(enabled, false);
    assert.equal(s.gainNodes.length, 0, 'legacy cached gain must not reach the graph before migration completes');
    s.resolveReady();
    await starting;
    assert.equal(s.gainNodes[0].gain.value, 1.7);
    s.change({ activeId: 'strat', activeName: 'Strat', gain: 2.2 });
    assert.equal(s.gainNodes[0].gain.value, 2.2);
    s.det.destroy();
    assert.equal(s.listeners.size, 0);
    const native = setup();
    await native.det.enable();
    assert.equal(native.det.getDiagnostic().settings.input_gain, 1.7);
    assert.deepEqual(native.nativeWrites, []);
    native.det.destroy();
});

test('full setup can choose an input before capture and applies its gain through the same profile service', async () => {
    const s = setup();
    await s.open(false);
    const next = () => s.overlay.querySelector('.nd-cal-next').onclick();
    next(); await flush(); // Audio Input has loaded its raw channel snapshot.
    s.change({ routeKey: 'interface:1' });
    next(); next();
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    next();
    s.setPeak(0.1);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    next(); next(); next(); next();
    assert.match(s.body.innerHTML, /Apply Recommended Settings/);
    await s.body.querySelector('.nd-cal-apply-safe').onclick();
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].gain, 2.5);
    assert.equal(s.writes[0].context.routeKey, 'interface:1');
    assert.match(s.body.innerHTML, /Calibration applied/);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

for (const short of [false, true]) {
    test(`${short ? 'short' : 'full'} setup can start without an input, select a channel, then calibrate Default`, async () => {
        const s = setup({ initialRunning: false });
        await s.open(short);
        const next = () => s.overlay.querySelector('.nd-cal-next').onclick();
        assert.equal(s.overlay.querySelector('.nd-cal-next').disabled, false);
        if (!short) { next(); await flush(); }
        assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /Audio Input/);
        assert.doesNotMatch(s.body.innerHTML, /role="status">Start and select/);
        s.startInput();
        await s.refreshWizard();
        const channel = s.body.querySelector('.nd-cal-native-channel');
        channel.value = '0'; channel.onchange();
        await s.body.querySelector('.nd-cal-use-channel').onclick();
        assert.match(s.body.innerHTML, /Channel saved/);
        next(); if (!short) next();
        await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
        next();
        s.setPeak(0.1);
        await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
        await s.body.querySelector('.nd-cal-save-gain').onclick();
        assert.equal(s.writes.length, 1);
        assert.equal(s.writes[0].context.profileId, 'default');
        assert.equal(s.writes[0].context.routeKey, 'interface:0');
        assert.equal(s.writes[0].gain, 2.5);
        assert.deepEqual(s.nativeWrites, []);
        s.det.destroy();
    });
}

test('short Default guitar calibration measures and saves only gain through Core', async () => {
    const s = setup();
    await s.capture();
    assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /Default.*Signal Level/);
    assert.doesNotMatch(s.body.innerHTML, /Timing \/ Latency/);
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].gain, 2.5);
    assert.equal(s.writes[0].context.profileId, 'default');
    assert.equal(s.writes[0].metadata.rawPeak, 0.1);
    assert.equal(s.det.getDiagnostic().settings.latency_offset_s, 0.08);
    assert.deepEqual(s.nativeWrites, []);
    assert.equal(s.overlay.querySelector('.nd-cal-next').textContent, 'Done');
    s.overlay.querySelector('.nd-cal-next').onclick();
    assert.equal(s.overlay.isConnected, false);
    s.det.destroy();
});

for (const mutation of [{ activeId: 'other', activeName: 'Other' }, { routeKey: 'interface:1' }, { gain: 1.1 }]) {
    test(`a captured calibration cannot save after ${Object.keys(mutation)[0]} changes`, async () => {
        const s = setup();
        await s.capture();
        s.change(mutation);
        await s.body.querySelector('.nd-cal-save-gain').onclick();
        assert.equal(s.writes.length, 0);
        assert.match(s.body.innerHTML, /changed.*start again/);
        s.det.destroy();
    });
}

test('closing while save awaits profile readiness prevents a late gain write', async () => {
    const s = setup();
    await s.capture();
    let resume;
    s.service.ready = new Promise(resolve => { resume = resolve; });
    const saving = s.body.querySelector('.nd-cal-save-gain').onclick();
    s.det.closeCalibrationWizard();
    resume();
    await saving;
    assert.equal(s.writes.length, 0);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('clipped raw input blocks saving; capped quiet input explains remaining headroom target', async () => {
    const s = setup();
    await s.capture();
    s.setPeak(0.99);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    assert.match(s.body.innerHTML, /clipping before game gain/);
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 0);
    s.setPeak(0.012);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    assert.match(s.body.innerHTML, /Maximum 5× boost reached/);
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes[0].gain, 5);
    s.det.destroy();
});

test('old Core without guitar profiles retains gain save compatibility', async () => {
    const s = setup({ profiles: false });
    await s.capture();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.deepEqual(s.nativeWrites.at(-1), ['input', 2.5]);
    assert.equal(s.det.getDiagnostic().settings.input_gain, 2.5);
    s.det.destroy();
});

test('legacy settings slider saves to the active profile and rejects a profile switch during a drag', async () => {
    const s = setup();
    await flush();
    const panel = s.settings();
    const slider = panel.querySelector('.nd-gain-slider');
    slider.onpointerdown();
    slider.oninput({ target: { value: '23' } });
    await slider.onchange({ target: { value: '23' } });
    assert.equal(s.writes[0].gain, 2.3);
    slider.onpointerdown();
    slider.oninput({ target: { value: '31' } });
    s.change({ activeId: 'other' });
    await slider.onchange({ target: { value: '31' } });
    assert.equal(s.writes.length, 1);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});
