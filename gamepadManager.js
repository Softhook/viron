/**
 * GamepadManager — 8BitDo Pro 2 / Ultimate / "Pro 3" controller integration.
 *
 * Control scheme for Viron:
 *   Left Stick  — steer the ship (yaw left/right, pitch up/down)
 *   R2          — thrust
 *   A  (btn 0)  — primary weapon (shoot)
 *   B  (btn 1)  — brake
 *   X  (btn 3)  — fire missile (edge-detect, one shot per press)
 *   Y  (btn 4)  — cycle weapon mode (edge-detect)
 *   L1 (btn 6)  — barrier weapon
 *   Start       — pause / resume the game
 *   D-Pad       — supplementary steering (overrides stick when stick is centred)
 *
 * @exports   GAMEPAD_MAP       — raw button/axis index constants
 * @exports   GamepadManager    — class definition
 * @exports   gamepadManager    — singleton
 */

import { p } from './p5Context.js';
import { gameState } from './gameState.js';

/** Raw button and axis indices for the 8BitDo Pro 2 / Ultimate. */
export const GAMEPAD_MAP = {
  // Face buttons
  A: 0, B: 1, X: 3, Y: 4,

  // Triggers & paddles
  L1: 6, R1: 7,
  L2: 8, R2: 9,
  L4: 16, R4: 17,
  Pl: 5, Pr: 2,

  // Sticks & D-Pad
  LX: 0, LY: 1,
  RX: 2, RY: 5,
  L3: 10, R3: 11,
  HAT: 9,

  // Utility
  SELECT: 10, START: 11, HOME: 12, STAR: 13  // STAR = the ☆ "screenshot" / share button on 8BitDo
};

/**
 * Sensitivity scalar applied to analogue stick steering.
 * Reduces the maximum turn rate so fine control is easier.
 * A value of 1.0 = full keyboard-equivalent turn rate at full deflection.
 */
