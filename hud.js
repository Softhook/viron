// =============================================================================

const HUD_WEAPON_LABELS = ['NORMAL', 'MISSILE', 'BARRIER'];
const HUD_WEAPON_ACTIVE_COLS = [[255, 255, 255], [0, 220, 255], [255, 160, 20]];
const HUD_HINT_CACHE = Object.create(null);
const HUD_LABEL_CACHE = Object.create(null); // Static labels graphic per viewport size
const HUD_RADAR_BUFFERS = Object.create(null); // Graphics buffers for radar (one per player)
const RADAR_SCALE = 0.012;
const RADAR_HALF = 68;
const RADAR_TILE_RADIUS_SQ = 4200;

/**
 * Creates or retrieves a static graphics buffer containing the text labels
 * (SCORE, ALT, VIRON, etc.) to avoid expensive text rendering every frame.
 */
function _getHUDLabelGraphic(hw, h) {
  const key = `${hw}|${h}`;
  if (HUD_LABEL_CACHE[key]) return HUD_LABEL_CACHE[key];

  const g = createGraphics(hw, h);
  g.pixelDensity(1);
  g.clear();
  g.noStroke();
  g.textAlign(LEFT, TOP);
  if (typeof gameFont !== 'undefined') g.textFont(gameFont);

  let lx = 14;
  let ly = 0;

  g.fill(255, 255, 255); g.textSize(20); g.text('SCORE', lx, ly + 8);
  g.fill(0, 255, 0); g.textSize(16); g.text('ALT', lx, ly + 32);
  g.fill(255, 60, 60); g.textSize(14); g.text('VIRON', lx, ly + 54);
  g.fill(255, 100, 100); g.text('ENEMIES', lx, ly + 72);
  g.fill(0, 200, 255); g.text('MISSILES', lx, ly + 90);
  g.fill(220, 220, 220); g.text('SHOT', lx, ly + 108);

  HUD_LABEL_CACHE[key] = g;
  return g;
}

/**
 * Ensures a player has a dedicated graphics buffer for the radar.
 */
function _getRadarBuffer(pId, size) {
  if (HUD_RADAR_BUFFERS[pId]) return HUD_RADAR_BUFFERS[pId];
  const g = createGraphics(size, size);
  g.pixelDensity(1);
  HUD_RADAR_BUFFERS[pId] = g;
  return g;
}

function _getControlHintGraphic(hint, hw, h) {
  const key = `${hint}|${hw}|${h}`;
  let entry = HUD_HINT_CACHE[key];
  if (entry) return entry;

  const w = Math.max(8, hw);
  const g = createGraphics(w, 24);
  g.pixelDensity(1);
  g.clear();
  g.noStroke();
  g.textAlign(CENTER, BOTTOM);
  g.textSize(11);
  g.fill(255, 255, 255, 120);
  g.text(hint, w * 0.5, 20);
  HUD_HINT_CACHE[key] = g;
  return g;
}

// hud.js — HUD and menu rendering functions
//
// All 2D overlay rendering is handled here.  Every function that draws in 2D
// must call setup2DViewport() first (or work within an ortho projection set up
// by the caller) and end with pop() to restore the 3D camera state.
//
// Functions:
//   drawMenu        — full-screen animated title / start screen
//   drawGameOver    — full-screen game-over overlay with auto-return to menu
//   drawPlayerHUD   — per-player HUD (score, altitude, infection count, radar)
//   drawRadarForPlayer — circular mini-map rendered inside drawPlayerHUD
//   drawControlHints   — small control hint text at the bottom of the viewport
// =============================================================================

/**
 * Renders the animated title / start screen.
 *
 * Layers (back to front):
 *   1. Live 3D landscape rendered with a slow-panning camera (menuCam)
 *   2. Soft green glow behind the title (2D overlay)
 *   3. Drop-shadow + pulsing title text "V I R O N"
 *   4. Author credit
 *   5. CRT scanline overlay
 *   6. Blinking start prompt (desktop: "PRESS 1/2", mobile: "TAP TO START")
 *   7. Control hint line at the bottom
 */
