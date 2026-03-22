'use strict';

/**
 * Unit tests for GameSFX.
 *
 * Verifies that compressor settings are within safe ranges (no pumping /
 * clipping artifacts), that gain levels stay at or below 0 dBFS before the
 * master compressor, and that every public play*() method executes without
 * exceptions when given a mock Web Audio API context.
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
    constructor(channels, length) {
        this._data = new Float32Array(length);
    }
    getChannelData() { return this._data; }
    get duration()   { return 1.0; }
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
    createBuffer(ch, len)      { return new AudioBuffer(ch, len); }
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

// Load GameSFX into the global scope.
// eval() in a CommonJS module does not promote `class` or `const` declarations
// to the outer scope, so we patch the two top-level declarations before
// evaluating: the class becomes an assignment to global.GameSFX, and the
// singleton const becomes an assignment to global.gameSFX.
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'sfx.js'), 'utf8');
    const patched = src
        .replace(/^class GameSFX\b/m,          'global.GameSFX = class GameSFX')
        .replace(/^const gameSFX\s*=/m,         'global.gameSFX =');
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
    assert(gameSFX.master !== null,        'master compressor node was created');
    assert(gameSFX.persistentNoise !== null, 'persistent noise buffer was created');
});

test('Master compressor – threshold: above gun-shot level to prevent pumping', () => {
    // A player gun-shot peaks at ~0.32 linear ≈ -10 dBFS.  The compressor
    // threshold must be ABOVE that (i.e. > -10 dBFS) so normal shots pass
    // through uncompressed and do not cause audible volume pumping.
    // A threshold ≤ -1 dBFS still catches true clipping peaks.
    const thr = mockCtx._compressor.threshold.value;
    assert(thr >= -10, `threshold ${thr} dBFS is ≥ -10 dBFS (won't compress normal gun-shots)`);
    assert(thr <=  -1, `threshold ${thr} dBFS is ≤ -1 dBFS  (still catches hard peaks)`);
});

test('Master compressor – ratio: gentle enough to avoid heavy gain-pumping', () => {
    // A ratio of 10:1 is near-limiting and causes dramatic gain changes on
    // each impulsive sound.  Keep ratio ≤ 6 for transparent compression.
    const ratio = mockCtx._compressor.ratio.value;
    assert(ratio >= 2, `ratio ${ratio} is ≥ 2 (some compression applied)`);
    assert(ratio <= 6, `ratio ${ratio} is ≤ 6 (gentle, avoids heavy pumping)`);
});

test('Master compressor – release: fast enough to recover between rapid-fire shots', () => {
    // At 10 shots/s the interval between shots is 100 ms.  If the release is
    // longer than that, the compressor never fully recovers and the gain
    // "breathes" audibly (pumping).  Keep release ≤ 100 ms.
    const rel = mockCtx._compressor.release.value;
    assert(rel <= 0.10, `release ${rel}s is ≤ 0.10 s (recovers between rapid shots)`);
    assert(rel >= 0.01, `release ${rel}s is ≥ 0.01 s (not instantaneously abrupt)`);
});

test('Master compressor – knee: not so wide it compresses every quiet sound', () => {
    // A 24 dB soft-knee applied at -18 dBFS means the compressor is already
    // active at -30 dBFS — effectively always on.  Limit knee to ≤ 10 dB.
    const knee = mockCtx._compressor.knee.value;
    assert(knee <= 10, `knee ${knee} dB is ≤ 10 dB (avoids always-on compression zone)`);
});

test('Explosion noiseGain peak ≤ 1.0 – no pre-compressor clipping', () => {
    // initVol values above 1.0 send the post-distortion signal above 0 dBFS
    // before the master compressor even sees it, causing hard clipping artifacts
    // (the "scraping and distortion" described in the issue).
    const src = fs.readFileSync(path.join(__dirname, '..', 'sfx.js'), 'utf8');
    // Match the initVol assignment line inside playExplosion
    const match = src.match(/const initVol\s*=\s*([^\n;]+)[;\n]/);
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
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`PASS – all ${passed} assertion(s) passed.`);
    process.exit(0);
} else {
    console.error(`FAIL – ${failed} assertion(s) failed, ${passed} passed.`);
    process.exit(1);
}
