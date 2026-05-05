/**
 * GamepadManager — Universal gamepad integration for Viron.
 *
 * Supports two mapping modes, detected automatically each frame:
 *
 *   STANDARD  (gp.mapping === "standard")
 *     Xbox, PlayStation, Switch Pro, 8BitDo X-mode, and most modern pads.
 *     Uses the W3C Standard Gamepad button/axis indices.
 *
 *   DIRECT  (everything else — 8BitDo D-mode, generic DirectInput)
 *     Button and axis indices differ from the standard layout.
 *     R2 is an analog axis (not a button), D-pad is a HAT axis, etc.
 *
 * Control scheme for Viron (physical labels):
 *   Left Stick   — steer the ship (yaw left/right, pitch up/down)
 *   L2/R2 (either) — analog thrust (0.0→1.0 on analog triggers, digital 0/1 otherwise)
 *   A  (btn 0)   — primary weapon (shoot)
 *   B  (btn 1)   — brake
 *   X            — fire missile (edge-detect, one shot per press)
 *   Y            — cycle weapon mode (edge-detect)
 *   L1 / LB      — barrier weapon
 *   Start        — pause / resume the game
 *   D-Pad        — supplementary steering (overrides stick when centred)
 *
 * Standard Gamepad button layout (W3C):
 *   0:A  1:B  2:X  3:Y  4:LB  5:RB  6:LT  7:RT
 *   8:Back/Select  9:Start  10:L3  11:R3
 *   12:D-Up  13:D-Down  14:D-Left  15:D-Right  16:Home
 *
 * Standard Gamepad axes:
 *   0:LX  1:LY  2:RX  3:RY
 *
 * DirectInput (8BitDo D-mode) button layout:
 *   0:A  1:B  2:Pr  3:X  4:Y  5:Pl  6:L1  7:R1
 *   8:L2(digital)  9:R2(digital)  10:Select  11:Start  12:Home  13:Star
 *
 * DirectInput axes:
 *   0:LX  1:LY  2:RX  3:L2(analog)  4:R2(analog)  5:RY  9:HAT(D-pad)
 *
 * @exports   GamepadManager    — class definition
 * @exports   gamepadManager    — singleton
 */

import { p } from './p5Context.js';
import { gameState } from './gameState.js';

// ---------------------------------------------------------------------------
// Standard Gamepad button indices (W3C "standard" mapping)
// ---------------------------------------------------------------------------
const STD_BTN = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9,
  L3: 10, R3: 11,
  D_UP: 12, D_DOWN: 13, D_LEFT: 14, D_RIGHT: 15,
  HOME: 16
};
const STD_AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 };

// ---------------------------------------------------------------------------
// DirectInput button indices (8BitDo D-mode / generic DirectInput)
// ---------------------------------------------------------------------------
const DI_BTN = {
  A: 0, B: 1, Pr: 2, X: 3, Y: 4, Pl: 5,
  L1: 6, R1: 7,
  L2: 8, R2: 9,      // digital click of the triggers
  BACK: 10, START: 11,
  HOME: 12, STAR: 13,
  L3: 10, R3: 11     // L3/R3 share indices with Select/Start on 8BitDo D-mode
};
const DI_AXIS = {
  LX: 0, LY: 1,
  RX: 2, RY: 5,      // RY is axis 5, not 3
  L2: 4, R2: 3,      // analog trigger axes (-1 rest → +1 full)
  HAT: 9             // D-pad as single HAT axis
};

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Deadzone threshold — axis values below this are treated as zero. */
const DEADZONE = 0.12;

/**
 * Sensitivity scalar applied to analogue stick steering.
 * A value of 1.0 = full keyboard-equivalent turn rate at full deflection.
 */
const GAMEPAD_STICK_SENSITIVITY = 0.5;

/**
 * Exponent for the analogue stick response curve (must be > 1).
 * Values near centre produce very little output; extremes produce full response.
 * 2.5 gives good fine-control precision while keeping crisp maximum response.
 */
const GAMEPAD_STICK_EXPO = 2.5;

/**
 * Applies an exponential (power) response curve to an axis value in [-1, 1].
 * Small deflections near centre are significantly reduced; full deflection is unchanged.
 * @param {number} v  Axis value in the range [-1, 1].
 * @returns {number}  Transformed value in the range [-1, 1].
 */
function _applyExpo(v) {
  return Math.sign(v) * Math.pow(Math.abs(v), GAMEPAD_STICK_EXPO);
}

/**
 * Applies deadzone to an axis value.  Returns 0 if within the deadzone.
 * @param {number} v  Raw axis value.
 * @returns {number}
 */
