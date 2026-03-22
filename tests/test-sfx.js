'use strict';

/**
 * Unit tests for GameSFX.
 *
 * Verifies that the master output node is a plain GainNode (no compressor),
 * that gain levels stay at or below 0 dBFS, and that every public play*()
 * method executes without exceptions when given a mock Web Audio API context.
 *
 * Usage:  node tests/test-sfx.js
 * Exit 0 = PASS, Exit 1 = FAIL.
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Web Audio API mock
// ─────────────────────────────────────────────────────────────────────────────

class AudioParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime(v)          { this.value = v; return this; }
    linearRampToValueAtTime()  { return this; }
    exponentialRampToValueAtTime() { return this; }
    setTargetAtTime()          { return this; }
    cancelScheduledValues()    { return this; }
    cancelAndHoldAtTime()      { return this; }
}

class AudioNode {
    connect(node) { return node; }
    disconnect()  {}
}

class GainNode extends AudioNode {
    constructor() { super(); this.gain = new AudioParam(1); }
}

class DynamicsCompressor extends AudioNode {
    constructor() {
        super();
        this.threshold = new AudioParam(-24);
        this.knee      = new AudioParam(30);
        this.ratio     = new AudioParam(12);
        this.attack    = new AudioParam(0.003);
        this.release   = new AudioParam(0.25);
    }
}

class BiquadFilterNode extends AudioNode {
    constructor() {
        super();
        this.type      = 'lowpass';
        this.frequency = new AudioParam(350);
        this.Q         = new AudioParam(1);
    }
}

class OscillatorNode extends AudioNode {
    constructor() {
        super();
        this.type      = 'sine';
        this.frequency = new AudioParam(440);
        this.detune    = new AudioParam(0);
    }
    start() {}
    stop()  {}
}

class WaveShaperNode extends AudioNode {
    constructor() { super(); this.curve = null; this.oversample = 'none'; }
}

class AudioBuffer {
    constructor(channels, length, sampleRate) {
        this._data       = new Float32Array(length);
        this._sampleRate = sampleRate || 44100;
    }
    getChannelData() { return this._data; }
    get duration()   { return this._data.length / this._sampleRate; }
    get length()     { return this._data.length; }
}

class BufferSourceNode extends AudioNode {
    constructor() {
        super();
        this.buffer = null;
        this.loop   = false;
    }
    start()  {}
    stop()   {}
}

class StereoPannerNode extends AudioNode {
    constructor() { super(); this.pan = new AudioParam(0); }
}

class PannerNode extends AudioNode {
    constructor() {
        super();
        this.panningModel  = 'equalpower';
        this.distanceModel = 'inverse';
        this.refDistance   = 1;
        this.maxDistance   = 10000;
        this.rolloffFactor = 1;
        this.positionX     = new AudioParam(0);
        this.positionY     = new AudioParam(0);
        this.positionZ     = new AudioParam(0);
    }
    setPosition() {}
}

class MockAudioContext {
    constructor() {
        this.sampleRate  = 44100;
        this._time       = 0.1;
        this.destination = new AudioNode();
        this.listener    = {
            positionX : new AudioParam(), positionY : new AudioParam(), positionZ : new AudioParam(),
            forwardX  : new AudioParam(), forwardY  : new AudioParam(), forwardZ  : new AudioParam(),
            upX       : new AudioParam(), upY       : new AudioParam(), upZ       : new AudioParam(),
        };
        this._compressor = null;
    }
    get currentTime() { return this._time; }
    createGain()               { return new GainNode(); }
    createDynamicsCompressor() { const c = new DynamicsCompressor(); this._compressor = c; return c; }
    createOscillator()         { return new OscillatorNode(); }
    createBiquadFilter()       { return new BiquadFilterNode(); }
    createWaveShaper()         { return new WaveShaperNode(); }
    createBufferSource()       { return new BufferSourceNode(); }
    createBuffer(ch, len)      { return new AudioBuffer(ch, len, this.sampleRate); }
    createPanner()             { return new PannerNode(); }
    createStereoPanner()       { return new StereoPannerNode(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inject globals required by sfx.js
// ─────────────────────────────────────────────────────────────────────────────

const mockCtx = new MockAudioContext();
global.getAudioContext  = () => mockCtx;
global.userStartAudio   = () => {};
global.lerp             = (a, b, t) => a + (b - a) * t;
global.constrain        = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
global.gameState        = { players: [] };

// Read sfx.js once and reuse across all tests that inspect the source.
const sfxSrc = fs.readFileSync(path.join(__dirname, '..', 'sfx.js'), 'utf8');

// Load GameSFX into the global scope.
// sfx.js uses `class` and `const` at the top level, which eval() does not
// promote to the module scope.  We therefore patch those two declarations to
// global assignments before evaluating.  eval() of a local trusted file in a
// Node.js test runner is an established pattern when the file under test was
// not written as an ES/CommonJS module (it targets a browser global environment).
{
    const patched = sfxSrc
        .replace(/^class GameSFX\b/m,  'global.GameSFX = class GameSFX')
        .replace(/^const gameSFX\s*=/m, 'global.gameSFX =');
    eval(patched); // eslint-disable-line no-eval
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal test runner
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) {
        console.log(`  PASS  ${msg}`);
        passed++;
    } else {
        console.error(`  FAIL  ${msg}`);
        failed++;
    }
}

function test(name, fn) {
    console.log(`\n${name}`);
    try {
        fn();
    } catch (e) {
        console.error(`  FAIL  threw unexpectedly: ${e.message}`);
        failed++;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test('GameSFX initialises without error', () => {
    gameSFX.init();
    assert(gameSFX.initialized === true,   'initialized flag is true after init()');
    assert(gameSFX.ctx === mockCtx,        'ctx is the injected AudioContext');
    assert(gameSFX.master !== null,        'master gain node was created');
    assert(gameSFX.persistentNoise !== null, 'persistent noise buffer was created');
});

test('Master output is a plain GainNode – no compressor pumping', () => {
    // The DynamicsCompressor caused audible pumping/ducking on every gun shot
    // and explosion and can introduce crackle.  The master stage is now a
    // simple GainNode.  Gain must be < 1.0 to leave headroom, and > 0.4 so
    // sounds are audible.
    assert(
        !(gameSFX.master instanceof DynamicsCompressor),
        'master is NOT a DynamicsCompressor (no pumping/ducking)'
    );
    assert(
        gameSFX.master instanceof GainNode,
        'master is a GainNode (simple, artefact-free)'
    );
    const g = gameSFX.master.gain.value;
    assert(g > 0.4 && g <= 1.0, `master gain ${g} is in range (0.4, 1.0]`);
});

test('Explosion noiseGain peak ≤ 1.0 – no clipping before master gain', () => {
    // initVol values above 1.0 send the post-distortion signal above 0 dBFS
    // into the master gain stage, causing hard clipping artifacts
    // (the "scraping and distortion" described in the issue).
    const match = sfxSrc.match(/const initVol\s*=\s*([^\n;]+)[;\n]/);
    assert(match !== null, 'initVol assignment found in playExplosion');
    if (match) {
        const expr   = match[1];
        const numLit = (expr.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        const over   = numLit.filter(n => n > 1.0);
        assert(
            over.length === 0,
            `No initVol literal > 1.0 (found: ${over.length ? over.join(', ') : 'none'})`
        );
    }
});

test('playShot does not throw', () => {
    let threw = false;
    try { gameSFX.playShot(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playShot(x,y,z) executes without exception');
});

test('playEnemyShot does not throw for all enemy types', () => {
    for (const type of ['fighter', 'crab']) {
        let threw = false;
        try { gameSFX.playEnemyShot(type, 0, 0, 0); } catch (e) { threw = true; }
        assert(!threw, `playEnemyShot('${type}') executes without exception`);
    }
});

test('playExplosion does not throw for all explosion types', () => {
    const cases = [
        [0, 0, 0, false, ''],
        [0, 0, 0, true,  ''],
        [0, 0, 0, true,  'bomber'],
        [0, 0, 0, false, 'squid'],
        [0, 0, 0, false, 'crab'],
        [0, 0, 0, true,  'colossus'],
    ];
    for (const args of cases) {
        let threw = false;
        try { gameSFX.playExplosion(...args); } catch (e) { threw = true; }
        assert(!threw, `playExplosion(${args}) executes without exception`);
    }
});

test('playMissileFire does not throw', () => {
    let threw = false;
    try { gameSFX.playMissileFire(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playMissileFire executes without exception');
});

test('playBombDrop does not throw for both types', () => {
    for (const type of ['normal', 'mega']) {
        let threw = false;
        try { gameSFX.playBombDrop(type, 0, 0, 0); } catch (e) { threw = true; }
        assert(!threw, `playBombDrop('${type}') executes without exception`);
    }
});

test('playInfectionPulse does not throw', () => {
    let threw = false;
    try { gameSFX.playInfectionPulse(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playInfectionPulse executes without exception');
});

test('playInfectionSpread does not throw', () => {
    let threw = false;
    try { gameSFX.playInfectionSpread(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playInfectionSpread executes without exception');
});

test('playPowerup does not throw for good and bad variants', () => {
    for (const isGood of [true, false]) {
        let threw = false;
        try { gameSFX.playPowerup(isGood, 0, 0, 0); } catch (e) { threw = true; }
        assert(!threw, `playPowerup(${isGood}) executes without exception`);
    }
});

test('playClearInfection does not throw', () => {
    let threw = false;
    try { gameSFX.playClearInfection(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playClearInfection executes without exception');
});

test('playNewLevel does not throw', () => {
    let threw = false;
    try { gameSFX.playNewLevel(); } catch (e) { threw = true; }
    assert(!threw, 'playNewLevel executes without exception');
});

test('playLevelComplete does not throw', () => {
    let threw = false;
    try { gameSFX.playLevelComplete(); } catch (e) { threw = true; }
    assert(!threw, 'playLevelComplete executes without exception');
});

test('playGameOver does not throw', () => {
    let threw = false;
    try { gameSFX.playGameOver(); } catch (e) { threw = true; }
    assert(!threw, 'playGameOver executes without exception');
});

test('playAlarm does not throw', () => {
    let threw = false;
    try { gameSFX.playAlarm(); } catch (e) { threw = true; }
    assert(!threw, 'playAlarm executes without exception');
});

test('playVillagerCure does not throw', () => {
    let threw = false;
    try { gameSFX.playVillagerCure(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playVillagerCure executes without exception');
});

test('playVillagerDeath does not throw', () => {
    let threw = false;
    try { gameSFX.playVillagerDeath(0, 0, 0); } catch (e) { threw = true; }
    assert(!threw, 'playVillagerDeath executes without exception');
});

test('setThrust on/off cycle does not throw', () => {
    let threw = false;
    try {
        gameSFX.setThrust(0, true,  100, 50, 0);
        gameSFX.setThrust(0, true,  110, 50, 0);   // update position while active
        gameSFX.setThrust(0, false, 110, 50, 0);   // stop
    } catch (e) { threw = true; }
    assert(!threw, 'setThrust on/position update/off does not throw');
});

test('updateAmbiance does not throw', () => {
    let threw = false;
    try {
        gameSFX.updateAmbiance(
            { dist: 500, pulseOverlap: 0.6, scanSweepAlpha: 0.4 },
            3,   // infectionCount
            10   // maxInfection
        );
    } catch (e) { threw = true; }
    assert(!threw, 'updateAmbiance executes without exception');
});

test('updateListener does not throw', () => {
    let threw = false;
    try {
        gameSFX.updateListener(0, 0, 0,  0, 0, -1,  0, 1, 0);
    } catch (e) { threw = true; }
    assert(!threw, 'updateListener executes without exception');
});

test('stopAll does not throw', () => {
    let threw = false;
    try { gameSFX.stopAll(); } catch (e) { threw = true; }
    assert(!threw, 'stopAll executes without exception');
});

// ─────────────────────────────────────────────────────────────────────────────
// Rigorous oscillator, modulation and graph-structure tests
// ─────────────────────────────────────────────────────────────────────────────

test('All 18 _levelTunes entries execute without exception', () => {
    assert(
        gameSFX._levelTunes.length === 18,
        `_levelTunes array has exactly 18 entries (found ${gameSFX._levelTunes.length})`
    );
    for (let i = 0; i < gameSFX._levelTunes.length; i++) {
        let threw = false;
        try {
            gameSFX._levelTunes[i](mockCtx, mockCtx.currentTime, mockCtx.destination);
        } catch (e) {
            threw = true;
            console.error(`    tune[${i}] threw: ${e.message}`);
        }
        assert(!threw, `_levelTunes[${i}] executes without exception`);
    }
});

test('Distortion curves are bounded within [-1, 1]', () => {
    // If a waveshaper curve exceeds ±1.0 the downstream audio signal will clip
    // at the DAC, causing audible distortion artefacts independent of compression.
    for (const amount of [60, 400]) {
        const curve = gameSFX.createDistortionCurve(amount);
        let allBounded = true;
        let maxAbs = 0;
        for (let i = 0; i < curve.length; i++) {
            maxAbs = Math.max(maxAbs, Math.abs(curve[i]));
            if (curve[i] < -1 || curve[i] > 1) { allBounded = false; }
        }
        assert(allBounded, `createDistortionCurve(${amount}) all values in [-1, 1] (maxAbs=${maxAbs.toFixed(4)})`);
        assert(curve[curve.length - 1] > 0, `createDistortionCurve(${amount}) positive at x = +1`);
        assert(curve[0] < 0,               `createDistortionCurve(${amount}) negative at x = -1`);
    }
});

test('Persistent noise buffer has correct sample count and is filled', () => {
    const buf = gameSFX.persistentNoise;
    assert(buf !== null, 'persistentNoise is not null');

    const expectedLen = Math.floor(mockCtx.sampleRate * 3.0); // 3 s at 44100 Hz
    const data = buf.getChannelData(0);
    assert(
        data.length === expectedLen,
        `noise buffer length ${data.length} === expected ${expectedLen} (3 s @ ${mockCtx.sampleRate} Hz)`
    );

    // Buffer must contain non-zero samples (random white noise was written)
    let allZero = true;
    for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) { allZero = false; break; }
    }
    assert(!allZero, 'noise buffer contains non-zero (white noise) samples');

    // Cross-fade: the first sample should have been blended from the tail.
    // After the blend loop, data[0] is replaced by data[len-blend+0], so the
    // very first sample is no longer the same as an un-touched middle sample.
    // We can verify the buffer is not a trivial all-zero or constant buffer.
    const sampleCount = Math.min(100, data.length);
    let minVal = data[0];
    let maxVal = data[0];
    for (let i = 1; i < sampleCount; i++) {
        const v = data[i];
        if (v < minVal) { minVal = v; }
        if (v > maxVal) { maxVal = v; }
    }
    assert(maxVal - minVal > 0.1, `noise buffer first 100 samples have variation > 0.1 (range: ${(maxVal - minVal).toFixed(4)})`);
});

test('updateAmbiance called 100 times rapidly does not throw', () => {
    let threw = false;
    try {
        for (let i = 0; i < 100; i++) {
            mockCtx._time += 1 / 60;  // simulate 60 fps frame advance
            gameSFX.updateAmbiance(
                {
                    dist:          300 + i * 3,
                    pulseOverlap:  Math.sin(i * 0.1) * 0.5 + 0.5,
                    scanSweepAlpha: Math.cos(i * 0.07) * 0.5 + 0.5
                },
                i % 6,   // infectionCount
                10       // maxInfection
            );
        }
    } catch (e) { threw = true; console.error('    threw: ' + e.message); }
    assert(!threw, 'updateAmbiance survives 100 rapid calls without throwing');
});

test('stopAll is idempotent – safe to call twice', () => {
    let threw = false;
    try { gameSFX.stopAll(); gameSFX.stopAll(); } catch (e) { threw = true; }
    assert(!threw, 'calling stopAll() twice does not throw');
});

test('setThrust: 20 rapid on/off cycles do not throw or accumulate nodes', () => {
    let threw = false;
    try {
        for (let i = 0; i < 20; i++) {
            gameSFX.setThrust(0, true,  i * 5, 50, 0);
            gameSFX.setThrust(0, false, i * 5, 50, 0);
        }
    } catch (e) { threw = true; }
    assert(!threw, '20 rapid on/off thrust cycles do not throw');
    // After all off-calls, no live thrust nodes should be accumulating
    // (nodes enter a "stopping" state and are cleaned up by timeout)
    const nodeCount = Object.keys(gameSFX.thrustNodes).length;
    assert(nodeCount <= 1, `thrustNodes has ≤ 1 entry after rapid cycling (found ${nodeCount})`);
});

test('setThrust: two-player split-screen does not throw', () => {
    // Simulate two-player mode (spatialEnabled = false, two panning directions)
    const origSpatial = gameSFX.spatialEnabled;
    gameSFX.spatialEnabled = false;
    let threw = false;
    try {
        gameSFX.setThrust(0, true,  0, 50, 0);
        gameSFX.setThrust(1, true,  100, 50, 0);
        gameSFX.setThrust(0, true,  10, 50, 0);   // position update
        gameSFX.setThrust(1, true,  110, 50, 0);
        gameSFX.setThrust(0, false, 10, 50, 0);
        gameSFX.setThrust(1, false, 110, 50, 0);
    } catch (e) { threw = true; }
    gameSFX.spatialEnabled = origSpatial;
    assert(!threw, 'two-player thrust (spatialEnabled=false) does not throw');
});

test('Level tune 6: tremolo uses intermediate gain stage, not direct masterGain.gain modulation', () => {
    // Root cause of "clicking and scraping" at level transitions:
    // tremoloGain (amplitude ±0.5) was connected directly to masterGain.gain.
    // masterGain schedules values starting at 0.0, so the effective gain ranged
    // from -0.5 to +0.8 — causing phase inversions at 6 Hz (= ~12 clicks/sec).
    //
    // Fix: route the LFO through a dedicated tremoloAmp GainNode whose base
    // value is 1.0.  The LFO then modulates tremoloAmp.gain in [0.6, 1.4]
    // (always positive), and the oscillator signal goes through tremoloAmp
    // before the master envelope — never negative.

    assert(
        !/tremoloGain\.connect\(\s*masterGain\.gain\s*\)/.test(sfxSrc),
        'tune 6: tremoloGain is NOT connected directly to masterGain.gain (prevents negative gain range)'
    );
    assert(
        /tremoloGain\.connect\(\s*tremoloAmp\.gain\s*\)/.test(sfxSrc),
        'tune 6: tremoloGain connects to tremoloAmp.gain (intermediate amplitude stage)'
    );
    // tremoloAmp must have a base gain of 1.0 so that LFO ±depth never produces a negative value
    const ampBaseMatch = sfxSrc.match(/tremoloAmp\.gain\.value\s*=\s*([\d.]+)/);
    assert(ampBaseMatch !== null, 'tune 6: tremoloAmp.gain.value is explicitly set');
    if (ampBaseMatch) {
        const base = parseFloat(ampBaseMatch[1]);
        assert(base === 1.0, `tune 6: tremoloAmp.gain.value = ${base} (must be 1.0 so LFO keeps range positive)`);
    }
    // LFO depth must be ≤ base (1.0) to keep the range [1-depth, 1+depth] ≥ 0
    const depthMatch = sfxSrc.match(/tremoloGain\.gain\.value\s*=\s*([\d.]+)/);
    assert(depthMatch !== null, 'tune 6: tremoloGain.gain.value is explicitly set');
    if (depthMatch) {
        const depth = parseFloat(depthMatch[1]);
        assert(depth <= 1.0, `tune 6: LFO depth ${depth} ≤ 1.0 (tremoloAmp.gain never negative)`);
        assert(depth > 0,    `tune 6: LFO depth ${depth} > 0 (tremolo effect is audible)`);
    }
});


console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`PASS – all ${passed} assertion(s) passed.`);
    process.exit(0);
} else {
    console.error(`FAIL – ${failed} assertion(s) failed, ${passed} passed.`);
    process.exit(1);
}
