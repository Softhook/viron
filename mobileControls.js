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
            cockpit: { x: 0, y: 0, w: 160, h: 50, label: 'COCKPIT VIEW' },
            continue: { x: 0, y: 0, w: 200, h: 60, label: 'CONTINUE' }
        };

        this.debug = false;
    }

    _resetFrameState() {
        this.thrustActive = false;
        this.shootActive = false;
        this.barrierActive = false;
        for (let b in this.btns) this.btns[b].active = false;
    }

    _isTouchOnMissileButton(touch) {
        return Math.hypot(touch.x - this.btns.missile.x, touch.y - this.btns.missile.y) < this.btns.missile.r * 1.7;
    }

    _trackExistingMissileTouch(touch) {
        if (this.missileTouchId !== touch.id) return false;
        this.btns.missile.active = true;
        this.hasUsed.missile = true;
        return true;
    }

    _captureNewMissileTouch(touch) {
        if (this.missileTouchId !== null || !this._isTouchOnMissileButton(touch)) return false;
        this.missileTouchId = touch.id;
        this.btns.missile.active = true;
        this.hasUsed.missile = true;
        return true;
    }

    _isAimZoneTouch(touch, w) {
        const onRight = touch.x > w / 2;
        return this.isSwapped ? !onRight : onRight;
    }

    _updateAimTouch(touch) {
        if (this.aimTouchId === touch.id) {
            this.lastAimX = touch.x;
            this.lastAimY = touch.y;

            // Keep the virtual joystick anchor from drifting too far from the finger.
            const offsetX = touch.x - this.aimAnchorX;
            const offsetY = touch.y - this.aimAnchorY;
            const stretch = Math.hypot(offsetX, offsetY);
            const maxStretch = 100 * this._scale;

            if (stretch > maxStretch) {
                const over = stretch - maxStretch;
                this.aimAnchorX += (offsetX / stretch) * over;
                this.aimAnchorY += (offsetY / stretch) * over;
            }

            this.hasUsed.aim = true;
            return true;
        }

        if (this.aimTouchId === null) {
            this.aimTouchId = touch.id;
            this.aimAnchorX = touch.x;
            this.aimAnchorY = touch.y;
            this.lastAimX = touch.x;
            this.lastAimY = touch.y;
            this.hasUsed.aim = true;
            return true;
        }

        return false;
    }

    _handleActionZoneTouch(touch, w, h) {
        if (touch.y > h / 2) {
            this.thrustActive = true;
            this.hasUsed.thrust = true;
            return;
        }

        const isShoot = this._isShootTouch(touch.x, w);
        const isBarrier = this._isBarrierTouch(touch.x, w);

        if (isShoot) {
            this.shootActive = true;
            this.hasUsed.shoot = true;
        } else if (isBarrier) {
            this.barrierActive = true;
            this.hasUsed.barrier = true;
        }
    }

    _isShootTouch(x, w) {
        if (!this.isSwapped) return x < w / 4;
        return x >= w * 0.75;
    }

    _isBarrierTouch(x, w) {
        if (!this.isSwapped) return x >= w / 4 && x < w / 2;
        return x >= w / 2 && x < w * 0.75;
    }

    _finalizeTrackedTouches(aimFound, missileFound) {
        if (!aimFound) this.aimTouchId = null;
        if (!missileFound) this.missileTouchId = null;
    }

    _buildInputs() {
        return {
            thrust: this.thrustActive,
            shoot: this.shootActive,
            missile: this.btns.missile.active,
            barrier: this.barrierActive,
            yawDelta: 0,
            pitchDelta: 0,
            assistYaw: 0,
            assistPitch: 0
        };
    }

    _applyAimDeltas(inputs, yawRate, pitchRate) {
        if (this.aimTouchId === null) return;

        const offsetX = this.lastAimX - this.aimAnchorX;
        const offsetY = this.lastAimY - this.aimAnchorY;
        const maxStretch = 100 * this._scale;

        // Map virtual joystick displacement to normalized steering.
        const turnX = constrain(offsetX / maxStretch, -1.0, 1.0);
        const turnY = constrain(offsetY / maxStretch, -1.0, 1.0);

        // Inverted: drag right turns right; drag up pitches up.
        // Original sensitivity (1.5) preserved for cockpit view as requested.
        // Third-person view uses increased sensitivity (2.2 yaw, 3.2 pitch) for easier handling.
        let yawMult = 2.2;
        let pitchMult = 3.2;

        if (typeof gameState !== 'undefined' && gameState.firstPersonView) {
            yawMult = 1.5;
            pitchMult = -1.5; // Inverted for flight-sim feel
        }

        inputs.yawDelta = -turnX * yawRate * yawMult;
        inputs.pitchDelta = -turnY * pitchRate * pitchMult;
    }

    _applyAimAssist(inputs, ship, enemies) {
        if (!aimAssist.enabled || !ship || !enemies) return;
        const steerMagnitude = Math.hypot(this.lastAimX - this.aimAnchorX, this.lastAimY - this.aimAnchorY);
        const isSteering = this.aimTouchId !== null && steerMagnitude > 5 * this._scale;
        const assist = aimAssist.getAssistDeltas(ship, enemies, isSteering);
        inputs.assistYaw = assist.yawDelta;
        inputs.assistPitch = assist.pitchDelta;
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
            
            // Large screen mobile (tablets): scale down the missile button to avoid it becoming massive
            let buttonScale = s;
            if (Math.min(w, h) > 500) {
                buttonScale *= 0.7;
            }
            this.btns.missile.r = this.btns.missile.baseR * buttonScale;
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

        // Position Continue button in center screen
        this.settingsBtns.continue.x = w / 2;
        this.settingsBtns.continue.y = h / 2;
        this.settingsBtns.continue.w = 200 * s;
        this.settingsBtns.continue.h = 60 * s;
    }

    update(touches, w, h) {
        this._updateLayout(w, h);
        this._resetFrameState();

        let aimFound = false;
        let missileFound = false;

        for (let i = 0; i < touches.length; i++) {
            const t = touches[i];

            if (this._trackExistingMissileTouch(t)) {
                missileFound = true;
                continue;
            }

            if (this._captureNewMissileTouch(t)) {
                missileFound = true;
                continue;
            }

            if (this._isAimZoneTouch(t, w)) {
                if (this._updateAimTouch(t)) aimFound = true;
            } else {
                this._handleActionZoneTouch(t, w, h);
            }
        }

        this._finalizeTrackedTouches(aimFound, missileFound);
    }

    getInputs(ship, enemies, yawRate, pitchRate) {
        const inputs = this._buildInputs();
        this._applyAimDeltas(inputs, yawRate, pitchRate);
        this._applyAimAssist(inputs, ship, enemies);

        return inputs;
    }

    draw(w, h, forceInstructions = false) {
        // Update layout parameters (scaling, button positions) without touching input state
        this._updateLayout(w, h);

        if (typeof setup2DViewport === 'function') setup2DViewport();
        push();
        let gl = drawingContext;
        gl.disable(gl.DEPTH_TEST);
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
                
                // Colors based on button type
                let baseCol = k === 'switchSides' ? [0, 220, 255] : [0, 255, 136];
                
                // 3D Shadow/Depth effect
                fill(0, 0, 0, 150);
                rect(btn.x + 4 * this._scale, btn.y + 4 * this._scale, btn.w, btn.h, 8);
                
                // Main button body
                fill(baseCol[0] * 0.4, baseCol[1] * 0.4, baseCol[2] * 0.4, 250);
                stroke(baseCol[0], baseCol[1], baseCol[2], 255);
                strokeWeight(2 * this._scale);
                rect(btn.x, btn.y, btn.w, btn.h, 8);

                // Text Label - Use bright white for visibility
                noStroke();
                fill(255);
                textSize(12 * this._scale);
                let label = btn.label;
                if (k === 'cockpit') label += (typeof gameState !== 'undefined' && gameState.firstPersonView ? ": ON" : ": OFF");
                text(label, btn.x, btn.y);
            }

            // --- Draw joystick preview on Instruction screen ---
            let aimZoneX = aimX + w / 4;
            let aimZoneY = h / 2;
            let maxStretch = 100 * this._scale;

            // Anchor dot
            noStroke();
            fill(255, 255, 255, 100);
            circle(aimZoneX, aimZoneY, 20 * this._scale);

            // Outer limits ring
            strokeWeight(3 * this._scale);
            stroke(255, 255, 255, 40);
            noFill();
            circle(aimZoneX, aimZoneY, maxStretch * 2);

            // Represent typical thumb position
            let previewOffX = 40 * this._scale;
            let previewOffY = -30 * this._scale;
            
            // Connecting line
            stroke(255, 255, 255, 50);
            strokeWeight(2 * this._scale);
            line(aimZoneX, aimZoneY, aimZoneX + previewOffX, aimZoneY + previewOffY);

            fill(255, 255, 255, 150);
            noStroke();
            circle(aimZoneX + previewOffX, aimZoneY + previewOffY, 60 * this._scale);

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

        gl.enable(gl.DEPTH_TEST);
        pop();
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
                    if (typeof gameState !== 'undefined') {
                        gameState.firstPersonView = !gameState.firstPersonView;
                    }
                } else if (k === 'continue') {
                    return 'continue';
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

    // Detect if we are on a mobile device (including iPad Pro)
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isIPadPro = (ua.includes('Mac') && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isMobile = isIOS || isIPadPro || isAndroid;

    // Check if we are in standalone (PWA) mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    // If we are on mobile (phone/tablet) and already in standalone mode, 
    // we usually DON'T want to request "real" fullscreen as it's redundant 
    // or can cause browser UI glitches.
    if (isStandalone && isMobile) return false;

    // On Desktop (macOS/Windows/Linux), even in standalone mode, we often 
    // want to trigger "real" fullscreen to hide the OS title bar/toolbar.
    // Also, don't request fullscreen on iPad/iPhone anyway as it can be flaky.
    if (isIOS || isIPadPro) return false;

    return true;
}

function handleTouchStarted(event) {
    if (event && event.target && event.target.tagName !== 'CANVAS') return true;

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