function _dz(v) {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

/**
 * Converts a D-mode trigger axis from [-1, +1] to [0, 1].
 * The 8BitDo D-mode triggers rest at -1 (released) and go to +1 (fully pressed).
 * @param {number} v  Raw axis value in [-1, 1].
 * @returns {number}  Normalised value in [0, 1].
 */
function _normTriggerAxis(v) {
  return Math.max(0, Math.min(1, (v + 1) / 2));
}

/**
 * Decodes the D-mode HAT axis into individual D-pad booleans.
 * The HAT axis encodes direction as a single float value.
 * @param {number} h  HAT axis value.
 * @returns {{ up: boolean, down: boolean, left: boolean, right: boolean }}
 */
function _decodeHat(h) {
  const dpad = { up: false, down: false, left: false, right: false };
  if (h >= -1.01 && h <= 1.01) {
    if (h < -0.5 || h > 0.8) dpad.up = true;
    if (h > -0.85 && h < -0.1) dpad.right = true;
    if (h > -0.25 && h < 0.5) dpad.down = true;
    if (h > 0.3 && h < 1.1) dpad.left = true;
  }
  return dpad;
}

/**
 * Sets up a full-screen 2D orthographic overlay.
 * Identical pattern to mobileControls.js _setupMobileOverlay2D().
 * Caller must call p.pop() when done.
 */
function _setup2DOverlay() {
  const pxD = p.pixelDensity();
  p.drawingContext.viewport(0, 0, p.width * pxD, p.height * pxD);
  p.push();
  p.ortho(-p.width / 2, p.width / 2, -p.height / 2, p.height / 2, 0, 1000);
  p.resetMatrix();
}

export class GamepadManager {
  constructor() {
    this._gamepadIndex = -1;
    this._connected = false;
    this._isStandard = true;   // true = W3C standard, false = DirectInput
    this._state = null;
    this._prevButtons = {};
    this._justPressed = {};
    this._prevDpad = { left: false, right: false, up: false, down: false };
    this._justDpad = { left: false, right: false, up: false, down: false };

    // Toast notification
    this.toastFrames = 0;
    this.toastMessage = '';

    this._boundConnect = this._onConnect.bind(this);
    this._boundDisconnect = this._onDisconnect.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Registers browser gamepad connect/disconnect events.
   * Must be called once during setup (after the canvas is created).
   */
  initialize() {
    if (typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', this._boundConnect);
    window.addEventListener('gamepaddisconnected', this._boundDisconnect);

    // Pick up any already-connected gamepads (e.g. page reload after plugging in)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]) {
        this._gamepadIndex = i;
        this._connected = true;
        this._isStandard = (pads[i].mapping === 'standard');
        this._showToast('CONTROLLER CONNECTED');
        const mode = this._isStandard ? 'standard' : 'direct';
        console.log(`[Viron] Gamepad connected: ${pads[i].id} (${mode})`);
        break;
      }
    }
  }

  _onConnect(e) {
    this._gamepadIndex = e.gamepad.index;
    this._connected = true;
    this._isStandard = (e.gamepad.mapping === 'standard');
    this._showToast('CONTROLLER CONNECTED');
    const mode = this._isStandard ? 'standard' : 'direct';
    console.log(`[Viron] Gamepad connected: ${e.gamepad.id} (${mode})`);
  }

  _onDisconnect(e) {
    if (e.gamepad.index === this._gamepadIndex) {
      this._gamepadIndex = -1;
      this._connected = false;
      this._state = null;
      this._justPressed = {};
      this._prevButtons = {};
      this._showToast('CONTROLLER DISCONNECTED');
      console.log('[Viron] Gamepad disconnected.');
    }
  }

  _showToast(msg) {
    this.toastMessage = msg;
    this.toastFrames = 180; // ~3 s at 60 fps
  }

  /** True when at least one controller is active. */
  get isConnected() {
    return this._connected;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /**
   * Polls the raw Gamepad API and refreshes internal state.
   * Detects standard vs DirectInput mapping and normalises both layouts
   * into a single unified internal state object.
   * Must be called once per draw frame (before any action / steering queries).
   */
  update() {
    // Tick down the toast timer regardless of connection state so
    // the "CONTROLLER DISCONNECTED" message clears itself correctly.
    if (this.toastFrames > 0) this.toastFrames--;

    if (!this._connected || this._gamepadIndex < 0) {
      this._state = null;
      return;
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[this._gamepadIndex];
    if (!gp) {
      this._state = null;
      this._connected = false;
      this._gamepadIndex = -1;
      return;
    }

    // Re-check mapping each frame (some browsers update it lazily)
    this._isStandard = (gp.mapping === 'standard');

    if (this._isStandard) {
      this._parseStandard(gp);
    } else {
      this._parseDirect(gp);
    }

    // ---- Edge-detect (just-pressed this frame) ----
    const prev = this._prevButtons;
    this._justPressed = {
      a: this._state.a.pressed && !prev.a,
      b: this._state.b.pressed && !prev.b,
      x: this._state.x.pressed && !prev.x,
      y: this._state.y.pressed && !prev.y,
      str: this._state.str.pressed && !prev.str,
      sel: this._state.sel.pressed && !prev.sel,
    };

    this._prevButtons = {
      a: this._state.a.pressed,
      b: this._state.b.pressed,
      x: this._state.x.pressed,
      y: this._state.y.pressed,
      str: this._state.str.pressed,
      sel: this._state.sel.pressed,
    };

    // D-pad edge detection (just-pressed this frame)
    const d = this._state.dpad;
    this._justDpad = {
      left: d.left && !this._prevDpad.left,
      right: d.right && !this._prevDpad.right,
      up: d.up && !this._prevDpad.up,
      down: d.down && !this._prevDpad.down,
    };
    this._prevDpad = { left: d.left, right: d.right, up: d.up, down: d.down };
  }

  /**
   * Parses a gamepad with W3C "standard" mapping into the unified state.
   * @private
   */
  _parseStandard(gp) {
    const btn = (idx) => gp.buttons[idx] || { pressed: false, value: 0 };

    const dpad = {
      up: btn(STD_BTN.D_UP).pressed,
      down: btn(STD_BTN.D_DOWN).pressed,
      left: btn(STD_BTN.D_LEFT).pressed,
      right: btn(STD_BTN.D_RIGHT).pressed
    };

    this._state = {
      a: btn(STD_BTN.A),
      b: btn(STD_BTN.B),
      x: btn(STD_BTN.X),
      y: btn(STD_BTN.Y),
      l1: btn(STD_BTN.LB),
      r1: btn(STD_BTN.RB),
      l2: btn(STD_BTN.LT),
      r2: btn(STD_BTN.RT),
      sel: btn(STD_BTN.BACK),
      str: btn(STD_BTN.START),
      l3: btn(STD_BTN.L3),
      r3: btn(STD_BTN.R3),
      dpad,
      ls: { x: _dz(gp.axes[STD_AXIS.LX] ?? 0), y: _dz(gp.axes[STD_AXIS.LY] ?? 0) },
      rs: { x: _dz(gp.axes[STD_AXIS.RX] ?? 0), y: _dz(gp.axes[STD_AXIS.RY] ?? 0) }
    };
  }

  /**
   * Parses a DirectInput gamepad (8BitDo D-mode / generic) into the unified state.
   * Key differences from standard:
   *   - X is btn 3, Y is btn 4 (not 2/3)
   *   - L1/R1 are btns 6/7 (not 4/5)
   *   - R2 is analog axis 4 (not button 7)
   *   - Select is btn 10, Start is btn 11 (not 8/9)
   *   - D-pad is encoded as a single HAT axis (axis 9)
   *   - RY is axis 5 (not axis 3)
   * @private
   */
  _parseDirect(gp) {
    const btn = (idx) => gp.buttons[idx] || { pressed: false, value: 0 };

    // D-pad from HAT axis
    const hatVal = gp.axes[DI_AXIS.HAT] ?? 2; // 2 = out-of-range → no hat input
    const dpad = _decodeHat(hatVal);

    // R2 trigger: use the analog axis for proportional thrust.
    // Convert from [-1, +1] to { pressed, value } to match standard button format.
    const r2Analog = _normTriggerAxis(gp.axes[DI_AXIS.R2] ?? -1);
    const l2Analog = _normTriggerAxis(gp.axes[DI_AXIS.L2] ?? -1);

    this._state = {
      a: btn(DI_BTN.A),
      b: btn(DI_BTN.B),
      x: btn(DI_BTN.X),
      y: btn(DI_BTN.Y),
      l1: btn(DI_BTN.L1),
      r1: btn(DI_BTN.R1),
      l2: { pressed: l2Analog > 0.1, value: l2Analog },
      r2: { pressed: r2Analog > 0.1, value: r2Analog },
      sel: btn(DI_BTN.BACK),
      str: btn(DI_BTN.START),
      l3: btn(DI_BTN.L3),
      r3: btn(DI_BTN.R3),
      dpad,
      ls: { x: _dz(gp.axes[DI_AXIS.LX] ?? 0), y: _dz(gp.axes[DI_AXIS.LY] ?? 0) },
      rs: { x: _dz(gp.axes[DI_AXIS.RX] ?? 0), y: _dz(gp.axes[DI_AXIS.RY] ?? 0) }
    };
  }

  // ---------------------------------------------------------------------------
  // Action queries
  // ---------------------------------------------------------------------------

  /** Returns the full cleaned controller state object, or null if disconnected. */
  getState() {
    return this._state;
  }

  /** True if the named button was newly pressed this frame (edge-detect). */
  justPressed(btnName) {
    return this._justPressed ? (this._justPressed[btnName] === true) : false;
  }

  /**
   * True if the given D-pad direction was newly pressed this frame.
   * @param {'left'|'right'|'up'|'down'} dir
   */
  justPressedDpad(dir) {
    return this._justDpad ? (this._justDpad[dir] === true) : false;
  }

  /**
   * Returns the current value of a gameplay action via gamepad.
   *
   * For 'thrust' this returns a float 0.0–1.0 from L2 or R2 (whichever
   * is pressed harder).  On controllers with analog triggers (Xbox, PS,
   * 8BitDo D-mode/X-mode) this gives proportional thrust.  On digital
   * triggers (Switch, 8BitDo S-mode) the value snaps to 0 or 1.
   *
   * All other actions return boolean true/false.
   *
   * @param {'thrust'|'shoot'|'brake'|'barrier'} action
   * @returns {number|boolean}
   */
  getAction(action) {
    if (!this._state) return (action === 'thrust') ? 0 : false;
    switch (action) {
      case 'thrust': return Math.max(this._state.l2.value, this._state.r2.value);
      case 'shoot': return this._state.a.pressed;
      case 'brake': return this._state.b.pressed;
      case 'barrier': return this._state.l1.pressed;
      default: return false;
    }
  }

  /**
   * Returns yaw / pitch steering deltas driven by the left analogue stick
   * and D-Pad (D-Pad only applies when the stick is centred).
   * @param {number} turnRate   Maximum yaw delta per frame (rad/frame).
   * @param {number} pitchRate  Maximum pitch delta per frame (rad/frame).
   * @returns {{ yaw: number, pitch: number }}
   */
  getSteeringDeltas(turnRate, pitchRate) {
    if (!this._state) return { yaw: 0, pitch: 0 };

    const { ls, dpad } = this._state;
    let lx = ls.x;
    let ly = ls.y;

    const dpadDeadzone = 0.1;
    const lxCentered = Math.abs(lx) < dpadDeadzone;
    const lyCentered = Math.abs(ly) < dpadDeadzone;

    // D-Pad supplements analog when stick is centred
    if (lxCentered && dpad.left) lx = -1;
    if (lxCentered && dpad.right) lx = 1;
    if (lyCentered && dpad.up) ly = -1;
    if (lyCentered && dpad.down) ly = 1;

    return {
      yaw: -_applyExpo(lx) * turnRate * GAMEPAD_STICK_SENSITIVITY,
      pitch: -_applyExpo(ly) * pitchRate * GAMEPAD_STICK_SENSITIVITY  // negated: push stick forward = pitch up
    };
  }

  // ---------------------------------------------------------------------------
  // HUD rendering — uses p5 API with an orthographic 2D overlay,
  // matching the pattern used by mobileControls.js and hudCore.js.
  // ---------------------------------------------------------------------------

  /**
   * Draws a brief toast notification (connect / disconnect) using a p5
   * orthographic 2D overlay.  Call once per frame after 3-D rendering.
   * The full controller mapping is shown on the Instructions screen instead.
   */
  drawHUD() {
    if (this.toastFrames <= 0) return;

    _setup2DOverlay();
    const gl = p.drawingContext;
    gl.disable(gl.DEPTH_TEST);

    const w = p.width;
    const h = p.height;
    p.translate(-w / 2, -h / 2, 0);

    p.noStroke();
    p.textAlign(p.CENTER, p.CENTER);
    if (gameState && gameState.gameFont) p.textFont(gameState.gameFont);

    this._drawToast(w, h);

    gl.enable(gl.DEPTH_TEST);
    p.pop();
  }

  /** @private — toast banner near top of screen */
  _drawToast(w, h) {
    const t = this.toastFrames;
    const alpha = Math.round(255 * Math.min(t / 30, 1) * Math.min((180 - t) / 30 + 1, 1));
    if (alpha <= 0) return;

    const msg = this.toastMessage;
    const cx = w / 2;
    const cy = 60;

    p.textSize(22);
    const tw = p.textWidth(msg) + 40;
    const th = 44;

    // Background
    p.noStroke();
    p.fill(0, 0, 0, alpha * 0.75);
    p.rect(cx - tw / 2, cy - th / 2, tw, th, 8);

    // Border
    p.stroke(0, 220, 120, alpha);
    p.strokeWeight(2);
    p.noFill();
    p.rect(cx - tw / 2, cy - th / 2, tw, th, 8);

    // Text
    p.noStroke();
    p.fill(200, 255, 200, alpha);
    p.textAlign(p.CENTER, p.CENTER);
    p.text(msg, cx, cy);
  }
}

export const gamepadManager = new GamepadManager();
