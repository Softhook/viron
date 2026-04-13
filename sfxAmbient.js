// =============================================================================
// sfxAmbient.js — Stateless functions for ambient audio and thrust rendering
//
// @exports   SfxAmbient   — namespace: updateAmbiance(), updateThrust()
// =============================================================================

export const SfxAmbient = {

    updateAmbiance(sfxCore, proximityData, infectionCount, maxInfection) {
        if (!sfxCore.initialized || !sfxCore.ctx) return;
        const dest = sfxCore.master || sfxCore.ctx.destination;
        const now = sfxCore.ctx.currentTime;

        const dtRaw = sfxCore._heartbeatLastTime > 0 ? (now - sfxCore._heartbeatLastTime) : (1 / 60);
        const dt = Math.min(0.1, Math.max(1 / 240, dtRaw));
        sfxCore._heartbeatLastTime = now;

        if (!sfxCore.ambientNodes.heartbeat) {
            const osc = sfxCore.ctx.createOscillator();
            const gain = sfxCore.ctx.createGain();
            const filter = sfxCore.ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.value = 45;
            filter.type = 'lowpass';
            filter.frequency.value = 80;
            gain.gain.value = 0;

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(dest);
            osc.start();
            sfxCore.ambientNodes.heartbeat = { osc, gain, filter };
        }

        const maxInf = Math.max(1, maxInfection || 1);
        const infectionRatio = Math.min(1, Math.max(0, infectionCount / maxInf));

        const heartRateTarget = 0.65 + infectionRatio * 1.05;
        const rateBlend = 1 - Math.exp(-dt / 0.8);
        const intensityBlend = 1 - Math.exp(-dt / 0.35);
        sfxCore._heartRateSmoothed += (heartRateTarget - sfxCore._heartRateSmoothed) * rateBlend;
        sfxCore._heartIntensitySmoothed += (infectionRatio - sfxCore._heartIntensitySmoothed) * intensityBlend;

        sfxCore._heartbeatPhase = (sfxCore._heartbeatPhase + sfxCore._heartRateSmoothed * dt) % 1;
        const phase = sfxCore._heartbeatPhase;
        const beatWindow = (center, width) => {
            const d = Math.abs(phase - center);
            if (d >= width) return 0;
            const x = 1 - d / width;
            return x * x * (3 - 2 * x);
        };
        const lub = beatWindow(0.08, 0.095);
        const dub = beatWindow(0.28, 0.08);
        const pulse = Math.min(1, lub + dub * 0.68);

        const heartVol = sfxCore._heartIntensitySmoothed * 0.25;
        const heartFreq = 38 + sfxCore._heartIntensitySmoothed * 10 + pulse * 12;
        sfxCore._paramSetTarget(sfxCore.ambientNodes.heartbeat.osc.frequency, heartFreq, now, 0.06);
        sfxCore._paramSetTarget(sfxCore.ambientNodes.heartbeat.gain.gain, heartVol * pulse, now, 0.03);

        if (!sfxCore.ambientNodes.proximityHum) {
            const osc = sfxCore.ctx.createOscillator();
            const noise = sfxCore._createNoise(0.25);
            const gain = sfxCore.ctx.createGain();
            const filter = sfxCore.ctx.createBiquadFilter();

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
            sfxCore.ambientNodes.proximityHum = { osc, noise, gain, filter };
        }

        if (!sfxCore.ambientNodes.scanningMod) {
            const osc = sfxCore.ctx.createOscillator();
            const gain = sfxCore.ctx.createGain();
            const filter = sfxCore.ctx.createBiquadFilter();
            const lfo = sfxCore.ctx.createOscillator();
            const lfoGain = sfxCore.ctx.createGain();

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
            sfxCore.ambientNodes.scanningMod = { osc, gain, filter, lfo, lfoGain };
        }

        const targetProximity = proximityData.dist < 800 ? (1 - proximityData.dist / 800) : 0;
        sfxCore._infectionProximityAlpha = typeof lerp !== 'undefined' 
            ? lerp(sfxCore._infectionProximityAlpha, targetProximity, 0.05)
            : sfxCore._infectionProximityAlpha + (targetProximity - sfxCore._infectionProximityAlpha) * 0.05;

        const humVol = sfxCore._infectionProximityAlpha * 1.0;
        sfxCore._paramSetTarget(sfxCore.ambientNodes.proximityHum.gain.gain, humVol, now, 0.1);
        sfxCore._paramSetTarget(sfxCore.ambientNodes.proximityHum.filter.frequency, 200 + sfxCore._infectionProximityAlpha * 400, now, 0.1);

        {
            const scanAlpha = Math.min(1, Math.max(0, proximityData.pulseOverlap || 0));
            sfxCore._scanPulseAlpha = typeof lerp !== 'undefined'
                ? lerp(sfxCore._scanPulseAlpha, scanAlpha, 0.22)
                : sfxCore._scanPulseAlpha + (scanAlpha - sfxCore._scanPulseAlpha) * 0.22;
            const alphaSq = sfxCore._scanPulseAlpha * sfxCore._scanPulseAlpha;
            sfxCore._paramSetTarget(sfxCore.ambientNodes.scanningMod.gain.gain, alphaSq * 0.7, now, 0.06);
            sfxCore._paramSetTarget(sfxCore.ambientNodes.scanningMod.lfo.frequency, 8.0 + alphaSq * 8.5, now, 0.08);
        }

        if (!sfxCore.ambientNodes.scanSweep) {
            const noise = sfxCore._createNoise(0.2);
            const filter = sfxCore.ctx.createBiquadFilter();
            const gain = sfxCore.ctx.createGain();

            filter.type = 'bandpass';
            filter.frequency.value = 2000;
            filter.Q.value = 25;
            gain.gain.value = 0;

            if (noise) noise.connect(filter);
            filter.connect(gain);
            gain.connect(dest);

            sfxCore.ambientNodes.scanSweep = { noise, filter, gain };
        }

        const sweepAlphaTarget = Math.min(1, Math.max(0, proximityData.scanSweepAlpha || 0));
        sfxCore._scanSweepAlpha = typeof lerp !== 'undefined'
            ? lerp(sfxCore._scanSweepAlpha, sweepAlphaTarget, 0.2)
            : sfxCore._scanSweepAlpha + (sweepAlphaTarget - sfxCore._scanSweepAlpha) * 0.2;
        const sweepVol = sfxCore._scanSweepAlpha * sfxCore._infectionProximityAlpha * 0.52;
        sfxCore._paramSetTarget(sfxCore.ambientNodes.scanSweep.gain.gain, sweepVol, now, 0.08);
        sfxCore._paramSetTarget(sfxCore.ambientNodes.scanSweep.filter.frequency, 1400 + sfxCore._scanSweepAlpha * 1300, now, 0.08);
    },

    setThrust(sfxCore, id, active, x, y, z) {
        sfxCore.init();
        if (!sfxCore.ctx) return;
        const t = sfxCore.ctx.currentTime;

        // Uses a fallback to Math.min / Math.max if constrain is missing, but it is available globally
        const constrainLocal = (typeof constrain !== 'undefined') ? constrain : Math.max;

        if (!active) {
            if (sfxCore.thrustNodes[id]) {
                const n = sfxCore.thrustNodes[id];
                if (!n.stopping) {
                    n.active = false;
                    n.stopping = true;
                    n.stopSeq = (n.stopSeq || 0) + 1;
                    const stopSeq = n.stopSeq;
                    sfxCore._paramSetTarget(n.gain.gain, 0, t, 0.04);
                    // Increased from 160ms to 250ms (~6*tau) to ensure the 40ms exponential 
                    // fade-out is truly silent before destroying the nodes. 
                    n.stopTimer = setTimeout(() => {
                        n.stopTimer = null;
                        if (sfxCore.thrustNodes[id] === n && n.stopping && n.stopSeq === stopSeq) {
                            sfxCore._stopThrustNode(n);
                            delete sfxCore.thrustNodes[id];
                        }
                    }, 250);
                }
            }
            return;
        }

        if (sfxCore.thrustNodes[id]) {
            const n = sfxCore.thrustNodes[id];
            n.active = true;
            if (n.stopping) {
                n.stopping = false;
                n.stopSeq = (n.stopSeq || 0) + 1;
                if (n.stopTimer) {
                    clearTimeout(n.stopTimer);
                    n.stopTimer = null;
                }
            }
        }

        if (!sfxCore.thrustNodes[id]) {
            const gain = sfxCore.ctx.createGain();
            gain.gain.value = 0;

            let panner = null;
            if (id !== 0 && sfxCore.spatialEnabled) {
                panner = sfxCore.createSpatializer(x, y, z);
                if (panner) {
                    panner.panningModel = 'equalpower';
                    panner.distanceModel = 'linear';
                    panner.refDistance = 200;
                    panner.rolloffFactor = 0.5;
                }
            } else if (!sfxCore.spatialEnabled && sfxCore.ctx.createStereoPanner) {
                panner = sfxCore.ctx.createStereoPanner();
                panner.pan.setValueAtTime((id === 0) ? -0.4 : 0.4, t);
            }

            const osc = sfxCore.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(42 + (id * 0.7), t);

            const noise = sfxCore._createNoise(0.4);

            const filter = sfxCore.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(110, t);
            filter.Q.value = 0.2;

            osc.connect(filter);
            if (noise) noise.connect(filter);
            filter.connect(gain);

            if (panner) {
                gain.connect(panner);
                panner.connect(sfxCore.master || sfxCore.ctx.destination);
            } else {
                gain.connect(sfxCore.master || sfxCore.ctx.destination);
            }

            osc.start(t);

            sfxCore.thrustNodes[id] = {
                osc,
                noise,
                gain,
                panner,
                filter,
                lastX: x,
                lastY: y,
                lastZ: z,
                active: true,
                stopSeq: 0,
                stopping: false,
                stopTimer: null
            };
        }

        const n = sfxCore.thrustNodes[id];
        const baseVol = (id === 0) ? (sfxCore.spatialEnabled ? 0.32 : 0.24) : (sfxCore.spatialEnabled ? 0.22 : 0.16);
        let finalVol = baseVol;

        if (x !== undefined && y !== undefined && z !== undefined) {
            let minDistSq = Infinity;
            if (typeof gameState !== 'undefined' && gameState.players.length > 0) {
                const numPlayers = gameState.players.length;
                for (let i = 0; i < numPlayers; i++) {
                    const p = gameState.players[i];
                    if (p.dead || !p.ship) continue;
                    const dSq = (x - p.ship.x) ** 2 + (y - p.ship.y) ** 2 + (z - p.ship.z) ** 2;
                    if (dSq < minDistSq) minDistSq = dSq;
                }
                if (minDistSq !== Infinity && !sfxCore.spatialEnabled) {
                    const distance = Math.sqrt(minDistSq);
                    if (distance > sfxCore._refDist) {
                        finalVol *= Math.pow(sfxCore._refDist / Math.min(distance, sfxCore._maxManualDist), 1.25);
                    }
                }
            }
        }

        sfxCore._paramSetTarget(n.gain.gain, finalVol, t, 0.05);

        if (id === 0 && y !== undefined) {
            let clamped = Math.max(0, Math.min(1, (100 - y) / 2000));
            const altFactor = typeof constrain !== 'undefined' ? constrain((100 - y) / 2000, 0, 1) : clamped;
            sfxCore._paramSetTarget(n.filter.frequency, 110 + altFactor * 40, t, 0.1);
            sfxCore._paramSetTarget(n.osc.frequency, 42 + altFactor * 10, t, 0.1);
        }

        if (sfxCore.spatialEnabled && n.panner && x !== undefined) {
            const dt = 0.05;
            const distSq = (x - n.lastX) ** 2 + (y - n.lastY) ** 2 + (z - n.lastZ) ** 2;
            if (distSq > 0.1) {
                try {
                    const px = n.panner.positionX;
                    const py = n.panner.positionY;
                    const pz = n.panner.positionZ;
                    if (px && py && pz) {
                        sfxCore._cancelAndHoldParam(px, t);
                        sfxCore._cancelAndHoldParam(py, t);
                        sfxCore._cancelAndHoldParam(pz, t);
                    }
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
};
