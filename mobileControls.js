/**
 * MobileController - Handles touch inputs and Aim Assist logic.
 * 
 * AIM ASSIST DUAL-LOGIC:
 * 1. Enemies: Selection uses CAMERA view. Since enemies are aerial, the player naturally
 *    tracks them through the screen center. Camera-relative selection is most intuitive here.
 * 2. Virus: Selection uses SHIP nose. For ground sweeping, the ship's physical orientation
 *    is a more reliable indicator of intent than the slightly tilted-up camera view.
 * 
 * BOTH logics eventually nudge the SHIP NOSE toward the target for firing alignment.
 */
class MobileController {
    constructor() {
        this.leftTouchId = null;
        this.joyCenter = null;
        this.joyPos = null;

        this.btns = {
            thrust: { active: false, r: 65, col: [0, 255, 60], label: 'THR', x: 0, y: 0 },
            shoot: { active: false, r: 65, col: [255, 60, 60], label: 'SHT', x: 0, y: 0 },
            missile: { active: false, r: 40, col: [0, 200, 255], label: 'MSL', x: 0, y: 0 }
        };

        // Configurable Aim Assist settings
        this.CONE_ANGLE = 0.82;          // ~35° half-angle (was 0.90 / ~26°)
        this.MAX_LOCK_DIST_SQ = 3000000; // ~1732 units (was 1800000 / ~1342)
        this.ASSIST_STRENGTH_NORMAL = 0.03;  // Reduced (was 0.05)
        this.ASSIST_STRENGTH_WEAK = 0.01;    // Reduced (was 0.02)
        this.VIRUS_ASSIST_STRENGTH = 0.012;  // Reduced (was 0.025)

        // Debug & Testing
        this.debug = false;
        this.desktopAssist = false;
        this.lastTracking = {
            target: null,
            virusTarget: null,
            dot: 0,
            yawDelta: 0,
            pitchDelta: 0,
            isSwipingHard: false
        };
    }

    update(touches, w, h) {
        this.btns.thrust.x = w - 250; this.btns.thrust.y = h - 100;
        this.btns.shoot.x = w - 105; this.btns.shoot.y = h - 100;
        this.btns.missile.x = w - 105; this.btns.missile.y = h - 240;

        for (let b in this.btns) this.btns[b].active = false;

        let leftFound = false;
        for (let i = 0; i < touches.length; i++) {
            let t = touches[i];
            if (t.x > w / 2) {
                for (let b in this.btns) {
                    if (Math.hypot(t.x - this.btns[b].x, t.y - this.btns[b].y) < this.btns[b].r * 1.7) this.btns[b].active = true;
                }
            } else {
                if (this.leftTouchId === t.id) {
                    this.joyPos = { x: t.x, y: t.y };
                    leftFound = true;
                } else if (!this.leftTouchId) {
                    this.leftTouchId = t.id;
                    this.joyCenter = { x: t.x, y: t.y };
                    this.joyPos = { x: t.x, y: t.y };
                    leftFound = true;
                }
            }
        }

        if (!leftFound) {
            this.leftTouchId = null;
            this.joyCenter = null;
            this.joyPos = null;
        }
    }

