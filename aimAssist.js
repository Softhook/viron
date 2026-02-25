// =============================================================================
// aimAssist.js — Platform-agnostic aim assistance and predictive targeting
//
// Works for all input modes: mobile touch, desktop mouse (pointer-lock),
// and desktop keyboard (P1 and P2).
//
// DUAL-LOGIC:
//   1. Enemies  — selection uses CAMERA forward vector.  Aerial enemies are
//      naturally tracked through the screen centre, so camera-relative
//      selection feels most intuitive.
//   2. Virus tiles — selection uses SHIP NOSE forward vector.  For ground
//      sweeping the physical ship orientation is a more reliable indicator
//      of intent than the slightly tilted-up camera view.
//
// BOTH paths nudge the SHIP NOSE toward the target via yaw/pitch deltas.
// Only enemy locks are stored in p.aimTarget for missile homing; virus-tile
// assist is purely a steering aid and never influences missiles.
// =============================================================================

class AimAssist {
    constructor() {
        // --- Tuning ---
        this.CONE_ANGLE = 0.82;    // ~35° half-angle for enemy lock-on
        this.MAX_LOCK_DIST_SQ = 3000000; // ~1732 units range cap
        this.ASSIST_STRENGTH_NORMAL = 0.03;  // Normal nudge strength
        this.ASSIST_STRENGTH_WEAK = 0.01;  // Weak nudge when swiping hard
        this.VIRUS_ASSIST_STRENGTH = 0.012; // Virus-tile steering strength

        // --- Runtime state ---
        this.enabled = false;  // Toggled by 'P' key
        this.debug = false;  // Debug overlay + 3D reticle

        // Last-frame tracking info (used by debug rendering and p.aimTarget writes)
        this.lastTracking = {
            target: null,   // Locked enemy (or null)
            virusTarget: null,   // Locked virus tile position (or null)
            predictedPos: null,   // Predicted lead position for the locked enemy
            dot: 0,
            yawDelta: 0,
            pitchDelta: 0,
            isSwipingHard: false
        };
    }

    // -------------------------------------------------------------------------
    // Orientation helpers
    // -------------------------------------------------------------------------

    /** Returns the ship's nose forward unit vector in world space. */
    _getShipForward(ship) {
        let cp = Math.cos(ship.pitch);
        return {
            x: -Math.sin(ship.yaw) * cp,
            y: Math.sin(ship.pitch),
            z: -Math.cos(ship.yaw) * cp
        };
    }

    /**
     * Returns the camera-to-ship forward unit vector (screen centre direction).
     * Camera sits 550 units behind the ship along the yaw axis with a slight
     * upward offset, so this vector is the yaw direction with a small +Y tilt.
     */
    _getCameraForward(ship) {
        let dx = -Math.sin(ship.yaw);
        let dz = -Math.cos(ship.yaw);
        let dy = 0.2; // Approximate upward tilt of the camera look vector
        let mag = Math.hypot(dx, dy, dz);
        return { x: dx / mag, y: dy / mag, z: dz / mag };
    }

    // -------------------------------------------------------------------------
    // Math helpers
    // -------------------------------------------------------------------------

    /**
     * Computes the yaw and pitch deltas needed to nudge the ship nose toward
     * targetPos, scaled by strength.
     */
    _calculateNudge(ship, targetPos, strength) {
        let ex = targetPos.x - ship.x;
        let ey = targetPos.y - ship.y;
        let ez = targetPos.z - ship.z;
        let distH = Math.sqrt(ex * ex + ez * ez);

        let targetYaw = Math.atan2(-ex, -ez);
        let targetPitch = Math.atan2(ey, distH);

        let yawDiff = targetYaw - ship.yaw;
        while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
        while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;

        return {
            yawDelta: yawDiff * strength,
            pitchDelta: (targetPitch - ship.pitch) * strength
        };
    }

