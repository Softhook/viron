class GameSFX {
    constructor() {
        this.initialized = false;
        this.distCurve = null;
        this.spatialEnabled = true;
        this.thrustNodes = {}; // id -> { osc, noise, gain, panner }
        this.ambientNodes = {}; // key -> { osc, noise, gain, filter, panner }
        this.lastExplosionTime = 0;
        this.lastExplosionPos = { x: 0, y: 0, z: 0 };
        this.ctx = null;
        this.master = null;
        this.activeVoices = []; // { startTime, duration, tailNode, priority, distSq }
        this.maxVoices = 32;
        this.pannerPool = [];
        this.MAX_PANNER_POOL = 16;

        // constant values used across methods
        this._refDist = 180;            // reference distance for manual attenuation
        this._zoomOffset = 520;         // offset to simulate camera zoom in 2p mode
        this._maxManualDist = 8000;     // upper clamp for manual volume falloff
        this._maxManualDistSq = 8000 * 8000; // cached squared — avoids ** per sound in _setup
        this._infectionProximityAlpha = 0; // Smoothed proximity value


        // Priority constants
        this.PRIORITY = {
            LOW: 0,     // Common environment sounds
            MED: 1,     // Most SFX
            HIGH: 2,    // Player-triggered crucial SFX
            CRITICAL: 3 // Alarms, Level transitions
        };
    }

    static _EXPLOSION_CONFIG = {
        'default': { dur: 0.9, heavy: false, initVol: 1.1, freqs: [150, 155, 145], endFreq: 20, baseGain: 0.6 },
        'large': { dur: 2.8, heavy: true, initVol: 1.4, freqs: [90, 94, 86], endFreq: 20, baseGain: 1.0 },
        'bomber': { dur: 2.8, heavy: true, initVol: 1.8, freqs: [90, 94, 86], endFreq: 20, baseGain: 1.0 },
        'colossus': { dur: 2.8, heavy: true, initVol: 1.8, freqs: [90, 94, 86], endFreq: 20, baseGain: 1.0 },
        'squid': { dur: 1.5, heavy: false, initVol: 1.1, freqs: [130, 135, 125], endFreq: 5, baseGain: 0.8, sawtooth: true },
        'crab': { dur: 0.9, heavy: false, initVol: 1.1, freqs: [150, 155, 145], endFreq: 20, baseGain: 0.6, bandpass: true }
    };

    static _ENEMY_SHOT_CONFIG = {
        'crab': { dur: 0.2, vol: 0.3, filter: 'highpass', freq: 3000, osc: 'sawtooth', baseF: 800, endF: 4000 },
        'fighter': { dur: 0.15, vol: 0.25, filter: 'lowpass', freq: 4000, osc: 'square', baseF: 1200, endF: 200 }
    };

    static _COMPRESSOR_CONFIG = {
        threshold: -18,
        knee: 24,
        ratio: 10,
        attack: 0.003,
        release: 0.25
    };

    static _PLAYER_SHOT_CONFIG = {
        dur: 0.18, vol: 0.32, detunes: [-10, 0, 10], baseF: 220, endF: 140, filterF: 1800
    };

    static _MISSILE_CONFIG = {
        dur: 0.6, vol: 0.5, detunes: [-25, 0, 25], baseF: 150, endF: 40, filterF: 400
    };

    static _BOMB_CONFIG = {
        normal: { dur: 0.4, vol: 0.3, maxVol: 0.4, baseF: 1200, endF: 300, osc: 'sine', noiseVol: 0.35, noiseF: 800 },
        mega: { dur: 0.8, vol: 0.6, maxVol: 0.8, baseF: 800, endF: 150, osc: 'sawtooth', noiseVol: 0.6, noiseF: 300 }
    };

    static _PULSE_CONFIG = {
        dur: 1.8, vol: 0.8, baseF: 120, endF: 40, filterF: 2000, noiseMul: 1.2
    };

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') {
            this.ctx = getAudioContext();

            const cfg = GameSFX._COMPRESSOR_CONFIG;
            this.master = this.ctx.createDynamicsCompressor();
            this.master.threshold.setValueAtTime(cfg.threshold, this.ctx.currentTime);
            this.master.knee.setValueAtTime(cfg.knee, this.ctx.currentTime);
            this.master.ratio.setValueAtTime(cfg.ratio, this.ctx.currentTime);
            this.master.attack.setValueAtTime(cfg.attack, this.ctx.currentTime);
            this.master.release.setValueAtTime(cfg.release, this.ctx.currentTime);
            this.master.connect(this.ctx.destination);

            this.distCurve = this.createDistortionCurve(400);
            this.distCurveGameOver = this.createDistortionCurve(60);

            // LATERAL OPT: Pre-calculate one long noise buffer and reuse it.
            // Eliminates O(N) loop math in _createNoise during explosions.
            this.persistentNoise = this._calculatePersistentNoise(3.0);
            this.lastSpreadTime = 0;
        }
        this.initialized = true;
    }

    _calculatePersistentNoise(dur) {
        if (!this.ctx) return null;
        let bufferSize = Math.floor(this.ctx.sampleRate * dur);
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        // Smooth loop cross-fade
        let blend = Math.floor(this.ctx.sampleRate * 0.2);
        for (let i = 0; i < blend; i++) {
            let r = i / blend;
            data[i] = data[i] * r + data[bufferSize - blend + i] * (1.0 - r);
        }
        return buffer;
    }

    /**
     * Internal voice limit enforcer. 
     * If too many voices are active, stops and disconnects the lowest priority/furthest ones.
     */
    _limitVoices() {
        if (this.activeVoices.length <= this.maxVoices) return;

        // Sort: Priority DESC, then Distance ASC (keep close high-priority sounds)
        this.activeVoices.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return a.distSq - b.distSq;
        });

        // Terminate excess voices
        while (this.activeVoices.length > this.maxVoices) {
            let voice = this.activeVoices.pop();
            this._terminateVoice(voice);
        }
    }

    _terminateVoice(voice) {
        if (!voice) return;
        try {
            // Stop all tracked source nodes first.
            if (voice.nodes) {
                voice.nodes.forEach(n => {
                    try { if (n.stop) n.stop(); } catch (e) { }
                });
            }
            // Only disconnect if tailNode is not a system bus node (master/destination).
            // Disconnecting master would silence all audio.
            const isBusNode = voice.tailNode === this.master || voice.tailNode === this.ctx.destination;
            if (voice.tailNode && !isBusNode) {
                voice.tailNode.disconnect();
            }
            // Return pooled panner.
            if (voice.panner && this.pannerPool.length < this.MAX_PANNER_POOL) {
                voice.panner.disconnect();
                this.pannerPool.push(voice.panner);
            }
        } catch (e) { }
    }

    /**
     * Cheap O(N) expired-voice sweep. Called at the start of _setup.
     * No sort — that stays in _limitVoices, called only when over cap.
     */
    _pruneExpired() {
        const now = this.ctx.currentTime;
        for (let i = this.activeVoices.length - 1; i >= 0; i--) {
            const v = this.activeVoices[i];
            if (now > v.startTime + v.duration + 0.1) {
                this._terminateVoice(v);
                this.activeVoices.splice(i, 1);
            }
        }
    }


    _getPanner() {
        if (this.pannerPool.length > 0) return this.pannerPool.pop();
        let panner = this.ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'exponential';
        panner.refDistance = 150;
        panner.maxDistance = 10000;
        panner.rolloffFactor = 1.0;
        return panner;
    }
    /**
     * Updates persistent ambient sounds based on player position and infection state.
     */
    updateAmbiance(proximityData, infectionCount, maxInfection) {
        if (!this.initialized || !this.ctx) return;
        // Single ctx.currentTime read — eliminates duplicate OS-clock call per frame.
        const t = this.ctx.currentTime;

        // 1. Infection Heartbeat (Sub-bass rumble)
        if (!this.ambientNodes.heartbeat) {
            let osc = this.ctx.createOscillator();
            let gain = this.ctx.createGain();
            let filter = this.ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.value = 45;

            filter.type = 'lowpass';
            filter.frequency.value = 80;

            gain.gain.value = 0;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.master || this.ctx.destination);
            osc.start();
            this.ambientNodes.heartbeat = { osc, gain, filter };
        }

        let heartRate = 0.5 + (infectionCount / maxInfection) * 1.5; // 0.5Hz to 2.0Hz
        let heartVol = (infectionCount / maxInfection) * 0.4;
        // Rhythmic pulsing: compute combined volume BEFORE scheduling.
        // NEVER write .value after setTargetAtTime — it cancels all prior automation.
        let pulse = Math.pow(Math.sin(t * Math.PI * heartRate) * 0.5 + 0.5, 4);
        this.ambientNodes.heartbeat.gain.gain.setTargetAtTime(heartVol * pulse, t, 0.02);

        // 2. Infection Proximity (Buzzy Scanning Hum)
        if (!this.ambientNodes.proximityHum) {
            let osc = this.ctx.createOscillator();
            let noise = this._createNoise(3.0, 0, 0.25, t);
            let gain = this.ctx.createGain();
            let filter = this.ctx.createBiquadFilter();

            osc.type = 'sawtooth';
            osc.frequency.value = 60;

            filter.type = 'bandpass';
            filter.frequency.value = 400;
            filter.Q.value = 10;

            gain.gain.value = 0;



            osc.connect(filter);
            if (noise) (noise.output || noise).connect(filter);
            filter.connect(gain);
            gain.connect(this.master || this.ctx.destination);
            osc.start();
            this.ambientNodes.proximityHum = { osc, noise, gain, filter };
        }

        // 3. Scanning Modulation (Temporary pulse-pass "zzz")
        if (!this.ambientNodes.scanningMod) {
            let osc = this.ctx.createOscillator();
            let gain = this.ctx.createGain();
            let filter = this.ctx.createBiquadFilter();
            let lfo = this.ctx.createOscillator();
            let lfoGain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.value = 80;

            filter.type = 'bandpass';
            filter.frequency.value = 800;
            filter.Q.value = 12;

            lfo.type = 'sine';
            lfo.frequency.value = 8.0;
            lfoGain.gain.value = 500;

            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);

            gain.gain.value = 0;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.master || this.ctx.destination);

            osc.start();
            lfo.start();
            this.ambientNodes.scanningMod = { osc, gain, filter, lfo, lfoGain };
        }

        // Smoothed proximity: inline exponential lerp — no dependency on sketch.js `lerp` global.
        const targetProximity = proximityData.dist < 800 ? (1 - proximityData.dist / 800) : 0;
        this._infectionProximityAlpha = (this._infectionProximityAlpha || 0) + (targetProximity - (this._infectionProximityAlpha || 0)) * 0.05;
        // Reuse `t` from top of method — no second currentTime read needed.
        // Steady Hum volume
        let humVol = this._infectionProximityAlpha * 0.18;
        this.ambientNodes.proximityHum.gain.gain.setTargetAtTime(humVol, t, 0.1);
        this.ambientNodes.proximityHum.filter.frequency.setTargetAtTime(200 + this._infectionProximityAlpha * 400, t, 0.1);

        if (this.ambientNodes.scanningMod) {
            const scanAlpha = proximityData.pulseOverlap || 0;
            const alphaSq = scanAlpha * scanAlpha;
            this.ambientNodes.scanningMod.gain.gain.setTargetAtTime(alphaSq * 0.8, t, 0.04);
            this.ambientNodes.scanningMod.lfo.frequency.setTargetAtTime(8.0 + alphaSq * 10.0, t, 0.04);
        }

        // 4. Visual Scan Line Sweep (Metallic "Ping")
        if (!this.ambientNodes.scanSweep) {
            let noise = this._createNoise(2.0, 0, 0.2, t);
            let filter = this.ctx.createBiquadFilter();
            let gain = this.ctx.createGain();

            filter.type = 'bandpass';
            filter.frequency.value = 2000;
            filter.Q.value = 25; // Very resonant

            gain.gain.value = 0;

            if (noise) (noise.output || noise).connect(filter);
            filter.connect(gain);
            gain.connect(this.master || this.ctx.destination);

            this.ambientNodes.scanSweep = { noise, filter, gain };
        }

        const sweepAlpha = proximityData.scanSweepAlpha || 0;
        const sweepVol = sweepAlpha * this._infectionProximityAlpha * 0.6;
        this.ambientNodes.scanSweep.gain.gain.setTargetAtTime(sweepVol, t, 0.05);
        this.ambientNodes.scanSweep.filter.frequency.setTargetAtTime(1500 + sweepAlpha * 1500, t, 0.05);
    }

    _setup(x, y, z, priority = 1, duration = 0.5) {
        this.init();
        if (!this.ctx) return null;
        this._pruneExpired();

        let t = this.ctx.currentTime;
        let targetNode = this.master || this.ctx.destination;
        let infraChain = []; // Nodes to be disconnected later
        let pannerFixed = null;
        let minDistSq = Infinity;

        if (x !== undefined && y !== undefined && z !== undefined) {
            // Early exit for performance: if sound is way beyond audible distance, don't even create it
            if (typeof players !== 'undefined' && players.length > 0) {
                for (let i = 0; i < players.length; i++) {
                    let p = players[i];
                    if (p.dead || !p.ship) continue;
                    let dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq > this._maxManualDistSq) return null;
            }

            if (this.spatialEnabled) {
                let panner = this._getPanner();
                if (panner) {
                    if (panner.positionX) {
                        panner.positionX.setValueAtTime(x, t);
                        panner.positionY.setValueAtTime(y, t);
                        panner.positionZ.setValueAtTime(z, t);
                    } else {
                        panner.setPosition(x, y, z);
                    }
                    panner.connect(targetNode);
                    targetNode = panner;
                    pannerFixed = panner;
                }
            } else {
                let manualVol = 1.0;
                let panVal = 0;
                let closestIdx = -1;

                if (minDistSq !== Infinity) {
                    let distance = Math.sqrt(minDistSq) + this._zoomOffset;
                    if (distance > this._refDist) {
                        manualVol = Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                    }
                    if (players.length === 2) {
                        // find which player was closest
                        for (let i = 0; i < players.length; i++) {
                            let p = players[i]; if (p.dead || !p.ship) continue;
                            let dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                            if (dSq <= minDistSq + 1) { closestIdx = i; break; }
                        }
                        panVal = (closestIdx === 0) ? -0.35 : 0.35;
                    }
                }

                if (manualVol < 0.99 || panVal !== 0) {
                    let g = this.ctx.createGain();
                    g.gain.setValueAtTime(manualVol, t);
                    infraChain.push(g);

                    let f = this.ctx.createBiquadFilter();
                    f.type = 'lowpass';
                    let distFactor = (minDistSq === Infinity) ? 0 : Math.min(Math.max(0, (minDistSq - 10000) / 1000000), 1);
                    f.frequency.setValueAtTime(20000 - (18000 * distFactor), t);
                    g.connect(f);
                    infraChain.push(f);

                    if (panVal !== 0 && this.ctx.createStereoPanner) {
                        let p = this.ctx.createStereoPanner();
                        p.pan.setValueAtTime(panVal, t);
                        f.connect(p);
                        p.connect(targetNode);
                        infraChain.push(p);
                    } else {
                        f.connect(targetNode);
                    }
                    targetNode = g;
                }
            }
        }

        // Create the voice tracker.
        // tailNode is the node to disconnect to sever the sound from the graph.
        // For spatialized voices it's the panner/infra tail. For non-spatial sounds
        // routed directly to master, we use the master node itself as the disconnect
        // target so that the voice is still tracked and cleaned up on schedule.
        let tailNode = null;
        if (infraChain.length > 0) {
            tailNode = infraChain[infraChain.length - 1];
        } else if (pannerFixed) {
            tailNode = pannerFixed;
        } else {
            // Non-spatial: track against master so _pruneVoices can still stop sources.
            tailNode = this.master || this.ctx.destination;
        }

        const voice = {
            startTime: t,
            duration: duration,
            tailNode,
            panner: pannerFixed,
            infra: infraChain,
            priority: priority,
            distSq: minDistSq,
            nodes: [] // Oscillators/sources to be stopped on termination
        };

        this.activeVoices.push(voice);
        // O(N log N) sort only when over cap — skipped on the vast majority of frames.
        if (this.activeVoices.length > this.maxVoices) this._limitVoices();

        return { ctx: this.ctx, t, targetNode, voice };
    }

    // Always returns the BufferSourceNode so callers can track it for cleanup.
    // When mul !== 1, a GainNode is inserted; access it via noise.output for connecting.
    _createNoise(dur, filterCoeff = 0, mul = 1, startAt = null) {
        if (!this.ctx || !this.persistentNoise) return null;
        let noise = this.ctx.createBufferSource();
        noise.buffer = this.persistentNoise;
        noise.loop = true;

        const t = startAt !== null ? startAt : this.ctx.currentTime;
        // Start at a random position in the seamless looped buffer for variety.
        noise.start(t, Math.random() * noise.buffer.duration);

        if (mul !== 1) {
            let gain = this.ctx.createGain();
            gain.gain.value = mul;
            noise.connect(gain);
            noise.output = gain; // callers: connect via (noise.output || noise)
        }

        return noise;
    }

    /**
     * Throttled infection spread sound. 
     * If 50 tiles spread at once, playing 50 sounds will crash the audio thread.
     * Limit to one sound every 60ms.
     */
    playInfectionSpread(x, y, z) {
        if (!this.initialized) return;
        let t = this.ctx.currentTime;
        if (t - (this.lastSpreadTime || 0) < 0.06) return;
        this.lastSpreadTime = t;

        let dur = 0.04;
        let s = this._setup(x, y, z, this.PRIORITY.LOW, dur);
        if (!s) return;
        let { targetNode, voice } = s;

        let gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.8, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + dur);

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + dur);
        filter.Q.value = 5;

        let osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + dur);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + dur);
        voice.nodes.push(osc);
    }

    updateListener(cx, cy, cz, lx, ly, lz, ux, uy, uz) {
        if (!this.ctx || !this.ctx.listener || !this.spatialEnabled) return;
        const listener = this.ctx.listener;

        let fx = lx - cx, fy = ly - cy, fz = lz - cz;
        let flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        if (listener.positionX) {
            listener.positionX.value = cx;
            listener.positionY.value = cy;
            listener.positionZ.value = cz;
            listener.forwardX.value = fx;
            listener.forwardY.value = fy;
            listener.forwardZ.value = fz;
            listener.upX.value = ux;
            listener.upY.value = uy;
            listener.upZ.value = uz;
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
        let k = typeof amount === 'number' ? amount : 50;
        // Use actual device sample rate to ensure correct curve shape on 48kHz hardware.
        let n_samples = (this.ctx && this.ctx.sampleRate) ? this.ctx.sampleRate : 44100;
        let curve = new Float32Array(n_samples);
        let deg = Math.PI / 180;
        for (let i = 0; i < n_samples; i++) {
            let x = i * 2 / n_samples - 1;
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    playShot(x, y, z) {
        const cfg = GameSFX._PLAYER_SHOT_CONFIG;
        const s = this._setup(x, y, z, this.PRIORITY.HIGH, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(cfg.vol, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cfg.filterF, t);
        filter.frequency.exponentialRampToValueAtTime(500, t + 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        cfg.detunes.forEach((det) => {
            const osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(cfg.baseF, t);
            osc.frequency.exponentialRampToValueAtTime(cfg.endF, t + 0.15);
            osc.connect(filter);
            osc.start(t); osc.stop(t + cfg.dur);
            voice.nodes.push(osc);
        });

        const sub = ctx.createOscillator();
        const subFilter = ctx.createBiquadFilter();
        subFilter.type = 'highpass';
        subFilter.frequency.value = 40;
        sub.type = 'sine';
        sub.frequency.setValueAtTime(80, t);
        sub.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.25, t);
        subGain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
        sub.connect(subFilter);
        subFilter.connect(subGain);
        subGain.connect(targetNode);
        sub.start(t); sub.stop(t + 0.12);
        voice.nodes.push(sub);
    }

    playInfectionPulse(x, y, z) {
        const cfg = GameSFX._PULSE_CONFIG;
        const s = this._setup(x, y, z, this.PRIORITY.MED, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.01, t);
        gainNode.gain.linearRampToValueAtTime(cfg.vol, t + 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cfg.filterF, t);
        filter.frequency.exponentialRampToValueAtTime(100, t + cfg.dur);

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(cfg.baseF, t);
        osc.frequency.exponentialRampToValueAtTime(cfg.endF, t + cfg.dur);

        const noise = this._createNoise(cfg.dur, 0.05, cfg.noiseMul, t);
        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;

        osc.connect(filter);
        if (noise) (noise.output || noise).connect(filter);
        filter.connect(distortion);
        distortion.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t); osc.stop(t + cfg.dur);
        voice.nodes.push(osc);
        if (noise) { voice.nodes.push(noise); noise.stop(t + cfg.dur); }
    }

    playEnemyShot(type = 'fighter', x, y, z) {
        const cfg = GameSFX._ENEMY_SHOT_CONFIG[type] || GameSFX._ENEMY_SHOT_CONFIG['fighter'];
        const s = this._setup(x, y, z, this.PRIORITY.MED, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(cfg.vol, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

        const filter = ctx.createBiquadFilter();
        filter.type = cfg.filter;
        filter.frequency.setValueAtTime(cfg.freq, t);
        if (cfg.filter === 'lowpass') {
            filter.frequency.exponentialRampToValueAtTime(100, t + cfg.dur);
        }

        const osc = ctx.createOscillator();
        osc.type = cfg.osc;
        osc.frequency.setValueAtTime(cfg.baseF, t);
        osc.frequency.exponentialRampToValueAtTime(cfg.endF, t + cfg.dur);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + cfg.dur);
        voice.nodes.push(osc);
    }


    playMissileFire(x, y, z) {
        const cfg = GameSFX._MISSILE_CONFIG;
        const s = this._setup(x, y, z, this.PRIORITY.HIGH, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(cfg.vol, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cfg.filterF, t);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2);
        filter.frequency.exponentialRampToValueAtTime(100, t + cfg.dur);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        cfg.detunes.forEach(det => {
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(cfg.baseF, t);
            osc.frequency.exponentialRampToValueAtTime(cfg.endF, t + cfg.dur);
            osc.connect(filter);
            osc.start(t); osc.stop(t + cfg.dur);
            voice.nodes.push(osc);
        });

        const noise = this._createNoise(cfg.dur, 0.05, 1.0, t);
        if (noise) {
            (noise.output || noise).connect(filter);
            noise.stop(t + cfg.dur);
            voice.nodes.push(noise);
        }
    }

    playBombDrop(type = 'normal', x, y, z) {
        const cfg = GameSFX._BOMB_CONFIG[type] || GameSFX._BOMB_CONFIG['normal'];
        const s = this._setup(x, y, z, this.PRIORITY.HIGH, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(cfg.vol, t);
        gainNode.gain.linearRampToValueAtTime(cfg.maxVol, t + cfg.dur * 0.5);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

        const osc = ctx.createOscillator();
        osc.type = cfg.osc;
        osc.frequency.setValueAtTime(cfg.baseF, t);
        osc.frequency.exponentialRampToValueAtTime(cfg.endF, t + cfg.dur);

        osc.connect(gainNode);
        gainNode.connect(targetNode);
        osc.start(t); osc.stop(t + cfg.dur);
        voice.nodes.push(osc);

        const noise = this._createNoise(cfg.dur, 0, cfg.noiseVol, t);
        if (noise) {
            const noiseFilter = ctx.createBiquadFilter();
            noiseFilter.type = 'highpass';
            noiseFilter.frequency.setValueAtTime(cfg.noiseF, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(60, t + cfg.dur);
            (noise.output || noise).connect(noiseFilter);
            noiseFilter.connect(gainNode);
            noise.stop(t + cfg.dur);
            voice.nodes.push(noise);
        }
    }

    playExplosion(x, y, z, isLarge = false, type = '') {
        this.init();
        if (!this.ctx) return;

        // --- Deduplication & Rate Limiting ---
        const now = this.ctx.currentTime;
        if (x !== undefined && y !== undefined && z !== undefined) {
            const dx = x - this.lastExplosionPos.x;
            const dy = y - this.lastExplosionPos.y;
            const dz = z - this.lastExplosionPos.z;
            if (now - this.lastExplosionTime < 0.045 && (dx * dx + dy * dy + dz * dz < 2500)) {
                return;
            }
            this.lastExplosionTime = now;
            this.lastExplosionPos.x = x; this.lastExplosionPos.y = y; this.lastExplosionPos.z = z;
        }

        const key = type || (isLarge ? 'large' : 'default');
        const cfg = GameSFX._EXPLOSION_CONFIG[key] || GameSFX._EXPLOSION_CONFIG['default'];

        const s = this._setup(x, y, z, cfg.heavy ? this.PRIORITY.HIGH : this.PRIORITY.MED, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;
        distortion.oversample = '4x';

        const noise = this._createNoise(cfg.dur, 0.02, cfg.initVol, t);
        if (noise) {
            const noiseFilter = ctx.createBiquadFilter();
            noiseFilter.type = cfg.bandpass ? 'bandpass' : 'lowpass';
            noiseFilter.frequency.setValueAtTime(cfg.freqs[0] * 10, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(60, t + cfg.dur);

            const noiseGain = ctx.createGain();
            noiseGain.gain.setValueAtTime(cfg.initVol, t);
            noiseGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);

            (noise.output || noise).connect(noiseFilter);
            noiseFilter.connect(distortion);
            distortion.connect(noiseGain);
            noiseGain.connect(targetNode);
            noise.stop(t + cfg.dur);
            voice.nodes.push(noise);
        }

        // Sub-rumble for heavy explosions
        if (cfg.heavy) {
            const sub = ctx.createOscillator();
            const subGain = ctx.createGain();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(60, t);
            sub.frequency.exponentialRampToValueAtTime(20, t + cfg.dur * 0.5);
            subGain.gain.setValueAtTime(0.8, t);
            subGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur * 0.6);
            sub.connect(subGain);
            subGain.connect(targetNode);
            sub.start(t); sub.stop(t + cfg.dur);
            voice.nodes.push(sub);
        }

        // Texture Oscillators
        cfg.freqs.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const oscGain = ctx.createGain();
            osc.type = cfg.sawtooth ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(cfg.endFreq, t + cfg.dur);
            osc.gain.value = 0; // standard init
            oscGain.gain.setValueAtTime(cfg.baseGain, t);
            oscGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);
            osc.connect(oscGain);
            oscGain.connect(distortion);
            osc.start(t); osc.stop(t + cfg.dur);
            voice.nodes.push(osc);
        });
    }


    playNewLevel() {
        let dur = 3.5; // Longest level tune approx
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;
        let pick = Math.floor(Math.random() * 8);
        this._levelTunes[pick](ctx, t, targetNode, voice);
    }

    /**
     * Eight Sentinel-style atmospheric dark tunes.
     * Each is a different atmospheric/electronic mood.
     */
    _levelTunes = [

        // 0 — Original: eerie resonant filter sweep on low A minor
        (ctx, t, targetNode, voice) => {
            let freqs = [110.00, 146.83, 164.81, 220.00]; // A2 D3 E3 A3
            freqs.forEach((freq, i) => {
                let noteT = t + i * 0.8;
                [-5, 5].forEach(det => {
                    let osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
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
                    if (voice) voice.nodes.push(osc);
                });
            });
        },

        // 1 — Rapid chiptune arpeggio: tight 8-bit style bleeps racing up and down
        (ctx, t, targetNode, voice) => {
            // Fast sequence of short square wave blips — sounds like a retro computer booting
            let seq = [220, 277.18, 329.63, 415.30, 523.25, 415.30, 329.63, 220, 174.61, 220];
            let masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(0.12, t);
            masterGain.connect(targetNode);
            seq.forEach((freq, i) => {
                let noteT = t + i * 0.1;
                let osc = ctx.createOscillator(), env = ctx.createGain();
                osc.type = 'square'; osc.frequency.value = freq;
                env.gain.setValueAtTime(0, noteT);
                env.gain.linearRampToValueAtTime(1, noteT + 0.005);
                env.gain.setValueAtTime(1, noteT + 0.07);
                env.gain.linearRampToValueAtTime(0, noteT + 0.09);
                osc.connect(env); env.connect(masterGain);
                osc.start(noteT); osc.stop(noteT + 0.1);
                if (voice) voice.nodes.push(osc);
            });
        },

        // 2 — FM-style clang: carrier + modulator for metallic bell-like tones
        (ctx, t, targetNode, voice) => {
            // Simulated FM: modulate gain of a high-freq osc into a carrier's frequency input via ring
            let carriers = [220, 293.66, 184.99]; // A3, D4, F#3
            carriers.forEach((cFreq, i) => {
                let noteT = t + i * 0.7;
                let carrier = ctx.createOscillator();
                let modulator = ctx.createOscillator();
                let modGain = ctx.createGain();
                let outGain = ctx.createGain();

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
                if (voice) {
                    voice.nodes.push(carrier);
                    voice.nodes.push(modulator);
                }
            });
        },

        // 3 — Theremin-like glide: one continuous pitch sliding eerily through wide interval
        (ctx, t, targetNode, voice) => {
            let osc = ctx.createOscillator();
            let filter = ctx.createBiquadFilter();
            let gain = ctx.createGain();

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
            if (voice) voice.nodes.push(osc);
        },

        // 4 — Rhythmic techno stabs: punchy staccato bursts at irregular intervals
        (ctx, t, targetNode, voice) => {
            // Offbeat pattern with two alternating pitches — robotic/mechanical feel
            let pattern = [
                [t + 0.0, 311.13],  // E♭4
                [t + 0.18, 233.08],  // B♭3
                [t + 0.3, 311.13],
                [t + 0.55, 174.61],  // F3
                [t + 0.7, 311.13],
                [t + 0.8, 233.08],
                [t + 1.1, 415.30],  // A♭4 — accent
                [t + 1.3, 311.13],
            ];
            pattern.forEach(([noteT, freq]) => {
                let osc = ctx.createOscillator(), gain = ctx.createGain(), filter = ctx.createBiquadFilter();
                osc.type = 'sawtooth'; osc.frequency.value = freq;
                filter.type = 'lowpass'; filter.frequency.setValueAtTime(3500, noteT);
                filter.frequency.exponentialRampToValueAtTime(200, noteT + 0.12);
                gain.gain.setValueAtTime(0.22, noteT);
                gain.gain.exponentialRampToValueAtTime(0.001, noteT + 0.14);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.16);
                if (voice) voice.nodes.push(osc);
            });
        },

        // 5 — Laser ping sweep: sci-fi rising "pew" with trailing decay
        (ctx, t, targetNode, voice) => {
            // Three overlapping laser sweeps at different speeds and pitches
            [[80, 2400, 0.3], [60, 1800, 0.55], [40, 3200, 0.8]].forEach(([start, end, offset]) => {
                let noteT = t + offset;
                let osc = ctx.createOscillator(), gain = ctx.createGain(), filter = ctx.createBiquadFilter();
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
                if (voice) voice.nodes.push(osc);
            });
        },

        // 6 — Deep bass pulse with tremolo: sub-bass heartbeat that throbs and fades
        (ctx, t, targetNode, voice) => {
            // A low drone with amplitude tremolo — ominous and pulsing
            let baseFreq = 55; // A1
            let osc = ctx.createOscillator();
            let tremoloOsc = ctx.createOscillator();
            let tremoloGain = ctx.createGain();
            let masterGain = ctx.createGain();
            let filter = ctx.createBiquadFilter();

            osc.type = 'sawtooth'; osc.frequency.value = baseFreq;
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
            if (voice) {
                voice.nodes.push(osc);
                voice.nodes.push(tremoloOsc);
            }
        },

        // 7 — Alien morse code: irregular high-pitched digital beeps with feedback ring
        (ctx, t, targetNode, voice) => {
            // Bursts of high sine tones at varying lengths — like intercepted transmissions
            let beeps = [
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
            beeps.forEach(([offset, dur, freq]) => {
                let noteT = t + offset;
                let osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sine'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.18, noteT + 0.005);
                gain.gain.setValueAtTime(0.18, noteT + dur - 0.01);
                gain.gain.linearRampToValueAtTime(0, noteT + dur);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + dur + 0.01);
                if (voice) voice.nodes.push(osc);
            });
        },
    ];


    /**
     * Plays a triumphant, electronic fanfare upon level completion.
     * Fast upward arpeggio with bright, snappy pulse waves.
     */
    playLevelComplete() {
        let dur = 1.5;
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;

        let notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 (C Major)

        notes.forEach((freq, i) => {
            let noteT = t + i * 0.08;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();

            osc.type = 'square';
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.2, noteT + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.15);

            osc.connect(gain);
            gain.connect(targetNode);

            osc.start(noteT);
            osc.stop(noteT + 0.2);
            voice.nodes.push(osc);
        });

        // Final lingering bright chord
        [523.25, 1046.50].forEach(freq => {
            let noteT = t + 0.4;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, noteT);
            gain.gain.linearRampToValueAtTime(0.1, noteT + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, noteT + 1.2);
            osc.connect(gain);
            gain.connect(targetNode);
            osc.start(noteT);
            osc.stop(noteT + 1.3);
            voice.nodes.push(osc);
        });
    }

    playGameOver() {
        let dur = 2.5;
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;
        let freqs = [329.63, 293.66, 261.63, 164.81];

        let distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurveGameOver;
        distortion.connect(targetNode);

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.45;
            [-20, 0, 20].forEach(det => {
                let osc = ctx.createOscillator();
                let filter = ctx.createBiquadFilter();
                let gain = ctx.createGain();

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
                voice.nodes.push(osc);
            });
        });
    }

    playPowerup(isGood = true, x, y, z) {
        let dur = isGood ? 0.6 : 0.8;
        let s = this._setup(x, y, z, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;

        let freqs = isGood ? [440, 554.37, 659.25, 880] : [220, 207.65, 196.00, 110];

        let masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.35, t);
        masterGain.gain.linearRampToValueAtTime(0.01, t + dur);
        masterGain.connect(targetNode);

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.1;
            [-15, 15].forEach(det => {
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();

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
                voice.nodes.push(osc);
            });
        });
    }

    playClearInfection(x, y, z) {
        let dur = 1.3;
        let s = this._setup(x, y, z, this.PRIORITY.HIGH, dur);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;

        let freqs = [523.25, 659.25, 1046.50];

        freqs.forEach((freq, i) => {
            [-15, 0, 15].forEach(det => {
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.detune.value = det;

                gain.gain.setValueAtTime(0.0, t);
                gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.01, t + 1.2);

                osc.connect(gain);
                gain.connect(targetNode);
                osc.start(t);
                osc.stop(t + dur);
                voice.nodes.push(osc);
            });
        });

        let noise = this._createNoise(0.4);
        if (noise) {
            let filter = ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 4000;

            let noiseGain = ctx.createGain();
            noiseGain.gain.setValueAtTime(0.2, t);
            noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

            (noise.output || noise).connect(filter);
            filter.connect(noiseGain);
            noiseGain.connect(targetNode);
            noise.stop(t + 0.4);
            voice.nodes.push(noise);
        }
    }

    playAlarm() {
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, 0.5);
        if (!s) return;
        let { ctx, t, targetNode, voice } = s;

        let gain = ctx.createGain();
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);

        let osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.linearRampToValueAtTime(440, t + 0.4);

        osc.connect(gain);
        gain.connect(targetNode);
        osc.start(t);
        osc.stop(t + 0.5);
        voice.nodes.push(osc);
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
        let t = this.ctx.currentTime;

        if (!active) {
            if (this.thrustNodes[id]) {
                let n = this.thrustNodes[id];
                n.gain.gain.setTargetAtTime(0, t, 0.05);
                setTimeout(() => {
                    if (this.thrustNodes[id] === n) {
                        try {
                            n.osc.stop();
                            n.noise.stop();
                            n.osc.disconnect();
                            n.noise.disconnect();
                            n.filter.disconnect();
                            n.gain.disconnect();
                            if (n.panner) {
                                n.panner.disconnect();
                                if (this.pannerPool.length < this.MAX_PANNER_POOL) {
                                    this.pannerPool.push(n.panner);
                                }
                            }
                        } catch (e) { }
                        delete this.thrustNodes[id];
                    }
                }, 200);
            }
            return;
        }

        if (!this.thrustNodes[id]) {
            let gain = this.ctx.createGain();
            gain.gain.value = 0;

            // Only spatialize engine thrust for OTHER players or enemies when spatialization is enabled.
            // For the local player (id 0), or in two-player mode where both are effectively local,
            // the engine drone should be non-spatialized to avoid HRTF/panning artifacts (crackling).
            let panner = null;
            if (id !== 0 && this.spatialEnabled) {
                // Use the pool to avoid HRTF allocation cost on each new thrust event.
                panner = this._getPanner();
                if (panner) {
                    panner.panningModel = 'equalpower';
                    panner.distanceModel = 'linear';
                    panner.refDistance = 200;
                    panner.rolloffFactor = 0.5;
                    if (x !== undefined && panner.positionX) {
                        panner.positionX.setValueAtTime(x, t);
                        panner.positionY.setValueAtTime(y, t);
                        panner.positionZ.setValueAtTime(z, t);
                    } else if (x !== undefined) {
                        panner.setPosition(x, y, z);
                    }
                }
            } else if (!this.spatialEnabled && this.ctx.createStereoPanner) {
                // Split-screen mode: add fixed stereo separation to help distinguish the two viewports
                panner = this.ctx.createStereoPanner();
                panner.pan.setValueAtTime((id === 0) ? -0.4 : 0.4, t);
            }

            // Low deep rumble (oscillator)
            let osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            // Offset frequency slightly per ID to prevent phasing/beating in mono
            osc.frequency.setValueAtTime(42 + (id * 0.7), t);

            // Deep roar (noise) — use scheduled t for tight sync
            let noise = this._createNoise(5.0, 0.45, 0.4, t);
            noise.loop = true;

            let filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(110, t);
            filter.Q.value = 0.2; // Keep Q extra low for the engine core

            osc.connect(filter);
            (noise.output || noise).connect(filter);
            filter.connect(gain);

            if (panner) {
                gain.connect(panner);
                panner.connect(this.master || this.ctx.destination);
            } else {
                // Connect local player thrust directly to master/output for perfect stability
                gain.connect(this.master || this.ctx.destination);
            }

            osc.start(t);

            this.thrustNodes[id] = { osc, noise, gain, panner, filter, lastX: x, lastY: y, lastZ: z };
        }

        let n = this.thrustNodes[id];
        // 50ms smoothing
        let baseVol = (id === 0) ? (this.spatialEnabled ? 0.32 : 0.24) : (this.spatialEnabled ? 0.22 : 0.16);
        let finalVol = baseVol;

        // Manual attenuation for engines in 2p mode
        let distance = 0;
        if (x !== undefined && y !== undefined && z !== undefined) {
            let minDistSq = Infinity;
            if (typeof players !== 'undefined' && players.length > 0) {
                let numPlayers = players.length;
                for (let i = 0; i < numPlayers; i++) {
                    let p = players[i];
                    if (p.dead || !p.ship) continue;
                    let dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq !== Infinity) {
                    distance = Math.sqrt(minDistSq);
                    if (!this.spatialEnabled && distance > this._refDist) {
                        finalVol *= Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                    }
                }
            }
        }

        n.gain.gain.setTargetAtTime(finalVol, t, 0.05);

        // Subtle altitude-based adjustment for player engine
        if (id === 0 && y !== undefined) {
            let altFactor = constrain((100 - y) / 2000, 0, 1); // 0 at launchpad, 1 at 2100 altitude
            n.filter.frequency.setTargetAtTime(110 + altFactor * 40, t, 0.1);
            n.osc.frequency.setTargetAtTime(42 + altFactor * 10, t, 0.1);
        }

        // Only update 3D panner position if we are in spatial mode (single player)
        if (this.spatialEnabled && n.panner && x !== undefined) {
            let dt = 0.05;
            let distSq = (x - n.lastX) ** 2 + (y - n.lastY) ** 2 + (z - n.lastZ) ** 2;
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
