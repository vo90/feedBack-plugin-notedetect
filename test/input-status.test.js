const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// Keep real parentage, attributes and text for the status under test. Other
// plugin UI uses HTML templates; their class-bearing elements are enough for
// this fixture's settings/HUD event wiring (no layout or rendering is faked).
function makeDocument() {
    class Element {
        constructor(tag = 'div') {
            this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
            this.attributes = {}; this.style = {}; this.dataset = {}; this.className = '';
            this.hidden = false; this._text = ''; this._html = '';
            const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
            this.classList = {
                contains: value => classes().has(value),
                add: (...values) => { this.className = [...new Set([...classes(), ...values])].join(' '); },
                remove: (...values) => { this.className = [...classes()].filter(value => !values.includes(value)).join(' '); },
                toggle: (value, force) => {
                    const on = force === undefined ? !classes().has(value) : !!force;
                    this.classList[on ? 'add' : 'remove'](value); return on;
                },
            };
        }
        appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
        removeChild(child) { const at = this.children.indexOf(child); if (at >= 0) this.children.splice(at, 1); child.parentNode = null; return child; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        contains(node) { return this === node || this.children.some(child => child.contains(node)); }
        get isConnected() { return document.body.contains(this) || document.head.contains(this); }
        setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); if (name === 'id') this.id = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        removeAttribute(name) { delete this.attributes[name]; }
        addEventListener() {}
        removeEventListener() {}
        focus() {}
        matches(selector) {
            if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            return this.tagName.toLowerCase() === selector.toLowerCase();
        }
        querySelectorAll(selector) {
            const result = [];
            for (const child of this.children) {
                if (selector.split(',').some(part => child.matches(part.trim()))) result.push(child);
                result.push(...child.querySelectorAll(selector));
            }
            return result;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set textContent(value) { for (const child of [...this.children]) child.remove(); this._text = String(value); this._html = ''; }
        get innerHTML() { return this._html; }
        set innerHTML(value) {
            for (const child of [...this.children]) child.remove();
            this._html = String(value); this._text = '';
            for (const match of this._html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
                const child = new Element(match[1]);
                for (const attr of match[2].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) child.setAttribute(attr[1], attr[2]);
                this.appendChild(child);
            }
        }
    }
    const document = {
        createElement: tag => new Element(tag), body: new Element('body'), head: new Element('head'),
        addEventListener() {}, removeEventListener() {},
        querySelector: selector => document.body.querySelector(selector) || document.head.querySelector(selector),
        querySelectorAll: selector => [...document.body.querySelectorAll(selector), ...document.head.querySelectorAll(selector)],
        getElementById: id => document.querySelector('#' + id),
    };
    const player = document.createElement('div'); player.id = 'player'; document.body.appendChild(player);
    return document;
}

function setup({ browser = false, detectWanted = false, autoEnable = false, sharedStatus = false, initializing = false } = {}) {
    const document = makeDocument(), intervals = new Map(), timeouts = new Map();
    let sb, id = 0, now = 10000, refreshGate = null, mediaGate = null;
    const state = { loaded: true, gain: 1, applied: false, activeId: 'default', revision: 1,
        routeKey: 'microphone', route: { generation: 1 },
        error: 'Start and select your audio input before detecting notes.' };
    const calls = { alerts: [], media: 0, refresh: 0, settings: [], errors: [], statusSets: [], statusClears: [] };
    const sharedCards = new Map();
    const statusStack = document.createElement('div'); statusStack.className = 'feedback-audio-status';
    const presenter = {
        isInitializing: () => initializing,
        set(channel, status) {
            calls.statusSets.push({ channel, ...status });
            if (initializing) return;
            let card = sharedCards.get(channel);
            if (!card) {
                card = document.createElement('div'); card.className = 'nd-input-status';
                const detail = document.createElement('span'); detail.className = 'nd-input-status-detail';
                card.appendChild(detail); statusStack.appendChild(card); document.body.appendChild(statusStack);
                sharedCards.set(channel, card);
            }
            card.querySelector('.nd-input-status-detail').textContent = status.detail;
            card.hidden = !!status.hidden;
        },
        clear(channel) { calls.statusClears.push(channel); sharedCards.get(channel)?.remove(); sharedCards.delete(channel); },
        setHidden(channel, hidden) { const card = sharedCards.get(channel); if (card) card.hidden = hidden; },
    };
    const listeners = new Set(), events = new Map();
    const emitProfile = patch => {
        Object.assign(state, patch);
        for (const listener of listeners) listener({ ...state });
    };
    const profiles = {
        ready: Promise.resolve(), getSnapshot: () => ({ ...state }),
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        async refresh() {
            calls.refresh++;
            const result = await (refreshGate || { ...state });
            emitProfile({});
            return result;
        },
    };
    const core = loadDetectionCore({ sandboxBeforeRun(s) {
        sb = s; s.document = document;
        s.Date = class extends Date { static now() { return now; } };
        s.console = { ...console, log() {}, warn() {}, error: (...args) => calls.errors.push(args) };
        s.alert = message => calls.alerts.push(message);
        s.setTimeout = (fn, ms) => { timeouts.set(++id, { fn, ms }); return id; };
        s.clearTimeout = timer => timeouts.delete(timer);
        s.setInterval = (fn, ms) => { intervals.set(++id, { fn, ms }); return id; };
        s.clearInterval = timer => intervals.delete(timer);
        s.addEventListener = (name, fn) => {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name).add(fn);
        };
        s.removeEventListener = (name, fn) => events.get(name)?.delete(fn);
        s.dispatchEvent = event => {
            for (const listener of events.get(event.type) || []) listener(event);
            return true;
        };
        s.localStorage.getItem = key => key === 'slopsmith_notedetect' ? JSON.stringify({ detectEnabled: detectWanted }) : null;
        // The function's presence enables the real construct-time startup
        // gate. Media rejection happens before a context would be created.
        if (autoEnable) s.AudioContext = function () { return {}; };
        s.highway.getSongInfo = () => ({ arrangement: 'lead', stringCount: 6, tuningOffsets: [0, 0, 0, 0, 0, 0] });
        s.feedBack = { guitarProfiles: profiles };
        if (sharedStatus) s.feedBackAudioStatus = presenter;
        s.navigator.mediaDevices.getUserMedia = async () => {
            calls.media++;
            if (mediaGate) return mediaGate;
            throw Error(state.error);
        };
        if (!browser) s.feedBackDesktop = { isDesktop: true, audio: {
            isAvailable: async () => true, isAudioRunning: async () => true,
            startAudio: async () => {}, getSampleRate: async () => 48000,
            getPitchDetection: async () => ({ midiNote: -1, confidence: 0 }),
            getLevels: async () => ({ inputLevel: 0, inputPeak: 0 }),
        } };
    } });
    assert.ok(sb.noteDetect, 'real plugin singleton must bootstrap successfully');
    return {
        sb, core, document, state, calls, profiles, intervals, timeouts, events, emitProfile, sharedCards, statusStack,
        det: sb.noteDetect,
        notice: () => document.querySelector('.nd-input-status'),
        gateRefresh(promise) { refreshGate = promise; },
        gateMedia(promise) { mediaGate = promise; },
        routeChanged() { sb.dispatchEvent(new sb.CustomEvent('feedback:audio-route-changed')); },
        finishInitialization() {
            initializing = false;
            sb.dispatchEvent(new sb.CustomEvent('feedback:audio-initialized'));
        },
        async runRecovery() {
            await flush();
            for (const [timerId, timer] of [...timeouts]) if (timer.ms === 0) {
                timeouts.delete(timerId); timer.fn();
            }
            await flush();
        },
        tickWatchdog(ms = 0) {
            now += ms;
            for (const timer of [...intervals.values()]) if (timer.ms === 1000) timer.fn();
        },
        destroy() { for (const detector of [sb.noteDetect]) detector.destroy(); },
    };
}

