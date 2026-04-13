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

function stripEsmSyntax(src) {
    return src
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*export\s+/gm, '');
}

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
global.window = global;
global.getAudioContext  = () => mockCtx;
global.userStartAudio   = () => {};
global.lerp             = (a, b, t) => a + (b - a) * t;
global.constrain        = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
global.gameState        = { players: [] };

// Read sfx.js and its neighbors
const sfxTunesSrc   = stripEsmSyntax(fs.readFileSync(path.join(__dirname, '..', 'sfxTunes.js'), 'utf8'));
const sfxAmbientSrc = stripEsmSyntax(fs.readFileSync(path.join(__dirname, '..', 'sfxAmbient.js'), 'utf8'));
const sfxWeaponsSrc = stripEsmSyntax(fs.readFileSync(path.join(__dirname, '..', 'sfxWeapons.js'), 'utf8'));
const sfxEnemiesSrc = stripEsmSyntax(fs.readFileSync(path.join(__dirname, '..', 'sfxEnemies.js'), 'utf8'));
const sfxSrc        = stripEsmSyntax(fs.readFileSync(path.join(__dirname, '..', 'sfx.js'), 'utf8'));
const sfxAllSrc     = [sfxSrc, sfxAmbientSrc, sfxWeaponsSrc, sfxEnemiesSrc, sfxTunesSrc].join('\n');

// Load modules into global scope
{
    const patchedTunes = sfxTunesSrc.replace(/^const SFX_LEVEL_TUNES\s*=\s*/m, 'global.SFX_LEVEL_TUNES = ');
    eval(patchedTunes); // eslint-disable-line no-eval
}
eval(sfxAmbientSrc);
eval(sfxWeaponsSrc);
eval(sfxEnemiesSrc);

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

function assertNoThrow(msg, fn) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    assert(!threw, msg);
}

function assertRegexFound(src, regex, msg) {
    const match = src.match(regex);
    assert(match !== null, msg);
    return match;
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
    // simple GainNode at 1.0 so sounds play at their individually tuned volumes.
    assert(
        !(gameSFX.master instanceof DynamicsCompressor),
        'master is NOT a DynamicsCompressor (no pumping/ducking)'
    );
    assert(
        gameSFX.master instanceof GainNode,
        'master is a GainNode (simple, artefact-free)'
    );
    const g = gameSFX.master.gain.value;
    assert(g === 1.0, `master gain is 1.0 (sounds play at individually tuned volumes)`);
});

test('Spatializer refDistance covers camera-ship follow distance', () => {
    // The camera follows the player at ~520 units distance (see _zoomOffset).
    // refDistance must be >= 520 so that local player shots play at full designed
    // volume even when the ship tilts (changes Y) within the follow range.
    // At refDistance 150 local shots were attenuated to ~29% and dipped further
    // on ship orientation changes.
    const match = assertRegexFound(sfxAllSrc, /panner\.refDistance\s*=\s*(\d+)/, 'panner.refDistance assignment found in createSpatializer');
    if (match) {
        const rd = Number(match[1]);
        assert(rd >= 520, `refDistance ${rd} covers camera-ship follow distance (≥ 520)`);
    }
});

