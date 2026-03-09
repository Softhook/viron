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

        this.hasUsed = {
            thrust: false,
            shoot: false,
            barrier: false,
            aim: false,
            missile: false
        };

        // Frame-over-frame deltas for aiming
        this.deltaAimX = 0;
        this.deltaAimY = 0;

        this._scale = 1;
        this._w = 0;
        this._h = 0;

        this.btns = {
            missile: { active: false, baseR: 44, col: [0, 200, 255], label: 'Mis', x: 0, y: 0, r: 44 }
        };

        this.isSwapped = false; // Aim on Left, Actions on Right
        this.settingsBtns = {
            switchSides: { x: 0, y: 0, w: 160, h: 50, label: 'SWITCH SIDES' },
            cockpit: { x: 0, y: 0, w: 160, h: 50, label: 'COCKPIT VIEW' }
        };

        this.debug = false;
    }

    // -------------------------------------------------------------------------
    // Dimensions & UI Scaling
    // -------------------------------------------------------------------------

    /**
     * Internal layout helper to update styling/button positions without resetting touch state.
     */
    _updateLayout(w, h) {
        if (w !== this._w || h !== this._h) {
            this._w = w;
            this._h = h;
            this._scale = Math.max(0.5, Math.min(w, h) / 400);
            const s = this._scale;
            this.btns.missile.r = this.btns.missile.baseR * s;
        }

        const s = this._scale;
        // Position missile button at the bottom center
        this.btns.missile.x = w / 2;
        this.btns.missile.y = h - 60 * s;

        // Position settings buttons for Instruction screen (Slightly higher to clear title)
        this.settingsBtns.switchSides.x = w / 2 - 90 * s;
        this.settingsBtns.switchSides.y = h * 0.15; // Raised from 0.2
        this.settingsBtns.switchSides.w = 160 * s;
        this.settingsBtns.switchSides.h = 44 * s;

        this.settingsBtns.cockpit.x = w / 2 + 90 * s;
        this.settingsBtns.cockpit.y = h * 0.15; // Raised from 0.2
        this.settingsBtns.cockpit.w = 160 * s;
        this.settingsBtns.cockpit.h = 44 * s;
    }

    update(touches, w, h) {
        this._updateLayout(w, h);

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
                this.hasUsed.missile = true;
                missileFound = true;
                continue; // Skip zone/aiming logic for this finger
            }

            // Check if a new touch hits the missile button
            let onMissile = false;
            // The distance check is multiplied by 1.7 to create a larger, more forgiving hit-box
            if (this.missileTouchId === null && Math.hypot(t.x - this.btns.missile.x, t.y - this.btns.missile.y) < this.btns.missile.r * 1.7) {
                this.missileTouchId = t.id;
                this.btns.missile.active = true;
                this.hasUsed.missile = true;
                missileFound = true;
                onMissile = true;
            }

            if (!onMissile) {
                let onRight = t.x > w / 2;
                let isAimZone = this.isSwapped ? !onRight : onRight;

                if (isAimZone) {
                    // Aiming half (Relative Trackpad / Floating Joystick)
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

                        this.hasUsed.aim = true;
                        aimFound = true;
                    } else if (this.aimTouchId === null) {
                        this.aimTouchId = t.id;
                        this.aimAnchorX = t.x;
                        this.aimAnchorY = t.y;
                        this.lastAimX = t.x;
                        this.lastAimY = t.y;
                        this.hasUsed.aim = true;
                        aimFound = true;
                    }
                } else {
                    // Action half (Thrust / Shoot / Barrier)
                    if (t.y > h / 2) {
                        this.thrustActive = true;
                        this.hasUsed.thrust = true;
                    } else {
                        // Horizontal logic for Shoot/Barrier depends on swap
                        let isShoot, isBarrier;
                        if (!this.isSwapped) {
                            isShoot = t.x < w / 4;
                            isBarrier = t.x >= w / 4 && t.x < w / 2;
                        } else {
                            // Swapped: Right side zones. Fire in corner, Barrier left of it.
                            isShoot = t.x >= w * 0.75;
                            isBarrier = t.x >= w / 2 && t.x < w * 0.75;
                        }

                        if (isShoot) {
                            this.shootActive = true;
                            this.hasUsed.shoot = true;
                        } else if (isBarrier) {
                            this.barrierActive = true;
                            this.hasUsed.barrier = true;
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

    draw(w, h, forceInstructions = false) {
        // Update layout parameters (scaling, button positions) without touching input state
        this._updateLayout(w, h);

        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        translate(-w / 2, -h / 2, 0);

        let showThrust = forceInstructions;
        let showShoot = forceInstructions;
        let showBarrier = forceInstructions;
        let showAim = forceInstructions;

        let leftX = this.isSwapped ? w / 2 : 0;
        let aimX = this.isSwapped ? 0 : w / 2;

        // --- Visual hints for Action Zones ---
        noStroke();

        // Thrust Zone
        if (showThrust) {
            let alpha = forceInstructions ? (this.thrustActive ? 60 : 40) : 15;
            fill(0, 255, 60, alpha);
            rect(leftX, h / 2, w / 2, h / 2);
        }

        // Shoot Zone
        if (showShoot) {
            let active = this.shootActive;
            let alpha = forceInstructions ? (active ? 60 : 40) : 15;
            fill(255, 60, 60, alpha);
            let sx = (!this.isSwapped) ? leftX : leftX + w / 4;
            rect(sx, 0, w / 4, h / 2);
        }

        // Barrier Zone
        if (showBarrier) {
            let active = this.barrierActive;
            let alpha = forceInstructions ? (active ? 60 : 40) : 15;
            fill(100, 200, 255, alpha);
            let bx = (!this.isSwapped) ? leftX + w / 4 : leftX;
            rect(bx, 0, w / 4, h / 2);
        }

        // Aim Zone background hint
        if (showAim) {
            fill(255, 255, 255, forceInstructions ? 20 : 8);
            rect(aimX, 0, w / 2, h);
        }

        // Dividers
        stroke(255, 255, 255, forceInstructions ? 60 : 25);
        strokeWeight(2 * this._scale);
        // Vertical center (Left vs Right)
        if (showThrust || showAim) line(w / 2, 0, w / 2, h);
        // Horizontal action line (Top vs Bottom)
        if (showThrust || showShoot || showBarrier) line(leftX, h / 2, leftX + w / 2, h / 2);
        // Vertical action split (Shoot vs Barrier)
        if (showShoot || showBarrier) line(leftX + w / 4, 0, leftX + w / 4, h / 2);

        // Labels - Only drawn during Instruction screen
        if (forceInstructions) {
            noStroke();
            textAlign(CENTER, CENTER);
            textSize(16 * Math.max(1, this._scale));
            fill(255, 255, 255, 200);
            let shootLabelX = (!this.isSwapped) ? leftX + w / 8 : leftX + 3 * w / 8;
            let barrierLabelX = (!this.isSwapped) ? leftX + 3 * w / 8 : leftX + w / 8;

            text("SHOOT", shootLabelX, h * 0.28);
            text("BARRIER", barrierLabelX, h * 0.28);
            text("THRUST", leftX + w / 4, h * 0.68);
            text("AIM (SWIPE)", aimX + w / 4, h * 0.22);

            // --- Settings Buttons (Only on Instructions) ---
            rectMode(CENTER);
            for (let k in this.settingsBtns) {
                let btn = this.settingsBtns[k];
                fill(255, 255, 255, 40);
                stroke(255, 255, 255, 100);
                rect(btn.x, btn.y, btn.w, btn.h, 8);

                noStroke();
                fill(255);
                textSize(12 * this._scale);
                let label = btn.label;
                if (k === 'cockpit') label += (typeof firstPersonView !== 'undefined' && firstPersonView ? ": ON" : ": OFF");
                text(label, btn.x, btn.y);
            }
            rectMode(CORNER);
        }

        // Floating Trackpad Indicator if aiming (only during actual gameplay)
        if (!forceInstructions && this.aimTouchId !== null) {
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

            if (forceInstructions) {
                // Dimmer, non-interactive rendering for instructions screen
                stroke(btn.col[0], btn.col[1], btn.col[2], 80);
                strokeWeight(2 * this._scale);
                fill(btn.col[0], btn.col[1], btn.col[2], 20);
                circle(btn.x, btn.y, btn.r * 2);
                noStroke();
                fill(255, 150);
                textAlign(CENTER, CENTER);
                textSize(Math.max(10, btn.r * 0.4));
                text(btn.label, btn.x, btn.y);
            } else {
                // Actual gameplay rendering
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
        }

        pop();
    }
    /**
     * Checks if a point (mouse/touch) hits any settings buttons on the Instructions screen.
     * Returns true if a button was hit (to prevent advancing the game state).
     */
    checkSettingsHit(mx, my) {
        for (let k in this.settingsBtns) {
            let btn = this.settingsBtns[k];
            if (mx > btn.x - btn.w / 2 && mx < btn.x + btn.w / 2 &&
                my > btn.y - btn.h / 2 && my < btn.y + btn.h / 2) {

                if (k === 'switchSides') {
                    this.isSwapped = !this.isSwapped;
                } else if (k === 'cockpit') {
                    if (typeof firstPersonView !== 'undefined') {
                        firstPersonView = !firstPersonView;
                    }
                }
                return true;
            }
        }
        return false;
    }
}

const mobileController = new MobileController();

function shouldRequestFullscreen() {
    if (typeof fullscreen !== 'function' || fullscreen()) return false;

    // Skip if already in standalone mode (PWA / "Add to Home Screen" app)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) return false;

    // Check device type
    const ua = navigator.userAgent;
    const isIPad = (ua.includes('Mac') && navigator.maxTouchPoints > 1) || ua.includes('iPad');

    // We want fullscreen on Desktop and Android, but NOT iPad
    if (isIPad) return false;

    return true;
}

function handleTouchStarted() {
    // Request fullscreen immediately on first interaction from Title screen
    if (gameState.mode === 'menu' || gameState.mode === 'instructions') {
        if (shouldRequestFullscreen()) {
            fullscreen(true);
        }
    }

    if (gameState.mode === 'menu') {
        setTimeout(() => { if (typeof startGame === 'function') startGame(1); }, 50);
    }
    return false;
}