function drawMenu() {
  drawBackgroundLandscape();

  // --- 2D Overlays ---
  setup2DViewport();

  // --- Glow halo behind the title ---
  let glowPulse = sin(frameCount * 0.04) * 0.3 + 0.7;
  noStroke();
  fill(160, 255, 10, 32 * glowPulse);
  ellipse(0, -height * 0.14, 580 * glowPulse, 170 * glowPulse);
  fill(120, 200, 5, 20 * glowPulse);
  ellipse(0, -height * 0.14, 820 * glowPulse, 240 * glowPulse);

  textAlign(CENTER, CENTER);
  noStroke();

  // Drop shadow layer
  fill(40, 80, 0, 100);
  textSize(110);
  text('V I R O N', 3, -height * 0.14 + 4);

  // Pulsing title — oscillates between the two infection tile greens
  let titlePulse = sin(frameCount * 0.06) * 0.5 + 0.5;  // 0..1
  fill(
    lerp(120, 160, titlePulse),
    lerp(200, 255, titlePulse),
    lerp(5, 10, titlePulse)
  );
  textSize(110);
  text('V I R O N', 0, -height * 0.14);

  // Author credit
  textSize(22);
  fill(140, 200, 140, 210);
  text('Christian Nold, 2026', 0, -height * 0.14 + 78);

  // CRT scanline overlay — subtle dark horizontal lines for retro feel
  // LATERAL OPT: Skip this loop on mobile to save 200+ line() calls.
  if (!isMobile) {
    stroke(0, 0, 0, 20); strokeWeight(1);
    for (let y = -height / 2; y < height / 2; y += 4) {
      line(-width / 2, y, width / 2, y);
    }
    noStroke();
  }

  // --- Start prompt (alternating blink phases for 1P / 2P options) ---
  let optY = height * 0.08;
  let blink1 = sin(frameCount * 0.08) * 0.3 + 0.7;
  let blink2 = sin(frameCount * 0.08 + 1.5) * 0.3 + 0.7;

  textSize(28);
  if (isMobile) {
    fill(255, 255, 255, 255 * blink1);
    text('TAP TO START', 0, optY + 25);
  } else {
    fill(255, 255, 255, 255 * blink1);
    text('PRESS 1 — SINGLE PLAYER', 0, optY);
    fill(255, 255, 255, 255 * blink2);
    text('PRESS 2 — MULTIPLAYER', 0, optY + 50);
  }

  // --- Control hint (bottom of screen) ---
  /*
  textSize(13);
  fill(100, 140, 100, 150);
  if (isMobile) {
    text('Use virtual joystick and buttons to play', 0, height / 2 - 40);
  } else {
    text('P1: w/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E cycle weapon  S brake  F/R tilt', 0, height / 2 - 55);
    text('P2: ARROWS turn  UP thrust  ;/\' tilt  . shoot  / cycle weapon  DOWN brake', 0, height / 2 - 35);
  }
  */

  pop();
}

/**
 * Renders the Instructions screen before ship selection.
 * Maintains the 3D background but adds a dark overlay for readability.
 */
