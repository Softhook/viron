// =============================================================================
// sfx.js — GameSFX class: Web Audio synthesis engine
//
// @exports   GameSFX        — class definition
// @exports   gameSFX        — singleton (used by sketch.js, gameLoop.js,
//                             gameState.js, player.js, enemies.js)
// =============================================================================
class GameSFX {
    constructor() {
        this.initialized = false;
        this.distCurve = null;
        this.spatialEnabled = true;
        this.thrustNodes = {}; // id -> { osc, noise, gain, filter, panner }
        this.ambientNodes = {}; // key -> { osc, noise, gain, filter, panner }
        this.lastExplosionTime = 0;
        this.lastExplosionPos = { x: 0, y: 0, z: 0 };
        this.lastSpreadTime = 0;
        this.ctx = null;
        this.master = null;

        // constant values used across methods
        this._refDist = 180;            // reference distance for manual attenuation
        this._zoomOffset = 520;         // offset to simulate camera zoom in 2p mode
        this._maxManualDist = 8000;     // upper clamp for manual volume falloff
        this._infectionProximityAlpha = 0; // Smoothed proximity value
        this._heartRateSmoothed = 0.65;
        this._heartIntensitySmoothed = 0;
        this._heartbeatPhase = 0;
        this._heartbeatLastTime = 0;
        this._scanPulseAlpha = 0;
        this._scanSweepAlpha = 0;
    }

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') {
            this.ctx = getAudioContext();

            // Simple master gain — no dynamics compressor.
            // A DynamicsCompressor causes audible pumping/ducking on every transient
            // (gun shot, explosion) and can introduce crackle.  1.0 passes all sounds
            // at their individually tuned volumes; individual gains are kept well below
            // 1.0 so simultaneous sounds stack without clipping.
            this.master = this.ctx.createGain();
            this.master.gain.value = 1.0;
            this.master.connect(this.ctx.destination);

            this.distCurve = this.createDistortionCurve(400);
            this.distCurveGameOver = this.createDistortionCurve(60);

