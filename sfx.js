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
        setTimeout(() => {
            for (const node of nodes) {
                if (!node) continue;
                try { node.disconnect(); } catch (e) {}
                // Noise gain-proxy wraps a hidden BufferSource — disconnect that too.
                if (node._src) try { node._src.disconnect(); } catch (e) {}
            }
        }, (delaySec + 0.05) * 1000);
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
        if (!this.initialized || !this.ctx) return;
        const dest = this.master || this.ctx.destination;
        const now = this.ctx.currentTime;

        // Use a bounded delta to keep modulation stable through frame hitches.
        const dtRaw = this._heartbeatLastTime > 0 ? (now - this._heartbeatLastTime) : (1 / 60);
        const dt = Math.min(0.1, Math.max(1 / 240, dtRaw));
        this._heartbeatLastTime = now;

        // 1. Infection Heartbeat (Sub-bass rumble)
        if (!this.ambientNodes.heartbeat) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.value = 45;
            filter.type = 'lowpass';
            filter.frequency.value = 80;
            gain.gain.value = 0;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(dest);
            osc.start();
            this.ambientNodes.heartbeat = { osc, gain, filter };
        }

        const maxInf = Math.max(1, maxInfection || 1);
        const infectionRatio = Math.min(1, Math.max(0, infectionCount / maxInf));

        // Smooth control values so infection-count jumps don't create irregular rhythm.
        const heartRateTarget = 0.65 + infectionRatio * 1.05; // ~39 BPM to ~102 BPM
        const rateBlend = 1 - Math.exp(-dt / 0.8);
        const intensityBlend = 1 - Math.exp(-dt / 0.35);
        this._heartRateSmoothed += (heartRateTarget - this._heartRateSmoothed) * rateBlend;
        this._heartIntensitySmoothed += (infectionRatio - this._heartIntensitySmoothed) * intensityBlend;

        // Deterministic "lub-dub" envelope in phase space for a heartbeat-like pulse.
        this._heartbeatPhase = (this._heartbeatPhase + this._heartRateSmoothed * dt) % 1;
        const phase = this._heartbeatPhase;
        const beatWindow = (center, width) => {
            const d = Math.abs(phase - center);
            if (d >= width) return 0;
            const x = 1 - d / width;
            return x * x * (3 - 2 * x);
        };
        const lub = beatWindow(0.08, 0.095);
        const dub = beatWindow(0.28, 0.08);
        const pulse = Math.min(1, lub + dub * 0.68);

        // heartbeat is a direct sine wave (45 Hz through a lowpass) — amplitude is
        // not attenuated by its filter, so heartVol maps 1:1 to output level.
        // 0.25 leaves headroom for simultaneous action sounds.
        const heartVol = this._heartIntensitySmoothed * 0.25;
        const heartFreq = 38 + this._heartIntensitySmoothed * 10 + pulse * 12;
        this._paramSetTarget(this.ambientNodes.heartbeat.osc.frequency, heartFreq, now, 0.06);
        this._paramSetTarget(this.ambientNodes.heartbeat.gain.gain, heartVol * pulse, now, 0.03);

        // 2. Infection Proximity (Buzzy Scanning Hum)
        if (!this.ambientNodes.proximityHum) {
            const osc = this.ctx.createOscillator();
            const noise = this._createNoise(0.25);
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'sawtooth';
            osc.frequency.value = 60;
            filter.type = 'bandpass';
            filter.frequency.value = 400;
            filter.Q.value = 10;
            gain.gain.value = 0;

            osc.connect(filter);
            if (noise) noise.connect(filter);
            filter.connect(gain);
            gain.connect(dest);
            osc.start();
            this.ambientNodes.proximityHum = { osc, noise, gain, filter };
        }

        // 3. Scanning Modulation (Temporary pulse-pass "zzz")
        if (!this.ambientNodes.scanningMod) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();
            const lfo = this.ctx.createOscillator();
            const lfoGain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.value = 80;
            filter.type = 'bandpass';
            filter.frequency.value = 800;
            filter.Q.value = 12;
            lfo.type = 'sine';
            lfo.frequency.value = 8.0;
            lfoGain.gain.value = 500;
            gain.gain.value = 0;

            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(dest);

            osc.start();
            lfo.start();
            this.ambientNodes.scanningMod = { osc, gain, filter, lfo, lfoGain };
        }

        // Smoothed proximity to infected tiles
        const targetProximity = proximityData.dist < 800 ? (1 - proximityData.dist / 800) : 0;
        this._infectionProximityAlpha = lerp(this._infectionProximityAlpha, targetProximity, 0.05);

        // Steady Hum volume.
        // The sawtooth (60 Hz) passes through a bandpass filter (Q=10, centre
        // sweeping 200–600 Hz) that attenuates the signal to approximately 10–14%
        // of the gain value — only the one or two harmonics that fall inside the
        // narrow passband contribute.  humVol = 1.0 gives an effective output of
        // ~0.10–0.14 at the targetNode, making the hum clearly audible.
        // At 0.18 the effective output was ~0.018 — essentially inaudible.
        const humVol = this._infectionProximityAlpha * 1.0;
        this._paramSetTarget(this.ambientNodes.proximityHum.gain.gain, humVol, now, 0.1);
        this._paramSetTarget(this.ambientNodes.proximityHum.filter.frequency, 200 + this._infectionProximityAlpha * 400, now, 0.1);

        // Pulsed Scanning "zzz" modulation - triggered when a pulse passes the player
        {
            const scanAlpha = Math.min(1, Math.max(0, proximityData.pulseOverlap || 0));
            this._scanPulseAlpha = lerp(this._scanPulseAlpha, scanAlpha, 0.22);
            // Use squared intensity for a sharper peak (more "zip", less "drone")
            const alphaSq = this._scanPulseAlpha * this._scanPulseAlpha;
            this._paramSetTarget(this.ambientNodes.scanningMod.gain.gain, alphaSq * 0.7, now, 0.06);
            // Speed up the rhythmic modulation at the peak of the scan
            this._paramSetTarget(this.ambientNodes.scanningMod.lfo.frequency, 8.0 + alphaSq * 8.5, now, 0.08);
        }

        // 4. Visual Scan Line Sweep (Metallic "Ping")
        if (!this.ambientNodes.scanSweep) {
            const noise = this._createNoise(0.2);
            const filter = this.ctx.createBiquadFilter();
            const gain = this.ctx.createGain();

            filter.type = 'bandpass';
            filter.frequency.value = 2000;
            filter.Q.value = 25; // Very resonant
            gain.gain.value = 0;

            if (noise) noise.connect(filter);
            filter.connect(gain);
            gain.connect(dest);

            this.ambientNodes.scanSweep = { noise, filter, gain };
        }

        const sweepAlphaTarget = Math.min(1, Math.max(0, proximityData.scanSweepAlpha || 0));
        this._scanSweepAlpha = lerp(this._scanSweepAlpha, sweepAlphaTarget, 0.2);
        // Only audible when near infection to match visual logic
        const sweepVol = this._scanSweepAlpha * this._infectionProximityAlpha * 0.52;
        this._paramSetTarget(this.ambientNodes.scanSweep.gain.gain, sweepVol, now, 0.08);
        this._paramSetTarget(this.ambientNodes.scanSweep.filter.frequency, 1400 + this._scanSweepAlpha * 1300, now, 0.08);
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
        if (!this.initialized || !this.ctx) return;
        const t = this.ctx.currentTime;
        if (t - this.lastSpreadTime < 0.06) return;
        this.lastSpreadTime = t;

        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, targetNode, routingNodes } = s;
        const dur = 0.04;

        // Single oscillator → bandpass filter → gainNode.  In single-player mode this
        // fires while the thrust engine is running at ~0.32.  gainNode 0.45 keeps the
        // combined sum below 0.77 (was 0.8 → 0.8 + 0.32 = 1.12 → hard clip).
        const gainNode = this._makeGainEnv(ctx, t, 0.45, 0.006, dur);
        const filter = this._makeFilter(ctx, t, 'bandpass', 1000, 200, dur, 5);
        const osc = this._makeOsc(ctx, t, 'triangle', 150, 40, dur, filter);

        filter.connect(gainNode);
        gainNode.connect(targetNode);
        this._cleanupNodes([gainNode, filter, osc, ...routingNodes], dur);
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
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.18;

        // Main volume envelope.
        // Three triangle oscillators share this gainNode via a common filter.
        // With ±10-cent detune the beat period is ~790 ms (>> shot duration 0.18 s),
        // so the three oscillators stay in-phase throughout and their amplitudes sum
        // to ~3× at the filter node.  Peak = 3 × 0.10 = 0.30 — safe with headroom.
        const gainNode = this._makeGainEnv(ctx, t, 0.10, 0.005, dur);
        // Low-pass filter to remove "annoying" high frequencies
        const filter = this._makeFilter(ctx, t, 'lowpass', 1800, 500, 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        // Core oscillators - triangle waves for a smoother, less buzzing sound
        // sweep ends at 0.15 s; osc stops at dur (0.18 s)
        const oscs = [-10, 0, 10].map(det =>
            this._makeOsc(ctx, t, 'triangle', 220, 140, 0.15, filter, det, dur)
        );

        // Sub-thrum for weight - with high-pass to avoid mud/scratchiness
        const subFilter = this._makeFilter(ctx, t, 'highpass', 40);
        const subGain = this._makeGainEnv(ctx, t, 0.14, 0.005, 0.12);
        // frequency sweep ends at 0.1 s; sub stops at 0.12 s
        const sub = this._makeOsc(ctx, t, 'sine', 80, 40, 0.1, subFilter, undefined, 0.12);

        subFilter.connect(subGain);
        subGain.connect(targetNode);

        this._cleanupNodes([gainNode, filter, sub, subFilter, subGain, ...oscs, ...routingNodes], dur);
    }

    playInfectionPulse(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 1.8;

        // WaveShaper saturates the combined noise+osc path to ≤0.349; gainNode is the
        // final output scalar.  0.60 → effective peak ≈ 0.349 × 0.60 = 0.210.
        // Previously 0.8 (→ 0.279); combined with a simultaneous large explosion
        // (0.664) and thrust (0.32) that summed to 1.263, causing clipping.
        const gainNode = this._makeGainEnv(ctx, t, 0.60, 0.012, dur);
        const filter = this._makeFilter(ctx, t, 'lowpass', 2000, 100, dur);
        const osc = this._makeOsc(ctx, t, 'sawtooth', 120, 40, dur, filter);

        const noise = this._createNoise(1.2);
        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;

        if (noise) noise.connect(filter);
        filter.connect(distortion);
        distortion.connect(gainNode);
        gainNode.connect(targetNode);

        if (noise) noise.stop(t + dur);
        this._cleanupNodes([gainNode, filter, osc, noise, distortion, ...routingNodes], dur);
    }

    playEnemyShot(type = 'fighter', x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;

        if (type === 'crab') {
            const dur = 0.2;
            const gain = this._makeGainEnv(ctx, t, 0.3, 0.004, dur);
            const filter = this._makeFilter(ctx, t, 'highpass', 3000);
            const osc = this._makeOsc(ctx, t, 'sawtooth', 800, 4000, 0.1, filter, undefined, dur);
            filter.connect(gain);
            gain.connect(targetNode);
            this._cleanupNodes([gain, filter, osc, ...routingNodes], dur);
        } else {
            const dur = 0.15;
            const gain = this._makeGainEnv(ctx, t, 0.25, 0.004, dur);
            const filter = this._makeFilter(ctx, t, 'lowpass', 4000, 100, dur);
            const osc = this._makeOsc(ctx, t, 'square', 1200, 200, dur, filter);
            filter.connect(gain);
            gain.connect(targetNode);
            this._cleanupNodes([gain, filter, osc, ...routingNodes], dur);
        }
    }

    playMissileFire(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.6;

        // Three square oscillators plus white noise all feed the same lowpass
        // filter → gainNode.  Peak input to the gainNode can reach ~4× amplitude
        // (3 correlated oscs + noise); gainNode 0.16 keeps peaks around 0.50–0.65.
        const gainNode = this._makeGainEnv(ctx, t, 0.16, 0.005, dur);
        // Two-stage filter sweep: rise then fall
        const filter = this._makeFilter(ctx, t, 'lowpass', 400);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2);
        filter.frequency.exponentialRampToValueAtTime(100, t + dur);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        const oscs = [-25, 0, 25].map(det =>
            this._makeOsc(ctx, t, 'square', 150, 40, dur, filter, det)
        );

        const noise = this._createNoise();
        if (noise) {
            noise.connect(filter);
            noise.stop(t + dur);
        }
        this._cleanupNodes([gainNode, filter, noise, ...oscs, ...routingNodes], dur);
    }

    playBombDrop(type = 'normal', x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const isMega = type === 'mega';
        const dur = isMega ? 0.8 : 0.4;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(isMega ? 0.40 : 0.3, t + 0.006);
        gain.gain.linearRampToValueAtTime(isMega ? 0.55 : 0.4, t + dur * 0.5);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        const osc = ctx.createOscillator();
        osc.type = isMega ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(isMega ? 800 : 1200, t);
        osc.frequency.exponentialRampToValueAtTime(isMega ? 150 : 300, t + dur);

        osc.connect(gain);
        gain.connect(targetNode);
        osc.start(t);
        osc.stop(t + dur);
        this._cleanupNodes([gain, osc, ...routingNodes], dur);
    }

    playExplosion(x, y, z, isLarge = false, type = '') {
        // Deduplicate: suppress if another explosion fired within 45ms within 50 units.
        const now = Date.now();
        if (x !== undefined && z !== undefined) {
            const dx = x - this.lastExplosionPos.x;
            const dz = z - this.lastExplosionPos.z;
            if (now - this.lastExplosionTime < 45 && (dx * dx + dz * dz < 2500)) return;
            this.lastExplosionTime = now;
            this.lastExplosionPos = { x, y, z };
        }

        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;

        const isBomber = type === 'bomber';
        const isSquid = type === 'squid';
        const isCrab = type === 'crab';
        const isColossus = type === 'colossus';
        const dur = isLarge || isBomber || isColossus ? 2.8 : (isSquid ? 1.5 : 0.9);

        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;
        distortion.oversample = '4x';

        const noise = this._createNoise(isLarge ? 4.5 : 3.5);

        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = isCrab ? 'bandpass' : 'lowpass';
        if (isCrab) {
            noiseFilter.frequency.setValueAtTime(2000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(500, t + dur);
        } else {
            noiseFilter.frequency.setValueAtTime(isLarge || isBomber || isColossus ? 1800 : 5000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(60, t + dur);
        }

        // The distorted body (noise + oscs → WaveShaper) saturates at ~0.35; multiplied
        // by noiseGain (0.9) the body contributes ~0.315 at targetNode.  The sub-rumble
        // bypasses the WaveShaper and feeds targetNode directly, so subGain 0.35 gives
        // a safe combined sum: 0.35 + 0.315 = 0.665.  The old 0.8 produced 1.115 → clip.
        // noiseGain controls the output envelope of the entire WaveShaper path; its value
        // barely affects peak amplitude since the WaveShaper already saturates to ≤0.35.
        const initVol = isLarge ? 0.9 : (isBomber || isColossus ? 0.9 : 0.75);
        const noiseGain = this._makeGainEnv(ctx, t, initVol, 0.006, dur);

        const toClean = [distortion, noise, noiseFilter, noiseGain];

        // Sub-rumble for weight on large explosions
        if (isLarge || isBomber || isColossus) {
            const subGain = this._makeGainEnv(ctx, t, 0.35, 0.006, dur * 0.6);
            const sub = this._makeOsc(ctx, t, 'sine', 60, 20, dur * 0.5, subGain, undefined, dur);
            subGain.connect(targetNode);
            toClean.push(sub, subGain);
        }

        if (noise) noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        // Oscillators — large/bombers use lower freqs; squids use sawtooth for a ripping sound.
        const freqs = isLarge || isBomber ? [90, 94, 86] : (isSquid ? [130, 135, 125] : [150, 155, 145]);
        const endFreq = isLarge || isBomber ? 20 : (isSquid ? 5 : 20);
        const baseGain = isLarge || isBomber ? 1.0 : (isSquid ? 0.8 : 0.6);
        freqs.forEach((freq, idx) => {
            const oscType = isSquid ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            const oscGain = this._makeGainEnv(ctx, t, baseGain, 0.004, dur);
            const osc = this._makeOsc(ctx, t, oscType, freq, endFreq, dur, oscGain);
            oscGain.connect(distortion);
            toClean.push(osc, oscGain);
        });

        distortion.connect(noiseGain);
        noiseGain.connect(targetNode);
        if (noise) noise.stop(t + dur);
        this._cleanupNodes([...toClean, ...routingNodes], dur);
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

        this._cleanupNodes(nodes, 0.4 + 1.3);
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
        this.init();
        if (!this.ctx) return;
        const t = this.ctx.currentTime;

        if (!active) {
            if (this.thrustNodes[id]) {
                const n = this.thrustNodes[id];
                if (!n.stopping) {
                    n.active = false;
                    n.stopping = true;
                    n.stopSeq = (n.stopSeq || 0) + 1;
                    const stopSeq = n.stopSeq;
                    this._paramSetTarget(n.gain.gain, 0, t, 0.04);
                    n.stopTimer = setTimeout(() => {
                        n.stopTimer = null;
                        if (this.thrustNodes[id] === n && n.stopping && n.stopSeq === stopSeq) {
                            this._stopThrustNode(n);
                            delete this.thrustNodes[id];
                        }
                    }, 160);
                }
            }
            return;
        }

        if (this.thrustNodes[id]) {
            // Invalidate any pending delayed stop from a recent key release.
            const n = this.thrustNodes[id];
            n.active = true;
            if (n.stopping) {
                n.stopping = false;
                n.stopSeq = (n.stopSeq || 0) + 1;
                if (n.stopTimer) {
                    clearTimeout(n.stopTimer);
                    n.stopTimer = null;
                }
            }
        }

        if (!this.thrustNodes[id]) {
            const gain = this.ctx.createGain();
            gain.gain.value = 0;

            // Only spatialize engine thrust for OTHER players when spatialization is enabled.
            // For the local player (id 0), or in two-player mode, the engine drone should be
            // non-spatialized to avoid HRTF/panning artifacts (crackling).
            let panner = null;
            if (id !== 0 && this.spatialEnabled) {
                panner = this.createSpatializer(x, y, z);
                if (panner) {
                    panner.panningModel = 'equalpower';
                    panner.distanceModel = 'linear';
                    panner.refDistance = 200;
                    panner.rolloffFactor = 0.5;
                }
            } else if (!this.spatialEnabled && this.ctx.createStereoPanner) {
                // Split-screen mode: add fixed stereo separation to help distinguish the two viewports.
                panner = this.ctx.createStereoPanner();
                panner.pan.setValueAtTime((id === 0) ? -0.4 : 0.4, t);
            }

            // Low deep rumble (oscillator)
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            // Offset frequency slightly per ID to prevent phasing/beating in mono.
            osc.frequency.setValueAtTime(42 + (id * 0.7), t);

            // Deep roar (noise) — mul=0.4 gives a quieter pre-mixed level.
            // _createNoise already sets loop=true on the inner BufferSource.
            const noise = this._createNoise(0.4);

            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(110, t);
            filter.Q.value = 0.2; // Keep Q extra low for the engine core

            osc.connect(filter);
            if (noise) noise.connect(filter);
            filter.connect(gain);

            if (panner) {
                gain.connect(panner);
                panner.connect(this.master || this.ctx.destination);
            } else {
                // Connect local player thrust directly to master/output for perfect stability.
                gain.connect(this.master || this.ctx.destination);
            }

            osc.start(t);

            this.thrustNodes[id] = {
                osc,
                noise,
                gain,
                panner,
                filter,
                lastX: x,
                lastY: y,
                lastZ: z,
                active: true,
                stopSeq: 0,
                stopping: false,
                stopTimer: null
            };
        }

        const n = this.thrustNodes[id];
        // 50ms smoothing
        const baseVol = (id === 0) ? (this.spatialEnabled ? 0.32 : 0.24) : (this.spatialEnabled ? 0.22 : 0.16);
        let finalVol = baseVol;

        // Manual attenuation for engines in split-screen mode
        if (x !== undefined && y !== undefined && z !== undefined) {
            let minDistSq = Infinity;
            if (typeof gameState !== 'undefined' && gameState.players.length > 0) {
                const numPlayers = gameState.players.length;
                for (let i = 0; i < numPlayers; i++) {
                    const p = gameState.players[i];
                    if (p.dead || !p.ship) continue;
                    const dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq !== Infinity && !this.spatialEnabled) {
                    const distance = Math.sqrt(minDistSq);
                    if (distance > this._refDist) {
                        finalVol *= Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                    }
                }
            }
        }

        this._paramSetTarget(n.gain.gain, finalVol, t, 0.05);

        // Subtle altitude-based adjustment for the local player engine
        if (id === 0 && y !== undefined) {
            const altFactor = constrain((100 - y) / 2000, 0, 1); // 0 at launchpad, 1 at 2100 altitude
            this._paramSetTarget(n.filter.frequency, 110 + altFactor * 40, t, 0.1);
            this._paramSetTarget(n.osc.frequency, 42 + altFactor * 10, t, 0.1);
        }

        // Only update 3D panner position if we are in spatial mode (single player)
        if (this.spatialEnabled && n.panner && x !== undefined) {
            const dt = 0.05;
            const distSq = (x - n.lastX) ** 2 + (y - n.lastY) ** 2 + (z - n.lastZ) ** 2;
            if (distSq > 0.1) {
                try {
                    const px = n.panner.positionX;
                    const py = n.panner.positionY;
                    const pz = n.panner.positionZ;
                    if (px && py && pz) {
                        this._cancelAndHoldParam(px, t);
                        this._cancelAndHoldParam(py, t);
                        this._cancelAndHoldParam(pz, t);
                    }
                    n.panner.positionX.linearRampToValueAtTime(x, t + dt);
                    n.panner.positionY.linearRampToValueAtTime(y, t + dt);
                    n.panner.positionZ.linearRampToValueAtTime(z, t + dt);
                } catch (e) {
                    n.panner.setPosition(x, y, z);
                }
                n.lastX = x; n.lastY = y; n.lastZ = z;
            }
        }
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
