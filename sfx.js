class GameSFX {
    constructor() {
        this.initialized = false;
        this.distCurve = null;
        this.spatialEnabled = true;
        this.thrustNodes = {}; // id -> { osc, noise, gain, panner }
        this.lastExplosionTime = 0;
        this.lastExplosionPos = { x: 0, y: 0, z: 0 };
        this.ctx = null;

        // constant values used across methods
        this._refDist = 180;            // reference distance for manual attenuation
        this._zoomOffset = 520;         // offset to simulate camera zoom in 2p mode
        this._maxManualDist = 8000;     // upper clamp for manual volume falloff
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


    _setup(x, y, z) {
        this.init();
        if (!this.ctx) return null;
        let t = this.ctx.currentTime;
        let targetNode = this.master || this.ctx.destination;

        if (x !== undefined && y !== undefined && z !== undefined) {
            if (this.spatialEnabled) {
                let panner = this.createSpatializer(x, y, z);
                if (panner) {
                    panner.connect(targetNode);
                    targetNode = panner;
                }
            } else {
                // FALLBACK: Manual distance-based volume scaling and stereo separation for split-screen
                let manualVol = 1.0;
                let panVal = 0;
                let minDistSq = Infinity;

                if (typeof players !== 'undefined' && players.length > 0) {
                    let closestIdx = -1;
                    let numPlayers = players.length;

                    for (let i = 0; i < numPlayers; i++) {
                        let p = players[i];
                        if (p.dead || !p.ship) continue;
                        let dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                        if (dSq < minDistSq) {
                            minDistSq = dSq;
                            closestIdx = i;
                        }
                    }

                    // if nobody viable, abandon the manual fallback early
                    if (minDistSq === Infinity) {
                        // no change to manualVol/panVal, targetNode remains as-is
                    } else {
                        // Offset distance by ~520 units to simulate the follow-camera being zoomed out.
                        // This prevents sounds at x=0 distance from blasting the speakers at 100% volume,
                        // making split-screen volume match the feel of single-player spatial audio.
                        let distance = Math.sqrt(minDistSq) + this._zoomOffset;
                        if (distance > this._refDist) {
                            manualVol = Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                        }

                        // Split-screen panning: shift sound toward the listener it's closer to
                        if (numPlayers === 2) {
                            panVal = (closestIdx === 0) ? -0.35 : 0.35;
                        }
                    }
                }

                // Create a utility gain/pan chain if needed
                // if we never found a player, skip the whole manual chain
                if (manualVol < 0.99 || panVal !== 0) {
                    let g = this.ctx.createGain();
                    g.gain.setValueAtTime(manualVol, t);

                    // FALLBACK: Manual distance-based low-pass to simulate "deepness" at range
                    let f = this.ctx.createBiquadFilter();
                    f.type = 'lowpass';
                    let distFactor = (minDistSq === Infinity) ? 0 : Math.min(Math.max(0, (minDistSq - 10000) / 1000000), 1);
                    f.frequency.setValueAtTime(20000 - (18000 * distFactor), t);
                    g.connect(f);

                    if (panVal !== 0 && this.ctx.createStereoPanner) {
                        let p = this.ctx.createStereoPanner();
                        p.pan.setValueAtTime(panVal, t);
                        f.connect(p);
                        p.connect(targetNode);
                    } else {
                        f.connect(targetNode);
                    }
                    targetNode = g;
                }
            }
        }
        return { ctx: this.ctx, t, targetNode };
    }

    _createNoise(dur, filterCoeff = 0, mul = 1) {
        if (!this.ctx || !this.persistentNoise) return null;
        let noise = this.ctx.createBufferSource();
        noise.buffer = this.persistentNoise;
        noise.loop = true;

        // LATERAL OPT: Use a random start time within the 3s buffer.
        // Because the persistent buffer is a seamless loop of white noise, 
        // starting anywhere is safe regardless of intended duration.
        noise.start(this.ctx.currentTime, Math.random() * noise.buffer.duration);

        if (mul !== 1) {
            let gain = this.ctx.createGain();
            gain.gain.value = mul;
            noise.connect(gain);
            // LATERAL OPT: Simple proxy for .stop() so callers can treat 
            // the returned node chain as a SourceNode.
            gain.stop = (t) => { try { noise.stop(t); } catch (e) { } };
            return gain;
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

        let s = this._setup(x, y, z);
        if (!s) return;
        let { targetNode } = s;

        let gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.8, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.04);
        filter.Q.value = 5;

        let osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.04);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + 0.04);
    }

    updateListener(cx, cy, cz, lx, ly, lz, ux, uy, uz) {
        if (!this.ctx || !this.ctx.listener || !this.spatialEnabled) return;
        const listener = this.ctx.listener;

        let fx = lx - cx, fy = ly - cy, fz = lz - cz;
        let flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
        fx /= flen; fy /= flen; fz /= flen;

        let t = this.ctx.currentTime;
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
        let k = typeof amount === 'number' ? amount : 50,
            n_samples = 44100,
            curve = new Float32Array(n_samples),
            deg = Math.PI / 180,
            i = 0,
            x;
        for (; i < n_samples; ++i) {
            x = i * 2 / n_samples - 1;
            curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
        }
        return curve;
    }

    playShot(x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        // Main volume envelope - smoother decay
        let gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.4, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.18);

        // Low-pass filter to remove "annoying" high frequencies
        let filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2000, t);
        filter.frequency.exponentialRampToValueAtTime(600, t + 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        // Core oscillators - triangle waves for a smoother, less buzzing sound
        [-10, 0, 10].forEach((det) => {
            let osc = ctx.createOscillator();
            osc.type = 'triangle';
            osc.detune.value = det;
            // Lower base frequency for a more powerful, less shrill sound
            osc.frequency.setValueAtTime(220, t); // A3
            osc.frequency.exponentialRampToValueAtTime(140, t + 0.15);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + 0.18);
        });

        // Sub-thrum for weight
        let sub = ctx.createOscillator();
        sub.type = 'sine';
        sub.frequency.setValueAtTime(80, t);
        sub.frequency.exponentialRampToValueAtTime(40, t + 0.1);
        let subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.3, t);
        subGain.gain.exponentialRampToValueAtTime(0.01, t + 0.12);
        sub.connect(subGain);
        subGain.connect(targetNode);
        sub.start(t);
        sub.stop(t + 0.12);
    }

    playEnemyShot(type = 'fighter', x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        let gainNode = ctx.createGain();
        let filter = ctx.createBiquadFilter();

        if (type === 'crab') {
            gainNode.gain.setValueAtTime(0.3, t);
            gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
            filter.type = 'highpass';
            filter.frequency.setValueAtTime(3000, t);

            let osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(800, t);
            osc.frequency.exponentialRampToValueAtTime(4000, t + 0.1);
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(targetNode);
            osc.start(t);
            osc.stop(t + 0.2);
        } else {
            gainNode.gain.setValueAtTime(0.25, t);
            gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(4000, t);
            filter.frequency.exponentialRampToValueAtTime(100, t + 0.15);

            let osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(1200, t);
            osc.frequency.exponentialRampToValueAtTime(200, t + 0.15);
            osc.connect(filter);
            filter.connect(gainNode);
            gainNode.connect(targetNode);
            osc.start(t);
            osc.stop(t + 0.15);
        }
    }

    playMissileFire(x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        let gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.5, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.6);

        let filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, t);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2);
        filter.frequency.exponentialRampToValueAtTime(100, t + 0.6);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        [-25, 0, 25].forEach(det => {
            let osc = ctx.createOscillator();
            osc.type = 'square';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(150, t);
            osc.frequency.exponentialRampToValueAtTime(40, t + 0.6);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + 0.6);
        });

        let noise = this._createNoise(0.6, 0.05);
        noise.connect(filter);
        noise.stop(t + 0.6);
    }

    playBombDrop(type = 'normal', x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;
        let isMega = type === 'mega';
        let dur = isMega ? 0.8 : 0.4;

        let gain = ctx.createGain();
        gain.gain.setValueAtTime(isMega ? 0.6 : 0.3, t);
        gain.gain.linearRampToValueAtTime(isMega ? 0.8 : 0.4, t + dur * 0.5);
        gain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        let osc = ctx.createOscillator();
        osc.type = isMega ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(isMega ? 800 : 1200, t);
        osc.frequency.exponentialRampToValueAtTime(isMega ? 150 : 300, t + dur);

        osc.connect(gain);
        gain.connect(targetNode);
        osc.start(t);
        osc.stop(t + dur);
    }

    playExplosion(isLarge = false, type = '', x, y, z) {
        // --- Deduplication & Rate Limiting ---
        // Prevents redundant explosion sounds from triggering in the same frame
        // or very close together in space/time, which can cause audio glitches.
        let now = Date.now();
        if (x !== undefined && z !== undefined) {
            let dx = x - this.lastExplosionPos.x;
            let dz = z - this.lastExplosionPos.z;
            if (now - this.lastExplosionTime < 45 && (dx * dx + dz * dz < 2500)) {
                return; // Suppress redundant trigger
            }
            this.lastExplosionTime = now;
            this.lastExplosionPos = { x, y, z };
        }

        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        let isBomber = type === 'bomber';
        let isSquid = type === 'squid';
        let isCrab = type === 'crab';
        let dur = isLarge || isBomber ? 2.2 : (isSquid ? 1.5 : 0.9);

        let distortion = ctx.createWaveShaper();
        distortion.curve = this.distCurve;
        distortion.oversample = '4x';

        let noise = this._createNoise(dur, 0.02, 3.5);

        let noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = isCrab ? 'bandpass' : 'lowpass';
        if (isCrab) {
            noiseFilter.frequency.setValueAtTime(2000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(500, t + dur);
        } else {
            noiseFilter.frequency.setValueAtTime(isLarge || isBomber ? 2200 : 5000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(80, t + dur);
        }

        let noiseGain = ctx.createGain();
        let initVol = isLarge ? (type === '' ? 1.3 : 1.5) : (isBomber ? 1.4 : 1.0);
        noiseGain.gain.setValueAtTime(initVol, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        // Oscillators - Large explosions (players/bombers) use lower frequencies, 
        // Squids use sawtooth for 'ripping' sound, others use highersine/triangle.
        let freqs = isLarge || isBomber ? [90, 94, 86] : (isSquid ? [130, 135, 125] : [150, 155, 145]);
        freqs.forEach((freq, idx) => {
            let osc = ctx.createOscillator();
            let oscGain = ctx.createGain();

            osc.type = isSquid ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            osc.frequency.setValueAtTime(freq, t);
            // End frequency: 20Hz for large, 5-20Hz for others. 
            let endFreq = isLarge || isBomber ? 20 : (isSquid ? 5 : 20);
            osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);

            let baseGain = isLarge || isBomber ? 1.0 : (isSquid ? 0.8 : 0.6);
            oscGain.gain.setValueAtTime(baseGain, t);
            oscGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

            osc.connect(oscGain);
            oscGain.connect(distortion);
            osc.start(t);
            osc.stop(t + dur);
        });

        distortion.connect(noiseGain);
        noiseGain.connect(targetNode);
        noise.stop(t + dur);
    }

    playNewLevel() {
        let s = this._setup();
        if (!s) return;
        let { ctx, t, targetNode } = s;
        let pick = Math.floor(Math.random() * 8);
        this._levelTunes[pick](ctx, t, targetNode);
    }

    /**
     * Eight Sentinel-style atmospheric dark tunes.
     * Each is a different atmospheric/electronic mood.
     */
    _levelTunes = [

        // 0 — Original: eerie resonant filter sweep on low A minor
        (ctx, t, targetNode) => {
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
                });
            });
        },

        // 1 — Rapid chiptune arpeggio: tight 8-bit style bleeps racing up and down
        (ctx, t, targetNode) => {
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
            });
        },

        // 2 — FM-style clang: carrier + modulator for metallic bell-like tones
        (ctx, t, targetNode) => {
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
            });
        },

        // 3 — Theremin-like glide: one continuous pitch sliding eerily through wide interval
        (ctx, t, targetNode) => {
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
        },

        // 4 — Rhythmic techno stabs: punchy staccato bursts at irregular intervals
        (ctx, t, targetNode) => {
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
            });
        },

        // 5 — Laser ping sweep: sci-fi rising "pew" with trailing decay
        (ctx, t, targetNode) => {
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
            });
        },

        // 6 — Deep bass pulse with tremolo: sub-bass heartbeat that throbs and fades
        (ctx, t, targetNode) => {
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
        },

        // 7 — Alien morse code: irregular high-pitched digital beeps with feedback ring
        (ctx, t, targetNode) => {
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
            });
        },
    ];


    /**
     * Plays a triumphant, electronic fanfare upon level completion.
     * Fast upward arpeggio with bright, snappy pulse waves.
     */
    playLevelComplete() {
        let s = this._setup();
        if (!s) return;
        let { ctx, t, targetNode } = s;

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
        });
    }

    playGameOver() {
        let s = this._setup();
        if (!s) return;
        let { ctx, t, targetNode } = s;
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
            });
        });
    }

    playPowerup(isGood = true, x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        let freqs = isGood ? [440, 554.37, 659.25, 880] : [220, 207.65, 196.00, 110];

        let masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.35, t);
        masterGain.gain.linearRampToValueAtTime(0.01, t + (isGood ? 0.6 : 0.8));
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
            });
        });
    }

    playClearInfection(x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

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
                osc.stop(t + 1.3);
            });
        });

        let noise = this._createNoise(0.4);
        let filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 4000;

        let noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.2, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(targetNode);
        noise.stop(t + 0.4);
    }


    playAlarm() {
        let s = this._setup();
        if (!s) return;
        let { ctx, t, targetNode } = s;

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
                panner = this.createSpatializer(x, y, z);
                if (panner) {
                    panner.panningModel = 'equalpower';
                    panner.distanceModel = 'linear';
                    panner.refDistance = 200;
                    panner.rolloffFactor = 0.5;
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

            // Deep roar (noise)
            let noise = this._createNoise(5.0, 0.45, 0.4);
            noise.loop = true;

            let filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(110, t);
            filter.Q.value = 0.2; // Keep Q extra low for the engine core

            osc.connect(filter);
            noise.connect(filter);
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
        let baseVol = this.spatialEnabled ? 0.22 : 0.16; // Lower base volume in 2p mode
        let finalVol = baseVol;

        // Manual attenuation for engines in 2p mode
        if (!this.spatialEnabled && x !== undefined && y !== undefined && z !== undefined) {
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
                    let distance = Math.sqrt(minDistSq);
                    if (distance > this._refDist) {
                        finalVol *= Math.pow(this._refDist / Math.min(distance, this._maxManualDist), 1.25);
                    }
                }
            }
        }

        n.gain.gain.setTargetAtTime(finalVol, t, 0.05);

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
