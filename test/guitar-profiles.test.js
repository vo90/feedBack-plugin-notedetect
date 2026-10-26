const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, flush } = require('./_guitar-profile-harness');

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

test('native input startup waits for the newly opened route gain before starting detection', async () => {
    const s = setup({ initialRunning: false });
    let started = false, refreshed = false, resolved = false, resume;
    const gainApplied = new Promise(resolve => { resume = resolve; });
    s.sb.feedBackDesktop.audio.startAudio = async () => {
        started = true;
        s.startInput();
    };
    s.service.refresh = async () => {
        assert.equal(started, true, 'refresh must read the actual opened input');
        refreshed = true;
        await gainApplied;
        s.change({ gain: 2.8, applied: true });
        return s.service.getSnapshot();
    };
    const enabling = s.det.enable().then(result => { resolved = true; return result; });
    await flush();
    assert.equal(refreshed, true);
    assert.equal(resolved, false, 'enable must wait until native calibration has applied');
    assert.equal(s.intervals.some(timer => timer.ms === 50), false, 'no frames may be polled with stale gain');
    resume();
    assert.equal(await enabling, true);
    assert.equal(s.det.getDiagnostic().settings.input_gain, 2.8);
    assert.equal(s.intervals.some(timer => timer.ms === 50), true);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('native detection does not start when the selected route calibration cannot apply', async () => {
    const s = setup();
    s.service.refresh = async () => { throw Error('Input device changed while applying gain'); };
    assert.equal(await s.det.enable(), false);
    assert.equal(s.intervals.some(timer => timer.ms === 50), false);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('failed initial startup offers an in-wizard Detect retry after input setup', async () => {
    const s = setup({ initialRunning: false });
    s.service.refresh = async () => ({ ...s.state, applied: !!s.state.routeKey });
    await s.det.launchGuitarCalibration();
    await flush();
    assert.match(s.body.innerHTML, /Enable Detect \/ retry input/);
    s.startInput();
    await s.refreshWizard();
    await s.body.querySelector('.nd-cal-enable-detect').onclick();
    assert.doesNotMatch(s.body.innerHTML, /Enable Detect \/ retry input/);
    const channel = s.body.querySelector('.nd-cal-native-channel');
    channel.value = '0'; channel.onchange();
    await s.body.querySelector('.nd-cal-use-channel').onclick();
    s.overlay.querySelector('.nd-cal-next').onclick();
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    assert.match(s.body.innerHTML, /Captured: avg/);
    s.det.destroy();
});

for (const [gain, rawPeak, recommended] of [[1, 0.1, 2.5], [4, 0.1, 2.5], [4, 0.35, 0.71], [4, 0.99, null]]) {
    test(`browser calibration measures raw sine peak ${rawPeak} independently of current ${gain}x boost`, async () => {
        const s = setup({ browser: true });
        s.change({ gain });
        await s.det.enable();
        await s.open();
        await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
        await s.tickSampler(2000);
        s.overlay.querySelector('.nd-cal-next').onclick();
        s.setPeak(rawPeak);
        await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
        await s.tickSampler(3400);
        await s.body.querySelector('.nd-cal-save-gain').onclick();
        if (recommended == null) {
            assert.match(s.body.innerHTML, /clipping before game gain/);
            assert.equal(s.writes.length, 0);
        } else {
            assert.equal(s.writes[0].gain, recommended);
            assert.ok(Math.abs(s.writes[0].metadata.rawPeak - rawPeak) < 1e-6);
            assert.ok(Math.abs(s.writes[0].metadata.noisePeak - 0.001) < 1e-6);
            assert.equal(s.gainNodes.at(-1).gain.value, recommended);
        }
        s.det.destroy();
    });
}

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

for (const failure of ['silence', 'stalled input']) {
    test(`failed ${failure} recapture cannot save the previous playing measurement`, async () => {
        const s = setup();
        await s.capture();
        if (failure === 'silence') s.setPeak(0);
        else s.stallInput();
        await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
        assert.match(s.overlay.querySelector('.nd-cal-auto-status').innerHTML,
            failure === 'silence' ? /No clear playing signal/ : /Input readings stopped/);
        assert.match(s.body.innerHTML, /class="nd-cal-save-gain[^>]*disabled/);
        await s.body.querySelector('.nd-cal-save-gain').onclick();
        assert.equal(s.writes.length, 0);
        assert.equal(s.state.gain, 1.7, 'retry must keep the currently applied gain');
        assert.deepEqual(s.nativeWrites, []);
        assert.match(s.body.innerHTML, /Capture your playing level/);
        s.det.destroy();
    });
}

test('recapture invalidates a previously saved result and Done stays blocked after failure', async () => {
    const s = setup();
    await s.capture();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.overlay.querySelector('.nd-cal-next').disabled, false);
    s.setPeak(0);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    assert.equal(s.overlay.querySelector('.nd-cal-next').disabled, true);
    s.overlay.querySelector('.nd-cal-next').onclick();
    assert.equal(s.overlay.isConnected, true);
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 1, 'only the explicitly saved first result remains');
    assert.equal(s.state.gain, 2.5);
    s.det.destroy();
});

test('new noise capture invalidates its dependent playing measurement until recaptured', async () => {
    const s = setup();
    await s.capture();
    s.overlay.querySelector('.nd-cal-back').onclick();
    s.setPeak(0.002);
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    s.overlay.querySelector('.nd-cal-next').onclick();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 0);
    assert.match(s.body.innerHTML, /Capture your playing level/);
    s.setPeak(0.05);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].gain, 5);
    assert.equal(s.writes[0].metadata.noisePeak, 0.002);
    assert.equal(s.writes[0].metadata.rawPeak, 0.05);
    s.det.destroy();
});

