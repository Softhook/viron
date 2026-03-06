/**
 * MobileController - Handles touch inputs and on-screen buttons.
 * 
 * "Trackpad Hybrid" Scheme:
 * Left Half (x < w/2):
 *   - Top-Left Quadrant (x < w/4, y < h/2): Shoot Area
 *   - Top-Right Quadrant (w/4 < x < w/2, y < h/2): Barrier Area
 *   - Bottom Half (y > h/2): Thrust Area
 * Right Half (x > w/2):
 *   - Trackpad Aiming: Swipe to aim (relative movement).
 *   - Missile Button: Floating button for secondary weapon.
 */
class MobileController {
    constructor() {
        this.aimTouchId = null;
        this.missileTouchId = null;
        this.aimAnchorX = 0;
        this.aimAnchorY = 0;
        this.lastAimX = 0;
        this.lastAimY = 0;

        // Current state for zones
        this.thrustActive = false;
        this.shootActive = false;
        this.barrierActive = false;

        // Frame-over-frame deltas for aiming
        this.deltaAimX = 0;
        this.deltaAimY = 0;

        this._scale = 1;
        this._w = 0;
        this._h = 0;

        this.btns = {
            missile: { active: false, baseR: 44, col: [0, 200, 255], label: 'Mis', x: 0, y: 0, r: 44 }
        };

        this.debug = false;
    }

    // -------------------------------------------------------------------------
    // Dimensions & UI Scaling
    // -------------------------------------------------------------------------

    update(touches, w, h) {
        // Cache scale on resize
        if (w !== this._w || h !== this._h) {
            this._w = w;
            this._h = h;
            this._scale = Math.min(w, h) / 400;
            const s = this._scale;
            this.btns.missile.r = this.btns.missile.baseR * s;
        }

        const s = this._scale;
        // Position missile button at the bottom center
        this.btns.missile.x = w / 2;
        this.btns.missile.y = h - 60 * s;

        // Reset states for this frame
        this.thrustActive = false;
        this.shootActive = false;
        this.barrierActive = false;
        for (let b in this.btns) this.btns[b].active = false;

        let aimFound = false;
        let missileFound = false;

        for (let i = 0; i < touches.length; i++) {
            let t = touches[i];

            // If this touch is already our missile touch, keep tracking it
            if (this.missileTouchId === t.id) {
                this.btns.missile.active = true;
                missileFound = true;
                continue; // Skip zone/aiming logic for this finger
            }

            // Check if a new touch hits the missile button
            let onMissile = false;
            // The distance check is multiplied by 1.7 to create a larger, more forgiving hit-box
            if (this.missileTouchId === null && Math.hypot(t.x - this.btns.missile.x, t.y - this.btns.missile.y) < this.btns.missile.r * 1.7) {
                this.missileTouchId = t.id;
                this.btns.missile.active = true;
                missileFound = true;
                onMissile = true;
            }

            if (!onMissile) {
                if (t.x > w / 2) {
                    // Right Half = Trackpad Aiming (Floating Joystick)
                    if (this.aimTouchId === t.id) {
                        this.lastAimX = t.x;
                        this.lastAimY = t.y;

                        // Prevent the anchor from getting dragged completely off-screen
                        // by pulling it if the user stretches too far.
                        let offsetX = t.x - this.aimAnchorX;
                        let offsetY = t.y - this.aimAnchorY;
                        let stretch = Math.hypot(offsetX, offsetY);
                        let maxStretch = 100 * this._scale;

                        if (stretch > maxStretch) {
                            let over = stretch - maxStretch;
                            this.aimAnchorX += (offsetX / stretch) * over;
                            this.aimAnchorY += (offsetY / stretch) * over;
                        }

                        aimFound = true;
                    } else if (this.aimTouchId === null) {
                        this.aimTouchId = t.id;
                        this.aimAnchorX = t.x;
                        this.aimAnchorY = t.y;
                        this.lastAimX = t.x;
                        this.lastAimY = t.y;
                        aimFound = true;
                    }
                } else {
                    // Left Half = Zones
                    if (t.y > h / 2) {
                        this.thrustActive = true;
                    } else {
                        if (t.x < w / 4) {
                            this.shootActive = true;
                        } else {
                            this.barrierActive = true;
                        }
                    }
                }
            }
        }

        if (!aimFound) {
            this.aimTouchId = null;
        }
        if (!missileFound) {
            this.missileTouchId = null;
        }
    }

