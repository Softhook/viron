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
        this.ASSIST_STRENGTH_NORMAL = 0.05;  // Subtler (was 0.12)
        this.ASSIST_STRENGTH_WEAK = 0.02;    // Subtler (was 0.04)

        // Debug & Testing
        this.debug = false;
        this.desktopAssist = false;
        this.lastTracking = {
            target: null,
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

        // Apply soft lock-on aim assist — always active on mobile, not just when joysticking
        if (ship && enemies) {
            let assist = this.calculateAimAssist(ship, enemies, isSwipingHard);
            if (assist) {
                ship.yaw += assist.yawDelta;
                ship.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, ship.pitch + assist.pitchDelta));
            }
        }

        return inputs;
    }

    calculateAimAssist(ship, enemies, isSwipingHard) {
        let bestTarget = null;
        let bestDot = -1;

        // Correct forward vector based on player.js (Forward = -sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))
        let cp = Math.cos(ship.pitch);
        let forwardX = -Math.sin(ship.yaw) * cp;
        let forwardY = Math.sin(ship.pitch);
        let forwardZ = -Math.cos(ship.yaw) * cp;

        for (let i = 0; i < enemies.length; i++) {
            let e = enemies[i];
            let ex = e.x - ship.x;
            let ey = e.y - ship.y;
            let ez = e.z - ship.z;
            let distSqToEnemy = ex * ex + ey * ey + ez * ez;

            // distance checks
            if (distSqToEnemy < this.MAX_LOCK_DIST_SQ && distSqToEnemy > 100) {
                let dist = Math.sqrt(distSqToEnemy);
                let dirX = ex / dist;
                let dirY = ey / dist;
                let dirZ = ez / dist;

                let dotProduct = forwardX * dirX + forwardY * dirY + forwardZ * dirZ;

                // angle cone check
                if (dotProduct > this.CONE_ANGLE && dotProduct > bestDot) {
                    bestDot = dotProduct;
                    bestTarget = e;
                }
            }
        }

        // Reset tracking if no target
        if (!bestTarget) {
            this.lastTracking.target = null;
            this.lastTracking.dot = 0;
            return null;
        }

        let assistStrength = isSwipingHard ? this.ASSIST_STRENGTH_WEAK : this.ASSIST_STRENGTH_NORMAL;

        let ex = bestTarget.x - ship.x;
        let ey = bestTarget.y - ship.y;
        let ez = bestTarget.z - ship.z;
        let distH = Math.hypot(ex, ez);

        // Correct target angles for p5 coordinate system
        // Yaw: atan2(-x, -z) since forward faces -Z
        // Pitch: atan2(y, distH) since +Y is up
        let targetYaw = Math.atan2(-ex, -ez);
        let targetPitch = Math.atan2(ey, distH);

        let yawDiff = targetYaw - ship.yaw;
        while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
        while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;

        let res = {
            yawDelta: yawDiff * assistStrength,
            pitchDelta: (targetPitch - ship.pitch) * assistStrength
        };

        // Store for debug display
        this.lastTracking.target = bestTarget;
        this.lastTracking.dot = bestDot;
        this.lastTracking.yawDelta = res.yawDelta;
        this.lastTracking.pitchDelta = res.pitchDelta;
        this.lastTracking.isSwipingHard = isSwipingHard;

        return res;
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
                `Target: ${this.lastTracking.target ? "LOCKED" : "NONE"}`,
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
