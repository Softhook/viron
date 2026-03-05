/**
 * MobileController - Handles touch inputs and on-screen buttons.
 * 
 * "Hybrid Floating Joystick" Scheme:
 * 1. Touching the left half places a floating anchor. Swiping away sets continuous Turn Rate.
 * 2. Holding the finger stationary logic (low velocity) engages thrust instantly.
 * 3. Actively scrubbing/moving the finger (high velocity) turns OFF thrust to allow precision aiming.
 */
class MobileController {
    constructor() {
        this.leftTouchId = null;
        this.anchorX = 0;
        this.anchorY = 0;
        this.lastX = 0;
        this.lastY = 0;

        // Thrust is engaged when the finger's frame-to-frame velocity is low
        this.stationaryTicks = 0;

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
    get _anchorDiam() { return 20 * this._scale; }
    get _maxStretch() { return 100 * this._scale; } // How far the blob can visually stretch
    get _velDeadzone() { return 3 * this._scale; }   // Movement below this is "stationary"

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
                // Hybrid Joystick logic
                if (this.leftTouchId === t.id) {
                    // Frame-to-frame velocity check for thrust
                    let dx = t.x - this.lastX;
                    let dy = t.y - this.lastY;
                    let dist = Math.hypot(dx, dy);

                    if (dist < this._velDeadzone) {
                        this.stationaryTicks++;
                    } else {
                        // Actively scrubbing the finger removes thrust for precise aiming
                        this.stationaryTicks = 0;
                    }

                    // Floating Anchor Drag (prevents getting stuck at the edge of the screen)
                    let offsetX = t.x - this.anchorX;
                    let offsetY = t.y - this.anchorY;
                    let stretch = Math.hypot(offsetX, offsetY);

                    if (stretch > this._maxStretch) {
                        let over = stretch - this._maxStretch;
                        this.anchorX += (offsetX / stretch) * over;
                        this.anchorY += (offsetY / stretch) * over;
                    }

                    this.lastX = t.x;
                    this.lastY = t.y;
                    leftFound = true;
                } else if (!this.leftTouchId) {
                    this.leftTouchId = t.id;
                    this.anchorX = t.x;
                    this.anchorY = t.y;
                    this.lastX = t.x;
                    this.lastY = t.y;
                    this.stationaryTicks = 0;
                    leftFound = true;
                }
            }
        }

        if (!leftFound) {
            this.leftTouchId = null;
            this.stationaryTicks = 0;
        }
    }

    getInputs(ship, enemies, yawRate, pitchRate) {
        let inputs = {
            thrust: (this.stationaryTicks > 5), // Thrust if held still for ~80ms
            shoot: this.btns.shoot.active,
            cycleWeapon: this.btns.missile.active,
            yawDelta: 0,
            pitchDelta: 0,
            assistYaw: 0,
            assistPitch: 0
        };

        if (this.leftTouchId) {
            // Joystick displacement determines constant turning rate
            let offsetX = this.lastX - this.anchorX;
            let offsetY = this.lastY - this.anchorY;

            // Map the offset visually to a (-1 to 1) steering multiplier
            let turnX = constrain(offsetX / this._maxStretch, -1.0, 1.0);
            let turnY = constrain(offsetY / this._maxStretch, -1.0, 1.0);

            // A full pull provides ~1.2x the standard keyboard turning rate
            // Inverted: drag right (X+) -> turn right (yaw-), drag up (Y-) -> turn up (pitch+)
            inputs.yawDelta = -turnX * yawRate * 1.2;
            inputs.pitchDelta = -turnY * pitchRate * 1.2;
        }

        // Aim Assist (only activate strong assist if the user is scrubbing hard)
        if (aimAssist.enabled && ship && enemies) {
            let isSwipingHard = this.leftTouchId && (this.stationaryTicks === 0);
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
            let thrusting = (this.stationaryTicks > 5);

            // Anchor dot
            noStroke();
            fill(255, 255, 255, 100);
            circle(this.anchorX, this.anchorY, this._anchorDiam);

            // Connecting rubber band line
            stroke(255, 255, 255, 50);
            strokeWeight(2 * this._scale);
            line(this.anchorX, this.anchorY, this.lastX, this.lastY);

            // Max stretch limit ring
            noFill();
            stroke(255, 255, 255, 20);
            circle(this.anchorX, this.anchorY, this._maxStretch * 2);

            // Finger blob
            noStroke();
            if (thrusting) {
                fill(0, 255, 60, 200);
            } else {
                fill(255, 255, 255, 150);
            }
            circle(this.lastX, this.lastY, this._blobDiam);

            // Thrust trigger buildup
            if (!thrusting && this.stationaryTicks > 0) {
                noFill();
                strokeWeight(3 * this._scale);
                stroke(0, 255, 60, 150);
                let progress = Math.min(1, this.stationaryTicks / 6);
                let r = this._blobDiam + (1 - progress) * 40 * this._scale;
                circle(this.lastX, this.lastY, r);
            }
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