const GAMEPAD_STICK_SENSITIVITY = 0.5;

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
    this._connected    = false;
    this._state        = null;
    this._prevButtons  = {};
    this._justPressed  = {};
    this._prevDpad     = { left: false, right: false, up: false, down: false };
    this._justDpad     = { left: false, right: false, up: false, down: false };

    // Toast notification
    this.toastFrames  = 0;
    this.toastMessage = '';

    this._boundConnect    = this._onConnect.bind(this);
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
    window.addEventListener('gamepadconnected',    this._boundConnect);
    window.addEventListener('gamepaddisconnected', this._boundDisconnect);

    // Pick up any already-connected gamepads (e.g. page reload after plugging in)
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]) {
        this._gamepadIndex    = i;
        this._connected       = true;
        this._showToast('CONTROLLER CONNECTED');
        console.log(`[Viron] Gamepad already connected: ${pads[i].id}`);
        break;
      }
    }
  }

  _onConnect(e) {
    this._gamepadIndex      = e.gamepad.index;
    this._connected         = true;
    this._showToast('CONTROLLER CONNECTED');
    console.log(`[Viron] Gamepad connected: ${e.gamepad.id}`);
  }

  _onDisconnect(e) {
    if (e.gamepad.index === this._gamepadIndex) {
      this._gamepadIndex      = -1;
      this._connected         = false;
      this._state             = null;
      this._justPressed       = {};
      this._prevButtons       = {};
      this._showToast('CONTROLLER DISCONNECTED');
      console.log('[Viron] Gamepad disconnected.');
    }
  }

  _showToast(msg) {
    this.toastMessage = msg;
    this.toastFrames  = 180; // ~3 s at 60 fps
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
   * Must be called once per draw frame (before any action / steering queries).
   */
  update() {
    if (!this._connected || this._gamepadIndex < 0) {
      this._state = null;
      return;
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp   = pads[this._gamepadIndex];
    if (!gp) return;

    const btn = (idx) => gp.buttons[idx] || { pressed: false, value: 0 };

    // ---- Diagonal D-Pad from HAT axis ----
    const h    = gp.axes[GAMEPAD_MAP.HAT] ?? 2; // 2 = out-of-range → no hat input
    const dpad = { up: false, down: false, left: false, right: false };
    if (h >= -1.01 && h <= 1.01) {
      if (h < -0.5  || h > 0.8)  dpad.up    = true;
      if (h > -0.85 && h < -0.1) dpad.right = true;
      if (h > -0.25 && h < 0.5)  dpad.down  = true;
      if (h > 0.3   && h < 1.1)  dpad.left  = true;
    }

    this._state = {
      a:   btn(GAMEPAD_MAP.A),
      b:   btn(GAMEPAD_MAP.B),
      x:   btn(GAMEPAD_MAP.X),
      y:   btn(GAMEPAD_MAP.Y),
      l1:  btn(GAMEPAD_MAP.L1),
      r1:  btn(GAMEPAD_MAP.R1),
      l2:  btn(GAMEPAD_MAP.L2),
      r2:  btn(GAMEPAD_MAP.R2),
      l4:  btn(GAMEPAD_MAP.L4),
      r4:  btn(GAMEPAD_MAP.R4),
      pl:  btn(GAMEPAD_MAP.Pl),
      pr:  btn(GAMEPAD_MAP.Pr),
      sel: btn(GAMEPAD_MAP.SELECT),
      str: btn(GAMEPAD_MAP.START),
      l3:  btn(GAMEPAD_MAP.L3),
      r3:  btn(GAMEPAD_MAP.R3),
      dpad,
      ls: {
        x: gp.axes[GAMEPAD_MAP.LX] ?? 0,
        y: gp.axes[GAMEPAD_MAP.LY] ?? 0
      },
      rs: {
        x: gp.axes[GAMEPAD_MAP.RX] ?? 0,
        y: gp.axes[GAMEPAD_MAP.RY] ?? 0
      }
    };

    // ---- Edge-detect (just-pressed this frame) ----
    const prev = this._prevButtons;
    this._justPressed = {
      a:   this._state.a.pressed   && !prev.a,
      b:   this._state.b.pressed   && !prev.b,
      x:   this._state.x.pressed   && !prev.x,
      y:   this._state.y.pressed   && !prev.y,
      str: this._state.str.pressed && !prev.str,
      sel: this._state.sel.pressed && !prev.sel,
    };

    this._prevButtons = {
      a:   this._state.a.pressed,
      b:   this._state.b.pressed,
      x:   this._state.x.pressed,
      y:   this._state.y.pressed,
      str: this._state.str.pressed,
      sel: this._state.sel.pressed,
    };

    if (this.toastFrames > 0) this.toastFrames--;

    // D-pad edge detection (just-pressed this frame)
    const d = this._state.dpad;
    this._justDpad = {
      left:  d.left  && !this._prevDpad.left,
      right: d.right && !this._prevDpad.right,
      up:    d.up    && !this._prevDpad.up,
      down:  d.down  && !this._prevDpad.down,
    };
    this._prevDpad = { left: d.left, right: d.right, up: d.up, down: d.down };
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
   * Returns true while the given gameplay action is active via gamepad.
   * @param {'thrust'|'shoot'|'brake'|'barrier'} action
   */
  getAction(action) {
    if (!this._state) return false;
    switch (action) {
      case 'thrust':  return this._state.r2.value > 0.1;
      case 'shoot':   return this._state.a.pressed;
      case 'brake':   return this._state.b.pressed;
      case 'barrier': return this._state.l1.pressed;
      default:        return false;
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

    // D-Pad supplements analog when stick is centred
    if (lx === 0 && dpad.left)  lx = -1;
    if (lx === 0 && dpad.right) lx =  1;
    if (ly === 0 && dpad.up)    ly = -1;
    if (ly === 0 && dpad.down)  ly =  1;

    return {
      yaw:   -lx * turnRate * GAMEPAD_STICK_SENSITIVITY,
      pitch:  ly * pitchRate * GAMEPAD_STICK_SENSITIVITY
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
    const t     = this.toastFrames;
    const alpha = Math.round(255 * Math.min(t / 30, 1) * Math.min((180 - t) / 30 + 1, 1));
    if (alpha <= 0) return;

    const msg = this.toastMessage;
    const cx  = w / 2;
    const cy  = 60;

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