test('construct-time startup stays quiet first, then shows one status after its single 1500ms retry', async t => {
    const s = setup({ browser: true, detectWanted: true, autoEnable: true });
    t.after(() => s.destroy());
    assert.equal(s.calls.media, 0, 'construction schedules startup instead of opening input synchronously');
    const immediate = [...s.timeouts.entries()].filter(([, timer]) => timer.ms === 0);
    assert.equal(immediate.length, 1, 'exactly one immediate automatic attempt');
    s.timeouts.delete(immediate[0][0]); immediate[0][1].fn();
    await flush();
    assert.equal(s.calls.media, 1);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.notice(), null, 'the first failure remains silent during device initialization');
    assert.deepEqual(s.calls.alerts, []);
    const retries = [...s.timeouts.entries()].filter(([, timer]) => timer.ms === 1500);
    assert.equal(retries.length, 1, 'preserve the existing single delayed retry');
    s.timeouts.delete(retries[0][0]); retries[0][1].fn();
    await flush();
    assert.equal(s.calls.media, 2);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    assert.equal(s.notice().parentNode, s.document.body);
    assert.deepEqual(s.calls.alerts, []);
    assert.equal([...s.timeouts.values()].filter(timer => timer.ms === 0 || timer.ms === 1500).length, 0,
        'persistent failure must not schedule another startup attempt');
});