function drawInstructions() {
  drawBackgroundLandscape();

  setup2DViewport();

  // Dim the 3D background
  fill(0, 0, 0, 180);
  noStroke();
  rect(-width / 2, -height / 2, width, height);

  textAlign(CENTER, CENTER);

  if (isMobile) {
    // --- Mobile Touch Screen Overlay ---
    if (typeof mobileController !== 'undefined') {
      // Draw the full-scale mobile zones forced to be visible
      mobileController.draw(width, height, true);
    }

    fill(255, 255, 255, 220);
    textSize(36);
    text('TOUCH CONTROLS', 0, -height * 0.42);

  } else {
    // --- Desktop Text Instructions ---
    fill(255, 255, 255, 220);
    textSize(48);
    text('HOW TO PLAY', 0, -height * 0.42);

    if (numPlayers === 1) {
      // Split single player controls: Mouse on left, Keyboard on right
      textSize(22);
      fill(200, 255, 200, 200);
      text('MOUSE CONTROLS', -width * 0.25, -height * 0.1);
      fill(255, 200, 200, 200);
      text('KEYBOARD ALTERNATIVES', width * 0.25, -height * 0.1);

      textSize(18);
      fill(255, 255, 255, 180);
      textAlign(CENTER, TOP);

      let my = -height * 0.02;
      let lh = 35;

      // Mouse list
      text('Pitch / Yaw: Move Mouse', -width * 0.25, my);
      text('Thrust: Right-Click', -width * 0.25, my + lh * 1);
      text('Shoot: Left-Click', -width * 0.25, my + lh * 2);
      text('Cycle Weapon: Middle-Click', -width * 0.25, my + lh * 3);

      // Keyboard list
      fill(255, 255, 255, 180);
      text('Forward Tilt: F', width * 0.25, my);
      text('Backward Tilt: R', width * 0.25, my + lh * 1);
      text('Thrust: W', width * 0.25, my + lh * 2);
      text('Brake: S', width * 0.25, my + lh * 3);
      text('Shoot: Q', width * 0.25, my + lh * 4);
      text('Cycle Weapon: E', width * 0.25, my + lh * 5);

    } else {
      // P1 vs P2 layout for 2 players
      textSize(22);
      fill(200, 255, 200, 200);
      text('P1 CONTROLS', -width * 0.25, -height * 0.1);

      textSize(18);
      fill(255, 255, 255, 180);
      textAlign(CENTER, TOP);
      let lh = 35;
      let p1y = -height * 0.02;

      text('Pitch / Yaw: Mouse', -width * 0.25, p1y);
      text('Forward Tilt: F', -width * 0.25, p1y + lh * 1);
      text('Backward Tilt: R', -width * 0.25, p1y + lh * 2);
      text('Thrust: W or Right-Click', -width * 0.25, p1y + lh * 3);
      text('Brake: S', -width * 0.25, p1y + lh * 4);
      text('Shoot: Q or Left-Click', -width * 0.25, p1y + lh * 5);
      text('Cycle Weapon: E or Middle-Click', -width * 0.25, p1y + lh * 6);

      fill(255, 200, 200, 200);
      textSize(22);
      text('P2 CONTROLS', width * 0.25, -height * 0.1);

      textSize(18);
      fill(255, 255, 255, 180);
      let p2y = -height * 0.02;
      text('Turn: Arrow Keys', width * 0.25, p2y);
      text('Forward Tilt: \' (Quote)', width * 0.25, p2y + lh * 1);
      text('Backward Tilt: ; (Semicolon)', width * 0.25, p2y + lh * 2);
      text('Thrust: Up Arrow', width * 0.25, p2y + lh * 3);
      text('Brake: Down Arrow', width * 0.25, p2y + lh * 4);
      text('Shoot: . (Period)', width * 0.25, p2y + lh * 5);
      text('Cycle Weapon: / (Slash)', width * 0.25, p2y + lh * 6);
    }
  }

  // Blinking continue prompt
  let blink = sin(frameCount * 0.1) * 0.5 + 0.5;
  fill(150, 255, 150, 255 * blink);
  textAlign(CENTER, CENTER);
  textSize(24);
  text(isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * 0.42);

  pop();
}

/**
 * Renders the full-screen game-over overlay.
 * Shows the game-over reason string (or a default message) and automatically
 * returns to the menu after 5 seconds.
 */
function drawGameOver() {
  setup2DViewport();
  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);  // Prevent 3D geometry bleeding through

  fill(255, 60, 60);
  textAlign(CENTER, CENTER);
  textSize(80);
  text('GAME OVER', 0, -50);

  textSize(24);
  fill(180, 200, 180);
  text(gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);

  pop();

  // Auto-return to menu after 5 seconds
  if (millis() - levelEndTime > 5000) {
    gameState = 'menu';
  }
}

/**
 * Renders the shared 3D landscape background used by the title and selection screens.
 * Pans the menuCam slowly around a low-altitude point in the world.
 */
function drawBackgroundLandscape() {
  let gl = drawingContext;
  let pxD = pixelDensity();

  // 1. Setup viewport and clear
  gl.viewport(0, 0, width * pxD, height * pxD);
  gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // 2. 3D Scene drawing
  push();
  perspective(PI / 3, width / height, 50, VIEW_FAR * TILE * 1.5);

  // Update panning animation
  menuCam.yaw += 0.0006;

  // Position camera low to the ground, panning in a circle
  let cx = menuCam.x + sin(menuCam.yaw) * 550;
  let cz = menuCam.z + cos(menuCam.yaw) * 550;
  let cy = -90;
  camera(cx, cy, cz, menuCam.x, -10, menuCam.z, 0, 1, 0);

  // Fake ship for culling / terrain logic
  let fakeShip = { x: menuCam.x, y: cy, z: menuCam.z, yaw: menuCam.yaw, pitch: 0 };

  setSceneLighting();
  terrain.drawLandscape(fakeShip, width / height);
  terrain.drawTrees(fakeShip);
  terrain.drawBuildings(fakeShip);
  pop();

  // 3. Reset depth for subsequent 2D/3D overlays
  gl.clear(gl.DEPTH_BUFFER_BIT);

}