    /**
     * Returns the predicted world-space position of target after the time it
     * would take a projectile travelling at projectileSpeed to reach it.
     * Uses a pre-calculated dist when available to skip the sqrt.
     */
    _getPredictedPos(ship, target, projectileSpeed, dist) {
        if (!target || !projectileSpeed) return target;

        let d = dist;
        if (d === undefined) {
            let dx = target.x - ship.x;
            let dy = target.y - ship.y;
            let dz = target.z - ship.z;
            d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        let tti = d / projectileSpeed; // Time to impact (first-order approximation)
        return {
            x: target.x + (target.vx || 0) * tti,
            y: target.y + (target.vy || 0) * tti,
            z: target.z + (target.vz || 0) * tti
        };
    }

    // -------------------------------------------------------------------------
    // Core assist calculations
    // -------------------------------------------------------------------------

    /**
     * Finds the best enemy inside the lock-on cone and returns yaw/pitch deltas
     * to nudge the ship nose toward its predicted lead position.
     *
     * Uses the provided forward vector (camera or ship nose) for cone selection.
     * Strength is halved when isSwipingHard is true so aggressive joystick input
     * can override the assist lock.
     *
     * Updates lastTracking.target / predictedPos.
     * Returns {yawDelta, pitchDelta} or null if no target in cone.
     */
    calculateAimAssist(ship, enemies, isSwipingHard, forward) {
        let bestTarget = null;
        let bestDot = -1;
        let bestDist = 0;

        const f = forward || this._getShipForward(ship);

        for (let i = 0; i < enemies.length; i++) {
            let e = enemies[i];
            let ex = e.x - ship.x, ey = e.y - ship.y, ez = e.z - ship.z;
            let distSq = ex * ex + ey * ey + ez * ez;

            if (distSq < this.MAX_LOCK_DIST_SQ && distSq > 100) {
                let dist = Math.sqrt(distSq);
                let dot = (ex / dist) * f.x + (ey / dist) * f.y + (ez / dist) * f.z;

                if (dot > this.CONE_ANGLE && dot > bestDot) {
                    bestDot = dot;
                    bestTarget = e;
                    bestDist = dist;
                }
            }
        }

        if (!bestTarget) {
            this.lastTracking.target = null;
            this.lastTracking.predictedPos = null;
            return null;
        }

        // Nudge toward the lead position (pre-calculated dist avoids a second sqrt)
        let predicted = this._getPredictedPos(ship, bestTarget, 25, bestDist);
        let strength = isSwipingHard ? this.ASSIST_STRENGTH_WEAK : this.ASSIST_STRENGTH_NORMAL;
        let res = this._calculateNudge(ship, predicted, strength);

        this.lastTracking.target = bestTarget;
        this.lastTracking.predictedPos = predicted;
        this.lastTracking.virusTarget = null;
        this.lastTracking.dot = bestDot;
        this.lastTracking.yawDelta = res.yawDelta;
        this.lastTracking.pitchDelta = res.pitchDelta;
        this.lastTracking.isSwipingHard = isSwipingHard;

        return res;
    }

    /**
     * Finds the best infected tile inside a strict nose cone and returns yaw/pitch
     * deltas to steer the ship toward it.
     *
     * Uses the ship's nose forward vector (not camera) so ground-sweeping feels
     * natural.  Tile altitude is only queried once (expensive call) for the winner.
     *
     * Updates lastTracking.virusTarget.
     * Returns {yawDelta, pitchDelta} or null if no tile in cone.
     */
    calculateVirusAssist(ship, forward) {
        const f = forward || this._getShipForward(ship);

        let shipTx = Math.floor(ship.x / 120);
        let shipTz = Math.floor(ship.z / 120);

        let bestTileK = null;
        let bestDot = 0.94;      // Strict ~20° half-angle
        let maxDistSq = 6250000;   // 2500 unit cap

        // Scan 22×22 tile window — fast: mostly hash lookups + cheap vector math
        for (let tz = shipTz - 11; tz <= shipTz + 11; tz++) {
            for (let tx = shipTx - 11; tx <= shipTx + 11; tx++) {
                let k = tx + ',' + tz;
                if (infection.tiles[k]) {
                    let vx = tx * 120 + 60 - ship.x;
                    let vy = 300 - ship.y; // Rough constant Y for fast rejection
                    let vz = tz * 120 + 60 - ship.z;
                    let distSq = vx * vx + vy * vy + vz * vz;
                    if (distSq < maxDistSq) {
                        let dist = Math.sqrt(distSq);
                        let dot = (vx / dist) * f.x + (vy / dist) * f.y + (vz / dist) * f.z;
                        if (dot > bestDot) { bestDot = dot; bestTileK = k; }
                    }
                }
            }
        }

        if (!bestTileK) {
            this.lastTracking.virusTarget = null;
            return null;
        }

        let [tx, tz] = bestTileK.split(',').map(Number);
        let txPos = tx * 120 + 60, tzPos = tz * 120 + 60;
        let tyPos = terrain.getAltitude(txPos, tzPos); // Expensive — called only once

        let bestTile = { x: txPos, y: tyPos, z: tzPos };
        let res = this._calculateNudge(ship, bestTile, this.VIRUS_ASSIST_STRENGTH);

        this.lastTracking.virusTarget = bestTile;
        this.lastTracking.dot = bestDot;
        this.lastTracking.yawDelta = res.yawDelta;
        this.lastTracking.pitchDelta = res.pitchDelta;
        return res;
    }

    /**
     * Convenience entry-point used by all input paths.
     * Tries enemy lock-on first (camera forward); falls back to virus-tile
     * steering (ship-nose forward) if no enemy is in cone.
     * Returns {yawDelta, pitchDelta} — never null.
     */
    getAssistDeltas(ship, enemies, isSwipingHard) {
        const cameraForward = this._getCameraForward(ship);
        const shipForward = this._getShipForward(ship);

        let assist = this.calculateAimAssist(ship, enemies, isSwipingHard, cameraForward);
        if (assist) return assist;

        let vAssist = this.calculateVirusAssist(ship, shipForward);
        return vAssist || { yawDelta: 0, pitchDelta: 0 };
    }

    // -------------------------------------------------------------------------
    // Debug rendering
    // -------------------------------------------------------------------------

    /** Draws a 3D reticle on the locked enemy and a yellow lead-position marker. */
    drawDebug3D(ship) {
        if (!this.debug || !ship) return;

        if (this.lastTracking.target) {
            let t = this.lastTracking.target;
            push();
            translate(t.x, t.y, t.z);
            noFill(); stroke(255, 0, 0, 200); strokeWeight(3);

            let s = this.getReticleSize(t.type) + Math.sin(frameCount * 0.1) * 5;
            beginShape(); vertex(-s, 0, 0); vertex(0, -s, 0); vertex(s, 0, 0); vertex(0, s, 0); endShape(CLOSE);
            beginShape(); vertex(0, 0, -s); vertex(0, -s, 0); vertex(0, 0, s); vertex(0, s, 0); endShape(CLOSE);
            pop();

            if (this.lastTracking.predictedPos) {
                let p = this.lastTracking.predictedPos;
                push();
                stroke(255, 255, 0, 150); strokeWeight(2);
                line(t.x, t.y, t.z, p.x, p.y, p.z);
                translate(p.x, p.y, p.z);
                noFill(); circle(0, 0, 20); rotateY(PI / 4); circle(0, 0, 20);
                pop();
            }
        }

        if (this.lastTracking.virusTarget) {
            let vt = this.lastTracking.virusTarget;
            push();
            translate(vt.x, vt.y - 2, vt.z);
            noFill(); stroke(0, 255, 0, 180); strokeWeight(2);
            rotateX(PI / 2); rectMode(CENTER); rect(0, 0, 120, 120);
            pop();
        }
    }

    /** Returns the reticle display size for a given enemy type. */
    getReticleSize(type) {
        const sizes = { bomber: 100, crab: 80, squid: 60, fighter: 50, hunter: 40, seeder: 60 };
        return sizes[type] || 50;
    }
}

// Singleton — all modules reference this directly
const aimAssist = new AimAssist();
