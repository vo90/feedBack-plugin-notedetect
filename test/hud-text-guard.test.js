const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Frozen original HUD block from bb1c24a64dbacaab879bebe4009c2b6ce45272fb.
// Never executed directly: the test evaluates its source in an isolated fixture.
function frozenBaselineHud() {
    function createHUD() {
        if (instanceRoot.querySelector('.nd-hud')) return;
        // Re-stamp the skin on (re)create — another instance (or the
        // settings screen) may have switched it while this HUD was down.
        try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        const hud = document.createElement('div');
        // All layout/typography lives in assets/plugin.css, themed by the
        // instanceRoot's data-nd-skin attribute. Class names queried by
        // updateHUD()/_drillRender() are load-bearing — keep them stable.
        hud.className = 'nd-hud';
        hud.innerHTML = `
            <div class="nd-hud-score">0</div>
            <div class="nd-hud-mainrow">
                <span class="nd-hud-accuracy"></span>
                <span class="nd-hud-mult" data-tier="1">×1</span>
            </div>
            <div class="nd-hud-streak"></div>
            <div class="nd-hud-counts"></div>
            <div class="nd-hud-detected"></div>
            <div class="nd-drill hidden">
                <div class="nd-drill-header"></div>
                <div class="nd-drill-list"></div>
            </div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        // Sync animation state to the live counters so a mid-song re-enable
        // doesn't replay a count-up / multiplier pop for ground it already
        // covered. The badge DOM must be seeded too — createHUD's template
        // hard-codes ×1, and updateHUD only rewrites it on tier CHANGES, so
        // syncing lastMultTier alone would leave a recreated HUD stuck at
        // ×1 while a >1 multiplier is live.
        displayScore = score;
        lastMultTier = multiplier;
        lastStreakVal = streak;
        const multEl = instanceRoot.querySelector('.nd-hud-mult');
        if (multEl) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
        }
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled) return;

        // Bridge slopsmith's loop state into our drill flag. Loop
        // changes normally arrive via the playback:loop-set /
        // playback:loop-cleared events bound in _drillBindEvents; this
        // is only the safety-net poll for hosts that don't emit them,
        // throttled to ~1 Hz — getLoop() is a legacy bridge surface on
        // newer hosts and every call is instrumented (bridge-hit event
        // + diagnostics snapshot), so a 30 Hz poll is NOT cheap.
        const nowMs = Date.now();
        if (nowMs - drillLoopPollLastMs >= DRILL_LOOP_POLL_MS) {
            drillLoopPollLastMs = nowMs;
            _drillSyncFromLoopState();
        }
        // Detect conductor loop wraps from the chart clock (reliable; the
        // host loop:restart event doesn't always reach us on this loop path)
        // and fire the beat-locked metronome. No-op unless a conductor drill
        // is active. Runs every tick (unthrottled) — it reads the local chart
        // clock, not the instrumented getLoop() bridge.
        _drillConductorTick();
        _drillRender();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');
        const scoreEl = instanceRoot.querySelector('.nd-hud-score');
        const multEl = instanceRoot.querySelector('.nd-hud-mult');

        if (scoreEl) {
            // Eased count-up toward the live score; snap instantly downward
            // (a reset/new song should not "count down" from the old total).
            if (score < displayScore) displayScore = score;
            const diff = score - displayScore;
            displayScore = diff < 1 ? score : displayScore + diff * 0.25;
            scoreEl.textContent = String(Math.round(displayScore));
        }

        if (multEl && multiplier !== lastMultTier) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
            if (multiplier > lastMultTier) {
                // Remove + reflow + re-add so consecutive tier-ups retrigger
                // the one-shot keyframe.
                multEl.classList.remove('nd-pop');
                void multEl.offsetWidth;
                multEl.classList.add('nd-pop');
            }
            lastMultTier = multiplier;
        }

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
            if (streak === 0 && lastStreakVal >= 10) {
                // A multiplier-worthy streak just broke — shake the panel.
                const hudEl = instanceRoot.querySelector('.nd-hud');
                if (hudEl) {
                    hudEl.classList.remove('nd-shake');
                    void hudEl.offsetWidth;
                    hudEl.classList.add('nd-shake');
                }
            } else if (streak > lastStreakVal && _ndIsStreakMilestone(streak)) {
                streakEl.classList.remove('nd-flash');
                void streakEl.offsetWidth;
                streakEl.classList.add('nd-flash');
            }
            lastStreakVal = streak;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {
            // Clear on zero-total so a reset/new-song enable doesn't
            // show the previous session's `X / Y` until the first
            // judgment lands. Mirrors the accuracy label's else-branch.
            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
                // Use the chart-corrected display MIDI when available;
                // otherwise use the raw detected MIDI. Bass, 7-string guitar,
                // non-standard tuning, and capo all still route through the
                // same MIDI-name formatter instead of string-index lookups.
                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {
                // No confident single-note detected this frame, but we
                // have a recent chord score from the constraint path —
                // show it for a short TTL after the chord's chart time
                // so the readout doesn't linger forever through silence
                // / noise between notes.
                const songTime = _ndPresentationTime(hw, latencyOffset);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            // Track pending flash timeouts so destroy()/disable() can
            // clear them. Each timeout self-splices from the list on
            // fire so the array doesn't grow unbounded across a long
            // session (~60 min of play at ~20 hits/min was previously
            // accumulating ~1200 stale entries before disable ran).
            const spawnFlash = (color) => {
                // slopsmith#254 — off by default now that the highway
                // renderer lights the note itself; opt back in via the
                // "Screen-edge flash on hit/miss" toggle.
                if (!edgeFlashEnabled) return;
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

}
const baseline = frozenBaselineHud.toString().slice('function frozenBaselineHud() {'.length, -1);
const source = fs.readFileSync(path.join(__dirname, '../screen.js'), 'utf8');
const start = source.indexOf('    function createHUD() {');
const end = source.indexOf('    // ── Draw hook overlay', start);
assert.ok(start >= 0 && end > start, 'production HUD source boundaries');
const candidate = source.slice(start, end);
const names = ['accuracy', 'streak', 'counts', 'detected', 'score', 'mult'];

function fixture(code) {
    const effects = [], elements = new Map(), timeouts = new Map();
    let timeoutId = 0;
    function element(name, initialText = '') {
        let text = initialText, writes = 0;
        const attributes = {}, classes = new Set();
        const style = new Proxy({}, { set(target, key, value) {
            effects.push(['style', name, key, value]); target[key] = value; return true;
        } });
        return {
            get textContent() { return text; },
            set textContent(value) { text = value; writes++; },
            get writes() { return writes; }, style, attributes, classes,
            setAttribute(key, value) { attributes[key] = value; effects.push(['attr', name, key, value]); },
            classList: {
                add(value) { classes.add(value); effects.push(['add', name, value]); },
                remove(value) { classes.delete(value); effects.push(['remove', name, value]); },
            },
            get offsetWidth() { effects.push(['reflow', name]); return 10; },
        };
    }
    function recreate() {
        for (const name of names) elements.set('.nd-hud-' + name, element(name));
        elements.set('.nd-hud', element('hud'));
        elements.set('.nd-flash-overlay', element('flash'));
    }
    recreate();
    const state = {
        enabled: true, now: 0, time: 0, Date: { now: () => state.now },
        drillLoopPollLastMs: 0, DRILL_LOOP_POLL_MS: 1000,
        _drillSyncFromLoopState() { effects.push(['poll']); },
        _drillConductorTick() { effects.push(['conductor']); },
        _drillRender() { effects.push(['drill']); },
        hits: 0, misses: 0, streak: 0, bestStreak: 0, score: 0, displayScore: 0,
        multiplier: 1, lastMultTier: 1, lastStreakVal: 0,
        _ndIsStreakMilestone: n => n === 25 || n === 50 || (n > 0 && n % 100 === 0),
        detectedString: -1, detectedConfidence: 0, detectionConfidenceMin: .5,
        detectedDisplayMidi: 64, detectedMidi: 64, detectedFret: 0,
        _ndMidiToName: n => 'MIDI' + n,
        lastChordScore: null, lastChordTime: 0, lastChordHit: 2, lastChordTotal: 3,
        latencyOffset: 17, hw: {},
        _ndPresentationTime(hw, offset) { effects.push(['clock', offset]); return state.time; },
        edgeFlashEnabled: false, lastHitCount: 0, lastMissCount: 0, flashTimeouts: [],
        setTimeout(callback, delay) { const id = ++timeoutId; timeouts.set(id, callback); effects.push(['timeout', id, delay]); return id; },
        instanceRoot: { querySelector: selector => elements.get(selector) || null },
    };
    vm.createContext(state);
    const helperStart = code.indexOf('    function _ndSetHudText(');
    vm.runInContext(code.slice(helperStart >= 0 ? helperStart : code.indexOf('    function updateHUD() {')), state);
    function snapshot() {
        return {
            elements: [...elements].map(([name, el]) => [name, el.textContent, { ...el.style }, { ...el.attributes }, [...el.classes]]),
            state: ['displayScore', 'lastMultTier', 'lastStreakVal', 'lastHitCount', 'lastMissCount', 'drillLoopPollLastMs']
                .map(key => [key, state[key]]),
            pending: [...state.flashTimeouts], effects: effects.slice(),
        };
    }
    return { state, effects, elements, recreate, snapshot, element,
        el: name => elements.get('.nd-hud-' + name),
        writes: () => [...elements.values()].reduce((sum, el) => sum + el.writes, 0),
        flush() { for (const callback of timeouts.values()) callback(); timeouts.clear(); },
    };
}

function pair() {
    const a = fixture(baseline), b = fixture(candidate);
    function tick(patch = {}) {
        for (const f of [a, b]) { Object.assign(f.state, patch); f.state.updateHUD(); }
        assert.deepEqual(b.snapshot(), a.snapshot());
    }
    return { a, b, tick };
}

test('settled text stops mutating while every HUD tick and safety poll still run', () => {
    const { a, b, tick } = pair();
    tick({ hits: 3, misses: 1, score: 100, displayScore: 100, streak: 3, bestStreak: 5,
        detectedString: 1, detectedConfidence: .9 });
    const oldWrites = a.writes(), newWrites = b.writes();
    for (let i = 1; i <= 100; i++) tick({ now: i * 33 });
    assert.equal(a.writes() - oldWrites, 500);
    assert.equal(b.writes() - newWrites, 0);
    assert.equal(b.effects.filter(e => e[0] === 'conductor').length, 101);
    assert.equal(b.effects.filter(e => e[0] === 'poll').length, 3);
});

test('each rounded score frame, settling, new judgments and downward reset match baseline', () => {
    const { b, tick } = pair();
    tick({ score: 120, hits: 2, misses: 1, streak: 2, bestStreak: 2 });
    assert.equal(b.el('score').textContent, '30');
    tick(); assert.equal(b.el('score').textContent, '53');
    for (let i = 0; i < 35; i++) tick();
    assert.equal(b.state.displayScore, 120);
    tick({ score: 997, hits: 3 });
    for (let i = 0; i < 30; i++) tick();
    tick({ score: 0, hits: 0, misses: 0, streak: 0, bestStreak: 0 });
    assert.equal(b.el('score').textContent, '0');
    assert.equal(b.el('accuracy').textContent, '');
    assert.equal(b.el('counts').textContent, '');
});

test('detected MIDI fallback, confidence boundary, chord TTL boundary and expiry match', () => {
    const { b, tick } = pair();
    tick({ detectedString: 2, detectedConfidence: .9, detectedDisplayMidi: 45, detectedFret: 7 });
    assert.equal(b.el('detected').textContent, 'MIDI45 · s2 f7');
    tick({ detectedDisplayMidi: NaN, detectedMidi: 47 });
    assert.equal(b.el('detected').textContent, 'MIDI47 · s2 f7');
    tick({ detectedConfidence: .5, lastChordScore: 2 / 3, lastChordTime: 10, time: 11.5 });
    assert.equal(b.el('detected').textContent, 'chord 2/3 (67%)');
    tick({ time: 11.500001 }); assert.equal(b.el('detected').textContent, '');
    tick({ time: 9 }); assert.equal(b.el('detected').textContent, 'chord 2/3 (67%)');
    tick({ lastChordScore: null }); assert.equal(b.el('detected').textContent, '');
});

test('tier pops, streak flashes/shakes and edge-flash timeout ordering are unchanged', () => {
    const { a, b, tick } = pair();
    tick({ edgeFlashEnabled: true, hits: 10, streak: 10, bestStreak: 10, multiplier: 2 });
    tick({ hits: 25, streak: 25, bestStreak: 25, multiplier: 3 });
    tick();
    tick({ misses: 1, streak: 0, multiplier: 1 });
    a.flush(); b.flush(); assert.deepEqual(b.snapshot(), a.snapshot());
    assert.deepEqual(b.effects.filter(e => e[0] === 'reflow'),
        [['reflow', 'mult'], ['reflow', 'mult'], ['reflow', 'streak'], ['reflow', 'hud']]);
    assert.equal(b.state.flashTimeouts.length, 0);
});

test('disabled, missing, recreated and externally changed elements remain correct', () => {
    const { a, b, tick } = pair();
    tick({ hits: 5, misses: 2, score: 50, displayScore: 50 });
    const before = b.snapshot(), writes = b.writes();
    tick({ enabled: false, score: 500 });
    assert.deepEqual(b.snapshot(), before); assert.equal(b.writes(), writes);
    a.recreate(); b.recreate(); tick({ enabled: true });
    assert.equal(b.el('counts').textContent, '5 / 7');
    for (const f of [a, b]) f.el('counts').textContent = 'external text';
    tick(); assert.equal(b.el('counts').textContent, '5 / 7');
    a.elements.clear(); b.elements.clear(); tick();
    a.recreate(); b.recreate(); tick();
});

test('independent split-screen instances do not share text or animation state', () => {
    const first = pair(), second = pair();
    first.tick({ hits: 2, score: 80, displayScore: 80 });
    second.tick({ hits: 9, misses: 1, score: 900, displayScore: 900 });
    first.tick(); second.tick();
    assert.equal(first.b.el('counts').textContent, '2 / 2');
    assert.equal(second.b.el('counts').textContent, '9 / 10');
    first.a.recreate(); first.b.recreate(); first.tick(); second.tick();
});

// Opt in with the existing host Playwright installation via NODE_PATH and,
// when necessary, HUD_BROWSER_EXECUTABLE. No browser downloads are performed.
test('real DOM: hidden/core/detailed modes, lifecycle and unchanged text mutations',
    { skip: !process.env.HUD_BROWSER_TEST }, async () => {
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true,
            ...(process.env.HUD_BROWSER_EXECUTABLE ? { executablePath: process.env.HUD_BROWSER_EXECUTABLE } : {}) });
        try {
            const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
            const result = await page.evaluate(({ baseline, candidate }) => {
                document.head.innerHTML = `<style>
                    html:not([data-scoreboard="detailed"]):not([data-scoreboard="off"]) .nd-hud { display:none!important }
                    html[data-scoreboard="off"] .nd-hud { display:none!important }
                </style>`;
                function setup(code) {
                    const root = document.createElement('div'); document.body.appendChild(root);
                    const ticks = [], clears = [];
                    const s = { document, instanceRoot: root, enabled: true, _ndLoadSkin: () => 'arcade',
                        hits: 3, misses: 1, score: 100, displayScore: 100, streak: 3, bestStreak: 5,
                        multiplier: 2, lastMultTier: 1, lastStreakVal: 0,
                        Date: { now: () => 0 }, drillLoopPollLastMs: 0, DRILL_LOOP_POLL_MS: 1000,
                        _drillSyncFromLoopState() {}, _drillConductorTick() { ticks.push('conductor'); }, _drillRender() {},
                        _ndIsStreakMilestone: () => false, detectedString: 1, detectedConfidence: .9,
                        detectionConfidenceMin: .5, detectedDisplayMidi: 64, detectedMidi: 64,
                        detectedFret: 2, _ndMidiToName: () => 'E4', lastChordScore: null,
                        edgeFlashEnabled: false, lastHitCount: 0, lastMissCount: 0, flashTimeouts: [], hudInterval: null,
                        setInterval(fn, ms) { ticks.push(ms); return ticks.length; }, clearInterval(id) { clears.push(id); } };
                    const api = new Function('s', 'with(s) {' + code + '; return { startHUD, stopHUD, updateHUD }; }')(s);
                    return { root, s, api, ticks, clears };
                }
                const a = setup(baseline), b = setup(candidate);
                const output = [];
                function snapshot(f) { return { html: f.root.innerHTML, ticks: f.ticks.slice(), clears: f.clears.slice(),
                    displayScore: f.s.displayScore, display: getComputedStyle(f.root.querySelector('.nd-hud')).display }; }
                a.api.startHUD(); b.api.startHUD(); a.api.updateHUD(); b.api.updateHUD();
                for (const mode of ['core', 'off', 'detailed']) {
                    document.documentElement.dataset.scoreboard = mode;
                    const observers = [a, b].map(f => { const o = new MutationObserver(() => {});
                        o.observe(f.root, { subtree: true, childList: true, characterData: true }); return o; });
                    for (let i = 0; i < 20; i++) { a.api.updateHUD(); b.api.updateHUD(); }
                    output.push({ mode, a: snapshot(a), b: snapshot(b), mutations: observers.map(o => o.takeRecords().length) });
                    observers.forEach(o => o.disconnect());
                }
                for (const f of [a, b]) { f.api.stopHUD(); f.api.startHUD(); f.api.updateHUD(); }
                output.push({ mode: 'recreated', a: snapshot(a), b: snapshot(b) });
                return output;
            }, { baseline, candidate });
            for (const row of result) {
                assert.deepEqual(row.b, row.a, row.mode + ' lifecycle/DOM/state parity');
                if (row.mutations) {
                    assert.equal(row.mutations[0], 100, row.mode + ' baseline child replacements');
                    assert.equal(row.mutations[1], 0, row.mode + ' candidate child replacements');
                    assert.equal(row.b.display, row.mode === 'detailed' ? 'block' : 'none');
                }
            }
        } finally { await browser.close(); }
    });