/**
 * Main entry point for the Ship Select screen.
 * Handles split-screen division if two players are present.
 */
function drawShipSelect() {
  drawBackgroundLandscape();

  let pxD = pixelDensity();
  if (numPlayers === 1) {
    renderShipSelectView(players[0], 0, 0, width, height, pxD);
  } else {
    let hw = floor(width / 2);
    // Left view (P1)
    renderShipSelectView(players[0], 0, 0, hw, height, pxD);
    // Right view (P2)
    renderShipSelectView(players[1], 1, hw, hw, height, pxD);

    // Split screen divider overlay
    setup2DViewport();
    stroke(0, 255, 0, 180);
    strokeWeight(2);
    line(0, -height / 2, 0, height / 2);
    pop();
  }
}

/**
 * Renders the 3D ship preview and 2D selection text for a single player viewport.
 * @param {object} p   Player object.
 * @param {number} pi  Player index.
 * @param {number} vx  Viewport X.
 * @param {number} vw  Viewport Width.
 * @param {number} vh  Viewport Height.
 * @param {number} pxD Pixel density.
 */
function renderShipSelectView(p, pi, vx, vw, vh, pxD) {
  let gl = drawingContext;
  gl.viewport(vx * pxD, 0, vw * pxD, vh * pxD);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vx * pxD, 0, vw * pxD, vh * pxD);

  // Clear depth for the ship preview (background landscape is already drawn)
  gl.clear(gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, vw / vh, 1, 1000);
  camera(0, -15, 60, 0, 0, 0, 0, 1, 0);

  // Cinematic lighting
  directionalLight(255, 255, 255, 0.5, 1, -0.5);
  directionalLight(120, 180, 255, -0.5, -1, 0.5); // Cool rim light
  ambientLight(45, 45, 55);

  // Rotating ship presentation
  push();
  rotateY(frameCount * 0.018);
  rotateX(sin(frameCount * 0.012) * 0.15);
  noStroke(); // Ensure no stroke for the ship preview
  drawShipPreview(p.designIndex, p.labelColor);
  pop();
  pop();

  // --- 2D Overlay ---
  setup2DViewport();
  // Adjust ortho X for the viewport slice
  let relX = (vx + vw / 2) - width / 2;

  textAlign(CENTER, TOP);
  noStroke();

  // Title
  fill(255, 255, 255, 200);
  textSize(28);
  text("SELECT YOUR CRAFT", relX, -vh / 2 + 50);

  // Ship Details
  let design = SHIP_DESIGNS[p.designIndex];
  if (design) {
    // Ship Name (Largest)
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2]);
    textSize(54);
    text(design.name.toUpperCase(), relX, vh / 2 - 320);

    // Role (Gold)
    fill(255, 200, 0);
    textSize(20);
    text(design.role || "UNKNOWN ROLE", relX, vh / 2 - 270);

    // Thrust type label (Subtle)
    textSize(14);
    fill(180, 180, 180, 200);
    let thrustType = "VTOL / HOVER";
    if (design.isGroundVehicle) {
      thrustType = design.canTravelOnWater ? "AMPHIBIOUS HOVERCRAFT" : "GROUND VEHICLE";
    } else {
      if (design.thrustAngle > 0.1 && design.thrustAngle < 1.0) thrustType = "DIAGONAL THRUST";
      if (design.thrustAngle >= 1.0) thrustType = "JET / FORWARD THRUST";
    }
    text(thrustType, relX, vh / 2 - 245);

    // Description (Body text, wrapped)
    fill(220);
    textSize(14);
    rectMode(CENTER);
    text(design.desc || "", relX, vh / 2 - 215, vw * 0.85);
    rectMode(CORNER);

    // --- Stats Panel ---
    let statY = vh / 2 - 195;
    let statW = vw * 0.4;
    let statX = relX - statW / 2;

    const drawStat = (label, val, maxVal, row) => {
      let y = statY + row * 18;
      textAlign(RIGHT, TOP);
      fill(180);
      textSize(11);
      text(label, statX - 10, y + 2);

      // Bar background
      fill(40);
      rect(statX, y + 3, statW, 8, 2);
      // Bar fill (using player color)
      fill(p.labelColor[0], p.labelColor[1], p.labelColor[2], 200);
      let fillW = map(val, 0, maxVal, 0, statW, true);
      rect(statX, y + 3, fillW, 8, 2);
    };

    let effectiveThrust = (design.thrust || 0.45) / (design.mass || 1.0);
    let effectiveTurn = (design.turnRate || 0.04) / (design.mass || 1.0);

    drawStat("ACCEL", effectiveThrust, 1.6, 0);
    drawStat("AGILITY", effectiveTurn, 0.12, 1);
    drawStat("GLIDE", design.lift || 0.008, 0.02, 2);
    drawStat("MISSILES", design.missileCapacity || 1, 5, 3);

    textAlign(CENTER, TOP);
  }

  // Selection Hints / Mobile Buttons
  if (isMobile && !p.ready) {
    // Arrow buttons
    fill(255, 40);
    rect(relX - vw / 2 + 20, -40, 60, 80, 10);
    rect(relX + vw / 2 - 80, -40, 60, 80, 10);

    fill(255);
    textAlign(CENTER, CENTER);
    textSize(40);
    text("<", relX - vw / 2 + 50, 0);
    text(">", relX + vw / 2 - 50, 0);

    // Confirm button
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2], 120);
    rect(relX - 120, vh / 2 - 100, 240, 60, 30);
    fill(255);
    textSize(22);
    text("CONFIRM", relX, vh / 2 - 70);
    textAlign(CENTER, TOP);
  } else if (!p.ready) {
    /*
    textSize(16);
    fill(200, 200, 200, 150);
    let hint = (pi === 0) ? "A / D TO CYCLE \u2022 ENTER TO READY" : "ARROWS TO CYCLE \u2022 . TO READY";
    if (numPlayers === 1) hint = "LEFT / RIGHT TO CYCLE \u2022 ENTER TO START";
    text(hint, relX, vh / 2 - 35);
    */
  }

  // Ready State
  if (p.ready) {
    fill(0, 255, 0);
    textSize(36);
    text("READY", relX, 0);
  }

  pop();
  gl.disable(gl.SCISSOR_TEST);
}

