// =============================================================================
// sfxEnemies.js — Stateless functions for enemy event audio
// =============================================================================

const SfxEnemies = {

    playInfectionSpread(sfxCore, x, y, z) {
        if (!sfxCore.initialized || !sfxCore.ctx) return;
        const t = sfxCore.ctx.currentTime;
        if (t - sfxCore.lastSpreadTime < 0.06) return;
        sfxCore.lastSpreadTime = t;

        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, targetNode, routingNodes } = s;
        const dur = 0.04;

        const gainNode = sfxCore._makeGainEnv(ctx, t, 0.45, 0.006, dur);
        const filter = sfxCore._makeFilter(ctx, t, 'bandpass', 1000, 200, dur, 5);
        const osc = sfxCore._makeOsc(ctx, t, 'triangle', 150, 40, dur, filter);

        filter.connect(gainNode);
        gainNode.connect(targetNode);
        sfxCore._cleanupNodes([gainNode, filter, osc, ...routingNodes], dur);
    },

    playInfectionPulse(sfxCore, x, y, z) {
        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;
        const dur = 1.8;

        const gainNode = sfxCore._makeGainEnv(ctx, t, 0.60, 0.012, dur);
        const filter = sfxCore._makeFilter(ctx, t, 'lowpass', 2000, 100, dur);
        const osc = sfxCore._makeOsc(ctx, t, 'sawtooth', 120, 40, dur, filter);

        const noise = sfxCore._createNoise(1.2);
        const distortion = ctx.createWaveShaper();
        distortion.curve = sfxCore.distCurve;

        if (noise) noise.connect(filter);
        filter.connect(distortion);
        distortion.connect(gainNode);
        gainNode.connect(targetNode);

        if (noise) noise.stop(t + dur);
        sfxCore._cleanupNodes([gainNode, filter, osc, noise, distortion, ...routingNodes], dur);
    },

    playEnemyShot(sfxCore, type = 'fighter', x, y, z) {
        const s = sfxCore._setup(x, y, z);
        if (!s) return;
        const { ctx, t, targetNode, routingNodes } = s;

        if (type === 'crab') {
            const dur = 0.2;
            const gain = sfxCore._makeGainEnv(ctx, t, 0.3, 0.004, dur);
            const filter = sfxCore._makeFilter(ctx, t, 'highpass', 3000);
            const osc = sfxCore._makeOsc(ctx, t, 'sawtooth', 800, 4000, 0.1, filter, undefined, dur);
            filter.connect(gain);
            gain.connect(targetNode);
            sfxCore._cleanupNodes([gain, filter, osc, ...routingNodes], dur);
        } else {
            const dur = 0.15;
            const gain = sfxCore._makeGainEnv(ctx, t, 0.25, 0.004, dur);
            const filter = sfxCore._makeFilter(ctx, t, 'lowpass', 4000, 100, dur);
            const osc = sfxCore._makeOsc(ctx, t, 'square', 1200, 200, dur, filter);
            filter.connect(gain);
            gain.connect(targetNode);
            sfxCore._cleanupNodes([gain, filter, osc, ...routingNodes], dur);
        }
    }
};
