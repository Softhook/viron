// =============================================================================
// hudScreens.js — Full-screen UI logic and game state screens
//
// @exports   drawMenu()           — main menu screen
// @exports   drawMission()        — mission briefing screen
// @exports   drawInstructions()   — instructions screen
// @exports   drawShipSelect()     — ship selection screen
// @exports   drawGameOver()       — game over screen
// @exports   drawPauseScreen()    — pause overlay
// @exports   HUD_Screens          — namespace: drawCockpitSelection()
// =============================================================================

import { p } from './p5Context.js';
import {
  UI_TYPE_TITLE, UI_TYPE_HEADER, UI_TYPE_BODY, UI_TYPE_HINT, UI_TYPE_PROMPT,
  UI_LAYOUT_TITLE_Y, UI_LAYOUT_HEADER_Y, UI_LAYOUT_BODY_Y, UI_LAYOUT_PROMPT_Y,
  HUD_Manager
} from './hudCore.js';
import { SHIP_DESIGNS } from './shipDesigns.js';
import { gameState } from './gameState.js';
import { mobileController } from './mobileControls.js';
import { drawBackgroundLandscape, setup2DViewport } from './gameRenderer.js';

/**
 * Sets up the p.perspective p.camera and scene lights for a 3D ship preview.
 * Both the ship-select and cockpit-selection screens share identical p.camera
 * positioning and lighting; this helper eliminates the duplication.
 * @param {number} vw          Viewport p.width in canvas pixels.
 * @param {number} vh          Viewport p.height in canvas pixels.
 * @param {number} keyLightB   Blue channel of the p.key directional light (default 255 = neutral
 *                             white; use 220 for the slightly warmer cockpit-selection tone).
 * @private
 */
function _setupShipPreviewCamera(vw, vh, keyLightB = 255) {
  p.perspective(p.PI / 3, vw / vh, 1, 1000);
  p.camera(0, -15, 60, 0, 0, 0, 0, 1, 0);
  p.directionalLight(255, 255, keyLightB, 0.5, 1, -0.5);
  p.directionalLight(120, 180, 255, -0.5, -1, 0.5);
  p.ambientLight(45, 45, 55);
}

/**
 * Sets up the background landscape, 2D viewport, and dim overlay — the shared
 * preamble for every full-screen menu.  The caller MUST call p.pop() when done.
 * @private
 */
function _beginFullScreenUI() {
  drawBackgroundLandscape();
  setup2DViewport();
  HUD_Manager.drawDimOverlay();
}

/**
 * Draws the blinking "continue" prompt.
 * On desktop it always shows "PRESS ENTER TO CONTINUE".
 * On mobile it shows "TAP TO CONTINUE" only when hideOnMobile is false
 * (screens where the mobile controller provides its own CONTINUE button
 * pass true so no duplicate prompt is rendered).
 * @private
 */
function _drawContinuePrompt(hideOnMobile = true) {
  if (gameState.isMobile && hideOnMobile) return;
  const blink = Math.sin(p.frameCount * 0.1) * 0.5 + 0.5;
  p.fill(150, 255, 150, 255 * blink);
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(UI_TYPE_PROMPT);
  p.text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, p.height * UI_LAYOUT_PROMPT_Y);
}

/**
 * Updates and draws the mobile controller overlay when on a mobile device.
 * No-ops on desktop or when mobileController is not available.
 * @private
 */
function _drawMobileController() {
  if (!gameState.isMobile || !mobileController) return;
  mobileController.update(p.touches, p.width, p.height);
  mobileController.draw(p.width, p.height);
}

/**
 * Standardized screen title rendering.
 * @private
 */
function _drawScreenTitle(label, xOffset = 0) {
  const titleSize = gameState.isMobile ? UI_TYPE_TITLE * 0.6 : UI_TYPE_TITLE * 0.8;
  p.textAlign(p.CENTER, p.TOP);
  p.fill(255, 255, 255, 220);
  p.textSize(titleSize);
  p.text(label.toUpperCase(), xOffset, p.height * UI_LAYOUT_TITLE_Y);
}

/**
 * Renders the primary ship details p.text for the selection screen.
 * @private
 */
function _renderShipDetails(player, design, relX, vw, vh) {
  if (!design) return;

  _drawScreenTitle("SELECT YOUR CRAFT", relX);

  p.fill(...player.labelColor);
  p.textSize(UI_TYPE_TITLE);
  p.text(design.name.toUpperCase(), relX, vh / 2 - 320);

  p.fill(220);
  p.textSize(UI_TYPE_BODY);
  p.rectMode(p.CENTER);
  p.text(design.desc || "", relX, vh / 2 - 215, vw * 0.85);
  p.rectMode(p.CORNER);
}