/**
 * Draws the ship geometry for the ship select preview.
 * Reuses the SHIP_DESIGNS draw functions but without the terrain shader overhead.
 * @param {number} designIdx Index of the ship design.
 * @param {number[]} tintColor RGB player color.
 */
function drawShipPreview(designIdx, tintColor) {
  let design = SHIP_DESIGNS[designIdx];
  if (!design) return;

  let r = tintColor[0], g = tintColor[1], b = tintColor[2];
  let dark = [r * 0.4, g * 0.4, b * 0.4];
  let light = [lerp(r, 255, 0.4), lerp(g, 255, 0.4), lerp(b, 255, 0.4)];
  let engineGray = [80, 80, 85];

  noStroke(); // Final safety for in-game look

  const drawFace = (pts, col) => {
    fill(col[0], col[1], col[2], col[3] || 255);
    beginShape();
    for (let p of pts) {
      vertex(p[0], p[1], p[2]);
    }
    endShape(CLOSE);
  };

  // Mock transform and ship state for the preview
  const transform = (pt) => pt;
  const sFake = { pitch: 0, yaw: 0 };

  design.draw(drawFace, tintColor, engineGray, light, dark, false, sFake, transform);
}

/**
 * Renders the 2D HUD overlay for one player within their viewport slice.
 *
 * Displays (top-left):
 *   P#  player number in label colour
 *   SCORE, ALT, INF (infection count), ENEMIES, MISSILES
 *
 * Displays (top-right):
 *   LVL #
 *
 * Also shows a "DESTROYED / Respawning..." message when the player is dead,
 * then calls drawRadarForPlayer and drawControlHints.
 *
 * @param {object} p   Player state object.
 * @param {number} pi  Player index (0 or 1) — used for the "P#" label.
 * @param {number} hw  Viewport half-width in pixels.
 * @param {number} h   Viewport height in pixels.
 */