    getInputs(ship, enemies, yawRate, pitchRate) {
        let inputs = {
            thrust: this.btns.thrust.active,
            shoot: this.btns.shoot.active,
            missile: this.btns.missile.active,
            yawDelta: 0,
            pitchDelta: 0
        };

        let isSwipingHard = false;

        if (this.joyCenter && this.joyPos) {
            let dx = this.joyPos.x - this.joyCenter.x;
            let dy = this.joyPos.y - this.joyCenter.y;
            let distSq = dx * dx + dy * dy;

            if (distSq > 100) {
                let d = Math.sqrt(distSq);
                let speedFactor = Math.min(1, (d - 10) / 60);
                inputs.yawDelta = -(dx / d) * yawRate * speedFactor;
                inputs.pitchDelta = -(dy / d) * pitchRate * speedFactor * 0.5;

                // Swiping hard check (for breaking aim assist lock)
                if (distSq > 4000) isSwipingHard = true;
            }
        }

        // Pre-calculate ship orientation once per frame
        const shipForward = this._getShipForward(ship);
        const cameraForward = this._getCameraForward(ship);

        // Apply soft lock-on aim assist — always active on mobile, not just when joysticking
        if (ship && enemies) {
            // Use camera view for selection, but ship nose for alignment
            let assist = this.calculateAimAssist(ship, enemies, isSwipingHard, cameraForward);
            if (assist) {
                ship.yaw += assist.yawDelta;
                ship.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, ship.pitch + assist.pitchDelta));
            } else {
                // Try virus assist if no enemy is targeted - USE SHIP NOSE for virus
                let vAssist = this.calculateVirusAssist(ship, shipForward);
                if (vAssist) {
                    ship.yaw += vAssist.yawDelta;
                    ship.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, ship.pitch + vAssist.pitchDelta));
                }
            }
        }

        return inputs;
    }

    _getShipForward(ship) {
        let cp = Math.cos(ship.pitch);
        return {
            x: -Math.sin(ship.yaw) * cp,
            y: Math.sin(ship.pitch),
            z: -Math.cos(ship.yaw) * cp
        };
    }

    _getCameraForward(ship) {
        // Camera math from sketch.js:
        // let cx = s.x + sin(s.yaw) * cd;
        // let cz = s.z + cos(s.yaw) * cd;
        // camera(cx, cy, cz, s.x, s.y, s.z, 0, 1, 0);
        // Normalized vector from Camera (cx, cy, cz) to Ship (s.x, s.y, s.z)
        // points exactly at the screen center.

        let dx = -Math.sin(ship.yaw); // s.x - (s.x + sin*550)
        let dz = -Math.cos(ship.yaw); // s.z - (s.z + cos*550)
        let dy = 0.2; // Approximate upward tilt of the camera look vector

        let mag = Math.hypot(dx, dy, dz);
        return { x: dx / mag, y: dy / mag, z: dz / mag };
    }

    _calculateNudge(ship, targetPos, strength) {
        let ex = targetPos.x - ship.x;
        let ey = targetPos.y - ship.y;
        let ez = targetPos.z - ship.z;
        let distH = Math.hypot(ex, ez);

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

    calculateAimAssist(ship, enemies, isSwipingHard, forward) {
        let bestTarget = null;
        let bestDot = -1;

        // Use provided forward or calculate if missing
        const f = forward || this._getShipForward(ship);

        for (let i = 0; i < enemies.length; i++) {
            let e = enemies[i];
            let ex = e.x - ship.x;
            let ey = e.y - ship.y;
            let ez = e.z - ship.z;
            let distSq = ex * ex + ey * ey + ez * ez;

            if (distSq < this.MAX_LOCK_DIST_SQ && distSq > 100) {
                let dist = Math.sqrt(distSq);
                let dot = (ex / dist) * f.x + (ey / dist) * f.y + (ez / dist) * f.z;

                if (dot > this.CONE_ANGLE && dot > bestDot) {
                    bestDot = dot;
                    bestTarget = e;
                }
            }
        }

        if (!bestTarget) {
            this.lastTracking.target = null;
            return null;
        }

        let strength = isSwipingHard ? this.ASSIST_STRENGTH_WEAK : this.ASSIST_STRENGTH_NORMAL;
        let res = this._calculateNudge(ship, bestTarget, strength);

        // Store for debug
        this.lastTracking.target = bestTarget;
        this.lastTracking.virusTarget = null;
        this.lastTracking.dot = bestDot;
        this.lastTracking.yawDelta = res.yawDelta;
        this.lastTracking.pitchDelta = res.pitchDelta;
        this.lastTracking.isSwipingHard = isSwipingHard;

        return res;
    }

    calculateVirusAssist(ship, forward) {
        const f = forward || this._getShipForward(ship);

        // Performance: Center scan on ship's current tile index
        let shipTx = Math.floor(ship.x / 120);
        let shipTz = Math.floor(ship.z / 120);

        let bestTileK = null;
        let bestDot = 0.94; // Strict cone (~20 deg half-angle)
        let maxDistSq = 6250000; // 2500 units distance cap

        // Scan a 22x22 window around the ship (~1300 units radius)
        // This is extremely performant as it mostly does key lookups and basic math
        for (let tz = shipTz - 11; tz <= shipTz + 11; tz++) {
            for (let tx = shipTx - 11; tx <= shipTx + 11; tx++) {
                let k = tx + ',' + tz;
                if (infectedTiles[k]) {
                    // Vector to tile center (rough y=300 for fast rejection)
                    let vx = tx * 120 + 60 - ship.x;
                    let vy = 300 - ship.y;
                    let vz = tz * 120 + 60 - ship.z;

                    let distSq = vx * vx + vy * vy + vz * vz;
                    if (distSq < maxDistSq) {
                        let dist = Math.sqrt(distSq);
                        let dot = (vx / dist) * f.x + (vy / dist) * f.y + (vz / dist) * f.z;

                        if (dot > bestDot) {
                            bestDot = dot;
                            bestTileK = k;
                        }
                    }
                }
            }
        }

        if (bestTileK) {
            let [tx, tz] = bestTileK.split(',').map(Number);
            let txPos = tx * 120 + 60;
            let tzPos = tz * 120 + 60;
            let tyPos = terrain.getAltitude(txPos, tzPos); // Expensive call: Only Once!

            let bestTile = { x: txPos, y: tyPos, z: tzPos };
            let res = this._calculateNudge(ship, bestTile, this.VIRUS_ASSIST_STRENGTH);

            this.lastTracking.virusTarget = bestTile;
            this.lastTracking.dot = bestDot;
            this.lastTracking.yawDelta = res.yawDelta;
            this.lastTracking.pitchDelta = res.pitchDelta;
            return res;
        }

        this.lastTracking.virusTarget = null;
        return null;
    }

    draw(w, h) {
        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        translate(-w / 2, -h / 2, 0);

        if (this.joyCenter && this.joyPos) {
            noStroke();
            fill(255, 255, 255, 40);
            circle(this.joyCenter.x, this.joyCenter.y, 140);
            fill(255, 255, 255, 120);
            let d = Math.hypot(this.joyPos.x - this.joyCenter.x, this.joyPos.y - this.joyCenter.y);
            let a = Math.atan2(this.joyPos.y - this.joyCenter.y, this.joyPos.x - this.joyCenter.x);
            let r = Math.min(d, 70);
            circle(this.joyCenter.x + Math.cos(a) * r, this.joyCenter.y + Math.sin(a) * r, 50);
        }

        for (let b in this.btns) {
            let btn = this.btns[b];
            stroke(btn.col[0], btn.col[1], btn.col[2], btn.active ? 200 : 80);
            strokeWeight(2);
            fill(btn.col[0], btn.col[1], btn.col[2], btn.active ? 80 : 20);
            circle(btn.x, btn.y, btn.r * 2);
            noStroke(); fill(255, btn.active ? 255 : 150);
            textAlign(CENTER, CENTER); textSize(Math.max(10, btn.r * 0.4));
            text(btn.label, btn.x, btn.y);
        }

        // 2D Debug Overlay
        if (this.debug) {
            resetMatrix();
            textAlign(LEFT, TOP);
            textSize(16);
            noStroke();
            fill(0, 255, 0);
            let info = [
                `DEBUG MODE (P to toggle)`,
                `Desktop Assist: ${this.desktopAssist ? "ON" : "OFF"}`,
                `Target: ${this.lastTracking.target ? "ENEMY LOCKED" : (this.lastTracking.virusTarget ? "VIRUS LOCKED" : "NONE")}`,
                `Dot Product: ${this.lastTracking.dot.toFixed(3)}`,
                `Yaw Delta: ${this.lastTracking.yawDelta.toFixed(4)}`,
                `Pitch Delta: ${this.lastTracking.pitchDelta.toFixed(4)}`,
                `Hard Swipe: ${this.lastTracking.isSwipingHard}`
            ];
            for (let i = 0; i < info.length; i++) {
                text(info[i], 20, 20 + i * 22);
            }
        }
        pop();
    }

    drawDebug3D(ship) {
        if (!this.debug || !ship) return;

        // Draw 3D Reticle around target
        if (this.lastTracking.target) {
            let t = this.lastTracking.target;
            push();
            translate(t.x, t.y, t.z);
            noFill();
            stroke(255, 0, 0, 200);
            strokeWeight(3);

            // Dynamic size based on enemy type
            let baseSize = this.getReticleSize(t.type);
            let s = baseSize + Math.sin(frameCount * 0.1) * 5; // Pulsing size

            beginShape();
            vertex(-s, 0, 0); vertex(0, -s, 0); vertex(s, 0, 0); vertex(0, s, 0);
            endShape(CLOSE);

            beginShape();
            vertex(0, 0, -s); vertex(0, -s, 0); vertex(0, 0, s); vertex(0, s, 0);
            endShape(CLOSE);
            pop();
        }

        // Draw Virus Target (Green Box on Ground)
        if (this.lastTracking.virusTarget) {
            let vt = this.lastTracking.virusTarget;
            push();
            translate(vt.x, vt.y - 2, vt.z);
            noFill();
            stroke(0, 255, 0, 180);
            strokeWeight(2);
            rotateX(PI / 2);
            rectMode(CENTER);
            rect(0, 0, 120, 120); // Tile size
            pop();
        }
    }

    getReticleSize(type) {
        const sizes = {
            bomber: 100,
            crab: 80,
            squid: 60,
            fighter: 50,
            hunter: 40,
            seeder: 60
        };
        return sizes[type] || 50;
    }
}

const mobileController = new MobileController();

function handleTouchStarted() {
    if (gameState === 'menu') {
        if (typeof isAndroid !== 'undefined' && isAndroid && typeof fullscreen === 'function' && !fullscreen()) fullscreen(true);
        setTimeout(() => { if (typeof startGame === 'function') startGame(1); }, 50);
    } else if (gameState === 'playing' && typeof isAndroid !== 'undefined' && isAndroid) {
        if (typeof fullscreen === 'function' && !fullscreen()) fullscreen(true);
    }
    return false;
}