/**
 * Renders ship statistics bars for the selection screen.
 * @private
 */
function _drawShipStats(player, design, relX, vw, vh) {
  if (!design) return;

  const statY = vh / 2 - 195;
  const statW = vw * 0.4;
  const statX = relX - statW / 2;

  const stats = [
    { label: "SPEED", val: (design.thrust || 0.45) / (1 - (design.drag || 0.992)), max: 250 },
    { label: "AGILITY", val: (design.turnRate || 0.04) / (design.mass || 1.0), max: 0.12 },
    { label: "GLIDE", val: 1 / (1 - (design.drag || 0.992)), max: 350 },
    { label: "LIFT", val: design.lift || 0.0, max: 0.02 },
    { label: "MISSILES", val: design.startingMissiles ?? design.missileCapacity ?? 1, max: 5 }
  ];

  stats.forEach((s, i) => {
    const y = statY + i * 18;
    p.textAlign(p.RIGHT, p.TOP);
    p.fill(180);
    p.textSize(UI_TYPE_HINT);
    p.text(s.label, statX - 10, y + 2);

    p.fill(40);
    p.rect(statX, y + 3, statW, 8, 2);
    p.fill(player.labelColor[0], player.labelColor[1], player.labelColor[2], 200);
    const fillW = p.map(s.val, 0, s.max, 0, statW, true);
    p.rect(statX, y + 3, fillW, 8, 2);
  });
}

/**
 * Renders the animated title / start screen.
 */
export function drawMenu() {
  _beginFullScreenUI();

  let glowPulse = Math.sin(p.frameCount * 0.04) * 0.3 + 0.7;

  p.noStroke();
  p.fill(255, 220, 10, 32 * glowPulse);
  p.ellipse(0, -p.height * 0.14, 580 * glowPulse, 170 * glowPulse);
  p.fill(200, 180, 5, 20 * glowPulse);
  p.ellipse(0, -p.height * 0.14, 820 * glowPulse, 240 * glowPulse);

  p.textAlign(p.CENTER, p.CENTER);
  p.noStroke();

  p.fill(40, 80, 0, 100);
  p.textSize(110);
  p.text('V I R O N', 3, -p.height * 0.14 + 4);

  let titlePulse = Math.sin(p.frameCount * 0.06) * 0.5 + 0.5;
  p.fill(p.lerp(220, 255, titlePulse), p.lerp(180, 255, titlePulse), p.lerp(0, 50, titlePulse));
  p.textSize(110);
  p.text('V I R O N', 0, -p.height * 0.14);

  p.textSize(22);
  p.fill(140, 200, 140, 210);
  p.text('Christian Nold, 2026', 0, -p.height * 0.14 + 78);

  if (!gameState.isMobile) {
    p.stroke(0, 0, 0, 20); p.strokeWeight(1);
    for (let y = -p.height / 2; y < p.height / 2; y += 4) {
      p.line(-p.width / 2, y, p.width / 2, y);
    }
    p.noStroke();
  }

  let optY = p.height * 0.08;
  let blink1 = Math.sin(p.frameCount * 0.08) * 0.3 + 0.7;
  let blink2 = Math.sin(p.frameCount * 0.08 + 1.5) * 0.3 + 0.7;

  p.textSize(28);
  if (gameState.isMobile) {
    p.fill(255, 255, 255, 255 * blink1);
    p.text('TAP TO START', 0, optY + 25);
  } else {
    p.fill(255, 255, 255, 255 * blink1);
    p.text('PRESS 1 — SINGLE PLAYER', 0, optY);
    p.fill(255, 255, 255, 255 * blink2);
    p.text('PRESS 2 — SPLIT SCREEN 2 PLAYER', 0, optY + 50);
  }
  p.pop();
}

/**
 * Renders the Mission Briefing screen.
 */