function drawPlayerHUD(p, pi, viewW, viewH) {
  let hw = viewW, h = viewH;
  let s = p.ship;

  push();
  if (typeof gameFont !== 'undefined') textFont(gameFont);
  // Set up an orthographic 2D projection for this viewport slice
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();

  // Reset imageMode to ensure CORNER works as expected for cached graphics
  imageMode(CORNER);

  let lx = -hw / 2 + 14;
  let ly = -h / 2;

  // 1. Draw cached static labels for stat names
  image(_getHUDLabelGraphic(hw, h), -hw / 2, -h / 2);

  // 2. Draw dynamic stat values (inline text calls are still needed for dynamic data)
  let vx = lx + 80; // value column X offset
  fill(255); textSize(20); text(p.score, vx, ly + 8);
  fill(0, 255, 0); textSize(16); text(max(0, floor(SEA - s.y)), vx, ly + 32);
  fill(255, 60, 60); textSize(14); text(infection.count, vx, ly + 54);
  fill(255, 100, 100); text(enemyManager.enemies.length, vx, ly + 72);
  fill(0, 200, 255); text(p.missilesRemaining, vx, ly + 90);
  fill(220); text((NORMAL_SHOT_MODE_LABELS[p.normalShotMode] || 'SINGLE'), vx, ly + 108);

  // --- Crosshair (first-person reticle — only shown in first-person mode) ---
  if (typeof firstPersonView !== 'undefined' && firstPersonView) {
    stroke(0, 255, 0, 150);
    strokeWeight(2);
    noFill();
    ellipse(0, 0, 30, 30);
    line(-20, 0, 20, 0);
    line(0, -20, 0, 20);
  }

  // --- Respawn Indicator ---
  if (p.dead && !p.gameOver) {
    textAlign(CENTER);
    fill(255, 255, 0, 200);
    textSize(32);
    text('Respawning...', 0, 30);
  }

  drawRadarForPlayer(p, hw, h);
  // drawControlHints(p, pi, hw, h); // Removed to hide control hints during gameplay

  // --- Weapon Selector Indicator (top-centre) ---
  let wId = p.weaponMode;
  let wName = HUD_WEAPON_LABELS[wId];
  let wCol = HUD_WEAPON_ACTIVE_COLS[wId];

  textAlign(CENTER, TOP);
  textSize(18);
  fill(wCol[0], wCol[1], wCol[2], 230);
  text(wName, 0, -h / 2 + 10);

  // Selector boxes
  let bw = 60, bh = 6, pad = 8;
  let totalW = (bw + pad) * 3 - pad;
  let sx = -totalW / 2;
  let sy = -h / 2 + 34;

  rectMode(CORNER);
  noStroke();
  for (let i = 0; i < 3; i++) {
    if (i === wId) {
      fill(wCol[0], wCol[1], wCol[2], 255);
    } else {
      fill(50, 50, 50, 150);
    }
    rect(sx + i * (bw + pad), sy, bw, bh);
  }

  pop();
}

/**
 * Renders a circular mini-map radar in the top-right corner of the player's viewport.
 *
 * Performance Optimization:
 * 1. Mobile-only: Throttled to 30fps (every 2nd frame) to recover frame budget.
 * 2. Spatial Query: Only iterates nearby infection chunks.
 * 3. Batching: Uses POINTS for all markers (1 vertex vs 4-6).
 * 4. Buffering: Draws to a Graphics buffer and skip frames properly without flickering.
 *
 * @param {object} p        Player state.
 * @param {number} hw       Viewport half-width.
 * @param {number} h        Viewport height.
 */