test('native input failure shows one safe, nonmodal status on Home and opens audio settings', async t => {
    const s = setup(); t.after(() => s.destroy());
    s.state.error = '<img src=x onerror="alert(1)"> device unavailable';
    assert.equal(await s.det.enable(), false);
    const notice = s.notice();
    assert.ok(notice);
    assert.equal(notice.parentNode, s.document.body, 'Home hides the player subtree');
    assert.equal(notice.getAttribute('role'), 'status');
    assert.equal(notice.getAttribute('aria-live'), 'polite');
    assert.equal(notice.children[0].textContent, 'Audio input unavailable — note detection paused.');
    assert.equal(notice.querySelector('.nd-input-status-detail').textContent, s.state.error);
    assert.equal(notice.querySelector('img'), null, 'device errors must stay text');
    assert.deepEqual(s.calls.alerts, []);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.calls.media, 0, 'status must not introduce a browser audio fallback');
    assert.ok(s.calls.errors.length, 'technical failure remains logged');
    s.state.error = 'Selected input disconnected';
    assert.equal(await s.det.enable(), false);
    assert.equal(s.notice(), notice, 'retry updates the same instance notice');
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    assert.equal(notice.querySelector('.nd-input-status-detail').textContent, s.state.error);
    const audioScreen = s.document.createElement('div'); audioScreen.id = 'plugin-audio_engine'; s.document.body.appendChild(audioScreen);
    s.sb.showScreen = name => s.calls.settings.push(name);
    notice.querySelector('.nd-input-status-settings').onclick();
    assert.deepEqual(s.calls.settings, ['plugin-audio_engine']);
});

test('browser media failure uses the same quiet status and retains settings fallback', async t => {
    const s = setup({ browser: true }); t.after(() => s.destroy());
    assert.equal(await s.det.enable(), false);
    assert.equal(s.calls.media, 1);
    assert.deepEqual(s.calls.alerts, []);
    assert.ok(s.notice());
    assert.doesNotThrow(() => s.notice().querySelector('.nd-input-status-settings').onclick());
    assert.ok(s.document.querySelector('.nd-settings-panel'), 'without the host audio screen, open detector settings');
});

test('a successful native retry clears the unavailable status', async t => {
    const s = setup(); t.after(() => s.destroy());
    assert.equal(await s.det.enable(), false);
    const notice = s.notice();
    s.state.applied = true;
    assert.equal(await s.det.enable(), true);
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
    assert.equal(notice.isConnected, false);
});