    getInputs(ship, enemies, yawRate, pitchRate) {
        let inputs = {
            thrust: this.thrustActive,
            shoot: this.shootActive,
            missile: this.btns.missile.active,
            barrier: this.barrierActive,
            yawDelta: 0,
            pitchDelta: 0,
            assistYaw: 0,
            assistPitch: 0
        };

        if (this.aimTouchId !== null) {
            // Floating Joystick relative movement
            let offsetX = this.lastAimX - this.aimAnchorX;
            let offsetY = this.lastAimY - this.aimAnchorY;
            let maxStretch = 100 * this._scale;

            // Map the offset visually to a (-1 to 1) steering multiplier
            let turnX = constrain(offsetX / maxStretch, -1.0, 1.0);
            let turnY = constrain(offsetY / maxStretch, -1.0, 1.0);

            // Maintain continuous turning while held
            // Inverted: drag right (X+) -> turn right (yaw-), drag up (Y-) -> turn up (pitch+)
            inputs.yawDelta = -turnX * yawRate * 1.5;
            inputs.pitchDelta = -turnY * pitchRate * 1.5;
        }

        // Aim Assist (only activate strong assist if the user is steering)
        if (aimAssist.enabled && ship && enemies) {
            let isSteering = (this.aimTouchId !== null) && (Math.hypot(this.lastAimX - this.aimAnchorX, this.lastAimY - this.aimAnchorY) > 5 * this._scale);
            let assist = aimAssist.getAssistDeltas(ship, enemies, isSteering);
            inputs.assistYaw = assist.yawDelta;
            inputs.assistPitch = assist.pitchDelta;
        }

        return inputs;
    }

    draw(w, h) {
        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        translate(-w / 2, -h / 2, 0);

        // --- Visual hints for Left Zones ---
        noStroke();

        // Thrust Zone
        if (this.thrustActive) {
            fill(0, 255, 60, 40);
            rect(0, h / 2, w / 2, h / 2);
        }

        // Shoot Zone
        if (this.shootActive) {
            fill(255, 60, 60, 40);
            rect(0, 0, w / 4, h / 2);
        }

        // Barrier Zone
        if (this.barrierActive) {
            fill(100, 200, 255, 40);
            rect(w / 4, 0, w / 4, h / 2);
        }

        // Dividers
        stroke(255, 255, 255, 30);
        strokeWeight(2 * this._scale);
        // Vertical center (Left vs Right)
        line(w / 2, 0, w / 2, h);
        // Horizontal left (Top vs Bottom)
        line(0, h / 2, w / 2, h / 2);
        // Vertical left (Shoot vs Barrier)
        line(w / 4, 0, w / 4, h / 2);

        // Labels
        noStroke();
        fill(255, 255, 255, 80);
        textAlign(CENTER, CENTER);
        textSize(16 * Math.max(1, this._scale));
        text("SHOOT", (w / 4) / 2, h / 4);
        text("BARRIER", w / 4 + (w / 4) / 2, h / 4);
        text("THRUST", (w / 2) / 2, h * 0.75);

        fill(255, 255, 255, 40);
        text("AIM (SWIPE)", w * 0.75, h / 2);

        // Floating Trackpad Indicator if aiming
        if (this.aimTouchId !== null) {
            let maxStretch = 100 * this._scale;

            // Anchor dot
            noStroke();
            fill(255, 255, 255, 100);
            circle(this.aimAnchorX, this.aimAnchorY, 20 * this._scale);

            // Connecting line
            stroke(255, 255, 255, 50);
            strokeWeight(2 * this._scale);
            line(this.aimAnchorX, this.aimAnchorY, this.lastAimX, this.lastAimY);

            // Outer limits ring
            strokeWeight(3 * this._scale);
            stroke(255, 255, 255, 40);
            noFill();
            circle(this.aimAnchorX, this.aimAnchorY, maxStretch * 2);

            // Current finger position
            fill(255, 255, 255, 150);
            noStroke();
            circle(this.lastAimX, this.lastAimY, 60 * this._scale);
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

        // Navigation Mode Label
        resetMatrix();
        textAlign(CENTER, TOP);
        textSize(14 * Math.max(1, this._scale));
        fill(255, 255, 255, 120);
        noStroke();
        text("NAV: Trackpad Split", w / 2, 20 * Math.max(1, this._scale));

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