test('Explosion noiseGain peak ≤ 1.0 – no clipping before master gain', () => {
    // initVol values above 1.0 send the post-distortion signal above 0 dBFS
    // into the master gain stage, causing hard clipping artifacts
    // (the "scraping and distortion" described in the issue).
    const match = assertRegexFound(sfxAllSrc, /const initVol\s*=\s*([^\n;]+)[;\n]/, 'initVol assignment found in playExplosion');
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

test('playShot gainNode safe for 3 in-phase oscillator summation', () => {
    // Three triangle oscillators share a single filter node → gainNode.
    // With ±10-cent detune the beat period is ~790 ms — far longer than the
    // 0.18 s shot, so the three waveforms stay in-phase and their amplitudes
    // ADD to ~3× at the filter output.  gainNode must be ≤ 1.0/3 ≈ 0.333 so
    // the combined output stays below 1.0 dBFS (was 0.32 → 3×0.32 = 0.96 + sub = 1.21 clip).
    const match = assertRegexFound(sfxAllSrc, /playShot[\s\S]{0,600}_makeGainEnv\(ctx,\s*t,\s*([\d.]+),\s*0\.005,\s*dur\)/, 'playShot main _makeGainEnv(…,0.005,dur) found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.333, `playShot gainNode peak ${peak} ≤ 0.333 (safe for 3-osc sum)`);
    }
});

test('playMissileFire gainNode safe for 3-oscillator + noise summation', () => {
    // Three square oscillators plus white noise all feed the same lowpass filter
    // → gainNode.  Peak input reaches ~4× amplitude; gainNode must be ≤ 0.25
    // to keep the combined output below 1.0 (was 0.5 → peak ~2.0 clip).
    const match = assertRegexFound(sfxAllSrc, /playMissileFire[\s\S]{0,600}_makeGainEnv\(ctx,\s*t,\s*([\d.]+)/, 'playMissileFire _makeGainEnv found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.25, `playMissileFire gainNode peak ${peak} ≤ 0.25 (safe for 3-osc+noise sum)`);
    }
});

test('playExplosion subGain leaves headroom for distorted body', () => {
    // The explosion body (noise + oscs → WaveShaper) saturates at ~0.35; multiplied
    // by noiseGain ≈ 0.9 the body contributes ~0.315 at targetNode.  The sub-rumble
    // bypasses the WaveShaper entirely → subGain must be ≤ 0.685 so the combined
    // sum stays below 1.0 (was 0.8 → 0.8+0.315 = 1.115 clip).
    const match = assertRegexFound(sfxAllSrc, /subGain\s*=\s*(?:this|sfxCore)\._makeGainEnv\(ctx,\s*t,\s*([\d.]+)/, 'explosion subGain _makeGainEnv found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.685, `explosion subGain peak ${peak} ≤ 0.685 (leaves room for distorted body ~0.315)`);
    }
});

test('proximityHum gain compensates for bandpass filter attenuation', () => {
    // The proximity hum runs a 60 Hz sawtooth through a bandpass (Q=10, centre
    // 200–600 Hz).  Only the one or two harmonics that fall inside the narrow
    // passband pass; the dominant harmonic amplitude after filtering is ~10–14% of
    // the gain value.  humVol must be ≥ 0.5 so the effective output is audible
    // (was 0.18 → effective ~0.018, inaudible).
    const match = assertRegexFound(sfxAllSrc, /humVol\s*=\s*(?:this|sfxCore)\._infectionProximityAlpha\s*\*\s*([\d.]+)/, 'humVol formula found in updateAmbiance');
    if (match) {
        const coeff = Number(match[1]);
        assert(coeff >= 0.5, `humVol coefficient ${coeff} ≥ 0.5 (compensates bandpass Q=10 attenuation; effective output ~0.10–0.14)`);
    }
});

test('playBombDrop mega peak safe when thrust is simultaneously active', () => {
    // Mega bomb drop is a single oscillator → gain → targetNode.  Thrust engine
    // runs concurrently at ~0.32; mega bomb peak + thrust must stay below 1.0,
    // so mega bomb peak ≤ 0.68.  The normal bomb peak ≤ 0.4 is already safe.
    const match = sfxAllSrc.match(/isMega \? ([\d.]+) : 0\.4, t \+ dur \* 0\.5/);
    assert(match !== null, 'playBombDrop mega peak assignment found');
    if (match) {
        const megaPeak = Number(match[1]);
        assert(megaPeak <= 0.68, `mega bomb peak ${megaPeak} ≤ 0.68 (safe with concurrent thrust ~0.32)`);
    }
});

test('playClearInfection per-oscillator gain is safe for 9-osc sum', () => {
    // 9 sine oscillators connect directly to targetNode.  Worst-case peak amplitude
    // = 9 × gain.  Must be ≤ 0.111 so 9 × gain ≤ 1.0 (was 0.2 → worst case 1.8 clip).
    const match = sfxAllSrc.match(/playClearInfection[\s\S]{0,900}linearRampToValueAtTime\(([\d.]+),\s*t\s*\+\s*0\.05\)/);
    assert(match !== null, 'playClearInfection per-osc gain ramp found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.111, `playClearInfection per-osc gain ${peak} ≤ 0.111 (9 × gain ≤ 1.0)`);
    }
});

test('playClearInfection decay endpoint is near-silence (no end-of-sound scratch)', () => {
    // The 9 oscillators must decay to 0.0001 by t+1.2 so they are inaudible
    // when they are stopped at t+1.3.  The previous value was 0.01 (-40 dBFS):
    // at stop time 9 × 0.01 = 0.09 combined amplitude was abruptly cut mid-cycle,
    // producing the audible scratch/click reported in the bug.
    // Match the exponentialRamp inside playClearInfection that ends at t+1.2.
    const match = sfxAllSrc.match(/playClearInfection[\s\S]{0,1200}exponentialRampToValueAtTime\(([\d.]+),\s*t\s*\+\s*1\.2\)/);
    assert(match !== null, 'playClearInfection exponentialRamp to t+1.2 found');
    if (match) {
        const endpoint = Number(match[1]);
        assert(endpoint <= 0.001, `playClearInfection decay endpoint ${endpoint} ≤ 0.001 (near-silence before stop at t+1.3)`);
    }
});

test('playInfectionSpread gainNode safe when thrust is simultaneously active', () => {
    // A single oscillator → bandpass filter → gainNode fires while the thrust
    // engine runs at ~0.32.  gainNode peak + thrust must stay below 1.0, so
    // gainNode peak must be ≤ 0.68.  Previously 0.8 → 0.8 + 0.32 = 1.12 clip.
    const match = sfxAllSrc.match(/playInfectionSpread[\s\S]{0,800}_makeGainEnv\(ctx,\s*t,\s*([\d.]+),\s*0\.006,\s*dur\)/);
    assert(match !== null, 'playInfectionSpread _makeGainEnv(…,0.006,dur) found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.68, `playInfectionSpread gainNode peak ${peak} ≤ 0.68 (safe with concurrent thrust ~0.32)`);
    }
});

test('playInfectionPulse gainNode safe for WaveShaper-saturated path', () => {
    // WaveShaper saturates the noise+osc path to ≤0.349; gainNode is the output
    // scalar.  Combined with a simultaneous large explosion (0.664) and thrust
    // (0.32), the total budget is 1.0, so gainNode × 0.349 ≤ 0.336, i.e. gainNode
    // ≤ 0.963.  The more conservative hard cap ≤ 0.75 avoids any scenario where
    // multiple infection pulses fire at once.  Previously 0.8, which combined with
    // an explosion + thrust summed to 1.263.
    const match = sfxAllSrc.match(/playInfectionPulse[\s\S]{0,600}_makeGainEnv\(ctx,\s*t,\s*([\d.]+),\s*0\.012,\s*dur\)/);
    assert(match !== null, 'playInfectionPulse _makeGainEnv(…,0.012,dur) found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak <= 0.75, `playInfectionPulse gainNode peak ${peak} ≤ 0.75 (WaveShaper-capped path; safe under simultaneous sounds)`);
    }
});

test('playShot does not throw', () => {
    assertNoThrow('playShot(x,y,z) executes without exception', () => gameSFX.playShot(0, 0, 0));
});

test('playEnemyShot does not throw for all enemy types', () => {
    for (const type of ['fighter', 'crab']) {
        assertNoThrow(`playEnemyShot('${type}') executes without exception`, () => gameSFX.playEnemyShot(type, 0, 0, 0));
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
        assertNoThrow(`playExplosion(${args}) executes without exception`, () => gameSFX.playExplosion(...args));
    }
});

test('playMissileFire does not throw', () => {
    assertNoThrow('playMissileFire executes without exception', () => gameSFX.playMissileFire(0, 0, 0));
});

test('playBombDrop does not throw for both types', () => {
    for (const type of ['normal', 'mega']) {
        assertNoThrow(`playBombDrop('${type}') executes without exception`, () => gameSFX.playBombDrop(type, 0, 0, 0));
    }
});

test('playInfectionPulse does not throw', () => {
    assertNoThrow('playInfectionPulse executes without exception', () => gameSFX.playInfectionPulse(0, 0, 0));
});

test('playInfectionSpread does not throw', () => {
    assertNoThrow('playInfectionSpread executes without exception', () => gameSFX.playInfectionSpread(0, 0, 0));
});

test('playPowerup does not throw for good and bad variants', () => {
    for (const isGood of [true, false]) {
        assertNoThrow(`playPowerup(${isGood}) executes without exception`, () => gameSFX.playPowerup(isGood, 0, 0, 0));
    }
});

test('playClearInfection does not throw', () => {
    assertNoThrow('playClearInfection executes without exception', () => gameSFX.playClearInfection(0, 0, 0));
});

test('playNewLevel does not throw', () => {
    assertNoThrow('playNewLevel executes without exception', () => gameSFX.playNewLevel());
});

test('playLevelComplete does not throw', () => {
    assertNoThrow('playLevelComplete executes without exception', () => gameSFX.playLevelComplete());
});

test('playLevelComplete arpeggio note gain is audibly loud (≥ 0.3)', () => {
    // playLevelComplete plays in isolation (no concurrent sounds), so gains should be
    // well above the action-sound floor.  Previously 0.2 → inaudible in game.
    // The fanfare must be clearly noticeable to reward the player for completing a level.
    const match = sfxAllSrc.match(/playLevelComplete[\s\S]{0,900}linearRampToValueAtTime\(([\d.]+),\s*noteT\s*\+\s*0\.01\)/);
    assert(match !== null, 'playLevelComplete arpeggio peak ramp at noteT+0.01 found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak >= 0.3, `playLevelComplete arpeggio peak ${peak} ≥ 0.3 (audibly loud in isolation)`);
    }
});

test('playLevelComplete lingering chord gain is audibly loud (≥ 0.2)', () => {
    // The lingering sawtooth chord sustains for 1.3 s after the arpeggio.
    // Previously 0.1 → this sustained tail was nearly inaudible.
    const match = sfxAllSrc.match(/playLevelComplete[\s\S]{0,1600}linearRampToValueAtTime\(([\d.]+),\s*noteT\s*\+\s*0\.05\)/);
    assert(match !== null, 'playLevelComplete lingering chord peak ramp at noteT+0.05 found');
    if (match) {
        const peak = Number(match[1]);
        assert(peak >= 0.2, `playLevelComplete lingering chord peak ${peak} ≥ 0.2 (audibly loud)`);
    }
});

test('playLevelComplete fanfare includes bass octave note (≤ 300 Hz)', () => {
    // The arpeggio must contain at least one note at or below 300 Hz (bass octave).
    // Previously the lowest note was C5 (523 Hz) → thin/treble-only fanfare.
    const match = sfxAllSrc.match(/playLevelComplete[\s\S]{0,400}const notes\s*=\s*\[([^\]]+)\]/);
    assert(match !== null, 'playLevelComplete notes array found');
    if (match) {
        const freqs = match[1].split(',').map(Number);
        const hasLow = freqs.some(f => f <= 300);
        assert(hasLow, `playLevelComplete notes include at least one ≤ 300 Hz (bass root present; found: [${freqs.join(', ')}])`);
    }
});

test('playClearInfection noise filter passes mid-range (≤ 2000 Hz highpass cutoff)', () => {
    // The clear-infection noise was highpass-filtered at 4000 Hz (air only, very shrill).
    // Lowering to ≤ 2000 Hz adds mid-range presence and reduces harshness.
    const match = sfxAllSrc.match(/playClearInfection[\s\S]{0,1800}_makeFilter\(ctx,\s*t,\s*'highpass',\s*([\d.]+)\)/);
    assert(match !== null, 'playClearInfection highpass filter frequency found');
    if (match) {
        const cutoff = Number(match[1]);
        assert(cutoff <= 2000, `playClearInfection highpass cutoff ${cutoff} Hz ≤ 2000 (less shrill than 4000)`);
    }
});

test('playClearInfection oscillators include bass octave note (≤ 300 Hz)', () => {
    // Previously [523, 659, 1046] Hz (C5–C6) → thin, high-pitched.
    // Now should include C4 (261.63 Hz) for body.
    const match = sfxAllSrc.match(/playClearInfection[\s\S]{0,200}const freqs\s*=\s*\[([^\]]+)\]/);
    assert(match !== null, 'playClearInfection freqs array found');
    if (match) {
        const freqs = match[1].split(',').map(Number);
        const hasLow = freqs.some(f => f <= 300);
        assert(hasLow, `playClearInfection freqs include at least one ≤ 300 Hz (bass content present; found: [${freqs.join(', ')}])`);
    }
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

test('All 18 level tune entries execute without exception', () => {
    const tuneList = gameSFX._levelTunes || global.SFX_LEVEL_TUNES || [];
    assert(
        tuneList.length === 18,
        `level tune array has exactly 18 entries (found ${tuneList.length})`
    );
    for (let i = 0; i < tuneList.length; i++) {
        let threw = false;
        try {
            tuneList[i].call(gameSFX, mockCtx, mockCtx.currentTime, mockCtx.destination);
        } catch (e) {
            threw = true;
            console.error(`    tune[${i}] threw: ${e.message}`);
        }
        assert(!threw, `level tune[${i}] executes without exception`);
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
        !/tremoloGain\.connect\(\s*masterGain\.gain\s*\)/.test(sfxAllSrc),
        'tune 6: tremoloGain is NOT connected directly to masterGain.gain (prevents negative gain range)'
    );
    assert(
        /tremoloGain\.connect\(\s*tremoloAmp\.gain\s*\)/.test(sfxAllSrc),
        'tune 6: tremoloGain connects to tremoloAmp.gain (intermediate amplitude stage)'
    );
    // tremoloAmp must have a base gain of 1.0 so that LFO ±depth never produces a negative value
    const ampBaseMatch = sfxAllSrc.match(/tremoloAmp\.gain\.value\s*=\s*([\d.]+)/);
    assert(ampBaseMatch !== null, 'tune 6: tremoloAmp.gain.value is explicitly set');
    if (ampBaseMatch) {
        const base = parseFloat(ampBaseMatch[1]);
        assert(base === 1.0, `tune 6: tremoloAmp.gain.value = ${base} (must be 1.0 so LFO keeps range positive)`);
    }
    // LFO depth must be ≤ base (1.0) to keep the range [1-depth, 1+depth] ≥ 0
    const depthMatch = sfxAllSrc.match(/tremoloGain\.gain\.value\s*=\s*([\d.]+)/);
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
