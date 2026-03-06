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
        this._lastFrameTime = 0;
        this._voicePool = [];
        this._MAX_VOICE_POOL = 64;

        // Rate-limiting trackers
        this._lastPlayerShot = 0;
        this.lastSpreadTime = 0;

        // Static tuning
        this._LOOKAHEAD = 0.025; // 25ms lookahead for scheduling stability
        this.PRIORITY = {
            LOW: 0,     // Common environment sounds
            MED: 1,     // Most SFX
            HIGH: 2,    // Player-triggered crucial SFX
            CRITICAL: 3 // Alarms, Level transitions
        };
    }

    static _EXPLOSION_CONFIG = {
        'default': { dur: 0.9, heavy: false, initVol: 0.45, freqs: [150, 155, 145], endFreq: 20, baseGain: 0.25 },
        'large': { dur: 2.8, heavy: true, initVol: 0.6, freqs: [90, 94, 86], endFreq: 20, baseGain: 0.4 },
        'bomber': { dur: 2.8, heavy: true, initVol: 0.8, freqs: [90, 94, 86], endFreq: 20, baseGain: 0.4 },
        'colossus': { dur: 2.8, heavy: true, initVol: 0.8, freqs: [90, 94, 86], endFreq: 20, baseGain: 0.4 },
        'squid': { dur: 1.5, heavy: false, initVol: 0.5, freqs: [130, 135, 125], endFreq: 5, baseGain: 0.35, sawtooth: true },
        'crab': { dur: 0.9, heavy: false, initVol: 0.45, freqs: [150, 155, 145], endFreq: 20, baseGain: 0.25, bandpass: true }
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

            // Safety limiter gain
            this.finalGain = this.ctx.createGain();
            this.finalGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
            this.master.connect(this.finalGain);
            this.finalGain.connect(this.ctx.destination);

            this.distCurve = this.createDistortionCurve(10); // Standard soft-clip
            this.persistentNoise = this._calculatePersistentNoise(3.0);
        }
        this.initialized = true;
    }

    _calculatePersistentNoise(dur) {
        if (!this.ctx) return null;
        const n_samples = this.ctx.sampleRate * dur;
        const buffer = this.ctx.createBuffer(1, n_samples, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < n_samples; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return buffer;
    }

    _createNoise(dur, mul = 1.0, vol = 1.1, scheduledT) {
        if (!this.ctx || !this.persistentNoise) return null;
        const t = scheduledT || (this.ctx.currentTime + this._LOOKAHEAD);
        const source = this.ctx.createBufferSource();
        source.buffer = this.persistentNoise;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.005);
        gain.gain.setValueAtTime(vol, t + dur - 0.015);
        gain.gain.linearRampToValueAtTime(0, t + dur);
        source.connect(gain);
        source.output = gain;
        source.start(t);
        source.stop(t + dur);
        return source;
    }

    updateAmbiance(proximityData, infCount, maxInf, scheduledT) {
        this.init();
        if (!this.ctx) return;
        const t = scheduledT || this._lastFrameTime || this.ctx.currentTime;
        if (!this._ambienceInited) {
            this.ambientNodes.infection = {
                osc: this.ctx.createOscillator(),
                gain: this.ctx.createGain(),
                filter: this.ctx.createBiquadFilter()
            };
            this.ambientNodes.infection.osc.type = 'sawtooth';
            this.ambientNodes.infection.osc.frequency.setValueAtTime(45, t);
            this.ambientNodes.infection.filter.type = 'lowpass';
            this.ambientNodes.infection.filter.frequency.setValueAtTime(400, t);
            this.ambientNodes.infection.gain.gain.setValueAtTime(0, t);
            this.ambientNodes.infection.osc.connect(this.ambientNodes.infection.filter);
            this.ambientNodes.infection.filter.connect(this.ambientNodes.infection.gain);
            this.ambientNodes.infection.gain.connect(this.master || this.ctx.destination);
            this.ambientNodes.infection.osc.start(t);

            this.ambientNodes.scanSweep = {
                osc: this.ctx.createOscillator(),
                gain: this.ctx.createGain(),
                filter: this.ctx.createBiquadFilter()
            };
            this.ambientNodes.scanSweep.osc.type = 'square';
            this.ambientNodes.scanSweep.osc.frequency.setValueAtTime(200, t);
            this.ambientNodes.scanSweep.filter.type = 'bandpass';
            this.ambientNodes.scanSweep.gain.gain.setValueAtTime(0, t);
            this.ambientNodes.scanSweep.osc.connect(this.ambientNodes.scanSweep.filter);
            this.ambientNodes.scanSweep.filter.connect(this.ambientNodes.scanSweep.gain);
            this.ambientNodes.scanSweep.gain.connect(this.master || this.ctx.destination);
            this.ambientNodes.scanSweep.osc.start(t);
            this._ambienceInited = true;
        }

        const infRatio = Math.min(proximityData.dist < 800 ? (1.0 - proximityData.dist / 800) : 0, 1.0);
        this._infectionProximityAlpha = this._infectionProximityAlpha * 0.95 + infRatio * 0.05;
        const pulseInt = proximityData.pulseOverlap || 0;
        const targetVol = (this._infectionProximityAlpha * 0.2) + (pulseInt * 0.15); // 50% quieter background hum
        this.ambientNodes.infection.gain.gain.setTargetAtTime(targetVol, t, 0.1);
        this.ambientNodes.infection.filter.frequency.setTargetAtTime(100 + this._infectionProximityAlpha * 800, t, 0.1);
        if (pulseInt > 0.01) {
            this.ambientNodes.infection.osc.frequency.setTargetAtTime(45 + pulseInt * 40, t, 0.05);
        } else {
            this.ambientNodes.infection.osc.frequency.setTargetAtTime(45, t, 0.1);
        }

        const sweepAlpha = proximityData.scanSweepAlpha || 0;
        const sweepVol = sweepAlpha * this._infectionProximityAlpha * 0.6;
        this.ambientNodes.scanSweep.gain.gain.setTargetAtTime(sweepVol, t, 0.05);
        this.ambientNodes.scanSweep.filter.frequency.setTargetAtTime(1500 + sweepAlpha * 1500, t, 0.05);
    }

    _setup(x, y, z, priority = 1, duration = 0.5) {
        this.init();
        if (!this.ctx) return null;
        const t = this.ctx.currentTime + this._LOOKAHEAD;
        let finalTarget = this.finalGain || this.master || this.ctx.destination;
        let infraChain = [];
        let pannerFixed = null;
        let minDistSq = Infinity;

        if (x !== undefined && y !== undefined && z !== undefined) {
            if (typeof players !== 'undefined' && players.length > 0) {
                for (let i = 0; i < players.length; i++) {
                    const p = players[i];
                    if (p.dead || !p.ship) continue;
                    const dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq > this._maxManualDistSq) return null;
            }

            if (this.spatialEnabled) {
                const panner = this._getPanner();
                if (panner) {
                    if (panner.positionX) {
                        panner.positionX.setValueAtTime(x, t);
                        panner.positionY.setValueAtTime(y, t);
                        panner.positionZ.setValueAtTime(z, t);
                    } else {
                        panner.setPosition(x, y, z);
                    }
                    panner.connect(finalTarget);
                    finalTarget = panner;
                    pannerFixed = panner;
                }
            } else {
                let manualVol = 1.0;
                let panVal = 0;
                if (minDistSq !== Infinity) {
                    const distance = Math.sqrt(minDistSq) + this._zoomOffset;
                    if (distance > this._refDist) {
                        manualVol = Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                    }
                    if (players.length === 2) {
                        let closestIdx = -1;
                        for (let i = 0; i < players.length; i++) {
                            const p = players[i]; if (p.dead || !p.ship) continue;
                            const dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                            if (dSq <= minDistSq + 1) { closestIdx = i; break; }
                        }
                        panVal = (closestIdx === 0) ? -0.35 : 0.35;
                    }
                }
                if (manualVol < 0.99 || panVal !== 0) {
                    const g = this.ctx.createGain();
                    g.gain.setValueAtTime(manualVol, t);
                    infraChain.push(g);
                    const f = this.ctx.createBiquadFilter();
                    f.type = 'lowpass';
                    const distFactor = (minDistSq === Infinity) ? 0 : Math.min(Math.max(0, (minDistSq - 10000) / 1000000), 1);
                    f.frequency.setValueAtTime(20000 - (18000 * distFactor), t);
                    g.connect(f);
                    infraChain.push(f);
                    if (panVal !== 0 && this.ctx.createStereoPanner) {
                        const p = this.ctx.createStereoPanner();
                        p.pan.setValueAtTime(panVal, t);
                        f.connect(p);
                        p.connect(finalTarget);
                        infraChain.push(p);
                    } else {
                        f.connect(finalTarget);
                    }
                    finalTarget = g;
                }
            }
        }

        const voiceGain = this.ctx.createGain();
        voiceGain.gain.value = 0; // Prevent initial leak before scheduled ramp
        voiceGain.gain.setValueAtTime(0, t);
        voiceGain.gain.linearRampToValueAtTime(1.0, t + 0.005); // Global attack
        voiceGain.connect(finalTarget);

        let tailNode = null;
        if (infraChain.length > 0) {
            tailNode = infraChain[infraChain.length - 1];
        } else if (pannerFixed) {
            tailNode = pannerFixed;
        } else {
            tailNode = this.finalGain || this.master || this.ctx.destination;
        }

        const voice = this._getVoice();
        voice.startTime = t;
        voice.duration = duration;
        voice.tailNode = tailNode;
        voice.voiceGain = voiceGain;
        voice.panner = pannerFixed;
        voice.infra = infraChain;
        voice.priority = priority;
        voice.distSq = minDistSq;
        this.activeVoices.push(voice);
        if (this.activeVoices.length > this.maxVoices) this._limitVoices();
        return { ctx: this.ctx, t, targetNode: voiceGain, voice, master: this.finalGain || this.ctx.destination };
    }

    _getPanner() {
        if (this.pannerPool.length > 0) {
            const p = this.pannerPool.pop();
            try {
                if (p.positionX) {
                    p.positionX.cancelScheduledValues(0);
                    p.positionY.cancelScheduledValues(0);
                    p.positionZ.cancelScheduledValues(0);
                }
            } catch (e) { }
            p.refDistance = 200;
            p.maxDistance = 6000;
            p.rolloffFactor = 1.0;
            return p;
        }
        if (!this.ctx) return null;
        const p = this.ctx.createPanner();
        p.panningModel = 'equalpower';
        p.distanceModel = 'linear';
        p.refDistance = 200;
        p.maxDistance = 6000;
        p.rolloffFactor = 1.0;
        return p;
    }

    updateListener(cx, cy, cz, lx, ly, lz, ux, uy, uz) {
        this.init();
        if (!this.ctx) return;
        const l = this.ctx.listener;
        const t = this.ctx.currentTime;
        const smooth = 0.02; // 20ms time constant for movement smoothing
        if (l.positionX) {
            l.positionX.setTargetAtTime(cx, t, smooth);
            l.positionY.setTargetAtTime(cy, t, smooth);
            l.positionZ.setTargetAtTime(cz, t, smooth);
            l.forwardX.setTargetAtTime(lx - cx, t, smooth);
            l.forwardY.setTargetAtTime(ly - cy, t, smooth);
            l.forwardZ.setTargetAtTime(lz - cz, t, smooth);
            l.upX.setTargetAtTime(ux, t, smooth);
            l.upY.setTargetAtTime(uy, t, smooth);
            l.upZ.setTargetAtTime(uz, t, smooth);
        } else {
            l.setPosition(cx, cy, cz);
            l.setOrientation(lx - cx, ly - cy, lz - cz, ux, uy, uz);
        }
    }

    createDistortionCurve(k) {
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        for (let i = 0; i < n_samples; i++) {
            const x = i * 2 / n_samples - 1;
            // Smoother sigmoid distortion: avoids the x=0 kink
            curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
        }
        return curve;
    }

    playShot(x, y, z) {
        const now = this.ctx ? this.ctx.currentTime : 0;
        if (now - this._lastPlayerShot < 0.04) return;
        this._lastPlayerShot = now;
        const cfg = GameSFX._PLAYER_SHOT_CONFIG;
        const s = this._setup(x, y, z, this.PRIORITY.HIGH, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0, t); // Micro-ramp attack
        gainNode.gain.linearRampToValueAtTime(cfg.vol * 0.75, t + 0.003);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cfg.filterF, t);
        filter.frequency.exponentialRampToValueAtTime(500, t + 0.15);
        filter.Q.setValueAtTime(0.5, t); // Soft Butterworth response to eliminate ringing
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
        subFilter.frequency.setValueAtTime(50, t); // Slightly higher for cleaner lows
        subFilter.Q.setValueAtTime(0.4, t); // Very soft
        sub.type = 'sine';
        sub.frequency.setValueAtTime(110, t); // Shifted up for hearing range
        sub.frequency.exponentialRampToValueAtTime(60, t + 0.1);
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.15, t); // Slightly lower sub for better clarity
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
        const now = this.ctx ? this.ctx.currentTime : 0;
        const throttleKey = `_lastEnemyShot_${type}`;
        if (now - (this[throttleKey] || 0) < 0.08) return;
        this[throttleKey] = now;
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
        osc.start(t); osc.stop(t + cfg.dur);
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
        const now = this.ctx.currentTime;
        if (now - this._lastExplosionTrigger < 0.05) return;
        this._lastExplosionTrigger = now;
        if (x !== undefined && y !== undefined && z !== undefined) {
            const dx = x - this.lastExplosionPos.x;
            const dy = y - this.lastExplosionPos.y;
            const dz = z - this.lastExplosionPos.z;
            if (now - this.lastExplosionTime < 0.045 && (dx * dx + dy * dy + dz * dz < 2500)) return;
            this.lastExplosionTime = now;
            this.lastExplosionPos.x = x; this.lastExplosionPos.y = y; this.lastExplosionPos.z = z;
        }
        const key = type || (isLarge ? 'large' : 'default');
        const cfg = GameSFX._EXPLOSION_CONFIG[key] || GameSFX._EXPLOSION_CONFIG['default'];
        const s = this._setup(x, y, z, cfg.heavy ? this.PRIORITY.HIGH : this.PRIORITY.MED, cfg.dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;

        // NEW: Standardized Explosion Signal Chain
        // Sum (Noise + Oscs) -> preGain -> Distortion -> mainFilter -> targetNode
        const preGain = ctx.createGain();
        preGain.gain.setValueAtTime(1.0, t);

        const distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;
        distortion.oversample = '4x';

        const mainFilter = ctx.createBiquadFilter();
        mainFilter.type = cfg.bandpass ? 'bandpass' : 'lowpass';
        mainFilter.frequency.setValueAtTime(cfg.freqs[0] * 8, t);
        mainFilter.frequency.exponentialRampToValueAtTime(80, t + cfg.dur);
        mainFilter.Q.value = 0.5;

        preGain.connect(distortion);
        distortion.connect(mainFilter);
        mainFilter.connect(targetNode);

        const noise = this._createNoise(cfg.dur, 0.02, cfg.initVol, t);
        if (noise) {
            const noiseGain = ctx.createGain();
            noiseGain.gain.setValueAtTime(cfg.initVol, t);
            noiseGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);
            (noise.output || noise).connect(noiseGain);
            noiseGain.connect(preGain);
            noise.stop(t + cfg.dur);
            voice.nodes.push(noise);
        }
        if (cfg.heavy) {
            const sub = ctx.createOscillator();
            const subGain = ctx.createGain();
            sub.type = 'sine';
            sub.frequency.setValueAtTime(100, t); // Shifted up from 65Hz
            sub.frequency.exponentialRampToValueAtTime(45, t + cfg.dur * 0.4); // Shifted up from 25Hz
            subGain.gain.setValueAtTime(0.65, t);
            subGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur * 0.5);
            sub.connect(subGain);
            subGain.connect(targetNode); // Sub layer stays CLEAN (bypasses distortion)
            sub.start(t); sub.stop(t + cfg.dur);
            voice.nodes.push(sub);
        }
        cfg.freqs.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const oscGain = ctx.createGain();
            osc.type = cfg.sawtooth ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(cfg.endFreq, t + cfg.dur);
            oscGain.gain.setValueAtTime(cfg.baseGain, t);
            oscGain.gain.exponentialRampToValueAtTime(0.01, t + cfg.dur);
            osc.connect(oscGain);
            oscGain.connect(preGain);
            osc.start(t); osc.stop(t + cfg.dur);
            voice.nodes.push(osc);
        });
    }

    playNewLevel() {
        let dur = 3.5;
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        const { ctx, targetNode, voice } = s;
        let pick = Math.floor(Math.random() * 8);
        this._levelTunes[pick](ctx, s.t, targetNode, voice);
    }

    _levelTunes = [
        (ctx, t, targetNode, voice) => {
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, t);
            osc.frequency.exponentialRampToValueAtTime(880, t + 2);
            gain.gain.setValueAtTime(0.2, t);
            gain.gain.linearRampToValueAtTime(0, t + 2.5);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 2.5);
            if (voice) voice.nodes.push(osc);
        },
        (ctx, t, targetNode, voice) => {
            let notes = [261.63, 329.63, 392.00, 523.25];
            notes.forEach((freq, i) => {
                let noteT = t + i * 0.2;
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, noteT);
                gain.gain.setValueAtTime(0.15, noteT);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.5);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.5);
                if (voice) voice.nodes.push(osc);
            });
        },
        (ctx, t, targetNode, voice) => {
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(110, t);
            osc.frequency.linearRampToValueAtTime(220, t + 3);
            gain.gain.setValueAtTime(0.1, t);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 3);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 3);
            if (voice) voice.nodes.push(osc);
        },
        (ctx, t, targetNode, voice) => {
            let notes = [440, 440, 440, 554, 659];
            notes.forEach((freq, i) => {
                let noteT = t + i * 0.15;
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, noteT);
                gain.gain.setValueAtTime(0.2, noteT);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.3);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.3);
                if (voice) voice.nodes.push(osc);
            });
        },
        (ctx, t, targetNode, voice) => {
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(55, t);
            osc.frequency.exponentialRampToValueAtTime(110, t + 4);
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.linearRampToValueAtTime(0, t + 4);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 4);
            if (voice) voice.nodes.push(osc);
        },
        (ctx, t, targetNode, voice) => {
            let notes = [523.25, 392, 329.63, 261.63];
            notes.forEach((freq, i) => {
                let noteT = t + i * 0.25;
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, noteT);
                gain.gain.setValueAtTime(0.2, noteT);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.6);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.6);
                if (voice) voice.nodes.push(osc);
            });
        },
        (ctx, t, targetNode, voice) => {
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(880, t);
            osc.frequency.exponentialRampToValueAtTime(440, t + 2);
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.linearRampToValueAtTime(0, t + 2);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 2);
            if (voice) voice.nodes.push(osc);
        },
        (ctx, t, targetNode, voice) => {
            let notes = [261, 293, 329, 349, 392];
            notes.forEach((freq, i) => {
                let noteT = t + i * 0.12;
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, noteT);
                gain.gain.setValueAtTime(0.1, noteT);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.3);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.3);
                if (voice) voice.nodes.push(osc);
            });
        }
    ];

    playLevelComplete() {
        let dur = 1.5;
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        let notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, i) => {
            let noteT = t + i * 0.15;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(freq, noteT);
            gain.gain.setValueAtTime(0.15, noteT);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.4);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(noteT); osc.stop(noteT + 0.4);
            voice.nodes.push(osc);
        });
    }

    playGameOver() {
        let dur = 2.5;
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        let freqs = [329.63, 293.66, 261.63, 164.81];
        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.4;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, noteT);
            gain.gain.setValueAtTime(0.25, noteT);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 1.5);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(noteT); osc.stop(noteT + 1.5);
            voice.nodes.push(osc);
        });
    }

    playPowerup(isGood = true, x, y, z) {
        let dur = isGood ? 0.6 : 0.8;
        let s = this._setup(x, y, z, this.PRIORITY.CRITICAL, dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        let freqs = isGood ? [440, 554.37, 659.25, 880] : [220, 207.65, 196.00, 110];
        let masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.35, t);
        masterGain.gain.linearRampToValueAtTime(0.01, t + dur);
        masterGain.connect(targetNode);
        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.08;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, noteT);
            gain.gain.setValueAtTime(0.2, noteT);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.3);
            osc.connect(gain); gain.connect(masterGain);
            osc.start(noteT); osc.stop(noteT + 0.3);
            voice.nodes.push(osc);
        });
    }

    playClearInfection(x, y, z) {
        let dur = 1.3;
        let s = this._setup(x, y, z, this.PRIORITY.HIGH, dur);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        let freqs = [523.25, 659.25, 1046.50];
        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.1;
            let osc = ctx.createOscillator();
            let gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, noteT);
            gain.gain.setValueAtTime(0.2, noteT);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.8);
            osc.connect(gain); gain.connect(targetNode);
            osc.start(noteT); osc.stop(noteT + 0.8);
            voice.nodes.push(osc);
        });
        let noise = this._createNoise(0.4, 0.4, 0.2, t);
        if (noise) {
            let filter = ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 4000;
            (noise.output || noise).connect(filter);
            filter.connect(targetNode);
            voice.nodes.push(noise);
        }
    }

    playInfectionSpread(x, y, z) {
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        if (now - (this.lastSpreadTime || 0) < 0.06) return;
        this.lastSpreadTime = now;

        const dur = 0.04;
        const s = this._setup(x, y, z, this.PRIORITY.LOW, dur);
        if (!s) return;
        const { t, targetNode, voice } = s;
        const ctx = this.ctx;

        const gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(1, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + dur);

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + dur);
        filter.Q.value = 5;

        // Customize panner falloff for spread sounds specifically
        if (voice.panner) {
            voice.panner.refDistance = 300;
            voice.panner.maxDistance = 15000;
            voice.panner.rolloffFactor = 1.5;
        }

        const osc = ctx.createOscillator();
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

    playAlarm() {
        let s = this._setup(undefined, undefined, undefined, this.PRIORITY.CRITICAL, 0.5);
        if (!s) return;
        const { ctx, t, targetNode, voice } = s;
        let osc = ctx.createOscillator();
        let gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, t);
        osc.frequency.linearRampToValueAtTime(800, t + 0.2);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
        osc.connect(gain); gain.connect(targetNode);
        osc.start(t); osc.stop(t + 0.5);
        voice.nodes.push(osc);
    }

    update() {
        if (!this.ctx) return;
        this._lastFrameTime = this.ctx.currentTime;
        this._pruneExpired();
    }

    _getVoice() {
        return this._voicePool.pop() || {
            startTime: 0,
            duration: 0,
            tailNode: null,
            voiceGain: null,
            panner: null,
            infra: [],
            priority: 0,
            distSq: 0,
            nodes: []
        };
    }

    _releaseVoice(v) {
        if (!v) return;
        v.nodes.length = 0;
        v.infra.length = 0;
        v.tailNode = null;
        if (v.panner) {
            try { v.panner.disconnect(); } catch (e) { }
            if (this.pannerPool.length < this.MAX_PANNER_POOL) {
                this.pannerPool.push(v.panner);
            }
        }
        v.panner = null;
        if (v.voiceGain) { try { v.voiceGain.disconnect(); } catch (e) { } }
        v.voiceGain = null;
        if (this._voicePool.length < this._MAX_VOICE_POOL) {
            this._voicePool.push(v);
        }
    }

    _pruneExpired() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        for (let i = this.activeVoices.length - 1; i >= 0; i--) {
            const v = this.activeVoices[i];
            // If sound is past its scheduled end + buffer, release it.
            if (t > v.startTime + v.duration + 0.2) {
                try {
                    if (v.tailNode &&
                        v.tailNode !== this.finalGain &&
                        v.tailNode !== this.master &&
                        v.tailNode !== this.ctx.destination) {
                        try { v.tailNode.disconnect(); } catch (e) { }
                    }
                    for (let n of v.nodes) { if (n && n.stop) try { n.stop(); } catch (e) { } }
                } catch (e) { }
                this._releaseVoice(v);
                this.activeVoices.splice(i, 1);
            } else if (t > v.startTime + v.duration && !v.decaying) {
                // Sound has finished, but we haven't done the final release ramp yet.
                if (v.voiceGain) {
                    v.voiceGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
                }
                v.decaying = true;
            }
        }
    }

    _limitVoices() {
        this.activeVoices.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return a.startTime - b.startTime;
        });
        const t = this.ctx.currentTime;
        while (this.activeVoices.length > this.maxVoices) {
            const v = this.activeVoices.pop();
            // Critical: ramp out killed voices to prevent pops
            if (v.voiceGain) {
                v.voiceGain.gain.cancelScheduledValues(t);
                v.voiceGain.gain.setValueAtTime(v.voiceGain.gain.value, t);
                v.voiceGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
            }
            v.duration = (t - v.startTime) + 0.05; // Expire in 50ms (after ramp)
        }
    }

    setThrust(id, active, x, y, z) {
        this.init();
        if (!this.ctx) return;
        const t = this.ctx.currentTime + this._LOOKAHEAD;
        if (!active) {
            if (this.thrustNodes[id]) {
                const n = this.thrustNodes[id];
                try {
                    n.gain.gain.setTargetAtTime(0, t, 0.05);
                    setTimeout(() => {
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
                    }, 300);
                } catch (e) { }
            }
            return;
        }

        if (!this.thrustNodes[id]) {
            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.35, t + 0.1);
            let targetNode = this.master || this.ctx.destination;
            let panner = null;
            if (id !== 0 && this.spatialEnabled) {
                panner = this._getPanner();
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
                }
            } else if (!this.spatialEnabled && this.ctx.createStereoPanner) {
                panner = this.ctx.createStereoPanner();
                panner.pan.setValueAtTime((id === 0) ? -0.4 : 0.4, t);
                panner.connect(targetNode);
                targetNode = panner;
            }

            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(42 + (id * 0.7), t);
            const noise = this._createNoise(5.0, 0.45, 0.4, t);
            if (noise) noise.loop = true;
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(110, t);
            filter.Q.value = 0.2;
            osc.connect(filter);
            if (noise) (noise.output || noise).connect(filter);
            filter.connect(gain);
            gain.connect(targetNode);
            osc.start(t);
            this.thrustNodes[id] = { osc, noise, filter, gain, panner, lastX: x, lastY: y, lastZ: z };
        } else {
            const n = this.thrustNodes[id];
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
}

if (typeof window !== 'undefined') window.gameSFX = new GameSFX();
