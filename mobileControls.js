/**
 * MobileController - Handles touch inputs and on-screen buttons.
 *
 * Aim-assist logic has been moved to aimAssist.js (AimAssist class) so it can
 * be used for all input modes (mobile, desktop mouse, desktop keyboard).
 * MobileController delegates to the aimAssist singleton for assist deltas and
 * for debug-overlay data.
 *
 * All pixel distances are expressed as a fraction of the screen's short edge
 * (min(w, h)) so that the controls feel identical in physical finger-distance
 * on both phones (~375 px short edge) and iPads (~768 px short edge).
 *
 * Baseline short-edge for the design: 400 px (just under iPhone width).
 * scale = min(w, h) / 400
 * All button radii, joystick thresholds, and positions are multiplied by scale.
 */
class MobileController {
    constructor() {
        this.leftTouchId = null;
        this.joyCenter = null;
        this.joyPos = null;
        this._scale = 1;
        this._w = 0;
        this._h = 0;

        // Button definitions — radii are BASE values at scale = 1 (phone baseline).
        this.btns = {
            shoot: { active: false, baseR: 65, col: [255, 60, 60], label: 'SHT', x: 0, y: 0, r: 65 },
            missile: { active: false, baseR: 44, col: [0, 200, 255], label: 'WPN', x: 0, y: 0, r: 44 }
        };

        this.debug = false; // Controls the 2D debug overlay and syncs aimAssist.enabled
    }

    // -------------------------------------------------------------------------
    // Scale helpers — physical-pixel baseline constants
    // -------------------------------------------------------------------------

    /** Thrust activation radius in scaled pixels. */
    get _thrustRadius() { return 60 * this._scale; }
    /** Max rubber-band stretch before anchor slides. */
    get _maxStretch() { return 100 * this._scale; }
    /** Visual indicator ring diameter. */
    get _ringDiam() { return 120 * this._scale; }
    /** Finger-blob diameter. */
    get _blobDiam() { return 60 * this._scale; }
    /** Anchor dot diameter. */
    get _anchorDiam() { return 20 * this._scale; }

    // -------------------------------------------------------------------------
    // update — called every frame before getInputs / draw
    // -------------------------------------------------------------------------

