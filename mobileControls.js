/**
 * MobileController - Handles touch inputs and on-screen buttons.
 * 
 * "Swipe-to-Turn / Stationary-to-Thrust" Scheme:
 * 1. Swiping on the left half of the screen performs relative turning (trackpad style).
 * 2. Holding the finger stationary logic (low velocity) engages thrust.
 * 3. A small "thrust grace" period allows turning while maintaining momentum.
 */
class MobileController {
    constructor() {
        this.leftTouchId = null;
        this.lastX = 0;
        this.lastY = 0;
        this.deltaX = 0;
        this.deltaY = 0;

        this.stationaryTicks = 0;
        this.thrustGrace = 0;

        this._scale = 1;
        this._w = 0;
        this._h = 0;

        this.btns = {
            shoot: { active: false, baseR: 65, col: [255, 60, 60], label: 'SHT', x: 0, y: 0, r: 65 },
            missile: { active: false, baseR: 44, col: [0, 200, 255], label: 'WPN', x: 0, y: 0, r: 44 }
        };

        this.debug = false;
    }

    // -------------------------------------------------------------------------
    // Dimensions & UI Scaling
    // -------------------------------------------------------------------------

    get _blobDiam() { return 60 * this._scale; }
    get _ringDiam() { return 80 * this._scale; }
    get _deadzone() { return 4 * this._scale; } // Increased for better jitter filtering

    update(touches, w, h) {
        // Cache scale on resize
        if (w !== this._w || h !== this._h) {
            this._w = w;
            this._h = h;
            this._scale = Math.min(w, h) / 400;
            const s = this._scale;
            this.btns.shoot.r = this.btns.shoot.baseR * s;
            this.btns.missile.r = this.btns.missile.baseR * s;
        }

        const s = this._scale;
        this.btns.shoot.x = w - 105 * s; this.btns.shoot.y = h - 100 * s;
        this.btns.missile.x = w - 105 * s; this.btns.missile.y = h - 240 * s;

        for (let b in this.btns) this.btns[b].active = false;

        let leftFound = false;
        this.deltaX = 0;
        this.deltaY = 0;

        for (let i = 0; i < touches.length; i++) {
            let t = touches[i];
            if (t.x > w / 2) {
                // Action Buttons
                for (let b in this.btns) {
                    if (Math.hypot(t.x - this.btns[b].x, t.y - this.btns[b].y) < this.btns[b].r * 1.7) {
                        this.btns[b].active = true;
                    }
                }
            } else {
                // Trackpad / Thrust logic
                if (this.leftTouchId === t.id) {
                    this.deltaX = t.x - this.lastX;
                    this.deltaY = t.y - this.lastY;

                    let dist = Math.hypot(this.deltaX, this.deltaY);

                    if (dist < this._deadzone) {
                        this.stationaryTicks++;
                    } else {
                        this.stationaryTicks = 0;
                        this.thrustGrace = 12; // ~200ms grace period for momentum turns
                    }

                    this.lastX = t.x;
                    this.lastY = t.y;
                    leftFound = true;
                } else if (!this.leftTouchId) {
                    this.leftTouchId = t.id;
                    this.lastX = t.x;
                    this.lastY = t.y;
                    this.stationaryTicks = 0;
                    this.thrustGrace = 0;
                    leftFound = true;
                }
            }
        }

        if (!leftFound) {
            this.leftTouchId = null;
            this.stationaryTicks = 0;
            this.thrustGrace = 0;
        }

        if (this.thrustGrace > 0) this.thrustGrace--;
    }

    getInputs(ship, enemies, yawRate, pitchRate) {
        let inputs = {
            thrust: (this.stationaryTicks > 5 || this.thrustGrace > 0),
            shoot: this.btns.shoot.active,
            cycleWeapon: this.btns.missile.active,
            yawDelta: 0,
            pitchDelta: 0,
            assistYaw: 0,
            assistPitch: 0
        };

        if (this.leftTouchId) {
            // Trackpad sensitivity: a 100px swipe is ~1.5 radians (approx 85 degrees)
            // This multiplier (1.0) with sens (0.4) is snappy but controllable.
            let sens = 0.4 / this._scale;
            inputs.yawDelta = -this.deltaX * sens * (yawRate * 1.0);
            inputs.pitchDelta = -this.deltaY * sens * (pitchRate * 1.0);
        }

        // Aim Assist
        if (aimAssist.enabled && ship && enemies) {
            let isSwipingHard = Math.hypot(this.deltaX, this.deltaY) > 15;
            let assist = aimAssist.getAssistDeltas(ship, enemies, isSwipingHard);
            inputs.assistYaw = assist.yawDelta;
            inputs.assistPitch = assist.pitchDelta;
        }

        return inputs;
    }

    draw(w, h) {
        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        translate(-w / 2, -h / 2, 0);

        if (this.leftTouchId) {
            let thrusting = (this.stationaryTicks > 5 || this.thrustGrace > 0);

            // Stationary/Thrust indicator ring
            noFill();
            strokeWeight(2 * this._scale);
            if (thrusting) {
                stroke(0, 255, 60, 150);
                // Pulse effect
                let pulse = (frameCount % 30) / 30;
                circle(this.lastX, this.lastY, this._ringDiam * (1 + pulse * 0.5));
            } else {
                stroke(255, 255, 255, 50);
                // Contracting ring shows progress to stationary thrust
                let progress = Math.min(1, this.stationaryTicks / 6);
                circle(this.lastX, this.lastY, this._ringDiam * (2 - progress));
            }

            // Finger blob
            noStroke();
            if (thrusting) {
                fill(0, 255, 60, 200);
            } else {
                fill(255, 255, 255, 150);
            }
            circle(this.lastX, this.lastY, this._blobDiam);
        }

        // Action buttons
        for (let b in this.btns) {
            let btn = this.btns[b];
            stroke(btn.col[0], btn.col[1], btn.col[2], btn.active ? 200 : 80);
            strokeWeight(2 * this._scale);
            fill(btn.col[0], btn.col[1], btn.col[2], btn.active ? 80 : 20);
            circle(btn.x, btn.y, btn.r * 2);
            noStroke();
            fill(255, btn.active ? 255 : 150);
            textAlign(CENTER, CENTER);
            textSize(Math.max(10, btn.r * 0.4));
            text(btn.label, btn.x, btn.y);
        }

        // Debug info
        if (this.debug) {
            resetMatrix();
            textAlign(LEFT, TOP); textSize(14); noStroke(); fill(0, 255, 0);
            let info = [
                `Velocity Mode`,
                `Stationary Ticks: ${this.stationaryTicks}`,
                `Thrust Grace: ${this.thrustGrace}`,
                `Delta: ${this.deltaX.toFixed(1)}, ${this.deltaY.toFixed(1)}`
            ];
            for (let i = 0; i < info.length; i++) text(info[i], 20, 20 + i * 20);
        }
        pop();
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
