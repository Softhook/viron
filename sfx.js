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
    }

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') {
            this.ctx = getAudioContext();

            // Master compressor to prevent clipping when multiple sounds (explosions, shots, engines)
            // overlap, especially likely in two-player mode.
            this.master = this.ctx.createDynamicsCompressor();
            this.master.threshold.setValueAtTime(-18, this.ctx.currentTime);
            this.master.knee.setValueAtTime(24, this.ctx.currentTime);
            this.master.ratio.setValueAtTime(10, this.ctx.currentTime);
            this.master.attack.setValueAtTime(0.003, this.ctx.currentTime);
            this.master.release.setValueAtTime(0.25, this.ctx.currentTime);
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
    /**
     * Updates persistent ambient sounds based on player position and infection state.
     */
    updateAmbiance(proximityData, infectionCount, maxInfection) {
        if (!this.initialized || !this.ctx) return;
        const dest = this.master || this.ctx.destination;
        let t = this.ctx.currentTime;

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

        const heartRate = 0.5 + (infectionCount / maxInfection) * 1.5; // 0.5Hz to 2.0Hz
        const heartVol = (infectionCount / maxInfection) * 0.4;
        this.ambientNodes.heartbeat.gain.gain.setTargetAtTime(heartVol, t, 0.1);
        // Rhythmic pulsing of the heartbeat
        const pulse = Math.pow(Math.sin(t * Math.PI * heartRate) * 0.5 + 0.5, 4);
        this.ambientNodes.heartbeat.gain.gain.value *= pulse;

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

        const now = this.ctx.currentTime;

        // Steady Hum volume
        const humVol = this._infectionProximityAlpha * 0.18;
        this.ambientNodes.proximityHum.gain.gain.setTargetAtTime(humVol, now, 0.1);
        this.ambientNodes.proximityHum.filter.frequency.setTargetAtTime(200 + this._infectionProximityAlpha * 400, now, 0.1);

        // Pulsed Scanning "zzz" modulation - triggered when a pulse passes the player
        {
            const scanAlpha = proximityData.pulseOverlap || 0;
            // Use squared intensity for a sharper peak (more "zip", less "drone")
            const alphaSq = scanAlpha * scanAlpha;
            this.ambientNodes.scanningMod.gain.gain.setTargetAtTime(alphaSq * 0.8, now, 0.04);
            // Speed up the rhythmic modulation at the peak of the scan
            this.ambientNodes.scanningMod.lfo.frequency.setTargetAtTime(8.0 + alphaSq * 10.0, now, 0.04);
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

        const sweepAlpha = proximityData.scanSweepAlpha || 0;
        // Only audible when near infection to match visual logic
        const sweepVol = sweepAlpha * this._infectionProximityAlpha * 0.6;
        this.ambientNodes.scanSweep.gain.gain.setTargetAtTime(sweepVol, now, 0.05);
        this.ambientNodes.scanSweep.filter.frequency.setTargetAtTime(1500 + sweepAlpha * 1500, now, 0.05);
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
        if (typeof players === 'undefined' || players.length === 0) return null;

        let minDistSq = Infinity;
        let closestIdx = -1;
        const numPlayers = players.length;
        for (let i = 0; i < numPlayers; i++) {
            const p = players[i];
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
        const { targetNode, routingNodes } = s;
        const dur = 0.04;

        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.8, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + dur);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + dur);
        filter.Q.value = 5;

        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + dur);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + dur);
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
            listener.positionX.linearRampToValueAtTime(cx, t + dt);
            listener.positionY.linearRampToValueAtTime(cy, t + dt);
            listener.positionZ.linearRampToValueAtTime(cz, t + dt);
            listener.forwardX.linearRampToValueAtTime(fx, t + dt);
            listener.forwardY.linearRampToValueAtTime(fy, t + dt);
            listener.forwardZ.linearRampToValueAtTime(fz, t + dt);
            listener.upX.linearRampToValueAtTime(ux, t + dt);
            listener.upY.linearRampToValueAtTime(uy, t + dt);
            listener.upZ.linearRampToValueAtTime(uz, t + dt);
        } else {
            listener.setPosition(cx, cy, cz);
            listener.setOrientation(fx, fy, fz, ux, uy, uz);
        }
    }

    createSpatializer(x, y, z) {
        if (!this.ctx || x === undefined || y === undefined || z === undefined) return null;
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
        let panner = this.ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'exponential';
        panner.refDistance = 150;
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

        // Main volume envelope - lower initial gain to prevent clipping during rapid fire
        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.32, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + dur);

        // Low-pass filter to remove "annoying" high frequencies
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, t);
        filter.frequency.exponentialRampToValueAtTime(500, t + 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        // Core oscillators - triangle waves for a smoother, less buzzing sound
        const oscs = [-10, 0, 10].map((det) => {
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(220, t); // A3
            osc.frequency.exponentialRampToValueAtTime(140, t + 0.15);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + dur);
            return osc;
        });

        // Sub-thrum for weight - with high-pass to avoid mud/scratchiness
        const sub = ctx.createOscillator();
        const subFilter = ctx.createBiquadFilter();
        subFilter.type = 'highpass';
        subFilter.frequency.value = 40;
        const subGain = ctx.createGain();

        sub.type = 'sine';
        sub.frequency.setValueAtTime(80, t);
        sub.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        subGain.gain.setValueAtTime(0.25, t);
        subGain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);

        sub.connect(subFilter);
        subFilter.connect(subGain);
        subGain.connect(targetNode);
        sub.start(t);
        sub.stop(t + 0.12);

        this._cleanupNodes([gainNode, filter, sub, subFilter, subGain, ...oscs, ...routingNodes], dur);
    }

    playInfectionPulse(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 1.8;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.01, t);
        gainNode.gain.linearRampToValueAtTime(0.8, t + 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2000, t);
        filter.frequency.exponentialRampToValueAtTime(100, t + dur);

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + dur);

        const noise = this._createNoise(1.2);
        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;

        osc.connect(filter);
        if (noise) noise.connect(filter);
        filter.connect(distortion);
        distortion.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + dur);
        if (noise) noise.stop(t + dur);
        this._cleanupNodes([gainNode, filter, osc, noise, distortion, ...routingNodes], dur);
    }

    playEnemyShot(type = 'fighter', x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;

        const gainNode = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const osc = ctx.createOscillator();

        if (type === 'crab') {
            gainNode.gain.setValueAtTime(0.3, t);
            gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
            filter.type = 'highpass';
            filter.frequency.setValueAtTime(3000, t);
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(800, t);
            osc.frequency.exponentialRampToValueAtTime(4000, t + 0.1);
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(targetNode);
            osc.start(t);
            osc.stop(t + 0.2);
            this._cleanupNodes([gainNode, filter, osc, ...routingNodes], 0.2);
        } else {
            gainNode.gain.setValueAtTime(0.25, t);
            gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(4000, t);
            filter.frequency.exponentialRampToValueAtTime(100, t + 0.15);
            osc.type = 'square';
            osc.frequency.setValueAtTime(1200, t);
            osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(targetNode);
            osc.start(t);
            osc.stop(t + 0.15);
            this._cleanupNodes([gainNode, filter, osc, ...routingNodes], 0.15);
        }
    }

    playMissileFire(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.6;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.5, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, t);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2);
        filter.frequency.exponentialRampToValueAtTime(100, t + dur);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        const oscs = [-25, 0, 25].map(det => {
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(150, t);
            osc.frequency.exponentialRampToValueAtTime(40, t + dur);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + dur);
            return osc;
        });

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
        gain.gain.setValueAtTime(isMega ? 0.6 : 0.3, t);
        gain.gain.linearRampToValueAtTime(isMega ? 0.8 : 0.4, t + dur * 0.5);
        gain.gain.exponentialRampToValueAtTime(0.01, t + dur);

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

        const noiseGain = ctx.createGain();
        const initVol = isLarge ? (type === '' ? 1.4 : 1.6) : (isBomber || isColossus ? 1.8 : 1.1);
        noiseGain.gain.setValueAtTime(initVol, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        const toClean = [distortion, noise, noiseFilter, noiseGain];

        // Sub-rumble for weight on large explosions
        if (isLarge || isBomber || isColossus) {
            const sub = ctx.createOscillator();
            const subGain = ctx.createGain();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(60, t);
            sub.frequency.exponentialRampToValueAtTime(20, t + dur * 0.5);
            subGain.gain.setValueAtTime(0.8, t);
            subGain.gain.exponentialRampToValueAtTime(0.01, t + dur * 0.6);
            sub.connect(subGain);
            subGain.connect(targetNode);
            sub.start(t);
            sub.stop(t + dur);
            toClean.push(sub, subGain);
        }

        if (noise) noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        // Oscillators — large/bombers use lower freqs; squids use sawtooth for a ripping sound.
        const freqs = isLarge || isBomber ? [90, 94, 86] : (isSquid ? [130, 135, 125] : [150, 155, 145]);
        const endFreq = isLarge || isBomber ? 20 : (isSquid ? 5 : 20);
        const baseGain = isLarge || isBomber ? 1.0 : (isSquid ? 0.8 : 0.6);
        freqs.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const oscGain = ctx.createGain();
            osc.type = isSquid ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
            oscGain.gain.setValueAtTime(baseGain, t);
            oscGain.gain.exponentialRampToValueAtTime(0.01, t + dur);
            osc.connect(oscGain);
            oscGain.connect(distortion);
            osc.start(t);
            osc.stop(t + dur);
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
        // so cleanup is handled entirely inside each _levelTunes entry.
        const pick = Math.floor(Math.random() * this._levelTunes.length);
        this._levelTunes[pick](ctx, t, targetNode);
    }

    /**
     * Eight Sentinel-style atmospheric dark tunes.
     * Each is a different atmospheric/electronic mood.
     */
    _levelTunes = [

        // 0 — Original: eerie resonant filter sweep on low A minor
        (ctx, t, targetNode) => {
            const freqs = [110.00, 146.83, 164.81, 220.00]; // A2 D3 E3 A3
            const nodes = [];
            freqs.forEach((freq, i) => {
                const noteT = t + i * 0.8;
                [-5, 5].forEach(det => {
                    const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
                    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(freq, noteT); osc.detune.value = det;
                    filter.type = 'lowpass'; filter.Q.value = 10;
                    filter.frequency.setValueAtTime(100, noteT);
                    filter.frequency.exponentialRampToValueAtTime(2000, noteT + 0.4);
                    filter.frequency.exponentialRampToValueAtTime(100, noteT + 1.2);
                    gain.gain.setValueAtTime(0, noteT);
                    gain.gain.linearRampToValueAtTime(0.15, noteT + 0.1);
                    gain.gain.exponentialRampToValueAtTime(0.01, noteT + 1.4);
                    osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                    osc.start(noteT); osc.stop(noteT + 1.5);
                    nodes.push(osc, filter, gain);
                });
            });
            this._cleanupNodes(nodes, 3 * 0.8 + 1.5);
        },

        // 1 — Rapid chiptune arpeggio: tight 8-bit style bleeps racing up and down
        (ctx, t, targetNode) => {
            const seq = [220, 277.18, 329.63, 415.30, 523.25, 415.30, 329.63, 220, 174.61, 220];
            const masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(0.12, t);
            masterGain.connect(targetNode);
            const nodes = [masterGain];
            seq.forEach((freq, i) => {
                const noteT = t + i * 0.1;
                const osc = ctx.createOscillator(), env = ctx.createGain();
                osc.type = 'square'; osc.frequency.value = freq;
                env.gain.setValueAtTime(0, noteT);
                env.gain.linearRampToValueAtTime(1, noteT + 0.005);
                env.gain.setValueAtTime(1, noteT + 0.07);
                env.gain.linearRampToValueAtTime(0, noteT + 0.09);
                osc.connect(env); env.connect(masterGain);
                osc.start(noteT); osc.stop(noteT + 0.1);
                nodes.push(osc, env);
            });
            this._cleanupNodes(nodes, 9 * 0.1 + 0.1);
        },

        // 2 — FM-style clang: carrier + modulator for metallic bell-like tones
        (ctx, t, targetNode) => {
            const carriers = [220, 293.66, 184.99]; // A3, D4, F#3
            const nodes = [];
            carriers.forEach((cFreq, i) => {
                const noteT = t + i * 0.7;
                const carrier = ctx.createOscillator();
                const modulator = ctx.createOscillator();
                const modGain = ctx.createGain();
                const outGain = ctx.createGain();

                carrier.type = 'sine'; carrier.frequency.value = cFreq;
                modulator.type = 'sine'; modulator.frequency.value = cFreq * 3.51; // Non-integer ratio = inharmonic
                modGain.gain.setValueAtTime(cFreq * 8, noteT); // Modulation depth
                modGain.gain.exponentialRampToValueAtTime(cFreq * 0.1, noteT + 1.4);

                modulator.connect(modGain);
                modGain.connect(carrier.frequency); // Frequency modulation

                outGain.gain.setValueAtTime(0, noteT);
                outGain.gain.linearRampToValueAtTime(0.2, noteT + 0.01);
                outGain.gain.exponentialRampToValueAtTime(0.001, noteT + 1.6);

                carrier.connect(outGain); outGain.connect(targetNode);
                carrier.start(noteT); carrier.stop(noteT + 1.7);
                modulator.start(noteT); modulator.stop(noteT + 1.7);
                nodes.push(carrier, modulator, modGain, outGain);
            });
            this._cleanupNodes(nodes, 2 * 0.7 + 1.7);
        },

        // 3 — Theremin-like glide: one continuous pitch sliding eerily through wide interval
        (ctx, t, targetNode) => {
            const osc = ctx.createOscillator();
            const filter = ctx.createBiquadFilter();
            const gain = ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(800, t);
            osc.frequency.exponentialRampToValueAtTime(120, t + 1.5);   // Sweeping glide
            osc.frequency.exponentialRampToValueAtTime(400, t + 2.8);   // Bend back up

            filter.type = 'bandpass'; filter.Q.value = 4; filter.frequency.value = 600;

            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.2, t + 0.3);
            gain.gain.setValueAtTime(0.2, t + 2.4);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 3.0);

            osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 3.1);
            this._cleanupNodes([osc, filter, gain], 3.1);
        },

        // 4 — Rhythmic techno stabs: punchy staccato bursts at irregular intervals
        (ctx, t, targetNode) => {
            const pattern = [
                [t + 0.0, 311.13],  // E♭4
                [t + 0.18, 233.08], // B♭3
                [t + 0.3, 311.13],
                [t + 0.55, 174.61], // F3
                [t + 0.7, 311.13],
                [t + 0.8, 233.08],
                [t + 1.1, 415.30],  // A♭4 — accent
                [t + 1.3, 311.13],
            ];
            const nodes = [];
            pattern.forEach(([noteT, freq]) => {
                const osc = ctx.createOscillator(), gain = ctx.createGain(), filter = ctx.createBiquadFilter();
                osc.type = 'sawtooth'; osc.frequency.value = freq;
                filter.type = 'lowpass'; filter.frequency.setValueAtTime(3500, noteT);
                filter.frequency.exponentialRampToValueAtTime(200, noteT + 0.12);
                gain.gain.setValueAtTime(0.22, noteT);
                gain.gain.exponentialRampToValueAtTime(0.001, noteT + 0.14);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.16);
                nodes.push(osc, filter, gain);
            });
            this._cleanupNodes(nodes, 1.3 + 0.16);
        },

        // 5 — Laser ping sweep: sci-fi rising "pew" with trailing decay
        (ctx, t, targetNode) => {
            const nodes = [];
            [[80, 2400, 0.3], [60, 1800, 0.55], [40, 3200, 0.8]].forEach(([start, end, offset]) => {
                const noteT = t + offset;
                const osc = ctx.createOscillator(), gain = ctx.createGain(), filter = ctx.createBiquadFilter();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(start, noteT);
                osc.frequency.exponentialRampToValueAtTime(end, noteT + 0.25);

                filter.type = 'bandpass'; filter.Q.value = 8;
                filter.frequency.setValueAtTime(start, noteT);
                filter.frequency.exponentialRampToValueAtTime(end, noteT + 0.25);

                gain.gain.setValueAtTime(0.25, noteT);
                gain.gain.exponentialRampToValueAtTime(0.001, noteT + 0.6);

                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.65);
                nodes.push(osc, filter, gain);
            });
            this._cleanupNodes(nodes, 0.8 + 0.65);
        },

        // 6 — Deep bass pulse with tremolo: sub-bass heartbeat that throbs and fades
        (ctx, t, targetNode) => {
            const osc = ctx.createOscillator();
            const tremoloOsc = ctx.createOscillator();
            const tremoloGain = ctx.createGain();
            const masterGain = ctx.createGain();
            const filter = ctx.createBiquadFilter();

            osc.type = 'sawtooth'; osc.frequency.value = 55; // A1
            tremoloOsc.type = 'sine'; tremoloOsc.frequency.value = 6; // 6Hz tremolo
            tremoloGain.gain.value = 0.5;
            filter.type = 'lowpass'; filter.frequency.value = 300; filter.Q.value = 5;

            masterGain.gain.setValueAtTime(0, t);
            masterGain.gain.linearRampToValueAtTime(0.3, t + 0.2);
            masterGain.gain.setValueAtTime(0.3, t + 2.5);
            masterGain.gain.exponentialRampToValueAtTime(0.001, t + 3.5);

            tremoloOsc.connect(tremoloGain);
            tremoloGain.connect(masterGain.gain); // Tremolo modulates the master gain
            osc.connect(filter); filter.connect(masterGain); masterGain.connect(targetNode);
            osc.start(t); osc.stop(t + 3.6);
            tremoloOsc.start(t); tremoloOsc.stop(t + 3.6);
            this._cleanupNodes([osc, tremoloOsc, tremoloGain, masterGain, filter], 3.6);
        },

        // 7 — Alien morse code: irregular high-pitched digital beeps with feedback ring
        (ctx, t, targetNode) => {
            const beeps = [
                [0.0, 0.04, 1200],
                [0.07, 0.04, 1200],
                [0.13, 0.12, 900],   // long
                [0.3, 0.04, 1500],
                [0.37, 0.04, 1500],
                [0.44, 0.04, 1500],
                [0.55, 0.12, 700],   // long low
                [0.72, 0.04, 1200],
                [0.79, 0.12, 1000],
                [0.95, 0.04, 1800],
            ];
            const nodes = [];
            beeps.forEach(([offset, dur, freq]) => {
                const noteT = t + offset;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sine'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.18, noteT + 0.005);
                gain.gain.setValueAtTime(0.18, noteT + dur - 0.01);
                gain.gain.linearRampToValueAtTime(0, noteT + dur);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + dur + 0.01);
                nodes.push(osc, gain);
            });
            this._cleanupNodes(nodes, 0.95 + 0.12 + 0.01);
        },
    ];

    /**
     * Plays a triumphant, electronic fanfare upon level completion.
     * Fast upward arpeggio with bright, snappy pulse waves.
     */
    playLevelComplete() {
        const s = this._setup();
        if (!s) return;
        const { ctx, t, targetNode } = s;
        const nodes = [];

        const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 (C Major)
        notes.forEach((freq, i) => {
            const noteT = t + i * 0.08;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.2, noteT + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.15);
            osc.connect(gain);
            gain.connect(targetNode);
            osc.start(noteT);
            osc.stop(noteT + 0.2);
            nodes.push(osc, gain);
        });

        // Final lingering bright chord
        [523.25, 1046.50].forEach(freq => {
            const noteT = t + 0.4;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.1, noteT + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, noteT + 1.2);
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
                gain.gain.setValueAtTime(0.0, noteT);
                gain.gain.linearRampToValueAtTime(0.3, noteT + 0.1);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 1.8);

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
        masterGain.gain.setValueAtTime(0.35, t);
        masterGain.gain.linearRampToValueAtTime(0.01, t + dur);
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
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.3);
                osc.connect(gain);
                gain.connect(masterGain);
                osc.start(noteT);
                osc.stop(noteT + 0.4);
                nodes.push(osc, gain);
            });
        });

        this._cleanupNodes([...nodes, ...routingNodes], 3 * 0.1 + 0.4);
    }

    playClearInfection(x, y, z) {
        const s = this._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const nodes = [];

        const freqs = [523.25, 659.25, 1046.50];
        freqs.forEach((freq) => {
            [-15, 0, 15].forEach(det => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.detune.value = det;
                gain.gain.setValueAtTime(0.0, t);
                gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.01, t + 1.2);
                osc.connect(gain);
                gain.connect(targetNode);
                osc.start(t);
                osc.stop(t + 1.3);
                nodes.push(osc, gain);
            });
        });

        const noise = this._createNoise();
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 4000;

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.2, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

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

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + dur);

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
                n.gain.gain.setTargetAtTime(0, t, 0.05);
                setTimeout(() => {
                    if (this.thrustNodes[id] === n) {
                        try { n.osc.stop(); } catch (e) {}
                        try { n.noise.stop(); } catch (e) {}
                        try { n.osc.disconnect(); } catch (e) {}
                        try { n.noise.disconnect(); } catch (e) {}
                        // Disconnect the inner BufferSource wrapped by the gain proxy.
                        if (n.noise && n.noise._src) try { n.noise._src.disconnect(); } catch (e) {}
                        try { n.filter.disconnect(); } catch (e) {}
                        if (n.panner) try { n.panner.disconnect(); } catch (e) {}
                        try { n.gain.disconnect(); } catch (e) {}
                        delete this.thrustNodes[id];
                    }
                }, 200);
            }
            return;
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

            this.thrustNodes[id] = { osc, noise, gain, panner, filter, lastX: x, lastY: y, lastZ: z };
        }

        const n = this.thrustNodes[id];
        // 50ms smoothing
        const baseVol = (id === 0) ? (this.spatialEnabled ? 0.32 : 0.24) : (this.spatialEnabled ? 0.22 : 0.16);
        let finalVol = baseVol;

        // Manual attenuation for engines in split-screen mode
        if (x !== undefined && y !== undefined && z !== undefined) {
            let minDistSq = Infinity;
            if (typeof players !== 'undefined' && players.length > 0) {
                const numPlayers = players.length;
                for (let i = 0; i < numPlayers; i++) {
                    const p = players[i];
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

        n.gain.gain.setTargetAtTime(finalVol, t, 0.05);

        // Subtle altitude-based adjustment for the local player engine
        if (id === 0 && y !== undefined) {
            const altFactor = constrain((100 - y) / 2000, 0, 1); // 0 at launchpad, 1 at 2100 altitude
            n.filter.frequency.setTargetAtTime(110 + altFactor * 40, t, 0.1);
            n.osc.frequency.setTargetAtTime(42 + altFactor * 10, t, 0.1);
        }

        // Only update 3D panner position if we are in spatial mode (single player)
        if (this.spatialEnabled && n.panner && x !== undefined) {
            const dt = 0.05;
            const distSq = (x - n.lastX) ** 2 + (y - n.lastY) ** 2 + (z - n.lastZ) ** 2;
            if (distSq > 0.1) {
                try {
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
}

const gameSFX = new GameSFX();
