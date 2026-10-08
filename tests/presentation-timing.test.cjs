const {test} = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../screen.js'), 'utf8');
const helper = source.slice(0, source.indexOf('// Note Detection plugin'));
const time = new Function(helper + '; return _ndPresentationTime;')();
test('note judgments and visible cues share presentation while input age stays independent', () => {
    const ages = [];
    const hw = {getTime: () => 99, getAvOffset: () => -500, getPresentationTime: age => { ages.push(age); return 10 - age / 1000; }};
    assert.equal(time(hw), 10); assert.equal(time(hw, .002), 9.998);
    assert.deepEqual(ages, [0, 2]);
    assert.equal(time({getTime: () => 10, getAvOffset: () => -100}, .002), 9.898);
});
test('matching, misses and verifier pushes use the same presentation helper', () => {
    assert.match(source, /const playheadAudio = _ndPresentationTime\(hw, latencyOffset\)/);
    assert.match(source, /const missJudgedAt = _ndPresentationTime\(hw, latencyOffset\)/);
    assert.match(source, /const t = _ndPresentationTime\(hw, latencyOffset\)/);
    assert.doesNotMatch(source, /const (?:t|playheadAudio|missJudgedAt) = .*getTime\(\).* - latencyOffset/);
});