export function drawMission() {
  _beginFullScreenUI();

  p.textAlign(p.CENTER, p.CENTER);

  _drawScreenTitle('MISSION BRIEFING');

  p.fill(200, 255, 200, 200);
  const headerSize = gameState.isMobile ? UI_TYPE_HEADER * 0.7 : UI_TYPE_HEADER;
  p.textSize(headerSize);
  p.text('OBJECTIVE: VIRAL CONTAINMENT', 0, p.height * UI_LAYOUT_HEADER_Y);

  const bodySize = gameState.isMobile ? UI_TYPE_BODY * 0.85 : UI_TYPE_BODY;
  p.fill(220, 220, 220);
  p.textSize(bodySize);
  p.textAlign(p.CENTER, p.TOP);
  p.rectMode(p.CENTER);
  let briefing =
    "A virus is being spread by aliens. " +
    "Left unchecked, it will take over the planet.\n\n" +
    "Your mission:\n\n" +
    "1. ELIMINATE aliens spreading the virus.\n" +
    "2. CONTAIN the virus spread\n" +
    "3. PROTECT the temples.";

  p.text(briefing, 0, p.height * UI_LAYOUT_BODY_Y, Math.min(p.width * 0.85, 700));
  p.rectMode(p.CORNER);

  _drawContinuePrompt(false); // show on mobile too (no controller CONTINUE button on this screen)

  p.pop();
}

/**
 * Renders the Instructions screen.
 */
export function drawInstructions() {
  _beginFullScreenUI();

  p.textAlign(p.CENTER, p.CENTER);

  if (gameState.isMobile) {
    _drawMobileController();
  } else {
    _drawScreenTitle('HOW TO PLAY');


    const drawConfig = (title, color, items, side) => {
      const tx = p.width * 0.25 * side;
      const ty = p.height * UI_LAYOUT_HEADER_Y;
      const my = ty + 40;
      const lh = 36;
      p.textAlign(p.CENTER, p.TOP);
      p.textSize(UI_TYPE_HEADER * 0.7);
      p.fill(...color, 200);
      p.text(title, tx, ty);
      p.textSize(UI_TYPE_BODY * 0.9);
      p.fill(255, 255, 255, 180);
      items.forEach((item, i) => {
        p.text(item, tx, my + lh * i);
      });
    };

    if (gameState.numPlayers === 1) {
      drawConfig('MOUSE CONTROLS', [200, 255, 200], ['Pitch / Yaw: Move Mouse', 'Thrust: Right-Click', 'Shoot: Left-Click', 'Cycle Weapon: Middle-Click'], -1);
      drawConfig('KEYBOARD ALTERNATIVES', [255, 200, 200], ['Forward Tilt: F', 'Backward Tilt: R', 'Thrust: W', 'Brake: S', 'Shoot: Q', 'Cycle Weapon: E'], 1);
    } else {
      drawConfig('P1 CONTROLS', [200, 255, 200], ['Pitch / Yaw: Mouse', 'Forward Tilt: F', 'Backward Tilt: R', 'Thrust: W or Right-Click', 'Brake: S', 'Shoot: Q or Left-Click', 'Cycle Weapon: E or Middle-Click'], -1);
      drawConfig('P2 CONTROLS', [255, 200, 200], ['Turn: Arrow Keys', 'Forward Tilt: \' (Quote)', 'Backward Tilt: ; (Semicolon)', 'Thrust: Up Arrow', 'Brake: Down Arrow', 'Shoot: . (Period)', 'Cycle Weapon: / (Slash)'], 1);
    }
  }

  _drawContinuePrompt();
  p.pop();
}

/**
 * Renders the Cockpit View Selection screen.
 */
function drawCockpitSelection() {
  _beginFullScreenUI();

  // Draw 3D ship preview in the center
  p.push();
  const vw = p.width / gameState.numPlayers;
  const pxD = p.pixelDensity();

  for (let pi = 0; pi < gameState.players.length; pi++) {
    const player = gameState.players[pi];
    const vx = pi * vw;

    // Set up viewport for this player's ship preview
    p.drawingContext.viewport(vx * pxD, 0, vw * pxD, p.height * pxD);
    p.drawingContext.clear(p.drawingContext.DEPTH_BUFFER_BIT);

    // On mobile, the mobileController handles the 3D ship preview to support touch rotation.
    // We only render it here for non-mobile devices.
    if (!gameState.isMobile) {
      p.push();
      _setupShipPreviewCamera(vw, p.height, 220);

      p.push();
      p.rotateY(p.frameCount * 0.012);
      p.rotateX(Math.sin(p.frameCount * 0.008) * 0.1);
      p.noStroke();
      if (!gameState.firstPersonView) {
        drawShipPreview(player.designIndex, player.labelColor);
      }
      p.pop();
      p.pop();
    }
  }
  p.pop();

  setup2DViewport();

  p.textAlign(p.CENTER, p.CENTER);

  if (gameState.isMobile) {
    _drawMobileController();
  } else {
    _drawScreenTitle('SELECT VIEW MODE');

    p.fill(200, 255, 200, 200);
    p.textSize(UI_TYPE_HEADER);
    const viewMode = gameState.firstPersonView ? "COCKPIT" : "BEHIND CRAFT";
    p.text('CURRENT VIEW: ' + viewMode, 0, 0);

    p.textSize(UI_TYPE_BODY);
    p.fill(255, 255, 255, 180);
    p.text("PRESS 'O' KEY TO TOGGLE VIEW", 0, 40);

    if (gameState.firstPersonView) {
      // Draw crosshair overlay preview
      p.stroke(0, 255, 0, 150);
      p.strokeWeight(2);
      p.noFill();
      p.ellipse(0, 0, 60, 60);
      p.line(-40, 0, 40, 0);
      p.line(0, -40, 0, 40);
    }
  }

  _drawContinuePrompt();
  p.pop();
}

