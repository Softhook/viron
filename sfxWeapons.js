// =============================================================================
// sfxWeapons.js — Stateless functions for player/combat weapon audio
// =============================================================================

const SfxWeapons = {

    playShot(sfxCore, x, y, z) {
        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.18;

        const gainNode = sfxCore._makeGainEnv(ctx, t, 0.10, 0.005, dur);
        const filter = sfxCore._makeFilter(ctx, t, 'lowpass', 1800, 500, 0.15);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        const oscs = [-10, 0, 10].map(det =>
            sfxCore._makeOsc(ctx, t, 'triangle', 220, 140, 0.15, filter, det, dur)
        );

        const subFilter = sfxCore._makeFilter(ctx, t, 'highpass', 40);
        const subGain = sfxCore._makeGainEnv(ctx, t, 0.14, 0.005, 0.12);
        const sub = sfxCore._makeOsc(ctx, t, 'sine', 80, 40, 0.1, subFilter, undefined, 0.12);

        subFilter.connect(subGain);
        subGain.connect(targetNode);

        sfxCore._cleanupNodes([gainNode, filter, sub, subFilter, subGain, ...oscs, ...routingNodes], dur);
    },

    playMissileFire(sfxCore, x, y, z) {
        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 0.6;

        const gainNode = sfxCore._makeGainEnv(ctx, t, 0.16, 0.005, dur);
        const filter = sfxCore._makeFilter(ctx, t, 'lowpass', 400);
        filter.frequency.linearRampToValueAtTime(3500, t + 0.2);
        filter.frequency.exponentialRampToValueAtTime(100, t + dur);

        filter.connect(gainNode);
        gainNode.connect(targetNode);

        const oscs = [-25, 0, 25].map(det =>
            sfxCore._makeOsc(ctx, t, 'square', 150, 40, dur, filter, det)
        );

        const noise = sfxCore._createNoise();
        if (noise) {
            noise.connect(filter);
            noise.stop(t + dur);
        }
        sfxCore._cleanupNodes([gainNode, filter, noise, ...oscs, ...routingNodes], dur);
    },

    playBombDrop(sfxCore, type = 'normal', x, y, z) {
        const s = sfxCore._setup(x, y, z);
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
        sfxCore._cleanupNodes([gain, osc, ...routingNodes], dur);
    },

    playExplosion(sfxCore, x, y, z, isLarge = false, type = '') {
        const now = Date.now();
        if (x !== undefined && z !== undefined) {
            const dx = x - sfxCore.lastExplosionPos.x;
            const dz = z - sfxCore.lastExplosionPos.z;
            if (now - sfxCore.lastExplosionTime < 45 && (dx * dx + dz * dz < 2500)) return;
            sfxCore.lastExplosionTime = now;
            sfxCore.lastExplosionPos = { x, y, z };
        }

        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;

        const isBomber = type === 'bomber';
        const isSquid = type === 'squid';
        const isCrab = type === 'crab';
        const isColossus = type === 'colossus';
        const dur = isLarge || isBomber || isColossus ? 2.8 : (isSquid ? 1.5 : 0.9);

        const distortion = ctx.createWaveShaper();
        distortion.curve = sfxCore.distCurve;
        distortion.oversample = '4x';

        const noise = sfxCore._createNoise(isLarge ? 4.5 : 3.5);

        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = isCrab ? 'bandpass' : 'lowpass';
        if (isCrab) {
            noiseFilter.frequency.setValueAtTime(2000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(500, t + dur);
        } else {
            noiseFilter.frequency.setValueAtTime(isLarge || isBomber || isColossus ? 1800 : 5000, t);
            noiseFilter.frequency.exponentialRampToValueAtTime(60, t + dur);
        }

        const initVol = isLarge ? 0.9 : (isBomber || isColossus ? 0.9 : 0.75);
        const noiseGain = sfxCore._makeGainEnv(ctx, t, initVol, 0.006, dur);

        const toClean = [distortion, noise, noiseFilter, noiseGain];

        if (isLarge || isBomber || isColossus) {
            const subGain = sfxCore._makeGainEnv(ctx, t, 0.35, 0.006, dur * 0.6);
            const sub = sfxCore._makeOsc(ctx, t, 'sine', 60, 20, dur * 0.5, subGain, undefined, dur);
            subGain.connect(targetNode);
            toClean.push(sub, subGain);
        }

        if (noise) noise.connect(noiseFilter);
        noiseFilter.connect(distortion);

        const freqs = isLarge || isBomber ? [90, 94, 86] : (isSquid ? [130, 135, 125] : [150, 155, 145]);
        const endFreq = isLarge || isBomber ? 20 : (isSquid ? 5 : 20);
        const baseGain = isLarge || isBomber ? 1.0 : (isSquid ? 0.8 : 0.6);
        freqs.forEach((freq, idx) => {
            const oscType = isSquid ? 'sawtooth' : (idx === 0 ? 'triangle' : 'sine');
            const oscGain = sfxCore._makeGainEnv(ctx, t, baseGain, 0.004, dur);
            const osc = sfxCore._makeOsc(ctx, t, oscType, freq, endFreq, dur, oscGain);
            oscGain.connect(distortion);
            toClean.push(osc, oscGain);
        });

        distortion.connect(noiseGain);
        noiseGain.connect(targetNode);
        if (noise) noise.stop(t + dur);
        sfxCore._cleanupNodes([...toClean, ...routingNodes], dur);
    }
};