test('browser recovery clears the notice only once the input graph starts successfully', async t => {
    const s = setup({ browser: true }); t.after(() => s.destroy());
    await s.det.enable();
    const notice = s.notice();
    let resolveMedia;
    s.gateMedia(new Promise(resolve => { resolveMedia = resolve; }));
    const node = () => ({ connect() {}, disconnect() {}, channelCount: 1, gain: { value: 1 } });
    s.sb.AudioContext = class {
        sampleRate = 48000;
        destination = node();
        createMediaStreamSource() { return node(); }
        createGain() { return node(); }
        createAnalyser() { return node(); }
        createScriptProcessor() { return node(); }
        close() { return Promise.resolve(); }
    };
    const enabling = s.det.enable();
    await flush();
    assert.equal(s.notice(), notice, 'retry-in-progress must not prematurely imply recovery');
    resolveMedia({ getTracks: () => [], getAudioTracks: () => [] });
    assert.equal(await enabling, true);
    assert.equal(s.notice(), null);
    assert.equal(s.calls.media, 2);
    assert.deepEqual(s.calls.alerts, []);
});

test('explicit disable clears a failed-start notice even when detection is already off', async t => {
    const s = setup(); t.after(() => s.destroy());
    await s.det.enable();
    assert.ok(s.notice());
    s.det.disable({ silent: true });
    assert.equal(s.notice(), null);
    assert.equal(s.det.isEnabled(), false);
});

test('failed restart stops detection but keeps the actionable status until recovery', async t => {
    const s = setup(); t.after(() => s.destroy());
    s.state.applied = true;
    assert.equal(await s.det.enable(), true);
    s.state.applied = false;
    s.det.applySettings({ frameSize: 4096 });
    await flush();
    assert.equal(s.det.isEnabled(), false);
    assert.ok(s.notice(), 'internal failed-restart cleanup must preserve the notice');
    assert.deepEqual(s.calls.alerts, []);
    s.state.applied = true;
    assert.equal(await s.det.enable(), true);
    assert.equal(s.notice(), null);
});

test('external MIDI recovery clears the stale audio-input status without reopening input', async t => {
    const s = setup(); t.after(() => s.destroy());
    await s.det.enable();
    assert.ok(s.notice());
    const opens = s.calls.refresh;
    s.sb.highway.getSongInfo = () => ({ arrangement: 'keys' });
    s.sb.slopsmith.noteDetection = { version: 1, snapshot: () => ({
        providers: [{ id: 'keys', kind: 'midi' }], bindings: [{ providerId: 'keys' }],
    }) };
    assert.equal(await s.det.enable(), true);
    assert.equal(s.notice(), null);
    assert.equal(s.calls.refresh, opens);
});

test('destroy during a pending failed start cannot resurrect an input notice', async () => {
    const s = setup({ browser: true });
    let rejectMedia;
    s.gateMedia(new Promise((resolve, reject) => { rejectMedia = reject; }));
    const enabling = s.det.enable();
    await flush();
    assert.equal(s.calls.media, 1);
    s.det.destroy();
    rejectMedia(Error('Device disappeared after teardown'));
    assert.equal(await enabling, false);
    assert.equal(s.notice(), null);
    assert.deepEqual(s.calls.alerts, []);
});

test('disable supersedes pending startup and leaves no stale status after its failure', async t => {
    const s = setup(); t.after(() => s.destroy());
    let release;
    s.gateRefresh(new Promise(resolve => { release = resolve; }));
    const enabling = s.det.enable();
    await flush();
    assert.equal(s.calls.refresh, 1);
    s.det.disable({ silent: true });
    release({ ...s.state });
    assert.equal(await enabling, false);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.notice(), null);
});