    update(touches, w, h) {
        // Only re-calculate scale if the screen dimensions change (e.g. orientation swap)
        if (w !== this._w || h !== this._h) {
            this._w = w;
            this._h = h;
            this._scale = Math.min(w, h) / 400;
            const s = this._scale;

            // Updated scaled radii for buttons — do this once per resize
            this.btns.shoot.r = this.btns.shoot.baseR * s;
            this.btns.missile.r = this.btns.missile.baseR * s;
        }

        const s = this._scale;

        // Button positions must still be updated per frame relative to current w/h
        this.btns.shoot.x = w - 105 * s; this.btns.shoot.y = h - 100 * s;
        this.btns.missile.x = w - 105 * s; this.btns.missile.y = h - 240 * s;

        for (let b in this.btns) this.btns[b].active = false;

        let leftFound = false;
        for (let i = 0; i < touches.length; i++) {
            let t = touches[i];
            if (t.x > w / 2) {
                // Right half — check action buttons
                for (let b in this.btns) {
                    if (Math.hypot(t.x - this.btns[b].x, t.y - this.btns[b].y) < this.btns[b].r * 1.7) {
                        this.btns[b].active = true;
                    }
                }
            } else {
                // Left half — rubber-band joystick
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
        } else if (this.joyCenter && this.joyPos) {
            // Rubber band: slide anchor if finger stretches past maxStretch.
            let dx = this.joyPos.x - this.joyCenter.x;
            let dy = this.joyPos.y - this.joyCenter.y;
            let d = Math.hypot(dx, dy);
            if (d > this._maxStretch) {
                let angle = Math.atan2(dy, dx);
                this.joyCenter.x = this.joyPos.x - Math.cos(angle) * this._maxStretch;
                this.joyCenter.y = this.joyPos.y - Math.sin(angle) * this._maxStretch;
            }
        }
    }

    // -------------------------------------------------------------------------
    // getInputs — returns the current control state for this frame
    // -------------------------------------------------------------------------

    getInputs(ship, enemies, yawRate, pitchRate) {
        let inputs = {
            thrust: this.btns.shoot.active && false, // shoot never drives thrust
            shoot: this.btns.shoot.active,
            cycleWeapon: this.btns.missile.active,
            yawDelta: 0,
            pitchDelta: 0,
            assistYaw: 0,
            assistPitch: 0
        };

        // Start with no thrust; rubber-band drag will enable it if stretched far enough.
        inputs.thrust = false;

        let isSwipingHard = false;

        if (this.joyCenter && this.joyPos) {
            let dx = this.joyPos.x - this.joyCenter.x;
            let dy = this.joyPos.y - this.joyCenter.y;
            let distSq = dx * dx + dy * dy;

            if (distSq > 25) {
                let d = Math.sqrt(distSq);
                let speedFactor = Math.min(1, (d - 5) / 50);
                inputs.yawDelta = -(dx / d) * yawRate * speedFactor;
                inputs.pitchDelta = -(dy / d) * pitchRate * speedFactor * 1.5;
                if (distSq > 4000) isSwipingHard = true;

                // Engage thrust once the rubber band is stretched beyond the threshold ring.
                if (d > this._thrustRadius) inputs.thrust = true;
            }
        }

        // Compute soft lock-on aim assist via the shared aimAssist singleton
        if (aimAssist.enabled && ship && enemies) {
            let assist = aimAssist.getAssistDeltas(ship, enemies, isSwipingHard);
            inputs.assistYaw = assist.yawDelta;
            inputs.assistPitch = assist.pitchDelta;
        }

        return inputs;
    }

    // -------------------------------------------------------------------------
    // draw — on-screen UI rendered after the 3D scene each frame
    // -------------------------------------------------------------------------

    draw(w, h) {
        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        translate(-w / 2, -h / 2, 0);

        // --- Rubber-band joystick ---
        if (this.joyCenter && this.joyPos) {
            let dx = this.joyPos.x - this.joyCenter.x;
            let dy = this.joyPos.y - this.joyCenter.y;
            let d = Math.hypot(dx, dy);
            let thrusting = d > this._thrustRadius;

            // Rubber band line
            stroke(255, 255, 255, thrusting ? 160 : 100);
            strokeWeight(4 * this._scale);
            line(this.joyCenter.x, this.joyCenter.y, this.joyPos.x, this.joyPos.y);

            // Anchor dot
            noStroke();
            fill(255, 255, 255, 80);
            circle(this.joyCenter.x, this.joyCenter.y, this._anchorDiam);

            // Thrust threshold ring
            stroke(255, 255, 255, 30);
            strokeWeight(2 * this._scale);
            noFill();
            circle(this.joyCenter.x, this.joyCenter.y, this._ringDiam);

            // Finger blob — green when thrusting
            noStroke();
            if (thrusting) {
                fill(0, 255, 60, 220);
            } else {
                fill(255, 255, 255, 180);
            }
            circle(this.joyPos.x, this.joyPos.y, this._blobDiam);
        }

        // --- Action buttons ---
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

        // --- 2D Debug Overlay ---
        if (this.debug) {
            let tr = aimAssist.lastTracking;
            resetMatrix();
            textAlign(LEFT, TOP); textSize(16); noStroke(); fill(0, 255, 0);
            let info = [
                `DEBUG MODE (P to toggle)`,
                `Aim Assist: ${aimAssist.enabled ? "ON" : "OFF"}`,
                `Target: ${tr.target ? "ENEMY LOCKED" : (tr.virusTarget ? "VIRUS LOCKED" : "NONE")}`,
                `Dot Product: ${tr.dot.toFixed(3)}`,
                `Yaw Delta: ${tr.yawDelta.toFixed(4)}`,
                `Pitch Delta: ${tr.pitchDelta.toFixed(4)}`,
                `Hard Swipe: ${tr.isSwipingHard}`,
                `Scale: ${this._scale.toFixed(2)}`
            ];
            for (let i = 0; i < info.length; i++) text(info[i], 20, 20 + i * 22);
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