            // Pre-calculate one seamless looping noise buffer and reuse it across all
            // synthesised sounds. Eliminates per-sound buffer allocation work.
            this.persistentNoise = this._buildNoiseBuffer(3.0);
        }
        this.initialized = true;
    }

    // Build a seamless looping white-noise buffer.
    _buildNoiseBuffer(dur) {
        if (!this.ctx) return null;
        const rate = this.ctx.sampleRate;
        const len = Math.floor(rate * dur);
        const buf = this.ctx.createBuffer(1, len, rate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        // Cross-fade loop edges so the buffer plays back seamlessly.
        const blend = Math.floor(rate * 0.2);
        for (let i = 0; i < blend; i++) {
            const r = i / blend;
            data[i] = data[i] * r + data[len - blend + i] * (1 - r);
        }
        return buf;
    }

    // Schedule disconnection of all provided nodes once a sound has finished.
    // Prevents stale nodes from accumulating in the audio graph over the lifetime
    // of a game session, which would cause growing CPU and memory overhead.
    _cleanupNodes(nodes, delaySec) {
        // Increased from 0.05 to 0.2: Web Audio scheduled events are precise, but
        // setTimeout is not. A 200ms buffer ensures that even during high CPU load
        // or frame drops, the nodes are never disconnected before their scheduled
        // stop/fade-out times have fully passed, preventing audible clicks.
        setTimeout(() => {
            for (const node of nodes) {
                if (!node) continue;
                try { node.disconnect(); } catch (e) {}
                // Noise gain-proxy wraps a hidden BufferSource — disconnect that too.
                if (node._src) try { node._src.disconnect(); } catch (e) {}
            }
        }, (delaySec + 0.2) * 1000);
    }

    // Cancel any pending AudioParam automation at time t, hold the current
    // interpolated value, then schedule a new setTargetAtTime event.
    // Must be called before every setTargetAtTime on params that are driven
    // every frame (updateAmbiance, setThrust) — without cancellation each frame
    // appends a new event to the queue, causing unbounded growth that leads to
    // growing CPU overhead and eventually audio dropouts / clicks.
    _paramSetTarget(param, value, t, tau) {
        if (!param) return;
        if (typeof param.cancelAndHoldAtTime === 'function') {
            param.cancelAndHoldAtTime(t);
        } else {
            param.cancelScheduledValues(t);
            param.setValueAtTime(param.value, t);
        }
        param.setTargetAtTime(value, t, tau);
    }

    _cancelAndHoldParam(param, t) {
        if (!param) return;
        if (typeof param.cancelAndHoldAtTime === 'function') {
            param.cancelAndHoldAtTime(t);
            return;
        }
        param.cancelScheduledValues(t);
        param.setValueAtTime(param.value, t);
    }

    _safeStop(node, when) {
        if (!node || typeof node.stop !== 'function') return;
        try {
            if (when === undefined) node.stop();
            else node.stop(when);
        } catch (e) {}
    }

    _safeDisconnect(node) {
        if (!node || typeof node.disconnect !== 'function') return;
        try { node.disconnect(); } catch (e) {}
    }

    _stopAndDisconnectNode(node, when) {
        if (!node) return;
        this._safeStop(node, when);
        if (node._src) {
            this._safeStop(node._src, when);
            this._safeDisconnect(node._src);
        }
        this._safeDisconnect(node);
    }

    _fadeGainToZero(gainNode, t, fadeTime) {
        if (!gainNode || !gainNode.gain) return;
        this._cancelAndHoldParam(gainNode.gain, t);
        gainNode.gain.linearRampToValueAtTime(0, t + fadeTime);
    }

    _stopThrustNode(node) {
        if (!node) return;
        this._stopAndDisconnectNode(node.osc);
        this._stopAndDisconnectNode(node.noise);
        this._safeDisconnect(node.filter);
        if (node.panner) this._safeDisconnect(node.panner);
        this._safeDisconnect(node.gain);
    }

    // Create a looping noise source backed by the shared persistent buffer.
    // mul != 1 inserts a gain stage; the returned node exposes a .stop() proxy
    // and a ._src reference so _cleanupNodes can reach the inner BufferSource.
    _createNoise(mul = 1) {
        if (!this.ctx || !this.persistentNoise) return null;
        const src = this.ctx.createBufferSource();
        src.buffer = this.persistentNoise;
        src.loop = true;
        src.start(this.ctx.currentTime, Math.random() * src.buffer.duration);

        if (mul === 1) return src;

        const gain = this.ctx.createGain();
        gain.gain.value = mul;
        src.connect(gain);
        // Expose stop() so callers can treat the gain proxy like a SourceNode.
        gain.stop = (when) => { try { src.stop(when); } catch (e) {} };
        gain._src = src;
        return gain;
    }
    // ---------------------------------------------------------------------------
    // One-shot sound building blocks — reduce repetition across effect methods
    // ---------------------------------------------------------------------------

    // Creates a GainNode with a standard near-zero → peak → near-zero envelope.
    _makeGainEnv(ctx, t, peak, attackDur, totalDur) {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + attackDur);
        g.gain.exponentialRampToValueAtTime(0.0001, t + totalDur);
        return g;
    }

    // Creates a BiquadFilterNode with optional exponential frequency sweep.
    // Pass endFreq/dur as undefined to skip the sweep and only set startFreq as value.
    _makeFilter(ctx, t, type, startFreq, endFreq, dur, Q) {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.setValueAtTime(startFreq, t);
        if (endFreq !== undefined && dur !== undefined) {
            f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
        }
        if (Q !== undefined) f.Q.value = Q;
        return f;
    }

    // Creates an OscillatorNode, connects it to targetNode, and schedules
    // start/stop.  sweepDur controls the end time of the frequency ramp;
    // stopDur (optional) overrides the stop time when it differs from sweepDur.
    _makeOsc(ctx, t, type, startFreq, endFreq, sweepDur, targetNode, detuneVal, stopDur) {
        const osc = ctx.createOscillator();
        osc.type = type;
        if (detuneVal !== undefined) osc.detune.value = detuneVal;
        osc.frequency.setValueAtTime(startFreq, t);
        osc.frequency.exponentialRampToValueAtTime(endFreq, t + sweepDur);
        osc.connect(targetNode);
        osc.start(t);
        osc.stop(t + (stopDur !== undefined ? stopDur : sweepDur));
        return osc;
    }

    /**
     * Updates persistent ambient sounds based on player position and infection state.
     */
    updateAmbiance(proximityData, infectionCount, maxInfection) {
        if (typeof SfxAmbient !== 'undefined') SfxAmbient.updateAmbiance(this, proximityData, infectionCount, maxInfection);
    }

    // Set up audio routing for a one-shot event.
    // Returns { ctx, t, targetNode, routingNodes } where routingNodes holds any
    // spatialiser/gain/filter nodes created here that must be cleaned up after the sound ends.
    _setup(x, y, z) {
        this.init();
        if (!this.ctx) return null;
        const t = this.ctx.currentTime;
        let targetNode = this.master || this.ctx.destination;
        const routingNodes = [];

        if (x !== undefined && y !== undefined && z !== undefined) {
            if (this.spatialEnabled) {
                const panner = this.createSpatializer(x, y, z);
                if (panner) {
                    panner.connect(targetNode);
                    targetNode = panner;
                    routingNodes.push(panner);
                }
            } else {
                // Fallback: manual distance-based volume and stereo separation for split-screen.
                const chain = this._buildManualChain(x, y, z, t, targetNode);
                if (chain) {
                    targetNode = chain.entry;
                    routingNodes.push(...chain.nodes);
                }
            }
        }
        return { ctx: this.ctx, t, targetNode, routingNodes };
    }

    // Build the manual distance-attenuation + stereo-pan chain used in split-screen mode.
    // Returns { entry, nodes } where entry is what sound sources connect to, and nodes
    // is the full list of created nodes to pass to _cleanupNodes.
    _buildManualChain(x, y, z, t, finalTarget) {
        if (typeof gameState === 'undefined' || gameState.players.length === 0) return null;

        let minDistSq = Infinity;
        let closestIdx = -1;
        const numPlayers = gameState.players.length;
        for (let i = 0; i < numPlayers; i++) {
            const p = gameState.players[i];
            if (p.dead || !p.ship) continue;
            const dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
            if (dSq < minDistSq) { minDistSq = dSq; closestIdx = i; }
        }

        if (minDistSq === Infinity) return null;

        // Offset distance by ~520 units to simulate the follow-camera being zoomed out.
        const distance = Math.sqrt(minDistSq) + this._zoomOffset;
        const manualVol = distance > this._refDist
            ? Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25)
            : 1.0;
        // Split-screen panning: shift sound toward whichever viewport it's closest to.
        const panVal = numPlayers === 2 ? (closestIdx === 0 ? -0.35 : 0.35) : 0;

        if (manualVol >= 0.99 && panVal === 0) return null;

        const g = this.ctx.createGain();
        g.gain.setValueAtTime(manualVol, t);

        // Manual distance-based low-pass to simulate "deepness" at range.
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        const distFactor = Math.min(Math.max(0, (minDistSq - 10000) / 1000000), 1);
        f.frequency.setValueAtTime(20000 - 18000 * distFactor, t);
        g.connect(f);

        const nodes = [g, f];
        if (panVal !== 0 && this.ctx.createStereoPanner) {
            const sp = this.ctx.createStereoPanner();
            sp.pan.setValueAtTime(panVal, t);
            f.connect(sp);
            sp.connect(finalTarget);
            nodes.push(sp);
        } else {
            f.connect(finalTarget);
        }

        return { entry: g, nodes };
    }

    /**
     * Throttled infection spread sound.
     * If 50 tiles spread at once, playing 50 sounds will crash the audio thread.
     * Limit to one sound every 60ms.
     */
    playInfectionSpread(x, y, z) {
        if (typeof SfxEnemies !== 'undefined') SfxEnemies.playInfectionSpread(this, x, y, z);
    }


    updateListener(cx, cy, cz, lx, ly, lz, ux, uy, uz) {
        if (!this.ctx || !this.ctx.listener || !this.spatialEnabled) return;
        const listener = this.ctx.listener;

        let fx = lx - cx, fy = ly - cy, fz = lz - cz;
        let flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        const t = this.ctx.currentTime;
        if (listener.positionX) {
            // Ramp all listener AudioParams to their new targets over 50ms (~3 frames at 60fps).
            // Direct .value assignment causes instantaneous HRTF direction/position jumps, producing
            // audible spatial discontinuities (clicks, glitches) whenever the player turns or moves
            // quickly.  linearRampToValueAtTime interpolates smoothly between frames without lag.
            const dt = 0.05;
            const endTime = t + dt;

            // Cancel any pending automation before scheduling new ramps.
            // Without this, each frame appends 9 new events to the AudioParam queues,
            // causing unbounded growth in long sessions and wasted CPU/memory.
            const params = [
                listener.positionX, listener.positionY, listener.positionZ,
                listener.forwardX,  listener.forwardY,  listener.forwardZ,
                listener.upX,       listener.upY,       listener.upZ,
            ];
            for (const p of params) this._cancelAndHoldParam(p, t);

            listener.positionX.linearRampToValueAtTime(cx, endTime);
            listener.positionY.linearRampToValueAtTime(cy, endTime);
            listener.positionZ.linearRampToValueAtTime(cz, endTime);
            listener.forwardX.linearRampToValueAtTime(fx, endTime);
            listener.forwardY.linearRampToValueAtTime(fy, endTime);
            listener.forwardZ.linearRampToValueAtTime(fz, endTime);
            listener.upX.linearRampToValueAtTime(ux, endTime);
            listener.upY.linearRampToValueAtTime(uy, endTime);
            listener.upZ.linearRampToValueAtTime(uz, endTime);
        } else {
            listener.setPosition(cx, cy, cz);
            listener.setOrientation(fx, fy, fz, ux, uy, uz);
        }
    }

    createSpatializer(x, y, z) {
        if (!this.ctx || x === undefined || y === undefined || z === undefined) return null;
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
        let panner = this.ctx.createPanner();
        // equalpower: simple stereo panning, no expensive HRTF convolution.
        // HRTF can cause glitches/pops on rapid position updates.
        panner.panningModel = 'equalpower';
        // inverse: standard 1/r distance law — smooth and predictable.
        // exponential model produces extreme gain discontinuities at range edges.
        panner.distanceModel = 'inverse';
        // Geometric analysis of refDistance = 600:
        //   Camera offset from ship: 300 units horizontal (behind) + ~120 units vertical.
        //   Camera–ship distance = sqrt(300² + 120²) ≈ 323 units.
        //   Any source within refDistance plays at full designed volume.
        //   323 < 600  →  own-ship shots/effects always play at full volume. ✓
        //   Distant enemies (800 units): listener distance ≈ sqrt(1100² + 120²) ≈ 1106
        //                                gain = 600/1106 ≈ 0.54 → natural falloff. ✓
        // Panning correctness (equalpower, up = (0,1,0)):
        //   listener right = normalize(forward × (0,1,0))
        //   This is identical to the right vector used by the visual camera()
        //   call, so audio L/R matches visual L/R at every ship yaw angle. ✓
        panner.refDistance = 600;
        panner.maxDistance = 10000;
        panner.rolloffFactor = 1.0;

        let t = this.ctx.currentTime;
        if (panner.positionX) {
            panner.positionX.setValueAtTime(x, t);
            panner.positionY.setValueAtTime(y, t);
            panner.positionZ.setValueAtTime(z, t);
        } else {
            panner.setPosition(x, y, z);
        }
        return panner;
    }

    createDistortionCurve(amount = 50) {
        const n = 256;
        const k = typeof amount === 'number' ? amount : 50;
        const curve = new Float32Array(n);
        const deg = Math.PI / 180;
        for (let i = 0; i < n; i++) {
            const x = i * 2 / n - 1;
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    playShot(x, y, z) {
        if (typeof SfxWeapons !== 'undefined') SfxWeapons.playShot(this, x, y, z);
    }

    playInfectionPulse(x, y, z) {
        if (typeof SfxEnemies !== 'undefined') SfxEnemies.playInfectionPulse(this, x, y, z);
    }

    playEnemyShot(type = 'fighter', x, y, z) {
        if (typeof SfxEnemies !== 'undefined') SfxEnemies.playEnemyShot(this, type, x, y, z);
    }

    playMissileFire(x, y, z) {
        if (typeof SfxWeapons !== 'undefined') SfxWeapons.playMissileFire(this, x, y, z);
    }

    playBombDrop(type = 'normal', x, y, z) {
        if (typeof SfxWeapons !== 'undefined') SfxWeapons.playBombDrop(this, type, x, y, z);
    }

    playExplosion(x, y, z, isLarge = false, type = '') {
        if (typeof SfxWeapons !== 'undefined') SfxWeapons.playExplosion(this, x, y, z, isLarge, type);
    }

    playNewLevel() {
        const s = this._setup();
        if (!s) return;
        const { ctx, t, targetNode } = s;
        // routingNodes is always empty here (no coordinates → no spatializer created),
        // so cleanup is handled entirely inside each SFX_LEVEL_TUNES entry.
        const pick = Math.floor(Math.random() * SFX_LEVEL_TUNES.length);
        SFX_LEVEL_TUNES[pick].call(this, ctx, t, targetNode);
    }


    /**
     * Plays a triumphant, electronic fanfare upon level completion.
     * Fast upward arpeggio with bright, snappy pulse waves.
     */
    playLevelComplete() {
        const s = this._setup();
        if (!s) return;
        const { ctx, t, targetNode } = s;
        const nodes = [];

        const notes = [261.63, 523.25, 659.25, 783.99, 1046.50]; // C4, C5, E5, G5, C6 – bass root added
        notes.forEach((freq, i) => {
            const noteT = t + i * 0.08;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, noteT);
            // Raised from 0.2: fanfare plays in isolation so headroom is generous.
            // Fast exponential decay means successive notes barely overlap (<0.01 combined).
            gain.gain.linearRampToValueAtTime(0.38, noteT + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.2);
            osc.connect(gain);
            gain.connect(targetNode);
            osc.start(noteT);
            osc.stop(noteT + 0.2);
            nodes.push(osc, gain);
        });

        // Final lingering chord – C4 root added for bass fullness; gains raised for audibility
        [261.63, 523.25, 1046.50].forEach(freq => {
            const noteT = t + 0.4;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.25, noteT + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 1.3);
            osc.connect(gain);
            gain.connect(targetNode);
            osc.start(noteT);
            osc.stop(noteT + 1.3);
            nodes.push(osc, gain);
        });

        // Raised from 1.7 to 1.9 (+200ms) to ensure the 1.3s decay on the final chord 
        // has strictly finished before disconnection.
        this._cleanupNodes(nodes, 0.4 + 1.5);
    }

    playGameOver() {
        const s = this._setup();
        if (!s) return;
        const { ctx, t, targetNode } = s;
        const freqs = [329.63, 293.66, 261.63, 164.81];

        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurveGameOver;
        distortion.connect(targetNode);
        const nodes = [distortion];

        freqs.forEach((freq, i) => {
            const noteT = t + i * 0.45;
            [-20, 0, 20].forEach(det => {
                const osc = ctx.createOscillator();
                const filter = ctx.createBiquadFilter();
                const gain = ctx.createGain();

                osc.type = 'sawtooth';
                osc.frequency.value = freq / 2;
                osc.detune.value = det;
                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(2500, noteT);
                filter.frequency.exponentialRampToValueAtTime(100, noteT + 1.8);
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.3, noteT + 0.1);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 1.9);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(distortion);
                osc.start(noteT);
                osc.stop(noteT + 1.9);
                nodes.push(osc, filter, gain);
            });
        });

        this._cleanupNodes(nodes, 3 * 0.45 + 1.9);
    }

    playPowerup(isGood = true, x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = isGood ? 0.6 : 0.8;
        const freqs = isGood ? [440, 554.37, 659.25, 880] : [220, 207.65, 196.00, 110];

        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.0001, t);
        masterGain.gain.linearRampToValueAtTime(0.35, t + 0.006);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        masterGain.connect(targetNode);
        const nodes = [masterGain];

        freqs.forEach((freq, i) => {
            const noteT = t + i * 0.1;
            [-15, 15].forEach(det => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = isGood ? 'square' : 'sawtooth';
                osc.frequency.value = freq;
                osc.detune.value = det;
                gain.gain.setValueAtTime(0.0, noteT);
                gain.gain.linearRampToValueAtTime(1.0, noteT + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.3);
                osc.connect(gain);
                gain.connect(masterGain);
                osc.start(noteT);
                osc.stop(noteT + 0.4);
                nodes.push(osc, gain);
            });
        });

        const cleanupDelay = Math.max(dur, 3 * 0.1 + 0.4);
        this._cleanupNodes([...nodes, ...routingNodes], cleanupDelay);
    }

    playClearInfection(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const nodes = [];

        const freqs = [261.63, 523.25, 659.25];  // C4, C5, E5 – lower octave range for body
        freqs.forEach((freq) => {
            [-15, 0, 15].forEach(det => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.detune.value = det;
                gain.gain.setValueAtTime(0.0, t);
                // 9 oscillators connect directly to targetNode without filtering.
                // Worst-case peak = 9 × 0.10 = 0.90; typical incoherent sum ≈ 0.35.
                gain.gain.linearRampToValueAtTime(0.10, t + 0.05);
                // Ramp to 0.0001 (near-silence) so the oscillator is inaudible before
                // its scheduled stop at t+1.3.  The previous value 0.01 (-40 dBFS)
                // left 9 × 0.01 = 0.09 combined amplitude at the stop moment, causing
                // an audible scratch/click when the waveforms were cut mid-cycle.
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
                osc.connect(gain);
                gain.connect(targetNode);
                osc.start(t);
                osc.stop(t + 1.3);
                nodes.push(osc, gain);
            });
        });

        const noise = this._createNoise();
        const filter = this._makeFilter(ctx, t, 'highpass', 1200);  // was 4000 – reduced shrillness
        const noiseGain = this._makeGainEnv(ctx, t, 0.2, 0.006, 0.4);

        if (noise) {
            noise.connect(filter);
            noise.stop(t + 0.4);
        }
        filter.connect(noiseGain);
        noiseGain.connect(targetNode);

        this._cleanupNodes([...nodes, noise, filter, noiseGain, ...routingNodes], 1.3);
    }


    playAlarm() {
        const s = this._setup();
        if (!s) return;
        const { ctx, t, targetNode } = s;
        const dur = 0.5;

        const gain = this._makeGainEnv(ctx, t, 0.25, 0.005, dur);

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.linearRampToValueAtTime(440, t + 0.4);

        osc.connect(gain);
        gain.connect(targetNode);
        osc.start(t);
        osc.stop(t + dur);
        this._cleanupNodes([gain, osc], dur);
    }

    /**
     * Plays a bright ascending chime when a villager cures an infected tile.
     * Three harmonically-spaced sine tones rise rapidly for a positive feel.
     */
    playVillagerCure(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.6;
        const nodes = [];

        // Ascending major triad — C5, E5, G5
        const freqs = [523.25, 659.25, 783.99];
        freqs.forEach((freq, i) => {
            const noteT = t + i * 0.08;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, noteT);
            osc.frequency.linearRampToValueAtTime(freq * 1.02, noteT + 0.3);
            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.18, noteT + 0.03);
            gain.gain.exponentialRampToValueAtTime(0.0001, noteT + dur - i * 0.08);
            osc.connect(gain);
            gain.connect(targetNode);
            osc.start(noteT);
            osc.stop(noteT + dur);
            nodes.push(osc, gain);
        });

        this._cleanupNodes([...nodes, ...routingNodes], dur + 0.16);
    }

    /**
     * Plays a short, muffled descending tone when a villager is killed.
     * A low sine sweep with noise burst for a sad, brief effect.
     */
    playVillagerDeath(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.35;

        const gainNode = this._makeGainEnv(ctx, t, 0.22, 0.005, dur);
        const filter = this._makeFilter(ctx, t, 'lowpass', 1200, 200, dur);
        const osc = this._makeOsc(ctx, t, 'sine', 440, 120, dur, filter);

        // Small noise burst for texture
        const noise = this._createNoise(0.3);
        const noiseGain = this._makeGainEnv(ctx, t, 0.12, 0.004, 0.15);
        if (noise) {
            noise.connect(noiseGain);
            noise.stop(t + 0.15);
        }
        noiseGain.connect(gainNode);

        filter.connect(gainNode);
        gainNode.connect(targetNode);
        this._cleanupNodes([gainNode, filter, osc, noise, noiseGain, ...routingNodes], dur);
    }

    /**
     * Updates or starts/stops a sustained thrust sound for a specific player.
     * @param {number} id      Player ID.
     * @param {boolean} active Whether thrust is currently firing.
     * @param {number} x,y,z   World position for spatialization.
     */
    setThrust(id, active, x, y, z) {
        if (typeof SfxAmbient !== 'undefined') SfxAmbient.setThrust(this, id, active, x, y, z);
    }

    /**
     * Immediately fades out and disconnects all persistent ambient and thrust
     * nodes. Call this when transitioning to game-over (or any state where game
     * audio should stop) so that looping oscillators and noise sources don't
     * continue playing silently in the background after the game loop exits.
     *
     * Captured snapshots are used so that any new nodes created by a rapid
     * game restart won't be accidentally torn down by the deferred cleanup.
     */
    stopAll() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const fadeTime = 0.08; // 80 ms linear fade to avoid abrupt clicks

        // Snapshot current node collections and clear them immediately.
        // Clearing before the setTimeout means a fast restart can create new
        // nodes without them being wrongly destroyed by the deferred teardown.
        const ambientSnapshot = this.ambientNodes;
        const thrustSnapshot  = this.thrustNodes;
        this.ambientNodes = {};
        this.thrustNodes  = {};

        // Reset per-frame smoothed state so the next session starts clean.
        this._infectionProximityAlpha = 0;
        this._heartRateSmoothed       = 0.65;
        this._heartIntensitySmoothed  = 0;
        this._heartbeatPhase          = 0;
        this._heartbeatLastTime       = 0;
        this._scanPulseAlpha          = 0;
        this._scanSweepAlpha          = 0;

        // Fade out all ambient node gains.
        for (const n of Object.values(ambientSnapshot)) {
            this._fadeGainToZero(n.gain, t, fadeTime);
        }

        // Fade out all thrust node gains.
        for (const n of Object.values(thrustSnapshot)) {
            this._fadeGainToZero(n.gain, t, fadeTime);
        }

        // Disconnect and stop everything after the fade completes.
        setTimeout(() => {
            for (const n of Object.values(ambientSnapshot)) {
                for (const node of Object.values(n)) {
                    this._stopAndDisconnectNode(node);
                }
            }
            for (const n of Object.values(thrustSnapshot)) {
                this._stopThrustNode(n);
            }
        }, (fadeTime + 0.05) * 1000);
    }
}

const gameSFX = new GameSFX();
