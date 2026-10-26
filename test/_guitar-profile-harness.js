const { loadDetectionCore } = require('./_loader');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup({ profiles = true, browser = false, pendingReady = false, initialRunning = true, nativeV2 = null } = {}) {
    let sb, overlay, panel, peak = 0.001, sequence = 0, now = 100000;
    let inputRunning = initialRunning, selected = initialRunning ? 0 : -1, inputStalled = false;
    const writes = [], nativeWrites = [], gainNodes = [], timers = new Map(), listeners = new Set(), intervals = [];
    let timerId = 0;
    const state = { activeId: 'default', activeName: 'Default', routeKey: 'interface:0', routeLabel: 'Interface · Input 1', gain: 1.7, revision: 1, stateRevision: 1 };
    if (!initialRunning) { state.routeKey = ''; state.routeLabel = 'Start your audio input'; }
    let resolveReady;
    const service = {
        ready: pendingReady ? new Promise(resolve => { resolveReady = resolve; }) : Promise.resolve(), getSnapshot: () => ({ ...state }),
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        async refresh() { return { ...state }; },
        async captureContext() {
            if (!state.routeKey) throw Error('Start and select your audio input before calibrating.');
            return { profileId: state.activeId, activeName: state.activeName, routeKey: state.routeKey, routeLabel: state.routeLabel, revision: state.revision };
        },
        async captureDraftContext(type) {
            return {type, profileId: state.activeId, routeKey: state.routeKey, routeLabel: state.routeLabel,
                revision: state.revision, stateRevision: state.stateRevision};
        },
        verifyDraftContext(context, {bindRoute = false, requireRoute = false} = {}) {
            if (!context || context.profileId !== state.activeId || context.stateRevision !== state.stateRevision || state.sessionLocked)
                throw Error('Instrument or session changed. Start again.');
            if (!bindRoute && (context.routeKey !== state.routeKey || context.revision !== state.revision))
                throw Error('Audio input changed. Start again.');
            if (requireRoute && !state.routeKey) throw Error('Start and select your audio input before calibrating.');
            return {...context, routeKey: state.routeKey, routeLabel: state.routeLabel, revision: state.revision};
        },
        async saveGain(gain, context, metadata) {
            if (context.profileId !== state.activeId || context.routeKey !== state.routeKey || context.revision !== state.revision)
                throw Error('Guitar or input changed');
            writes.push({ gain, context, metadata });
            state.gain = gain; state.revision++; state.stateRevision++;
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
            setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name] ?? null; }, focus() {},
            remove() { this.isConnected = false; },
            querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
            querySelectorAll(selector) {
                if (nativeV2 && selector === '.nd-cal-v2-note') return [...this.innerHTML.matchAll(/data-string="(\d+)" value="([^"]+)"/g)].map(([, string, value]) => {
                    const key = `.nd-cal-v2-note-${string}`;
                    if (!children.has(key)) children.set(key, element());
                    const input = children.get(key); input.value = value; input['data-string'] = string;
                    return input;
                });
                return [];
            },
        };
    };
    const core = loadDetectionCore({ sandboxBeforeRun(s) {
        sb = s;
        s.Date = class extends Date { static now() { return now; } };
        s.setTimeout = (fn, ms) => {
            const id = ++timerId;
            timers.set(id, fn);
            if (ms === 80 || ms === 1000 || (nativeV2 && [100, 120].includes(ms))) Promise.resolve().then(async () => {
                if (nativeV2?.onSleep) await nativeV2.onSleep(ms);
                if (timers.delete(id)) fn();
            });
            return id;
        };
        s.clearTimeout = id => timers.delete(id);
        s.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
        s.clearInterval = id => { if (intervals[id - 1]) intervals[id - 1].cleared = true; };
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
            const node = () => ({ connect(target) { target.upstream = this; }, disconnect() {}, channelCount: 1, gain: { value: 0 },
                getFloatTimeDomainData(buffer) {
                    const multiplier = gainNodes.includes(this.upstream) ? this.upstream.gain.value : 1;
                    for (let i = 0; i < buffer.length; i++) buffer[i] = peak * multiplier * Math.sin(i * Math.PI / 16);
                } });
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
                getInputChannelSnapshot: async () => ({ running: inputRunning, generation: 1, selected, sequence: inputStalled ? sequence : ++sequence,
                    channels: inputRunning ? [{ index: 0, name: 'Instrument', peak }] : [] }),
                confirmInputChannel: async channel => {
                    selected = channel; state.routeKey = `interface:${channel}`; state.revision++;
                    for (const listener of listeners) listener({ ...state });
                    return { ok: true };
                },
                ...(nativeV2 ? {getInputCalibrationSnapshot: request => nativeV2.getInputCalibrationSnapshot(request)} : {}),
            } };
        }
    } });
    const det = sb.noteDetect || core.createNoteDetector({ isDefault: true });
    return {
        sb, det, service, state, writes, nativeWrites, gainNodes, listeners, intervals, resolveReady: () => resolveReady(),
        change(next) {
            Object.assign(state, next); state.revision++;
            if ('activeId' in next || 'gain' in next) state.stateRevision++;
            for (const fn of listeners) fn({ ...state });
        },
        startInput() { inputRunning = true; this.change({ routeKey: `interface:${selected}`, routeLabel: 'Interface' }); },
        async refreshWizard() { for (const timer of intervals) if (!timer.cleared && timer.ms === 200) timer.fn(); await flush(); },
        async tickSampler(ms) { now += ms; for (const timer of [...intervals]) if (!timer.cleared && timer.ms === 120) timer.fn(); await flush(); },
        setPeak(value) { peak = value; },
        stallInput(value = true) { inputStalled = value; },
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
        async draft(type = 'bass', name = 'My bass') {
            const context = await service.captureDraftContext(type);
            const pending = det.measureInstrumentGain({type, name, context});
            await flush();
            return {pending, context};
        },
        async captureDraft() {
            const draft = await this.draft();
            await this.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
            overlay.querySelector('.nd-cal-next').onclick();
            peak = 0.1;
            await this.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
            return draft;
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


module.exports = { setup, flush };