test('a superseded successful retry does not re-enable detection after explicit disable', async t => {
    const s = setup(); t.after(() => s.destroy());
    await s.det.enable(); assert.ok(s.notice());
    let release;
    s.gateRefresh(new Promise(resolve => { release = resolve; }));
    const enabling = s.det.enable();
    await flush();
    assert.ok(s.notice());
    s.det.disable({ silent: true });
    assert.equal(s.notice(), null);
    release({ ...s.state, applied: true });
    assert.equal(await enabling, false);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.notice(), null);
});

test('secondary detector statuses stay inside their own player and destroy independently', async t => {
    const s = setup({ browser: true }); t.after(() => s.destroy());
    const panel = s.document.createElement('div'); s.document.body.appendChild(panel);
    const second = s.core.createNoteDetector({ isDefault: false, container: panel });
    t.after(() => second.destroy());
    await s.det.enable(); await second.enable();
    const secondNotice = panel.querySelector('.nd-input-status');
    assert.ok(secondNotice);
    assert.equal(secondNotice.parentNode.className, 'nd-instance-root');
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 2);
    second.destroy();
    assert.equal(secondNotice.isConnected, false);
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    assert.equal(s.notice().parentNode, s.document.body);
});

test('quiet status yields to the scoring-stall banner and reappears when playback stops', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    const notice = s.notice();
    assert.equal(notice.hidden, false);
    s.sb.slopsmith.isPlaying = true;
    s.tickWatchdog(); s.tickWatchdog(2600); await flush();
    assert.ok(s.document.querySelector('.nd-scoring-stall'));
    assert.equal(notice.hidden, true);
    s.sb.slopsmith.isPlaying = false; s.tickWatchdog(1000);
    assert.equal(s.document.querySelector('.nd-scoring-stall'), null);
    assert.equal(notice.hidden, false);
});

test('split-screen suppression hides a default notice and does not create a second one', async t => {
    const s = setup(); t.after(() => s.destroy());
    await s.det.enable(); const notice = s.notice();
    s.core.createNoteDetector.setDefaultSuppressed(true);
    s.tickWatchdog();
    assert.equal(notice.hidden, true);
    await s.det.enable();
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    s.core.createNoteDetector.setDefaultSuppressed(false);
    s.tickWatchdog();
    assert.equal(notice.hidden, false);
});

test('ready input restores wanted detection while idle, after Apply synchronizes its source', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    const notice = s.notice(), before = s.calls.refresh;
    let selected = 'old-asio', opened = [];
    s.sb.slopsmith.capabilities = { async command(domain, command) {
        if (command === 'open-source') opened.push(selected);
        return { outcome: 'handled' };
    } };
    // Match Audio Apply: refresh publishes readiness before it updates the
    // input capability selection, then dispatches the route event.
    s.emitProfile({ applied: true, error: '' });
    await flush();
    assert.equal(s.det.isEnabled(), false, 'profile publication must not reopen the old source');
    assert.deepEqual(opened, []);
    selected = 'microphone';
    s.routeChanged();
    await s.runRecovery();
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.calls.refresh, before + 1, 'profile and route events coalesce');
    assert.deepEqual(opened, ['microphone']);
    assert.equal(s.notice(), null);
    assert.equal(notice.isConnected, false);
    assert.equal(s.sb.slopsmith.isPlaying, undefined, 'no playback was needed');
});

test('route event during a failing start retries after that start settles', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    let release;
    s.gateRefresh(new Promise(resolve => { release = resolve; }));
    const enabling = s.det.enable();
    await flush();
    s.emitProfile({ applied: true, error: '' });
    s.routeChanged();
    await s.runRecovery();
    assert.equal(s.calls.refresh, 1, 'recovery must wait for the earlier startup');
    s.gateRefresh(null);
    release({ ...s.state, applied: false, error: 'Old device failed' });
    assert.equal(await enabling, false);
    await flush();
    assert.equal(s.calls.refresh, 2);
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
});

