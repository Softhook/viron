class GameSFX {
    constructor() {
        this.initialized = false;
        this.distCurve = null;
        this.spatialEnabled = true;
    }

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') {
            this.ctx = getAudioContext();
            this.distCurve = this.createDistortionCurve(400);
            this.distCurveGameOver = this.createDistortionCurve(60);
        }
        this.initialized = true;
    }

    _setup(x, y, z) {
        this.init();
        if (!this.ctx) return null;
        let t = this.ctx.currentTime;
        let targetNode = this.ctx.destination;

        if (x !== undefined && y !== undefined && z !== undefined && this.spatialEnabled) {
            let panner = this.createSpatializer(x, y, z);
            if (panner) {
                panner.connect(targetNode);
                targetNode = panner;
            }
        }
        return { ctx: this.ctx, t, targetNode };
    }

    _createNoise(dur, filterCoeff = 0, mul = 1) {
        let bufferSize = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
            let white = Math.random() * 2 - 1;
            lastOut = filterCoeff > 0 ? (lastOut + filterCoeff * white) / (1 + filterCoeff) : white;
            data[i] = lastOut * mul;
        }
        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        return noise;
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

        let gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(0.35, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.15);

        let filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(6000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        [-18, 0, 18].forEach(det => {
            let osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(880, t);
            osc.frequency.exponentialRampToValueAtTime(110, t + 0.15);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + 0.15);
        });
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
        noise.start(t);
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
            noiseFilter.frequency.setValueAtTime(isLarge || isBomber ? 3000 : 5000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(80, t + dur);
        }

        let noiseGain = ctx.createGain();
        let initVol = isLarge ? 1.5 : (isBomber ? 1.4 : 1.0);
        noiseGain.gain.setValueAtTime(initVol, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        let freqs = isLarge || isBomber ? [110, 114, 106] : (isSquid ? [130, 135, 125] : [150, 155, 145]);
        freqs.forEach((freq, idx) => {
            let osc = ctx.createOscillator();
            let oscGain = ctx.createGain();

            osc.type = isSquid ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(isLarge || isBomber ? 10 : (isSquid ? 5 : 20), t + dur * 0.8);

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
        noise.start(t);
        noise.stop(t + dur);
    }

    playNewLevel() {
        let s = this._setup();
        if (!s) return;
        let { ctx, t, targetNode } = s;
        let freqs = [261.63, 329.63, 392.00, 523.25];

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.15;
            [-12, 12].forEach(det => {
                let osc = ctx.createOscillator();
                let gain = ctx.createGain();
                let filter = ctx.createBiquadFilter();

                osc.type = 'sawtooth';
                osc.frequency.value = freq;
                osc.detune.value = det;

                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(3000, noteT);
                filter.frequency.exponentialRampToValueAtTime(400, noteT + 0.8);

                gain.gain.setValueAtTime(0.0, noteT);
                gain.gain.linearRampToValueAtTime(0.2, noteT + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.8);

                osc.connect(filter);
                filter.connect(gain);
                gain.connect(targetNode);
                osc.start(noteT);
                osc.stop(noteT + 0.9);
            });
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
        noise.start(t);
        noise.stop(t + 0.4);
    }

    playInfectionSpread(x, y, z) {
        let s = this._setup(x, y, z);
        if (!s) return;
        let { ctx, t, targetNode } = s;

        let gainNode = ctx.createGain();
        // --- VOLUME SETTING ---
        // 1 is now louder (was 0.08). Increase this for more volume, decrease for less.
        gainNode.gain.setValueAtTime(1, t);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

        let filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.04);
        filter.Q.value = 5;

        // --- SPATIAL EXTENT ---
        // These settings control how the sound drops off with distance.
        // We override the default _setup panner if it exists.
        if (targetNode instanceof PannerNode) {
            targetNode.refDistance = 300;     // Distance where volume begins to drop (default 150)
            targetNode.maxDistance = 15000;   // Maximum distance the sound can be heard
            targetNode.rolloffFactor = 1.5;   // How fast it gets quiet (higher = faster drop-off)
        }

        let osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.04);

        osc.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(targetNode);

        osc.start(t);
        osc.stop(t + 0.04);
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
}

const gameSFX = new GameSFX();
