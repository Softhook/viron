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
 *
 * @exports   MobileController  — class definition
 * @exports   mobileController  — singleton
 * @exports   handleTouchStarted() — called by sketch.js touchStarted()
 */
import { p } from './p5Context.js';
import { gameState } from './gameState.js';
import { aimAssist } from './aimAssist.js';
import { SHIP_DESIGNS } from './shipDesigns.js';

function _setupMobileOverlay2D() {
    const pxD = p.pixelDensity();
    p.drawingContext.viewport(0, 0, p.width * pxD, p.height * pxD);
    p.push();
    p.ortho(-p.width / 2, p.width / 2, -p.height / 2, p.height / 2, 0, 1000);
    p.resetMatrix();
}

export class MobileController {
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
            switchSides: { x: 0, y: 0, w: 180, h: 50, label: 'SWITCH CONTROLS' },
            cockpit: { x: 0, y: 0, w: 200, h: 50, label: 'COCKPIT VIEW' },
            continue: { x: 0, y: 0, w: 200, h: 60, label: 'CONTINUE' }
        };

        this.debug = false;
        
        // Preview state for Instructions screen
        this.previewYaw = 0;
        this.previewPitch = 0;
        this.previewTouchId = null;
        this.lastPreviewX = 0;
        this.lastPreviewY = 0;
        this.previewBullets = [];
        this.previewFired = 0;
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
        const turnX = p.constrain(offsetX / maxStretch, -1.0, 1.0);
        const turnY = p.constrain(offsetY / maxStretch, -1.0, 1.0);

        // Inverted: drag right turns right; drag up pitches up.
        // Original sensitivity (1.5) preserved for cockpit view as requested.
        // Third-person view uses increased sensitivity (2.2 yaw, 3.2 pitch) for easier handling.
        let yawMult = 2.2;
        let pitchMult = 3.2;

        if (gameState?.firstPersonView) {
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

    /**
     * Draws the static joystick base: the anchor dot and the outer limits ring.
     * Call this before drawing the live thumb indicator on top.
     * @param {number} cx - Centre X of the joystick in screen space.
     * @param {number} cy - Centre Y of the joystick in screen space.
     */
    _drawJoystickBase(cx, cy) {
        const maxStretch = 100 * this._scale;
        p.noStroke();
        p.fill(255, 255, 255, 100);
        p.circle(cx, cy, 20 * this._scale);
        p.strokeWeight(3 * this._scale);
        p.stroke(255, 255, 255, 40);
        p.noFill();
        p.circle(cx, cy, maxStretch * 2);
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

        // Position settings buttons
        if (gameState.mode === 'instructions') {
            // Instructions Screen: Center Switch Sides button
            this.settingsBtns.switchSides.x = w / 2;
            this.settingsBtns.switchSides.y = h * 0.15;
            this.settingsBtns.switchSides.w = 180 * s;
            this.settingsBtns.switchSides.h = 44 * s;

            this.settingsBtns.continue.x = w / 2;
            this.settingsBtns.continue.y = h / 2;
            this.settingsBtns.continue.w = 200 * s;
            this.settingsBtns.continue.h = 60 * s;
        } else if (gameState.mode === 'cockpitSelection') {
            // Cockpit Selection Screen: Toggle button slightly above center preview
            this.settingsBtns.cockpit.x = w / 2;
            this.settingsBtns.cockpit.y = h * 0.15;
            this.settingsBtns.cockpit.w = 200 * s;
            this.settingsBtns.cockpit.h = 44 * s;

            // Continue button at the bottom
            this.settingsBtns.continue.x = w / 2;
            this.settingsBtns.continue.y = h * 0.85;
            this.settingsBtns.continue.w = 200 * s;
            this.settingsBtns.continue.h = 60 * s;
        }
    }

    update(touches, w, h) {
        this._updateLayout(w, h);
        this._resetFrameState();

        let aimFound = false;
        let missileFound = false;
        let previewFound = false;

        for (let i = 0; i < touches.length; i++) {
            const t = touches[i];

            if (gameState.mode !== 'cockpitSelection') {
                if (this._trackExistingMissileTouch(t)) {
                    missileFound = true;
                    continue;
                }

                if (this._captureNewMissileTouch(t)) {
                    missileFound = true;
                    continue;
                }
            }

            // Aim Zone check
            if (this._isAimZoneTouch(t, w)) {
                if (this._updateAimTouch(t)) aimFound = true;
                continue;
            } 

            // Preview Zone Check (Center screen for instructions/cockpit)
            if (gameState.mode === 'instructions' || gameState.mode === 'cockpitSelection') {
                const btn = this.settingsBtns.continue;
                const isContBtn = t.x > btn.x - btn.w/2 && t.x < btn.x + btn.w/2 &&
                                  t.y > btn.y - btn.h/2 && t.y < btn.y + btn.h/2;
                
                // Allow interaction with ship preview if in cockpitSelection and FIRST PERSON is OFF
                const isCockpitPreview = gameState.mode === 'cockpitSelection' && !gameState.firstPersonView;
                const isInstructionPreview = gameState.mode === 'instructions' && false; // Disabled ship in instructions per requirement

                if (!isContBtn && (isCockpitPreview || isInstructionPreview)) {
                    if (this.previewTouchId === t.id) {
                        let dx = t.x - this.lastPreviewX;
                        let dy = t.y - this.lastPreviewY;
                        this.previewYaw -= dx * 0.01;
                        this.previewPitch += dy * 0.01;
                        this.lastPreviewX = t.x;
                        this.lastPreviewY = t.y;
                        previewFound = true;
                        continue;
                    } else if (this.previewTouchId === null) {
                        this.previewTouchId = t.id;
                        this.lastPreviewX = t.x;
                        this.lastPreviewY = t.y;
                        previewFound = true;
                        continue;
                    }
                }
            }

            // Action Zones (Only during gameplay or instructions)
            if (gameState.mode !== 'cockpitSelection') {
                this._handleActionZoneTouch(t, w, h);
            }
        }

        this._finalizeTrackedTouches(aimFound, missileFound);
        if (!previewFound) this.previewTouchId = null;

        // Update preview bullets
        for (let i = this.previewBullets.length - 1; i >= 0; i--) {
            let b = this.previewBullets[i];
            b.x += b.vx; b.y += b.vy; b.z += b.vz;
            b.life--;
            if (b.life <= 0) this.previewBullets.splice(i, 1);
        }

        if (gameState.mode === 'instructions') {
            if ((this.shootActive || this.barrierActive) && p.frameCount > this.previewFired + 8) {
                this.previewFired = p.frameCount;
                this._spawnPreviewBullet(this.barrierActive);
            }
        }
    }

    _spawnPreviewBullet(isBarrier) {
        let cp = Math.cos(this.previewPitch), sp = Math.sin(this.previewPitch);
        let cy = Math.cos(this.previewYaw), sy = Math.sin(this.previewYaw);
        let speed = 5;
        this.previewBullets.push({
            x: 0, y: 0, z: 0,
            vx: -cp * sy * speed,
            vy: sp * speed,
            vz: -cp * cy * speed,
            life: 60,
            isBarrier: isBarrier
        });
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

        _setupMobileOverlay2D();
        let gl = p.drawingContext;
        gl.disable(gl.DEPTH_TEST);
        p.translate(-w / 2, -h / 2, 0);

        const isInstructions = gameState.mode === 'instructions';
        const isCockpitSelection = gameState.mode === 'cockpitSelection';

        let showThrust = forceInstructions || isInstructions;
        let showShoot = forceInstructions || isInstructions;
        let showBarrier = forceInstructions || isInstructions;
        let showAim = forceInstructions || isInstructions;

        let leftX = this.isSwapped ? w / 2 : 0;
        let aimX = this.isSwapped ? 0 : w / 2;

        // --- Visual hints for Action Zones ---
        p.noStroke();

        if (isInstructions) {
            // Thrust Zone
            if (showThrust) {
                let active = this.thrustActive;
                let alpha = (active ? 60 : 40);
                p.fill(0, 255, 60, alpha);
                p.rect(leftX, h / 2, w / 2, h / 2);
            }

            // Shoot Zone
            if (showShoot) {
                let active = this.shootActive;
                let alpha = (active ? 60 : 40);
                p.fill(255, 60, 60, alpha);
                let sx = (!this.isSwapped) ? leftX : leftX + w / 4;
                p.rect(sx, 0, w / 4, h / 2);
            }

            // Barrier Zone
            if (showBarrier) {
                let active = this.barrierActive;
                let alpha = (active ? 60 : 40);
                p.fill(100, 200, 255, alpha);
                let bx = (!this.isSwapped) ? leftX + w / 4 : leftX;
                p.rect(bx, 0, w / 4, h / 2);
            }

            // Aim Zone background hint
            if (showAim) {
                p.fill(255, 255, 255, 20);
                p.rect(aimX, 0, w / 2, h);
            }

            // Dividers
            p.stroke(255, 255, 255, 60);
            p.strokeWeight(2 * this._scale);
            // Vertical center (Left vs Right)
            p.line(w / 2, 0, w / 2, h);
            // Horizontal action p.line (Top vs Bottom)
            p.line(leftX, h / 2, leftX + w / 2, h / 2);
            // Vertical action split (Shoot vs Barrier)
            p.line(leftX + w / 4, 0, leftX + w / 4, h / 2);

            // Labels
            p.noStroke();
            p.textAlign(p.CENTER, p.CENTER);
            p.textSize(16 * Math.max(1, this._scale));
            p.fill(255, 255, 255, 200);
            let shootLabelX = (!this.isSwapped) ? leftX + w / 8 : leftX + 3 * w / 8;
            let barrierLabelX = (!this.isSwapped) ? leftX + 3 * w / 8 : leftX + w / 8;

            p.text("SHOOT", shootLabelX, h * 0.28);
            p.text("BARRIER", barrierLabelX, h * 0.28);
            p.text("THRUST", leftX + w / 4, h * 0.68);
            p.text("AIM (JOYSTICK)", aimX + w / 4, h / 2 + 130 * this._scale);
        }

        // --- Settings Buttons ---
        if (isInstructions || (isCockpitSelection && gameState.isMobile)) {
            p.rectMode(p.CENTER);
            for (let k in this.settingsBtns) {
                // Filter buttons based on screen
                if (isInstructions && k === 'cockpit') continue;
                if (isCockpitSelection && k === 'switchSides') continue;

                let btn = this.settingsBtns[k];

                // Colors based on button type
                let baseCol = k === 'switchSides' ? [0, 220, 255] : [0, 255, 136];

                // 3D Shadow/Depth effect
                p.fill(0, 0, 0, 150);
                p.rect(btn.x + 4 * this._scale, btn.y + 4 * this._scale, btn.w, btn.h, 8);

                // Main button body
                p.fill(baseCol[0] * 0.4, baseCol[1] * 0.4, baseCol[2] * 0.4, 250);
                p.stroke(baseCol[0], baseCol[1], baseCol[2], 255);
                p.strokeWeight(2 * this._scale);
                p.rect(btn.x, btn.y, btn.w, btn.h, 8);

                // Text Label
                p.noStroke();
                p.fill(255);
                p.textSize(12 * this._scale);
                let label = btn.label;
                if (k === 'cockpit') {
                    label = "VIEW: " + (gameState.firstPersonView ? "COCKPIT" : "BEHIND CRAFT");
                }
                p.text(label, btn.x, btn.y);
            }
        }

        // Joystick preview (Only on Instructions)
        if (isInstructions) {
            let aimZoneX = aimX + w / 4;
            let aimZoneY = h / 2;

            this._drawJoystickBase(aimZoneX, aimZoneY);

            // If user is actively touching the joystick area in instructions, show live joystick
            if (this.aimTouchId !== null && this._isAimZoneTouch({x: this.lastAimX, y: this.lastAimY}, w)) {
                // Tracking p.line
                p.stroke(255, 255, 255, 80);
                p.strokeWeight(2 * this._scale);
                p.line(aimZoneX, aimZoneY, aimZoneX + (this.lastAimX - this.aimAnchorX), aimZoneY + (this.lastAimY - this.aimAnchorY));
                
                p.fill(255, 255, 255, 200);
                p.noStroke();
                p.circle(aimZoneX + (this.lastAimX - this.aimAnchorX), aimZoneY + (this.lastAimY - this.aimAnchorY), 60 * this._scale);
            } else {
                // Represent typical thumb position preview
                let previewOffX = 40 * this._scale * Math.sin(p.frameCount * 0.03);
                let previewOffY = -30 * this._scale * Math.cos(p.frameCount * 0.04);
                p.stroke(255, 255, 255, 50);
                p.strokeWeight(2 * this._scale);
                p.line(aimZoneX, aimZoneY, aimZoneX + previewOffX, aimZoneY + previewOffY);
                p.fill(255, 255, 255, 150);
                p.noStroke();
                p.circle(aimZoneX + previewOffX, aimZoneY + previewOffY, 60 * this._scale);
            }
        }

        // --- Render Live Preview (Only on Cockpit Selection) ---
        if (isCockpitSelection) {
            p.push();
            p.resetMatrix();
            if (gameState.firstPersonView) {
                // DRAW CROSSHAIRS (Center of screen 2D)
                gl.disable(gl.DEPTH_TEST);
                p.stroke(0, 255, 136, 180);
                p.strokeWeight(2);
                p.line(0, -20 * this._scale, 0, 20 * this._scale);
                p.line(-20 * this._scale, 0, 20 * this._scale, 0);
                p.noFill();
                p.circle(0, 0, 40 * this._scale);
            } else {
                // DRAW SHIP
                gl.enable(gl.DEPTH_TEST);
                gl.clear(gl.DEPTH_BUFFER_BIT);
                
                // Re-setup 3D for the preview
                p.perspective(p.PI/3, w/h, 1, 1000);
                p.camera(0, -10, 80, 0, 0, 0, 0, 1, 0);
                
                // Lighting
                p.ambientLight(100);
                p.directionalLight(255, 255, 255, 0.5, 1, -0.5);
                
                p.translate(0, 0, 0); 
                
                p.push();
                p.rotateY(this.previewYaw + p.frameCount * 0.005);
                p.rotateX(this.previewPitch + Math.sin(p.frameCount * 0.02) * 0.1);
                
                let design = SHIP_DESIGNS[gameState.players[0].designIndex]; 
                let tintColor = [80, 180, 255];
                let dark = [80*0.4, 180*0.4, 255*0.4];
                let light = [200, 220, 255];
                let engineGray = [80, 80, 85];
                
                const drawFace = (pts, col) => {
                    p.fill(col[0], col[1], col[2], col[3] || 255);
                    p.beginShape();
                    for (let pt of pts) p.vertex(pt[0], pt[1], pt[2]);
                    p.endShape(p.CLOSE);
                };
                
                const sFake = { pitch: 0, yaw: 0 };
                const tf = (pt) => pt;
                let flamePoints = design.draw(drawFace, tintColor, engineGray, light, dark, false, sFake, tf, tf);
                
                // Draw thrust flames (Only on Instructions)
                if (isInstructions && this.thrustActive && Array.isArray(flamePoints)) {
                    flamePoints.forEach(fp => {
                        p.push();
                        p.translate(fp.x, fp.y, fp.z);
                        let flicker = 1.0 + Math.sin(p.frameCount * 0.8) * 0.15;
                        p.fill(100, 230, 255, 200);
                        p.cone(4 * flicker, 15 * flicker, 8);
                        p.pop();
                    });
                }
                
                if (isInstructions) {
                    for (let b of this.previewBullets) {
                        p.push();
                        p.translate(b.x, b.y, b.z);
                        if (b.isBarrier) {
                            p.fill(100, 200, 255);
                            p.box(4);
                        } else {
                            p.fill(255, 255, 100);
                            p.sphere(2);
                        }
                        p.pop();
                    }
                }
                p.pop(); // End ship rotation
            }
            p.pop(); // End preview pass

            gl.disable(gl.DEPTH_TEST);
            p.rectMode(p.CORNER);
        }

        // Floating Trackpad Indicator if aiming (only during actual gameplay)
        if (!isInstructions && !isCockpitSelection && this.aimTouchId !== null) {
            this._drawJoystickBase(this.aimAnchorX, this.aimAnchorY);

            // Connecting p.line
            p.stroke(255, 255, 255, 50);
            p.strokeWeight(2 * this._scale);
            p.line(this.aimAnchorX, this.aimAnchorY, this.lastAimX, this.lastAimY);

            // Current finger position
            p.fill(255, 255, 255, 150);
            p.noStroke();
            p.circle(this.lastAimX, this.lastAimY, 60 * this._scale);
        }

        // Action buttons (Only during gameplay or instructions)
        if (!isCockpitSelection) {
            for (let b in this.btns) {
                let btn = this.btns[b];

                p.stroke(btn.col[0], btn.col[1], btn.col[2], btn.active ? 200 : 80);
                p.strokeWeight(2 * this._scale);
                p.fill(btn.col[0], btn.col[1], btn.col[2], btn.active ? 80 : 20);
                p.circle(btn.x, btn.y, btn.r * 2);

                // Active glow only during gameplay (not on the instructions preview)
                if (btn.active && !forceInstructions && !isInstructions) {
                    p.fill(btn.col[0], btn.col[1], btn.col[2], 40);
                    p.circle(btn.x, btn.y, btn.r * 2.4);
                }

                p.noStroke();
                p.fill(255, btn.active ? 255 : 150);
                p.textAlign(p.CENTER, p.CENTER);
                p.textSize(Math.max(10, btn.r * 0.4));
                p.text(btn.label, btn.x, btn.y);
            }
        }

        gl.enable(gl.DEPTH_TEST);
        p.pop();
    }
    /**
     * Checks if a point (mouse/touch) hits any settings buttons on the Instructions screen.
     * Returns true if a button was hit (to prevent advancing the game state).
     */
    checkSettingsHit(mx, my) {
        for (let k in this.settingsBtns) {
            // Only check buttons relevant to current mode
            if (gameState.mode === 'instructions' && k === 'cockpit') continue;
            if (gameState.mode === 'cockpitSelection') {
                if (k === 'switchSides') continue;
                if (!gameState.isMobile) continue; // Skip physical hits on desktop
            }

            let btn = this.settingsBtns[k];
            if (mx > btn.x - btn.w / 2 && mx < btn.x + btn.w / 2 &&
                my > btn.y - btn.h / 2 && my < btn.y + btn.h / 2) {

                if (k === 'switchSides') {
                    this.isSwapped = !this.isSwapped;
                } else if (k === 'cockpit') {
                    if (gameState) {
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

export const mobileController = new MobileController();

export function shouldRequestFullscreen() {
    if (typeof p.fullscreen !== 'function' || p.fullscreen()) return false;

    // Detect if we are on a mobile device (including iPad Pro)
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isIPadPro = (ua.includes('Mac') && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isMobile = isIOS || isIPadPro || isAndroid;

    // Check if we are in standalone (PWA) mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    // If we are on mobile (phone/tablet) and already in standalone mode, 
    // we usually DON'T want to request "real" p.fullscreen as it's redundant 
    // or can cause browser UI glitches.
    if (isStandalone && isMobile) return false;

    // On Desktop (macOS/Windows/Linux), even in standalone mode, we often 
    // want to trigger "real" p.fullscreen to hide the OS title bar/toolbar.
    // Also, don't request p.fullscreen on iPad/iPhone anyway as it can be flaky.
    if (isIOS || isIPadPro) return false;

    return true;
}

export function handleTouchStarted(event) {
    if (event && event.target && event.target.tagName !== 'CANVAS') return true;

    // Request p.fullscreen immediately on first interaction from Title screen
    if (gameState.mode === 'menu' || gameState.mode === 'instructions') {
        if (shouldRequestFullscreen()) {
            p.fullscreen(true);
        }
    }

    if (gameState.mode === 'menu') {
        setTimeout(() => {
            const start = (typeof window !== 'undefined') ? window.startGame : undefined;
            if (typeof start === 'function') start(1);
        }, 50);
    }
    return false;
}