test('healthy detection ignores repeated readiness and route events without resetting its session', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    s.state.applied = true;
    await s.det.enable();
    const before = s.calls.refresh, timers = [...s.intervals.keys()];
    s.emitProfile({ revision: 2, gain: 2 });
    s.emitProfile({ route: { generation: 2 } });
    s.routeChanged(); s.routeChanged();
    await s.runRecovery();
    assert.equal(s.calls.refresh, before);
    assert.deepEqual([...s.intervals.keys()], timers, 'the active detection/HUD session remains intact');
    assert.equal(s.det.isEnabled(), true);
});

test('failed recovery is bounded until fresh readiness or an explicit route change', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    s.emitProfile({ applied: true });
    s.gateRefresh(Promise.resolve({ ...s.state, applied: false, error: 'Still unavailable' }));
    await s.runRecovery();
    const attempts = s.calls.refresh;
    assert.equal(attempts, 2);
    assert.equal(s.det.isEnabled(), false);
    // Real profile polling republishes unchanged readiness; calibration edits
    // can change the general revision without changing the input route.
    for (let i = 0; i < 3; i++) {
        s.emitProfile({ revision: 3 + i, gain: 1 + i });
        await s.runRecovery();
    }
    assert.equal(s.calls.refresh, attempts);
    s.gateRefresh(null);
    s.routeChanged();
    await s.runRecovery();
    assert.equal(s.calls.refresh, attempts + 1);
    assert.equal(s.det.isEnabled(), true);
});

test('a recovery refresh cannot create its own retry loop', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    s.emitProfile({ applied: true });
    s.profiles.refresh = async () => {
        s.calls.refresh++;
        s.emitProfile({ applied: false });
        s.emitProfile({ applied: true });
        return { ...s.state, applied: false, error: 'Opening still fails' };
    };
    await s.runRecovery();
    await s.runRecovery();
    assert.equal(s.calls.refresh, 2);
    assert.equal(s.det.isEnabled(), false);
    assert.ok(s.notice());
});

test('new native route generation permits recovery even on the same named input', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    s.emitProfile({ applied: true });
    s.gateRefresh(Promise.resolve({ ...s.state, applied: false }));
    await s.runRecovery();
    s.gateRefresh(null);
    s.emitProfile({ route: { generation: 2 } });
    await s.runRecovery();
    assert.equal(s.calls.refresh, 3);
    assert.equal(s.det.isEnabled(), true);
});

test('new readiness during a failed recovery is retained without a route event', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    let release;
    s.gateRefresh(new Promise(resolve => { release = resolve; }));
    s.emitProfile({ applied: true });
    await s.runRecovery();
    assert.equal(s.calls.refresh, 2);
    s.emitProfile({ route: { generation: 2 } });
    s.gateRefresh(null);
    release({ ...s.state, applied: false });
    await s.runRecovery();
    assert.equal(s.calls.refresh, 3);
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
});

test('disable cancels queued recovery even when detection is already off', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    s.emitProfile({ applied: true });
    s.det.disable({ silent: true });
    s.routeChanged();
    await s.runRecovery();
    assert.equal(s.calls.refresh, 1);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.notice(), null);
});

test('disable during recovery preflight cannot resurrect the detector', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    let release;
    s.profiles.ready = new Promise(resolve => { release = resolve; });
    s.emitProfile({ applied: true });
    s.state.loaded = false;
    await s.runRecovery();
    s.det.disable({ silent: true });
    s.state.loaded = true;
    release();
    await flush();
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.calls.refresh, 1, 'cancelled preflight never opens input');
    assert.equal(s.notice(), null);
});

test('split suppression during recovery preflight cannot enable the default detector', async t => {
    const s = setup({ detectWanted: true }); t.after(() => s.destroy());
    await s.det.enable();
    let release;
    s.profiles.ready = new Promise(resolve => { release = resolve; });
    s.emitProfile({ applied: true });
    s.state.loaded = false;
    await s.runRecovery();
    s.core.createNoteDetector.setDefaultSuppressed(true);
    s.state.loaded = true;
    release();
    await flush();
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.calls.refresh, 1);
});

