// =============================================================================
// sfxTunes.js — Level completion atmospheric tunes array
// =============================================================================

const SFX_LEVEL_TUNES = [

        // 0 — Original: eerie resonant filter sweep on low A minor
        function(ctx, t, targetNode) {
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
                    gain.gain.linearRampToValueAtTime(0.28, noteT + 0.1);
                    gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 1.5);
                    osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                    osc.start(noteT); osc.stop(noteT + 1.5);
                    nodes.push(osc, filter, gain);
                });
            });
            this._cleanupNodes(nodes, 3 * 0.8 + 1.8);
        },

        // 1 — Rapid chiptune arpeggio: tight 8-bit style bleeps racing up and down
        function(ctx, t, targetNode) {
            const seq = [220, 277.18, 329.63, 415.30, 523.25, 415.30, 329.63, 220, 174.61, 220];
            const masterGain = ctx.createGain();
            masterGain.gain.setValueAtTime(0.28, t);
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
            this._cleanupNodes(nodes, 9 * 0.1 + 0.4);
        },

        // 2 — FM-style clang: carrier + modulator for metallic bell-like tones
        function(ctx, t, targetNode) {
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
                outGain.gain.exponentialRampToValueAtTime(0.0001, noteT + 1.7);

                carrier.connect(outGain); outGain.connect(targetNode);
                carrier.start(noteT); carrier.stop(noteT + 1.7);
                modulator.start(noteT); modulator.stop(noteT + 1.7);
                nodes.push(carrier, modulator, modGain, outGain);
            });
            this._cleanupNodes(nodes, 2 * 0.7 + 2.0);
        },

        // 3 — Theremin-like glide: one continuous pitch sliding eerily through wide interval
        function(ctx, t, targetNode) {
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
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.1);

            osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
            osc.start(t); osc.stop(t + 3.1);
            this._cleanupNodes([osc, filter, gain], 3.1);
        },

        // 4 — Rhythmic techno stabs: punchy staccato bursts at irregular intervals
        function(ctx, t, targetNode) {
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
                gain.gain.setValueAtTime(0.0001, noteT);
                gain.gain.linearRampToValueAtTime(0.22, noteT + 0.004);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.14);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.16);
                nodes.push(osc, filter, gain);
            });
            this._cleanupNodes(nodes, 1.3 + 0.4);
        },

        // 5 — Laser ping sweep: sci-fi rising "pew" with trailing decay
        function(ctx, t, targetNode) {
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

                gain.gain.setValueAtTime(0.0001, noteT);
                gain.gain.linearRampToValueAtTime(0.25, noteT + 0.004);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.6);

                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.65);
                nodes.push(osc, filter, gain);
            });
            this._cleanupNodes(nodes, 0.8 + 0.9);
        },

        // 6 — Deep bass pulse with tremolo: sub-bass heartbeat that throbs and fades
        function(ctx, t, targetNode) {
            const osc = ctx.createOscillator();
            const tremoloOsc = ctx.createOscillator();
            const tremoloGain = ctx.createGain();
            const tremoloAmp = ctx.createGain();   // intermediate amplitude stage for the LFO
            const masterGain = ctx.createGain();
            const filter = ctx.createBiquadFilter();

            osc.type = 'sawtooth'; osc.frequency.value = 55; // A1
            tremoloOsc.type = 'sine'; tremoloOsc.frequency.value = 6; // 6Hz tremolo
            // LFO depth 0.4 applied to tremoloAmp whose base is 1.0 → range [0.6, 1.4].
            // Routing the LFO through an intermediate gain stage (tremoloAmp) rather
            // than directly into masterGain.gain keeps the signal amplitude strictly
            // positive throughout the fade envelope.  Connecting ±0.5 directly to a
            // gain AudioParam that starts at 0.0 (masterGain) made the effective gain
            // swing from -0.5 to +0.8, causing 6 Hz phase-inversion clicks.
            tremoloGain.gain.value = 0.4;
            tremoloAmp.gain.value  = 1.0;   // base = 1.0; LFO adds ±0.4 around this
            filter.type = 'lowpass'; filter.frequency.value = 300; filter.Q.value = 5;

            masterGain.gain.setValueAtTime(0, t);
            masterGain.gain.linearRampToValueAtTime(0.5, t + 0.2);
            masterGain.gain.setValueAtTime(0.5, t + 2.5);
            masterGain.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);

            tremoloOsc.connect(tremoloGain);
            tremoloGain.connect(tremoloAmp.gain); // Modulate tremoloAmp's gain: 1.0 ± 0.4 = [0.6, 1.4]
            osc.connect(filter); filter.connect(tremoloAmp); tremoloAmp.connect(masterGain); masterGain.connect(targetNode);
            osc.start(t); osc.stop(t + 3.6);
            tremoloOsc.start(t); tremoloOsc.stop(t + 3.6);
            this._cleanupNodes([osc, tremoloOsc, tremoloGain, tremoloAmp, masterGain, filter], 3.6);
        },

        // 7 — Alien morse code: irregular high-pitched digital beeps with feedback ring
        function(ctx, t, targetNode) {
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
            this._cleanupNodes(nodes, 0.95 + 0.4);
        },

        // 8 — Granular shimmer: rapid micro-grains of pitched sine creating a shimmering cloud
        function(ctx, t, targetNode) {
            const nodes = [];
            const baseFreqs = [440, 554.37, 659.25, 880]; // A4 C#5 E5 A5
            for (let i = 0; i < 24; i++) {
                const noteT = t + i * 0.08 + Math.random() * 0.03;
                const freq = baseFreqs[i % baseFreqs.length] * (1 + (Math.random() - 0.5) * 0.04);
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const dur = 0.06 + Math.random() * 0.06;
                gain.gain.setValueAtTime(0, noteT);
                // Normalised: max peak sum of 24 grains approx 0.85
                gain.gain.linearRampToValueAtTime((0.08 + Math.random() * 0.06) * 0.25, noteT + 0.005);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + dur);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + dur + 0.01);
                nodes.push(osc, gain);
            }
            // Buffer raised to 0.4 to accommodate random jitters in grain scheduling.
            this._cleanupNodes(nodes, 23 * 0.08 + 0.4);
        },

        // 9 — Distorted power chord: heavy overdriven fifths rumbling in
        function(ctx, t, targetNode) {
            const chords = [
                [82.41, 123.47],  // E2 + B2
                [73.42, 110.00],  // D2 + A2
                [65.41, 98.00],   // C2 + G2
            ];
            const distortion = ctx.createWaveShaper();
            const curve = new Float32Array(256);
            for (let i = 0; i < 256; i++) {
                const x = (i / 128) - 1;
                curve[i] = (Math.PI + 200) * x / (Math.PI + 200 * Math.abs(x));
            }
            distortion.curve = curve;
            distortion.connect(targetNode);
            const nodes = [distortion];
            chords.forEach(([root, fifth], i) => {
                const noteT = t + i * 0.6;
                [root, fifth].forEach(freq => {
                    [-8, 0, 8].forEach(det => {
                        const osc = ctx.createOscillator(), gain = ctx.createGain();
                        osc.type = 'sawtooth'; osc.frequency.value = freq; osc.detune.value = det;
                        gain.gain.setValueAtTime(0, noteT);
                        // Normalised: 6 oscillators hit the shaper. 
                        // Reduced from 0.12 to 0.08 to allow for cleaner saturation without 
                        // harsh digital "flat-lining".
                        gain.gain.linearRampToValueAtTime(0.08, noteT + 0.02);
                        gain.gain.setValueAtTime(0.08, noteT + 0.35);
                        gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.55);
                        osc.connect(gain); gain.connect(distortion);
                        osc.start(noteT); osc.stop(noteT + 0.6);
                        nodes.push(osc, gain);
                    });
                });
            });
            // Extended from 1.8s to 2.1s (+300ms) to ensure the heavy distorted 
            // tail has fully settled before disconnection.
            this._cleanupNodes(nodes, 2.1);
        },

        // 10 — Pentatonic wind chimes: randomly timed delicate high-pitched tones
        function(ctx, t, targetNode) {
            const pentatonic = [1318.51, 1174.66, 987.77, 880.00, 783.99, 659.25]; // E6 D6 B5 A5 G5 E5
            const nodes = [];
            for (let i = 0; i < 14; i++) {
                const noteT = t + i * 0.15 + Math.random() * 0.08;
                const freq = pentatonic[Math.floor(Math.random() * pentatonic.length)];
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                // Normalised: multi-voice chimes capped to prevent clipping
                gain.gain.linearRampToValueAtTime((0.1 + Math.random() * 0.08) * 0.4, noteT + 0.003);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.7);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.75);
                nodes.push(osc, gain);
            }
            // Buffer raised to 1.2 to ensure the long decays (0.7s) of the final chimes 
            // are fully audible before disconnection.
            this._cleanupNodes(nodes, 13 * 0.15 + 1.2);
        },

        // 11 — Resonant drone cluster: thick layered sustained tones beating against each other
        function(ctx, t, targetNode) {
            const freqs = [130.81, 133.5, 195.99, 199.2, 261.63]; // C3 cluster + G3 cluster + C4
            const nodes = [];
            freqs.forEach(freq => {
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                const filter = ctx.createBiquadFilter();
                osc.type = 'sawtooth';
                osc.frequency.value = freq;
                filter.type = 'lowpass'; filter.frequency.value = 400; filter.Q.value = 3;
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(0.18, t + 0.5);
                gain.gain.setValueAtTime(0.18, t + 2.5);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.8);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(t); osc.stop(t + 3.8);
                nodes.push(osc, filter, gain);
            });
            this._cleanupNodes(nodes, 3.8);
        },

        // 12 — Glitchy digital stutter: rapid-fire repeated tone bursts with pitch jumps
        function(ctx, t, targetNode) {
            const nodes = [];
            const freqPattern = [330, 330, 495, 330, 660, 330, 495, 880, 330, 660, 990, 330];
            freqPattern.forEach((freq, i) => {
                const noteT = t + i * 0.065;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'square';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.16, noteT + 0.002);
                gain.gain.setValueAtTime(0.16, noteT + 0.035);
                gain.gain.linearRampToValueAtTime(0, noteT + 0.05);
                osc.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.06);
                nodes.push(osc, gain);
            });
            this._cleanupNodes(nodes, 11 * 0.065 + 0.3);
        },

        // 13 — Whale song: slow portamento sine bends with vibrato, deep and haunting
        function(ctx, t, targetNode) {
            const osc = ctx.createOscillator();
            const vibrato = ctx.createOscillator();
            const vibGain = ctx.createGain();
            const masterGain = ctx.createGain();
            const filter = ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(220, t);
            osc.frequency.exponentialRampToValueAtTime(380, t + 1.2);
            osc.frequency.exponentialRampToValueAtTime(160, t + 2.5);
            osc.frequency.exponentialRampToValueAtTime(300, t + 3.8);
            osc.frequency.exponentialRampToValueAtTime(180, t + 4.5);

            vibrato.type = 'sine'; vibrato.frequency.value = 5;
            vibGain.gain.value = 12; // ±12 Hz vibrato
            vibrato.connect(vibGain);
            vibGain.connect(osc.frequency);

            filter.type = 'lowpass'; filter.frequency.value = 800; filter.Q.value = 2;

            masterGain.gain.setValueAtTime(0, t);
            masterGain.gain.linearRampToValueAtTime(0.38, t + 0.4);
            masterGain.gain.setValueAtTime(0.38, t + 3.8);
            masterGain.gain.exponentialRampToValueAtTime(0.0001, t + 4.8);

            osc.connect(filter); filter.connect(masterGain); masterGain.connect(targetNode);
            osc.start(t); osc.stop(t + 4.8);
            vibrato.start(t); vibrato.stop(t + 4.8);
            this._cleanupNodes([osc, vibrato, vibGain, masterGain, filter], 4.8);
        },

        // 14 — Phaser sweep pulse: rhythmic notes through a sweeping allpass chain
        function(ctx, t, targetNode) {
            const notes = [174.61, 233.08, 174.61, 293.66, 174.61, 233.08, 349.23, 293.66]; // F3 Bb3 F3 D4…
            const nodes = [];
            // Create allpass sweep for phaser effect
            const allpass1 = ctx.createBiquadFilter();
            const allpass2 = ctx.createBiquadFilter();
            [allpass1, allpass2].forEach(f => {
                f.type = 'allpass'; f.Q.value = 5;
                f.frequency.setValueAtTime(200, t);
                f.frequency.exponentialRampToValueAtTime(3000, t + 1.2);
                f.frequency.exponentialRampToValueAtTime(200, t + 2.4);
                nodes.push(f);
            });
            const dryGain = ctx.createGain(); dryGain.gain.value = 0.5;
            const wetGain = ctx.createGain(); wetGain.gain.value = 0.5;
            const sumGain = ctx.createGain(); sumGain.gain.value = 1;
            dryGain.connect(sumGain); wetGain.connect(sumGain); sumGain.connect(targetNode);
            allpass1.connect(allpass2); allpass2.connect(wetGain);
            nodes.push(dryGain, wetGain, sumGain);
            notes.forEach((freq, i) => {
                const noteT = t + i * 0.3;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'sawtooth'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.14 * 0.6, noteT + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.28);
                osc.connect(gain);
                gain.connect(dryGain);
                gain.connect(allpass1);
                osc.start(noteT); osc.stop(noteT + 0.3);
                nodes.push(osc, gain);
            });
            this._cleanupNodes(nodes, 7 * 0.3 + 0.6);
        },

        // 15 — Bitcrushed march: lo-fi military-style stepping pattern
        function(ctx, t, targetNode) {
            const marchNotes = [
                [0.0,  196.00, 0.15],  // G3
                [0.2,  196.00, 0.08],  // G3 (short)
                [0.35, 246.94, 0.15],  // B3
                [0.55, 293.66, 0.2],   // D4
                [0.8,  246.94, 0.15],  // B3
                [1.0,  220.00, 0.3],   // A3 (held)
                [1.35, 196.00, 0.15],  // G3
                [1.55, 164.81, 0.3],   // E3 (held)
            ];
            const nodes = [];
            // Simple sample-rate reduction effect via waveshaper quantization
            const shaper = ctx.createWaveShaper();
            const steps = 16;
            const shaperCurve = new Float32Array(65536);
            for (let i = 0; i < 65536; i++) {
                const v = (i / 32768) - 1;
                shaperCurve[i] = Math.round(v * steps) / steps;
            }
            shaper.curve = shaperCurve;
            shaper.connect(targetNode);
            nodes.push(shaper);
            marchNotes.forEach(([offset, freq, dur]) => {
                const noteT = t + offset;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                osc.type = 'square'; osc.frequency.value = freq;
                gain.gain.setValueAtTime(0, noteT);
                gain.gain.linearRampToValueAtTime(0.18, noteT + 0.008);
                gain.gain.setValueAtTime(0.18, noteT + dur - 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + dur + 0.04);
                osc.connect(gain); gain.connect(shaper);
                osc.start(noteT); osc.stop(noteT + dur + 0.05);
                nodes.push(osc, gain);
            });
            this._cleanupNodes(nodes, 1.55 + 0.3 + 0.3);
        },

        // 16 — Spectral whisper harmonics: breathy high overtones fading in and out
        function(ctx, t, targetNode) {
            const fundamental = 110; // A2
            const harmonics = [3, 5, 7, 9, 11, 13]; // odd harmonics only for hollow timbre
            const nodes = [];
            harmonics.forEach((h, i) => {
                const freq = fundamental * h;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                const filter = ctx.createBiquadFilter();
                osc.type = 'sine'; osc.frequency.value = freq;
                filter.type = 'bandpass'; filter.frequency.value = freq; filter.Q.value = 20;
                const fadeIn = 0.3 + i * 0.15;
                const peak = fadeIn + 0.4;
                const fadeOut = peak + 0.6 + i * 0.1;
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(0, t + fadeIn);
                gain.gain.linearRampToValueAtTime(0.12 - i * 0.012, t + peak);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeOut);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(t); osc.stop(t + fadeOut + 0.05);
                nodes.push(osc, filter, gain);
            });
            // maxFade = 2.55s.  Extended to 2.8s to provide ample headroom for the 
            // final harmonic tails.
            this._cleanupNodes(nodes, 2.8);
        },

        // 17 — Cosmic radio burst: chaotic broadband sweep condensing into a tone
        function(ctx, t, targetNode) {
            const nodes = [];
            // Start with wide noise burst narrowing into a tone
            for (let i = 0; i < 6; i++) {
                const noteT = t + i * 0.25;
                const osc = ctx.createOscillator(), gain = ctx.createGain();
                const filter = ctx.createBiquadFilter();
                osc.type = 'sawtooth';
                // Each burst starts with wild frequency and converges toward 440
                const startFreq = 100 + Math.random() * 2000;
                osc.frequency.setValueAtTime(startFreq, noteT);
                osc.frequency.exponentialRampToValueAtTime(440, noteT + 0.2);
                filter.type = 'bandpass';
                filter.Q.setValueAtTime(0.5, noteT);
                filter.Q.linearRampToValueAtTime(15, noteT + 0.2);
                filter.frequency.setValueAtTime(startFreq, noteT);
                filter.frequency.exponentialRampToValueAtTime(440, noteT + 0.2);
                gain.gain.setValueAtTime(0.0001, noteT);
                gain.gain.linearRampToValueAtTime(0.15, noteT + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteT + 0.35);
                osc.connect(filter); filter.connect(gain); gain.connect(targetNode);
                osc.start(noteT); osc.stop(noteT + 0.4);
                nodes.push(osc, filter, gain);
            }
            // Final sustained convergence tone
            const finalT = t + 1.6;
            const finalOsc = ctx.createOscillator(), finalGain = ctx.createGain();
            finalOsc.type = 'sine'; finalOsc.frequency.value = 440;
            finalGain.gain.setValueAtTime(0, finalT);
            finalGain.gain.linearRampToValueAtTime(0.2, finalT + 0.1);
            finalGain.gain.exponentialRampToValueAtTime(0.0001, finalT + 1.5);
            finalOsc.connect(finalGain); finalGain.connect(targetNode);
            finalOsc.start(finalT); finalOsc.stop(finalT + 1.5);
            nodes.push(finalOsc, finalGain);
            this._cleanupNodes(nodes, 1.6 + 1.5);
        },
    ];
;