/**
 * Draws the game-over p.text content.
 * @private
 */
function _drawGameOverContent() {
  p.drawingContext.clear(p.drawingContext.DEPTH_BUFFER_BIT);

  if (gameState.gameFont) p.textFont(gameState.gameFont);
  p.fill(255, 60, 60);
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(80);
  p.text('GAME OVER', 0, -50);

  p.textSize(24);
  p.fill(180, 200, 180);
  p.text(gameState.gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);

  p.textSize(18);
  p.fill(180, 200, 180, 160);
  p.text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, p.height * 0.35);

  if (p.millis() - gameState.levelEndTime > 5000) {
    gameState.mode = 'menu';
  }
}

/**
 * Renders the full-screen game-over overlay.
 */
export function drawGameOver() {
  setup2DViewport();
  HUD_Manager.drawDimOverlay();
  _drawGameOverContent();
  p.pop();
}

/**
 * Renders the Pause screen overlay.
 */
export function drawPauseScreen() {
  setup2DViewport();
  if (gameState.pauseSnapshot) {
    p.push();
    p.imageMode(p.CENTER);
    p.image(gameState.pauseSnapshot, 0, 0, p.width, p.height);
    p.pop();
  }

  HUD_Manager.drawDimOverlay();

  p.textAlign(p.CENTER, p.CENTER);
  if (gameState.gameFont) p.textFont(gameState.gameFont);

  p.fill(0, 255, 136);
  p.textSize(80);
  p.text('PAUSED', 0, -100);

  const btnW = 280, btnH = 60, spacing = 40;
  _drawMenuButton('RESUME', 0, 20, btnW, btnH, [0, 255, 136]);
  _drawMenuButton('RESTART', 0, 20 + btnH + spacing, btnW, btnH, [255, 60, 60]);

  p.textSize(18);
  p.fill(255, 200);
  p.text(gameState.isMobile ? '' : 'PRESS ESC TO RESUME', 0, 20 + btnH + spacing + 80);
  p.pop();
}

/**
 * Helper to draw a styled menu button.
 * @private
 */
function _drawMenuButton(label, x, y, w, h, col) {
  p.rectMode(p.CENTER);
  p.fill(0, 200);
  p.rect(x + 4, y + 4, w, h, 12);
  p.fill(col[0] * 0.2, col[1] * 0.2, col[2] * 0.2, 255);
  p.stroke(col[0], col[1], col[2], 255);
  p.strokeWeight(2);
  p.rect(x, y, w, h, 12);
  p.noStroke();
  p.fill(255);
  p.textSize(28);
  p.text(label, x, y);
  p.rectMode(p.CORNER);
}

/**
 * Main entry point for the Ship Select screen.
 */
export function drawShipSelect() {
  drawBackgroundLandscape();
  let pxD = p.pixelDensity();
  if (gameState.numPlayers === 1) {
    renderShipSelectView(gameState.players[0], 0, p.width, p.height, pxD);
  } else {
    let hw = Math.floor(p.width / 2);
    renderShipSelectView(gameState.players[0], 0, hw, p.height, pxD);
    renderShipSelectView(gameState.players[1], hw, hw, p.height, pxD);
    setup2DViewport();
    p.stroke(0, 255, 0, 180); p.strokeWeight(2);
    p.line(0, -p.height / 2, 0, p.height / 2);
    p.pop();
  }
}

/**
 * Renders the 3D ship preview and 2D selection p.text.
 */
