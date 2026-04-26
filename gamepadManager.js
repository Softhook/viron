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

const DEADZONE = 0.15;

function _applyDeadzone(v) {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

export class GamepadManager {
  constructor() {
    this._gamepadIndex = -1;
    this._connected    = false;
    this._state        = null;
    this._prevButtons  = {};
    this._justPressed  = {};

    // Toast notification
    this.toastFrames  = 0;
    this.toastMessage = '';

    // Info overlay (shown briefly on first connect)
    this._infoOverlayFrames = 0;

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
        this._infoOverlayFrames = 300; // show info panel for ~5 s
        this._showToast('🎮  CONTROLLER CONNECTED');
        console.log(`[Viron] Gamepad already connected: ${pads[i].id}`);
        break;
      }
    }
  }

  _onConnect(e) {
    this._gamepadIndex      = e.gamepad.index;
    this._connected         = true;
    this._infoOverlayFrames = 300;
    this._showToast('🎮  CONTROLLER CONNECTED');
    console.log(`[Viron] Gamepad connected: ${e.gamepad.id}`);
  }

  _onDisconnect(e) {
    if (e.gamepad.index === this._gamepadIndex) {
      this._gamepadIndex      = -1;
      this._connected         = false;
      this._state             = null;
      this._justPressed       = {};
      this._prevButtons       = {};
      this._infoOverlayFrames = 0;
      this._showToast('🎮  CONTROLLER DISCONNECTED');
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
        x: _applyDeadzone(gp.axes[GAMEPAD_MAP.LX] ?? 0),
        y: _applyDeadzone(gp.axes[GAMEPAD_MAP.LY] ?? 0)
      },
      rs: {
        x: _applyDeadzone(gp.axes[GAMEPAD_MAP.RX] ?? 0),
        y: _applyDeadzone(gp.axes[GAMEPAD_MAP.RY] ?? 0)
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

    if (this.toastFrames       > 0) this.toastFrames--;
    if (this._infoOverlayFrames > 0) this._infoOverlayFrames--;
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
      yaw:   -lx * turnRate,
      pitch:  ly * pitchRate
    };
  }

  // ---------------------------------------------------------------------------
  // HUD rendering helpers (use raw Canvas 2D, safe inside WEBGL context)
  // ---------------------------------------------------------------------------

  /**
   * Draws the connect / disconnect toast banner near the top of the screen.
   * Call this each frame inside a 2D canvas context (after 3-D rendering).
   * @param {CanvasRenderingContext2D} ctx  p5 drawingContext.
   * @param {number} w  Canvas CSS width.
   * @param {number} h  Canvas CSS height.
   */
  drawToast(ctx, w, h) {
    if (this.toastFrames <= 0) return;
    const t     = this.toastFrames;
    const alpha = Math.min(t / 30, 1) * Math.min((180 - t) / 30 + 1, 1);

    ctx.save();
    ctx.font      = 'bold 22px Impact, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const msg = this.toastMessage;
    const mx  = w / 2;
    const my  = 60;
    const tw  = ctx.measureText(msg).width + 40;
    const th  = 44;

    // Background
    ctx.fillStyle = `rgba(0,0,0,${alpha * 0.75})`;
    _roundRect(ctx, mx - tw / 2, my - th / 2, tw, th, 8);
    ctx.fill();

    // Border
    ctx.strokeStyle = `rgba(0,220,120,${alpha})`;
    ctx.lineWidth   = 2;
    _roundRect(ctx, mx - tw / 2, my - th / 2, tw, th, 8);
    ctx.stroke();

    // Text
    ctx.fillStyle = `rgba(200,255,200,${alpha})`;
    ctx.fillText(msg, mx, my);

    ctx.restore();
  }

  /**
   * Draws a small persistent 🎮 icon in the top-right corner when a
   * controller is connected.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   */
  drawControllerIndicator(ctx, w, h) {
    if (!this._connected) return;
    ctx.save();
    ctx.font         = '18px Arial, sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = 'rgba(0,220,120,0.85)';
    ctx.fillText('🎮', w - 10, 10);
    ctx.restore();
  }

  /**
   * Draws a full-screen controller info overlay showing the button-to-action
   * mapping.  Displayed for ~5 seconds after the controller connects.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   */
  drawControllerInfoOverlay(ctx, w, h) {
    if (this._infoOverlayFrames <= 0) return;

    const t     = this._infoOverlayFrames;
    const alpha = Math.min(t / 30, 1) * Math.min((300 - t) / 30 + 1, 1);

    const cx = w / 2;
    const cy = h / 2;
    const bw = Math.min(540, w - 40);
    const bh = 360;
    const bx = cx - bw / 2;
    const by = cy - bh / 2;

    ctx.save();

    // Panel background
    ctx.fillStyle = `rgba(0,0,0,${alpha * 0.88})`;
    _roundRect(ctx, bx, by, bw, bh, 14);
    ctx.fill();

    // Panel border
    ctx.strokeStyle = `rgba(0,200,100,${alpha})`;
    ctx.lineWidth   = 2;
    _roundRect(ctx, bx, by, bw, bh, 14);
    ctx.stroke();

    // Title
    ctx.fillStyle    = `rgba(0,255,150,${alpha})`;
    ctx.font         = 'bold 26px Impact, Arial, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🎮  CONTROLLER DETECTED', cx, by + 18);

    ctx.fillStyle = `rgba(160,160,160,${alpha})`;
    ctx.font      = '13px Arial, sans-serif';
    ctx.fillText('8BitDo Pro 2 / Ultimate — Default Mapping', cx, by + 54);

    // Mapping table
    const mappings = [
      ['Left Stick',  'Steer ship (yaw / pitch)'],
      ['R2',          'Thrust'],
      ['A',           'Primary weapon (shoot)'],
      ['X',           'Fire missile'],
      ['Y',           'Cycle weapon mode'],
      ['B',           'Brake'],
      ['L1',          'Barrier weapon'],
      ['D-Pad',       'Steer (when stick centred)'],
      ['Start',       'Pause / Resume'],
    ];

    const colW   = bw / 2 - 20;
    const rowH   = 28;
    const startY = by + 88;

    ctx.font         = 'bold 14px Arial, sans-serif';
    ctx.textBaseline = 'top';

    mappings.forEach(([key, desc], i) => {
      const col  = i % 2;
      const row  = Math.floor(i / 2);
      const tx   = bx + 20 + col * (colW + 20);
      const ty   = startY + row * rowH;

      ctx.fillStyle = `rgba(0,220,120,${alpha})`;
      ctx.textAlign = 'left';
      ctx.fillText(key, tx, ty);

      ctx.fillStyle = `rgba(220,220,220,${alpha})`;
      ctx.fillText(`  —  ${desc}`, tx + ctx.measureText(key).width, ty);
    });

    // Dismiss hint
    ctx.fillStyle    = `rgba(120,120,120,${alpha * Math.abs(Math.sin(Date.now() / 500))})`;
    ctx.font         = '12px Arial, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('(panel closes automatically)', cx, by + bh - 10);

    ctx.restore();
  }
}

/** Polyfill-safe rounded rect path helper. */
function _roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
}

export const gamepadManager = new GamepadManager();
