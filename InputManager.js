/**
 * InputManager - Unified input handling for Viron.
 * Centralizes keyboard, mouse, and touch state and delegates mode-specific
 * input transitions to ensure consistent behavior across platforms.
 *
 * @exports   InputManager      — class definition
 * @exports   inputManager      — singleton
 */

import { gameState } from './gameState.js';
import { p } from './p5Context.js';
import { mobileController } from './mobileControls.js';
import { WEAPON_MODES, YAW_RATE, PITCH_RATE, MOUSE_SENSITIVITY, MOUSE_SMOOTHING } from './constants.js';
import { aimAssist } from './aimAssist.js';
import { enemyManager } from './enemies.js';

export class InputManager {
  constructor() {
    this.initialized = false;
    this.keys = new Set();
    this.mouse = {
      left: false,
      right: false,
      middle: false,
      x: 0,
      y: 0,
      movedX: 0,
      movedY: 0
    };
    this.hasClickedOnce = false;
    this.mouseReleasedSinceStart = true;
    this.isMobile = false; // PLATFORM_MOBILE
    this.isAndroid = false;
    this.smoothedMX = 0;
    this.smoothedMY = 0;
  }

  /**
   * Initializes DOM event listeners for low-level input tracking.
   */
  initialize() {
    if (this.initialized) return;

    // Keyboard
    window.addEventListener('keydown', e => this.keys.add(e.keyCode));
    window.addEventListener('keyup', e => this.keys.delete(e.keyCode));

    // Mouse Buttons
    window.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 1) this.mouse.middle = true;
      if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener('mouseup', e => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 1) this.mouse.middle = false;
      if (e.button === 2) this.mouse.right = false;
    });

    // Pointer Lock / Mouse Look
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) {
        // If we lose pointer lock while playing, we might want to pause
        if (gameState.mode === 'playing') {
          // Optional: gameState.pauseGame();
        }
      }
    });

    // Prevent context menu
    document.addEventListener('contextmenu', e => e.preventDefault());

    this.detectPlatform();
    this.initialized = true;
  }

  detectPlatform() {
    const ua = navigator.userAgent;
    this.isAndroid = /Android/i.test(ua);
    this.isMobile = this.isAndroid || /iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    if (!this.isMobile && /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) this.isMobile = true;
    if (!this.isMobile && /Mobile|Tablet/i.test(ua)) this.isMobile = true;
    if (!this.isMobile && 'ontouchstart' in window) {
      if (!/Windows NT|Macintosh|Linux/i.test(ua)) this.isMobile = true;
    }
    if (typeof gameState !== 'undefined' && gameState) {
      gameState.isMobile = this.isMobile;
      gameState.isAndroid = this.isAndroid;
    }
    console.log(`[Viron] Input: ${this.isMobile ? 'MOBILE' : 'DESKTOP'}`);
  }

  clearInputs() {
    this.keys.clear();
    this.mouse.left = false;
    this.mouse.right = false;
    this.mouse.middle = false;
    this.mouse.movedX = 0;
    this.mouse.movedY = 0;
    this.mouseReleasedSinceStart = true;
    this.smoothedMX = 0;
    this.smoothedMY = 0;

    if (mobileController) {
      mobileController.thrustActive = false;
      mobileController.shootActive = false;
      mobileController.barrierActive = false;
      mobileController.aimTouchId = null;
      mobileController.missileTouchId = null;
      if (mobileController.btns?.missile) mobileController.btns.missile.active = false;
    }
  }

  /**
   * Updates per-frame input state (deltas, smoothed values).
   * Called at the start of every draw() call.
   */
  update() {
    this.mouse.x = p.mouseX;
    this.mouse.y = p.mouseY;
    this.mouse.movedX = p.movedX;
    this.mouse.movedY = p.movedY;

    if (!this.mouse.left) {
      this.mouseReleasedSinceStart = true;
    }

    if (this.isMobile && mobileController) {
      mobileController.update(p.touches, p.width, p.height);
    }
  }

  /**
   * Checks if a key is currently held down.
   * @param {number} keyCode 
   */
  isKeyDown(keyCode) {
    return this.keys.has(keyCode);
  }

  /**
   * Returns whether a weapon fire action should trigger for a player.
   * Merges mouse/keyboard/mobile inputs.
   */
  getActionActive(player, action) {
    if (player.dead || gameState.mode !== 'playing') return false;

    const k = player.keys;
    const isP1 = player.id === 0;
    const isMobile = this.isMobile;

    switch (action) {
      case 'thrust':
        return this.isKeyDown(k.thrust) || 
               (isP1 && !isMobile && this.mouse.right) ||
               (isP1 && isMobile && mobileController?.thrustActive);
      
      case 'shoot':
        return this.isKeyDown(k.shoot) || 
               (isP1 && !isMobile && this.mouse.left && this.mouseReleasedSinceStart) ||
               (isP1 && isMobile && mobileController?.shootActive);

      case 'brake':
        return this.isKeyDown(k.brake);

      case 'missile':
        // Specifically for mobile one-shot or keyboard edge detect
        return false; // Handled via events/edge detect usually

      case 'barrier':
        return (isP1 && isMobile && mobileController?.barrierActive);

      case 'up': return this.isKeyDown(k.up);
      case 'down': return this.isKeyDown(k.down);
      case 'left': return this.isKeyDown(k.left);
      case 'right': return this.isKeyDown(k.right);
      case 'pitchUp': return this.isKeyDown(k.pitchUp);
      case 'pitchDown': return this.isKeyDown(k.pitchDown);

      default:
        return false;
    }
  }

  /**
   * Returns steering (yaw/pitch) deltas for a player.
   * Merges mouse-look, keyboard turning, and mobile joysticks.
   */
  getSteeringDeltas(player, design) {
    let dy = 0, dp = 0;
    const k = player.keys;
    const isP1 = player.id === 0;
    const isMobile = this.isMobile;

    // 1. Keyboard / Generic Steering
    const m = design.mass || 1.0;
    const turnRate = (design.turnRate || YAW_RATE) / m;
    const pitchRate = (design.pitchRate || PITCH_RATE) / m;

    if (this.isKeyDown(k.left)) dy += turnRate;
    if (this.isKeyDown(k.right)) dy -= turnRate;
    if (this.isKeyDown(k.pitchUp)) dp = p.constrain(dp + pitchRate, -p.PI / 2.2, p.PI / 2.2);
    if (this.isKeyDown(k.pitchDown)) dp = p.constrain(dp - pitchRate, -p.PI / 2.2, p.PI / 2.2);

    // 2. Mouse Look (P1 Desktop)
    if (isP1 && !isMobile && document.pointerLockElement) {
      const smoothedX = p.lerp(this.smoothedMX || 0, p.movedX, MOUSE_SMOOTHING);
      const smoothedY = p.lerp(this.smoothedMY || 0, p.movedY, MOUSE_SMOOTHING);
      this.smoothedMX = smoothedX;
      this.smoothedMY = smoothedY;

      dy -= smoothedX * MOUSE_SENSITIVITY;
      const pitchSign = gameState.firstPersonView ? 1 : -1;
      dp += pitchSign * smoothedY * MOUSE_SENSITIVITY;
    }

    // 3. Mobile Joystick (P1 Mobile)
    if (isP1 && isMobile && mobileController) {
      const inputs = mobileController.getInputs(player.ship, enemyManager.enemies, YAW_RATE, PITCH_RATE);
      dy += inputs.yawDelta + inputs.assistYaw;
      dp += inputs.pitchDelta + inputs.assistPitch;
      player.aimTarget = aimAssist.lastTracking.target;
    }

    // 4. Aim Assist (Desktop/Keyboard)
    const isKeyboardPlayer = !(isP1 && !isMobile && document.pointerLockElement);
    if (!isMobile && aimAssist.enabled && isKeyboardPlayer) {
      const assist = aimAssist.getAssistDeltas(player.ship, enemyManager.enemies, false);
      dy += assist.yawDelta;
      dp += assist.pitchDelta;
      player.aimTarget = aimAssist.lastTracking.target;
    }

    return { yaw: dy, pitch: dp };
  }

  /**
   * Standard mode-transition logic for input events (keyPressed, mousePressed, touchStarted).
   * Returns true if the input was consumed by a transition.
   */
  handleTransition(type, event) {
    const mode = gameState.mode;

    if (type === 'key') {
      return this._handleKeyTransition(mode, p.keyCode, p.key);
    } else if (type === 'mouse') {
      return this._handleMouseTransition(mode, p.mouseButton);
    } else if (type === 'touch') {
      return this._handleTouchTransition(mode);
    }

    return false;
  }

  _handleKeyTransition(mode, keyCode, key) {
    if (mode === 'menu') {
      if (key === '1') { globalThis.startGame(1); return true; }
      if (key === '2') { globalThis.startGame(2); return true; }
    }

    if (keyCode === 27) { // ESC
      if (mode === 'playing') { gameState.pauseGame(); return true; }
      if (mode === 'paused') { 
        gameState.resumeGame(); 
        if (!gameState.isMobile) p.requestPointerLock();
        return true; 
      }
    }

    if (mode === 'mission') { gameState.mode = 'instructions'; return true; }
    if (mode === 'instructions') {
      if (keyCode === p.ENTER || key === ' ' || key === '1' || key === '2') {
        gameState.mode = 'shipselect';
        return true;
      }
    }

    if (mode === 'shipselect') {
      // Standard ship selection keys (already in sketch.js, moving here later if needed)
      return false; 
    }

    if (mode === 'cockpitSelection') {
      if (keyCode === p.ENTER || key === ' ' || key === '1' || key === '2') {
        gameState.activatePlayingMode();
        return true;
      }
      if (key === 'o' || key === 'O') {
        gameState.firstPersonView = !gameState.firstPersonView;
        return true;
      }
    }

    return false;
  }

  _handleMouseTransition(mode, button) {
    if (gameState.isMobile) return false;
    
    const mouseX = p.mouseX;
    const mouseY = p.mouseY;

    if (mode === 'menu') {
      if (!this.hasClickedOnce) {
        if (typeof globalThis.shouldRequestFullscreen === 'function' && globalThis.shouldRequestFullscreen()) {
          p.fullscreen(true);
        }
        this.hasClickedOnce = true;
        return true;
      }
      globalThis.startGame(1);
      return true;
    }

    if (mode === 'mission') { gameState.mode = 'instructions'; return true; }

    if (mode === 'instructions') {
      if (mobileController) {
        let hit = mobileController.checkSettingsHit(mouseX, mouseY);
        if (hit === 'continue') { gameState.mode = 'shipselect'; return true; }
        if (hit) return true;
      }
      gameState.mode = 'shipselect';
      return true;
    }

    if (mode === 'paused') {
      const action = globalThis._handlePauseScreenHit(mouseX, mouseY);
      if (action === 'resume') { gameState.resumeGame(); p.requestPointerLock(); return true; }
      if (action === 'restart') { gameState.mode = 'menu'; gameState.pauseSnapshot = null; return true; }
    }

    if (mode === 'playing') {
      if (button === p.CENTER) {
        if (gameState.players.length > 0 && !gameState.players[0].dead) {
          gameState.players[0].weaponMode = (gameState.players[0].weaponMode + 1) % WEAPON_MODES.length;
          return true;
        }
      }
      p.requestPointerLock();
    }

    return false;
  }

  _handleTouchTransition(mode) {
    const mouseX = p.mouseX;
    const mouseY = p.mouseY;

    if (mode === 'menu' || mode === 'instructions') {
      if (typeof globalThis.shouldRequestFullscreen === 'function' && globalThis.shouldRequestFullscreen()) {
        p.fullscreen(true);
      }
    }

    if (mode === 'menu') { globalThis.startGame(1); return true; }
    if (mode === 'mission') { gameState.mode = 'instructions'; return true; }
    if (mode === 'instructions') {
      if (mobileController) {
        let hit = mobileController.checkSettingsHit(mouseX, mouseY);
        if (hit === 'continue') { gameState.mode = 'shipselect'; return true; }
      }
      return true;
    }
    if (mode === 'paused') {
      const action = globalThis._handlePauseScreenHit(mouseX, mouseY);
      if (action === 'resume') { gameState.resumeGame(); return true; }
      if (action === 'restart') { gameState.mode = 'menu'; gameState.pauseSnapshot = null; return true; }
    }

    return false;
  }
}

export const inputManager = new InputManager();