test('recovery respects user-off, split suppression, external MIDI and destruction', async t => {
    for (const blockedBy of ['user-off', 'split', 'external', 'destroy']) {
        const s = setup({ detectWanted: blockedBy !== 'user-off' });
        t.after(() => s.destroy());
        await s.det.enable();
        s.emitProfile({ applied: true });
        if (blockedBy === 'split') s.sb.__ndSuppressDefault = true;
        if (blockedBy === 'external') s.sb.highway.getSongInfo = () => ({ arrangement: 'keys' });
        if (blockedBy === 'destroy') s.det.destroy();
        s.routeChanged();
        await s.runRecovery();
        assert.equal(s.calls.refresh, 1, blockedBy);
        assert.equal(s.det.isEnabled(), false, blockedBy);
        if (blockedBy === 'destroy') {
            assert.equal(s.events.get('feedback:audio-route-changed').size, 0);
            assert.equal(s.notice(), null);
        }
    }
});

test('route notifications never acquire browser or secondary inputs', async t => {
    const s = setup({ browser: true, detectWanted: true }); t.after(() => s.destroy());
    const secondary = s.core.createNoteDetector({ isDefault: false });
    t.after(() => secondary.destroy());
    await s.det.enable(); await secondary.enable();
    s.emitProfile({ applied: true });
    s.routeChanged();
    await s.runRecovery();
    assert.equal(s.calls.media, 2);
    assert.equal(s.events.get('feedback:audio-route-changed').size, 1, 'only the default detector subscribes');
    assert.equal(secondary.isEnabled(), false);
});

test('native startup stays silent through the delayed retry and recovers after initialization', async t => {
    const s = setup({ detectWanted: true, autoEnable: true, sharedStatus: true, initializing: true });
    t.after(() => s.destroy());
    await s.runRecovery();
    const retries = [...s.timeouts.entries()].filter(([, timer]) => timer.ms === 1500);
    assert.equal(retries.length, 1);
    s.timeouts.delete(retries[0][0]); retries[0][1].fn();
    await flush();
    assert.equal(s.calls.refresh, 2);
    assert.equal(s.notice(), null);
    assert.deepEqual(s.calls.statusSets, [], 'intermediate failures are never queued in the presenter');
    s.sb.slopsmith.isPlaying = true;
    s.tickWatchdog(); s.tickWatchdog(3000);
    assert.equal(s.document.querySelector('.nd-scoring-stall'), null, 'startup must not flash the scoring-stall banner either');
    s.state.applied = true;
    s.finishInitialization();
    await s.runRecovery();
    assert.equal(s.calls.refresh, 3, 'Desktop completion probes the settled input');
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
    assert.deepEqual(s.calls.statusSets, []);
});

test('initialization completion reports a fresh real failure even when no input was applied', async t => {
    const s = setup({ detectWanted: true, sharedStatus: true, initializing: true });
    t.after(() => s.destroy());
    await s.det.enable();
    assert.deepEqual(s.calls.statusSets, []);
    s.state.error = 'The selected input is unavailable after startup.';
    s.finishInitialization();
    assert.equal(s.notice(), null, 'completion never reveals the earlier startup error');
    await s.runRecovery();
    assert.equal(s.calls.refresh, 2);
    assert.equal(s.det.isEnabled(), false);
    assert.equal(s.calls.statusSets.length, 1);
    assert.equal(s.calls.statusSets[0].detail, s.state.error);
    assert.equal(s.notice().parentNode, s.statusStack);
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    await s.runRecovery();
    assert.equal(s.calls.refresh, 2, 'a failed settled probe does not loop');
});