test('failed noise recapture cannot reuse the previous noise or playing result', async () => {
    const s = setup();
    await s.capture();
    s.overlay.querySelector('.nd-cal-back').onclick();
    s.stallInput();
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    assert.match(s.overlay.querySelector('.nd-cal-auto-status').innerHTML, /Input readings stopped/);
    assert.equal(s.overlay.querySelector('.nd-cal-next').disabled, true);
    s.overlay.querySelector('.nd-cal-next').onclick();
    assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /Noise/);
    assert.equal(s.writes.length, 0);
    assert.equal(s.state.gain, 1.7);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('full browser wizard retains its valid gain recommendation through final Apply', async () => {
    const s = setup({browser: true});
    await s.det.enable();
    await s.open(false);
    const next = () => s.overlay.querySelector('.nd-cal-next').onclick();
    next(); next(); next();
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    await s.tickSampler(2000);
    next();
    s.setPeak(0.1);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.tickSampler(3400);
    next(); next(); next(); next();
    assert.match(s.body.innerHTML, /Apply Recommended Settings/);
    await s.body.querySelector('.nd-cal-apply-safe').onclick();
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].gain, 2.5);
    assert.ok(Math.abs(s.writes[0].metadata.rawPeak - 0.1) < 1e-6);
    assert.equal(s.gainNodes.at(-1).gain.value, 2.5);
    s.det.destroy();
});

test('pending and cancelled recapture cannot save or restore the prior proposal', async () => {
    const s = setup();
    await s.capture();
    const captureContext = s.service.captureContext;
    let resume;
    s.service.captureContext = () => new Promise(resolve => { resume = resolve; });
    const retry = s.body.querySelector('.nd-cal-start-signal').onclick();
    await flush();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 0, 'save is blocked while capture awaits its profile');
    s.overlay.querySelector('.nd-cal-back').onclick();
    s.service.captureContext = captureContext;
    resume(await captureContext());
    await retry; await flush();
    s.overlay.querySelector('.nd-cal-next').onclick();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 0);
    assert.match(s.body.innerHTML, /Capture your playing level/);
    assert.equal(s.state.gain, 1.7);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('back and forward without recapture preserves the measured proposal', async () => {
    const s = setup();
    await s.capture();
    s.overlay.querySelector('.nd-cal-back').onclick();
    s.overlay.querySelector('.nd-cal-next').onclick();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal(s.writes.length, 1);
    assert.equal(s.writes[0].gain, 2.5);
    s.det.destroy();
});