function drawRadarForPlayer(p, hw, h) {
  let s = p.ship;
  let radarSize = 150;
  let gb = _getRadarBuffer(p.id, radarSize);

  // Throttled update on mobile: redraw into buffer every 2nd frame
  const shouldUpdate = !isMobile || (frameCount + p.id) % 2 === 0;

  if (shouldUpdate) {
    gb.clear();
    gb.push();
    gb.translate(radarSize / 2, radarSize / 2);

    // 1. Radar frame
    gb.fill(0, 180); gb.stroke(0, 255, 0, 150); gb.strokeWeight(1.5);
    gb.rectMode(CENTER);
    gb.rect(0, 0, radarSize, radarSize);

    // Rotation setup
    let yawSin = sin(s.yaw), yawCos = cos(s.yaw);

    // 2. Viron tiles (Batch with POINTS)
    let shipTX = toTile(s.x), shipTZ = toTile(s.z);
    let shipCX = Math.floor(shipTX / CHUNK_SIZE), shipCZ = Math.floor(shipTZ / CHUNK_SIZE);

    gb.stroke(255, 50, 50, 235);
    gb.strokeWeight(3);
    gb.beginShape(POINTS);
    for (let dcz = -3; dcz <= 3; dcz++) {
      for (let dcx = -3; dcx <= 3; dcx++) {
        let bucket = infection.buckets.get(`${shipCX + dcx},${shipCZ + dcz}`);
        if (!bucket) continue;
        for (let t of bucket) {
          let rx = (t.tx * TILE - s.x) * RADAR_SCALE;
          let rz = (t.tz * TILE - s.z) * RADAR_SCALE;
          let rrx = rx * yawCos - rz * yawSin;
          let rrz = rx * yawSin + rz * yawCos;
          if (abs(rrx) < RADAR_HALF && abs(rrz) < RADAR_HALF) {
            gb.vertex(rrx, rrz);
          }
        }
      }
    }
    gb.endShape();

    // 3. Enemy markers (Batch with POINTS)
    if (enemyManager.enemies.length > 0) {
      gb.stroke(170, 255, 50);
      gb.strokeWeight(4);
      gb.beginShape(POINTS);
      for (let e of enemyManager.enemies) {
        let rx = (e.x - s.x) * RADAR_SCALE;
        let rz = (e.z - s.z) * RADAR_SCALE;
        let rrx = rx * yawCos - rz * yawSin;
        let rrz = rx * yawSin + rz * yawCos;
        if (abs(rrx) < RADAR_HALF && abs(rrz) < RADAR_HALF) {
          gb.vertex(rrx, rrz);
        }
      }
      gb.endShape();
    }

    // 4. Launchpad centre marker
    let lx = (420 - s.x) * RADAR_SCALE, lz = (420 - s.z) * RADAR_SCALE;
    let rlx = lx * yawCos - lz * yawSin, rlz = lx * yawSin + lz * yawCos;
    if (abs(rlx) < RADAR_HALF && abs(rlz) < RADAR_HALF) {
      gb.stroke(0, 150, 255, 220); gb.strokeWeight(5);
      gb.point(rlx, rlz);
    }

    // 5. Co-op partner
    let other = players[1 - p.id];
    if (other && !other.dead) {
      let ox = (other.ship.x - s.x) * RADAR_SCALE, oz = (other.ship.z - s.z) * RADAR_SCALE;
      let rox = ox * yawCos - oz * yawSin, roz = ox * yawSin + oz * yawCos;
      if (abs(rox) < RADAR_HALF && abs(roz) < RADAR_HALF) {
        gb.stroke(other.labelColor[0], other.labelColor[1], other.labelColor[2], 200);
        gb.strokeWeight(5);
        gb.point(rox, roz);
      }
    }

    // 6. Own ship
    gb.stroke(255); gb.strokeWeight(5);
    gb.point(0, 0);

    gb.pop();
  }

  // Always draw the buffered radar to the screen (at 60fps, even if content updates at 30fps)
  push();
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();
  imageMode(CENTER);
  translate(floor(hw / 2 - radarSize / 2 - 4), floor(-h / 2 + radarSize / 2 + 4));
  image(gb, 0, 0);
  pop();
}


/**
 * Renders one-line keyboard/touch control hints at the bottom of the viewport.
 * Hidden on mobile (replaced by the on-screen button overlay in mobileControls.js).
 * @param {object} p   Player state (unused, kept for API consistency).
 * @param {number} pi  Player index — used to show P1 vs P2 bindings.
 * @param {number} hw  Viewport half-width.
 * @param {number} h   Viewport height.
 */
function drawControlHints(p, pi, hw, h) {
  if (isMobile) return;
  push();
  imageMode(CENTER);
  let hints = '';
  if (numPlayers === 1) {
    hints = 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E cycle weapon  S brake  F/R tilt';
  } else {
    hints = pi === 0
      ? 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E cycle weapon  S brake  F/R tilt'
      : '\u2191 thrust  \u2190/\u2192 turn  ;/\' tilt  . shoot  / cycle weapon  \u2193 brake';
  }
  const g = _getControlHintGraphic(hints, hw, h);
  image(g, 0, h / 2 - 12);
  pop();
}
