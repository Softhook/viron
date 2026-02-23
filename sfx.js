class GameSFX {
    constructor() {
        this.initialized = false;
        this.distCurve = null;
    }

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') {
            this.ctx = getAudioContext();
            this.distCurve = this.createDistortionCurve(400); // Precompute curve for heavy crunch
        }
        this.initialized = true;
    }

    // Generates a wave-shaping curve for crunch/distortion
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

    playShot() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        let gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.35, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.15);

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(6000, t);
        filter.frequency.exponentialRampToValueAtTime(200, t + 0.15);

        filter.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        // 3 Detuned Sawtooths for a FAT laser impact
        [-18, 0, 18].forEach(det => {
            let osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(880, t);
            osc.frequency.exponentialRampToValueAtTime(110, t + 0.15);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + 0.15);
        });
    }

    playMissileFire() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        let gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.5, t);
        gainNode.gain.exponentialRampToValueAtTime(0.01, t + 0.6);

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, t);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2); // Woosh open
        filter.frequency.exponentialRampToValueAtTime(100, t + 0.6); // Woosh close

        filter.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        // Fat rocket thrust engines
        [-25, 0, 25].forEach(det => {
            let osc = this.ctx.createOscillator();
            osc.type = 'square';
            osc.detune.value = det;
            osc.frequency.setValueAtTime(150, t); // lower pitch initially
            osc.frequency.exponentialRampToValueAtTime(40, t + 0.6);
            osc.connect(filter);
            osc.start(t);
            osc.stop(t + 0.6);
        });

        // Plume noise for missile
        let bufferSize = this.ctx.sampleRate * 0.6;
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
            let white = Math.random() * 2 - 1;
            data[i] = (lastOut + (0.05 * white)) / 1.05; // Brownish noise
            lastOut = data[i];
        }
        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        noise.connect(filter);
        noise.start(t);
    }

    playExplosion(isLarge = false) {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let dur = isLarge ? 2.2 : 0.9;

        // Hard Distortion
        let distortion = this.ctx.createWaveShaper();
        distortion.curve = this.distCurve;
        distortion.oversample = '4x';

        // Noise buffer (Deep brown noise for massive crunch)
        let bufferSize = this.ctx.sampleRate * dur;
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
            let white = Math.random() * 2 - 1;
            data[i] = (lastOut + (0.02 * white)) / 1.02; // Heavy rolloff
            lastOut = data[i];
            data[i] *= 3.5; // Gain comp
        }

        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        let noiseFilter = this.ctx.createBiquadFilter();
        noiseFilter.type = 'lowpass';
        noiseFilter.frequency.setValueAtTime(isLarge ? 3000 : 5000, t);
        noiseFilter.frequency.exponentialRampToValueAtTime(80, t + dur);

        let noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(isLarge ? 1.5 : 1.0, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        // Sub-bass thump (3 Detuned Oscillators dropping into the sub-20Hz range)
        let freqs = isLarge ? [110, 114, 106] : [150, 155, 145];
        freqs.forEach((freq, idx) => {
            let osc = this.ctx.createOscillator();
            let oscGain = this.ctx.createGain();
            osc.type = (idx === 0) ? 'triangle' : 'sine'; // One triangle for bite, two sines for sheer weight
            osc.frequency.setValueAtTime(freq, t);
            osc.frequency.exponentialRampToValueAtTime(isLarge ? 10 : 20, t + dur * 0.8); // Deep dive

            oscGain.gain.setValueAtTime(isLarge ? 1.0 : 0.6, t);
            oscGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

            osc.connect(oscGain);
            oscGain.connect(distortion);
            osc.start(t);
            osc.stop(t + dur);
        });

        distortion.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        noise.start(t);
    }

    playNewLevel() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let freqs = [261.63, 329.63, 392.00, 523.25]; // C E G C

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.15;

            // Detuned chorus per note
            [-12, 12].forEach(det => {
                let osc = this.ctx.createOscillator();
                let gain = this.ctx.createGain();
                let filter = this.ctx.createBiquadFilter();

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
                gain.connect(this.ctx.destination);
                osc.start(noteT);
                osc.stop(noteT + 0.9);
            });
        });
    }

    playGameOver() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let freqs = [329.63, 293.66, 261.63, 164.81]; // Decreasing notes

        let distortion = this.ctx.createWaveShaper();
        distortion.curve = this.createDistortionCurve(60);
        distortion.connect(this.ctx.destination);

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.45;

            // Huge detuned drone cluster
            [-20, 0, 20].forEach(det => {
                let osc = this.ctx.createOscillator();
                let filter = this.ctx.createBiquadFilter();
                let gain = this.ctx.createGain();

                osc.type = 'sawtooth';
                osc.frequency.value = freq / 2; // Dropped an octave for doom
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

    playPowerup(isGood = true) {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        // Arpeggios (Good = A Maj up, Bad = diminished down)
        let freqs = isGood ? [440, 554.37, 659.25, 880] : [220, 207.65, 196.00, 110];

        let masterGain = this.ctx.createGain();
        masterGain.gain.setValueAtTime(0.35, t);
        masterGain.gain.linearRampToValueAtTime(0.01, t + (isGood ? 0.6 : 0.8));
        masterGain.connect(this.ctx.destination);

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.1;

            // Thicc Detuned Sync
            [-15, 15].forEach(det => {
                let osc = this.ctx.createOscillator();
                let gain = this.ctx.createGain();

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

    playClearInfection() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        let freqs = [523.25, 659.25, 1046.50]; // C5, E5, C6 - big shiny chord

        // Huge detuned FM-like chime
        freqs.forEach((freq, i) => {
            [-15, 0, 15].forEach(det => {
                let osc = this.ctx.createOscillator();
                let gain = this.ctx.createGain();

                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.detune.value = det;

                gain.gain.setValueAtTime(0.0, t);
                gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.01, t + 1.2); // long shiny ring

                osc.connect(gain);
                gain.connect(this.ctx.destination);
                osc.start(t);
                osc.stop(t + 1.3);
            });
        });

        // Spritz of high noise 
        let bufferSize = this.ctx.sampleRate * 0.4;
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 4000;

        let noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.2, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        noise.start(t);
    }
}

const gameSFX = new GameSFX();