test('draft calibration cannot return an old proposal after failed recapture', async () => {
    const s = setup();
    const {pending} = await s.captureDraft();
    let settled = false; pending.then(() => { settled = true; });
    s.setPeak(0);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.body.querySelector('.nd-cal-save-gain').onclick(); await flush();
    assert.equal(settled, false);
    assert.equal(s.overlay.isConnected, true);
    assert.match(s.body.innerHTML, /Capture your playing level/);
    s.setPeak(0.05);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    const result = await pending;
    assert.equal(result.gain, 5);
    assert.equal(result.metadata.rawPeak, 0.05);
    assert.equal(s.state.gain, 1.7);
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.nativeWrites, []);
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

test('draft bass calibration returns a proposal only after Use calibration, without saving or changing gain', async () => {
    const s = setup();
    const {pending} = await s.captureDraft();
    let settled = false; pending.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false);
    assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /My bass/);
    assert.match(s.body.innerHTML, /bass notes or plucks/);
    assert.match(s.body.innerHTML, /Use calibration/);
    assert.equal(s.overlay.querySelector('.nd-cal-next').style.display, 'none');
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    const result = await pending;
    assert.equal(result.gain, 2.5);
    assert.equal(result.context.type, 'bass');
    assert.equal(result.context.routeKey, 'interface:0');
    assert.equal(result.metadata.rawPeak, 0.1);
    assert.equal(result.metadata.method, 'guided-level-v1');
    assert.equal(s.state.activeId, 'default');
    assert.equal(s.state.gain, 1.7);
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.nativeWrites, []);
    assert.equal(s.overlay.isConnected, false);
    s.det.destroy();
});

for (const afterCapture of [false, true]) {
    test(`cancelling draft calibration ${afterCapture ? 'after capture' : 'before capture'} resolves null without persistence`, async () => {
        const s = setup();
        const {pending} = await (afterCapture ? s.captureDraft() : s.draft());
        s.det.closeCalibrationWizard();
        assert.equal(await pending, null);
        assert.equal(s.state.gain, 1.7);
        assert.deepEqual(s.writes, []);
        assert.deepEqual(s.nativeWrites, []);
        s.det.destroy();
    });
}

for (const mutation of [{activeId: 'other'}, {routeKey: 'interface:1'}, {sessionLocked: true}]) {
    test(`draft calibration cannot finish after ${Object.keys(mutation)[0]} changes`, async () => {
        const s = setup();
        const {pending} = await s.captureDraft();
        s.change(mutation);
        await s.body.querySelector('.nd-cal-save-gain').onclick();
        assert.match(s.body.innerHTML, /changed.*Start again/);
        assert.deepEqual(s.writes, []);
        s.det.closeCalibrationWizard();
        assert.equal(await pending, null);
        s.det.destroy();
    });
}

test('closing a draft while final validation is pending prevents a late measurement result', async () => {
    const s = setup();
    const {pending} = await s.captureDraft();
    let resume;
    s.service.refresh = () => new Promise(resolve => { resume = resolve; });
    const finishing = s.body.querySelector('.nd-cal-save-gain').onclick();
    await flush();
    s.det.closeCalibrationWizard();
    assert.equal(await pending, null);
    resume(s.state);
    await finishing;
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.nativeWrites, []);
    s.det.destroy();
});