test('a startup operation that fails after initialization cannot flash its stale error', async t => {
    const s = setup({ detectWanted: true, sharedStatus: true, initializing: true });
    t.after(() => s.destroy());
    let release;
    s.gateRefresh(new Promise(resolve => { release = resolve; }));
    const enabling = s.det.enable();
    await flush();
    s.state.applied = true;
    s.finishInitialization();
    await s.runRecovery();
    assert.equal(s.calls.refresh, 1, 'settled probe waits for the pending startup');
    s.gateRefresh(null);
    release({ ...s.state, applied: false, error: 'Stale startup failure' });
    assert.equal(await enabling, false);
    await flush();
    assert.equal(s.calls.refresh, 2);
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
    assert.deepEqual(s.calls.statusSets, [], 'neither a queued error nor the late failure reaches the presenter');
});

test('shared input card updates, follows split visibility, and clears on successful recovery', async t => {
    const s = setup({ detectWanted: true, sharedStatus: true }); t.after(() => s.destroy());
    await s.det.enable();
    const card = s.notice();
    assert.equal(card.parentNode, s.statusStack);
    assert.equal(s.calls.statusSets[0].channel, 'input');
    assert.equal(s.calls.statusSets[0].message, 'Audio input unavailable — note detection paused.');
    s.state.error = '<img src=x> Changed error';
    await s.det.enable();
    assert.equal(s.notice(), card);
    assert.equal(s.calls.statusSets[1].detail, s.state.error);
    assert.equal(s.document.querySelectorAll('.nd-input-status').length, 1);
    s.core.createNoteDetector.setDefaultSuppressed(true); s.tickWatchdog();
    assert.equal(card.hidden, true);
    s.core.createNoteDetector.setDefaultSuppressed(false); s.tickWatchdog();
    assert.equal(card.hidden, false);
    s.emitProfile({ applied: true });
    await s.runRecovery();
    assert.equal(s.det.isEnabled(), true);
    assert.equal(s.notice(), null);
    assert.equal(card.isConnected, false);
    assert.deepEqual(s.calls.statusClears, ['input']);
});

test('initialization recovery honors off, disable, suppression, external scoring and teardown', async t => {
    for (const blockedBy of ['off', 'disable', 'split', 'external', 'destroy']) {
        const s = setup({ detectWanted: blockedBy !== 'off', sharedStatus: true, initializing: true });
        t.after(() => s.destroy());
        await s.det.enable();
        if (blockedBy === 'disable') s.det.disable({ silent: true });
        if (blockedBy === 'split') s.core.createNoteDetector.setDefaultSuppressed(true);
        if (blockedBy === 'external') s.sb.highway.getSongInfo = () => ({ arrangement: 'keys' });
        if (blockedBy === 'destroy') s.det.destroy();
        s.state.applied = true;
        s.finishInitialization();
        await s.runRecovery();
        assert.equal(s.calls.refresh, 1, blockedBy);
        assert.equal(s.det.isEnabled(), false, blockedBy);
        assert.deepEqual(s.calls.statusSets, [], blockedBy);
        if (blockedBy === 'destroy') assert.equal(s.events.get('feedback:audio-initialized').size, 0);
    }
});

test('destroy clears its shared input card and initialized listener', async () => {
    const s = setup({ sharedStatus: true });
    await s.det.enable();
    assert.ok(s.notice());
    s.det.destroy();
    assert.equal(s.notice(), null);
    assert.deepEqual(s.calls.statusClears, ['input']);
    assert.equal(s.events.get('feedback:audio-initialized').size, 0);
});

test('primary initialization does not hide an independently owned panel failure', async t => {
    const s = setup({ browser: true, sharedStatus: true, initializing: true });
    t.after(() => s.destroy());
    const panel = s.document.createElement('div'); s.document.body.appendChild(panel);
    const secondary = s.core.createNoteDetector({ isDefault: false, container: panel });
    t.after(() => secondary.destroy());
    await secondary.enable();
    assert.ok(panel.querySelector('.nd-input-status'), 'independent input errors keep their local status');
    assert.deepEqual(s.calls.statusSets, [], 'panels never share the primary input channel');
    s.finishInitialization();
    await s.runRecovery();
    assert.equal(s.calls.media, 1, 'primary startup must not reopen an independently owned input');
});