function renderShipSelectView(player, vx, vw, vh, pxD) {
  let gl = p.drawingContext;
  gl.viewport(vx * pxD, 0, vw * pxD, vh * pxD);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vx * pxD, 0, vw * pxD, vh * pxD);
  gl.clear(gl.DEPTH_BUFFER_BIT);

  p.push();
  _setupShipPreviewCamera(vw, vh);

  p.push();
  p.rotateY(p.frameCount * 0.018);
  p.rotateX(Math.sin(p.frameCount * 0.012) * 0.15);
  p.noStroke();
  drawShipPreview(player.designIndex, player.labelColor);
  p.pop();
  p.pop();

  setup2DViewport();

  // Handle smooth transitions
  HUD_Manager.drawDimOverlay();

  let relX = (vx + vw / 2) - p.width / 2;

  p.noStroke();
  const design = SHIP_DESIGNS[player.designIndex];
  _renderShipDetails(player, design, relX, vw, vh);
  _drawShipStats(player, design, relX, vw, vh);

  if (!player.ready) {
    const arrowX = 220; // Distance from center
    const arrowW = 60, arrowH = 80;
    
    p.textAlign(p.CENTER, p.CENTER);
    p.fill(255, 60);
    p.stroke(255, 100);
    p.strokeWeight(2);
    
    // Left Arrow
    p.rect(relX - arrowX - arrowW/2, -arrowH/2, arrowW, arrowH, 10);
    // Right Arrow
    p.rect(relX + arrowX - arrowW/2, -arrowH/2, arrowW, arrowH, 10);
    
    p.noStroke();
    p.fill(255);
    p.textSize(44);
    p.text("<", relX - arrowX, 0);
    p.text(">", relX + arrowX, 0);

    p.fill(player.labelColor[0], player.labelColor[1], player.labelColor[2], 120);
    p.rect(relX - 120, vh / 2 - 100, 240, 60, 30);
    p.fill(255); 
    p.textSize(22);
    p.text("CONFIRM", relX, vh / 2 - 70);
    p.textAlign(p.CENTER, p.TOP);
  }

  if (player.ready) {
    p.fill(0, 255, 0); p.textSize(36); p.textAlign(p.CENTER, p.CENTER);
    p.text("READY", relX, 0);
  }
  p.pop();
  gl.disable(gl.SCISSOR_TEST);
}

/**
 * Draws the ship geometry for preview.
 */
function drawShipPreview(designIdx, tintColor) {
  let design = SHIP_DESIGNS[designIdx];
  if (!design) return;

  let r = tintColor[0], g = tintColor[1], b = tintColor[2];
  let dark = [r * 0.4, g * 0.4, b * 0.4];
  let light = [p.lerp(r, 255, 0.4), p.lerp(g, 255, 0.4), p.lerp(b, 255, 0.4)];
  let engineGray = [80, 80, 85];

  p.noStroke();
  const drawFace = (pts, col, xform) => {
    const activeTransform = xform || transform;
    p.fill(col[0], col[1], col[2], col[3] || 255);
    p.beginShape();
    for (let pt of pts) {
      let t = activeTransform(pt);
      p.vertex(t[0], t[1], t[2]);
    }
    p.endShape(p.CLOSE);
  };
  const sFake = { pitch: 0, yaw: 0 };
  const transform = (pt) => pt;
  design.draw(drawFace, tintColor, engineGray, light, dark, false, sFake, transform, transform);
}

/**
 * HUD_Screens: Collection of screen-rendering logic.
 */
export function _shipSelectHit(mx, my, isTouch) {
  const vw = p.width / gameState.numPlayers;
  const playerIdx = Math.floor(mx / vw);
  if (playerIdx >= gameState.players.length) return;
  const player = gameState.players[playerIdx];
  if (player.ready) return;

  const localX = mx % vw;
  const centerX = vw / 2;
  const arrowOffset = 220;
  const arrowHitWidth = isTouch ? 120 : 80;

  let arrowHit = false;
  if (my > p.height / 2 - 60 && my < p.height / 2 + 60) {
    if (localX > centerX - arrowOffset - arrowHitWidth / 2 && localX < centerX - arrowOffset + arrowHitWidth / 2) {
      player.designIndex = (player.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
      arrowHit = true;
    } else if (localX > centerX + arrowOffset - arrowHitWidth / 2 && localX < centerX + arrowOffset + arrowHitWidth / 2) {
      player.designIndex = (player.designIndex + 1) % SHIP_DESIGNS.length;
      arrowHit = true;
    }
  }

  if (!arrowHit) {
    const isConfirmHit = my > p.height - 110 && localX > centerX - 130 && localX < centerX + 130;
    if (isConfirmHit || !isTouch) player.ready = true;
  }

  if (gameState.players.every(plr => plr.ready)) {
    gameState.mode = 'cockpitSelection';
  }
}

export const HUD_Screens = {
  drawMenu,
  drawMission,
  drawInstructions,
  drawCockpitSelection,
  drawShipSelect,
  drawGameOver,
  drawPauseScreen
};