test('draft calibration can bind an input started and selected before its first measurement', async () => {
    const s = setup({initialRunning: false});
    s.service.refresh = async () => ({...s.state, applied: !!s.state.routeKey});
    const {pending} = await s.draft();
    assert.match(s.overlay.querySelector('.nd-cal-title').textContent, /Audio Input/);
    s.startInput();
    await s.refreshWizard();
    await s.body.querySelector('.nd-cal-enable-detect').onclick();
    const channel = s.body.querySelector('.nd-cal-native-channel');
    channel.value = '0'; channel.onchange();
    await s.body.querySelector('.nd-cal-use-channel').onclick();
    s.overlay.querySelector('.nd-cal-next').onclick();
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    s.overlay.querySelector('.nd-cal-next').onclick();
    s.setPeak(0.1);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    const result = await pending;
    assert.equal(result.gain, 2.5);
    assert.equal(result.context.routeKey, 'interface:0');
    assert.deepEqual(s.writes, []);
    s.det.destroy();
});

test('browser draft returns calibrated gain while preserving the live active-profile gain', async () => {
    const s = setup({browser: true});
    const {pending} = await s.draft('guitar', 'Tele');
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    await s.tickSampler(2000);
    s.overlay.querySelector('.nd-cal-next').onclick();
    s.setPeak(0.1);
    await s.body.querySelector('.nd-cal-start-signal').onclick(); await flush();
    await s.tickSampler(3400);
    await s.body.querySelector('.nd-cal-save-gain').onclick();
    assert.equal((await pending).gain, 2.5);
    assert.equal(s.gainNodes.at(-1).gain.value, 1.7);
    assert.deepEqual(s.writes, []);
    s.det.destroy();
});

test('draft calibration rejects a changed instrument type before opening', async () => {
    const s = setup();
    const context = await s.service.captureDraftContext('guitar');
    await assert.rejects(s.det.measureInstrumentGain({type: 'bass', name: 'Bass', context}), /instrument type changed/);
    assert.equal(s.overlay, undefined);
    assert.deepEqual(s.writes, []);
    s.det.destroy();
});

test('selected Bass level calibration keeps its name and playing instructions after a guitar song', async () => {
    const s = setup();
    s.change({activeId: 'jazz-bass', activeName: 'Jazz Bass', activeType: 'bass'});
    s.sb.highway.getSongInfo = () => ({arrangement: 'guitar-lead', tuning: [0, 0, 0, 0, 0, 0]});
    s.sb.feedBack.instrumentSession = {isLocked: () => false};
    await s.det.launchGuitarCalibration(); await flush();
    assert.match(s.body.innerHTML, /Jazz Bass.*Bass/);
    await s.body.querySelector('.nd-cal-start-noise').onclick(); await flush();
    s.overlay.querySelector('.nd-cal-next').onclick();
    assert.match(s.body.innerHTML, /strongest normal bass notes or plucks/);
    s.det.destroy();
});

for (const inSong of [false, true]) {
    test(`full Bass setup ${inSong ? 'preserves a loaded song tuning' : 'uses selected five-string Bass after leaving a guitar song'}`, async () => {
        const s = setup();
        s.change({activeId: 'jazz-bass', activeName: 'Jazz Bass', activeType: 'bass'});
        s.sb.highway.getSongInfo = () => ({arrangement: 'guitar-lead', tuning: [-2, 0, 0, 0, 0, 0]});
        s.sb.highway.getStringCount = () => 6;
        s.sb.feedBack.instrumentSession = {isLocked: () => inSong};
        s.sb.feedBack.workingTuning = {get: () => ({instrument: 'bass', stringCount: 5})};
        await s.open(false);
        for (let i = 0; i < 5; i++) { s.overlay.querySelector('.nd-cal-next').onclick(); await flush(); }
        if (inSong) {
            assert.match(s.body.innerHTML, /Open low string \(D2\)/);
            assert.doesNotMatch(s.body.innerHTML, /Auto \(5-string bass\)/);
        } else {
            assert.match(s.body.innerHTML, /Auto \(5-string bass\)/);
            assert.match(s.body.innerHTML, /Open low string \(B0\)/);
            assert.equal(s.det._getChartState().arrangement, 'bass');
            assert.equal(s.det._getChartState().stringCount, 5);
        }
        s.det.destroy();
    });
}
