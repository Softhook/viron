class GameSFX {
    constructor() {
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        try { if (typeof userStartAudio !== 'undefined') userStartAudio(); } catch (e) { }
        if (typeof getAudioContext !== 'undefined') this.ctx = getAudioContext();
        this.initialized = true;
    }

    playShot() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let osc = this.ctx.createOscillator();
        let gain = this.ctx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.exponentialRampToValueAtTime(110, t + 0.15);

        gain.gain.setValueAtTime(0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + 0.15);
    }

    playMissileFire() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let osc = this.ctx.createOscillator();
        let gain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.exponentialRampToValueAtTime(50, t + 0.4);

        gain.gain.setValueAtTime(0.2, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.4);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
    }

    playExplosion(isLarge = false) {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let dur = isLarge ? 1.5 : 0.6; // slightly longer

        let bufferSize = this.ctx.sampleRate * dur;
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        let filter = this.ctx.createBiquadFilter();
        filter.type = isLarge ? 'lowpass' : 'bandpass';
        filter.frequency.setValueAtTime(isLarge ? 600 : 1200, t); // lower freq for more bass
        filter.frequency.exponentialRampToValueAtTime(50, t + dur); // sweep down further

        let gain = this.ctx.createGain();
        gain.gain.setValueAtTime(isLarge ? 1.0 : 0.6, t); // louder
        gain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start(t);

        // Add sub-bass oscillator for ALL explosions, just bigger for large ones
        let osc = this.ctx.createOscillator();
        let oscGain = this.ctx.createGain();
        osc.type = isLarge ? 'triangle' : 'sine'; // triangle has more harmonics for big boom
        osc.frequency.setValueAtTime(isLarge ? 120 : 150, t);
        osc.frequency.exponentialRampToValueAtTime(isLarge ? 20 : 40, t + dur);

        oscGain.gain.setValueAtTime(isLarge ? 0.9 : 0.5, t); // stronger bass
        oscGain.gain.exponentialRampToValueAtTime(0.01, t + dur);

        osc.connect(oscGain);
        oscGain.connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
    }

    playNewLevel() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let freqs = [261.63, 329.63, 392.00, 523.25];

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.15;
            let osc = this.ctx.createOscillator();
            let gain = this.ctx.createGain();

            osc.type = 'triangle';
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0.0, noteT);
            gain.gain.linearRampToValueAtTime(0.2, noteT + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 0.6);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(noteT);
            osc.stop(noteT + 0.7);
        });
    }

    playGameOver() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;
        let freqs = [329.63, 293.66, 261.63, 164.81];

        freqs.forEach((freq, i) => {
            let noteT = t + i * 0.4;
            let osc = this.ctx.createOscillator();
            let filter = this.ctx.createBiquadFilter();
            let gain = this.ctx.createGain();

            osc.type = 'sawtooth';
            osc.frequency.value = freq;

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(1500, noteT);
            filter.frequency.exponentialRampToValueAtTime(200, noteT + 1.0);

            gain.gain.setValueAtTime(0.0, noteT);
            gain.gain.linearRampToValueAtTime(0.2, noteT + 0.1);
            gain.gain.exponentialRampToValueAtTime(0.01, noteT + 1.0);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(noteT);
            osc.stop(noteT + 1.1);
        });
    }

    playPowerup(isGood = true) {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        let osc = this.ctx.createOscillator();
        let gain = this.ctx.createGain();

        osc.type = isGood ? 'sine' : 'sawtooth';

        if (isGood) {
            osc.frequency.setValueAtTime(440, t);
            osc.frequency.exponentialRampToValueAtTime(880, t + 0.1);
            osc.frequency.exponentialRampToValueAtTime(1760, t + 0.2);
        } else {
            osc.frequency.setValueAtTime(220, t);
            osc.frequency.exponentialRampToValueAtTime(110, t + 0.3);
        }

        gain.gain.setValueAtTime(0.0, t);
        gain.gain.linearRampToValueAtTime(0.2, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
    }

    playClearInfection() {
        this.init();
        if (!this.ctx) return;
        let t = this.ctx.currentTime;

        // Nice ringing sound
        let freqs = [523.25, 659.25]; // C5, E5
        freqs.forEach((freq, i) => {
            let osc = this.ctx.createOscillator();
            let gain = this.ctx.createGain();

            osc.type = 'sine';
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0.0, t);
            gain.gain.linearRampToValueAtTime(0.15, t + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.8);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(t);
            osc.stop(t + 0.9);
        });

        // Tiny sprinkle of noise
        let bufferSize = this.ctx.sampleRate * 0.2;
        let buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

        let noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        let filter = this.ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 3000;

        let noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.1, t);
        noiseGain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        noise.start(t);
    }
}

const gameSFX = new GameSFX();
