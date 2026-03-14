// =============================================================================

const HUD_WEAPON_LABELS = ['NORMAL', 'MISSILE', 'BARRIER'];
const HUD_WEAPON_ACTIVE_COLS = [[255, 255, 255], [0, 220, 255], [255, 160, 20]];
const HUD_HINT_CACHE = Object.create(null);
const HUD_LABEL_CACHE = Object.create(null); // Static labels graphic per viewport size
const HUD_RADAR_BUFFERS = Object.create(null); // Graphics buffers for radar (one per player)
const HUD_WEAPON_BUFFERS = Object.create(null); // Cached weapon-selector graphic per player id, rebuilt on weaponMode change
const RADAR_SCALE = 0.012;
const RADAR_HALF = 68;
const RADAR_TILE_RADIUS_SQ = 4200;

// HUD_STATS grouped by textSize to minimise textSize() calls per frame.
// Three groups: size 20 (SCORE), size 16 (ALT), size 14 (VIRON/ENEMIES/MISSILES/SHOT).
// The original flat order is preserved within each group so vertical positions are correct.
const HUD_STATS = [
  { label: 'SCORE', color: [255, 255, 255], size: 20, py: 8, getVal: p => p.score },
  { label: 'ALT', color: [0, 255, 0], size: 16, py: 32, getVal: (p, s) => Math.max(0, Math.floor(SEA - s.y)) },
  { label: 'VIRON', color: [255, 60, 60], size: 14, py: 54, getVal: () => (typeof infection !== 'undefined' ? infection.count : 0) },
  { label: 'ENEMIES', color: [255, 100, 100], size: 14, py: 72, getVal: () => (typeof enemyManager !== 'undefined' ? enemyManager.enemies.length : 0) },
  { label: 'MISSILES', color: [0, 200, 255], size: 14, py: 90, getVal: p => p.missilesRemaining },
  { label: 'SHOT', color: [220, 220, 220], size: 14, py: 108, getVal: p => (NORMAL_SHOT_MODE_LABELS[p.normalShotMode] || 'SINGLE') }
];
// Pre-grouped by size so drawPlayerHUD() calls textSize() once per group (3×) not per stat (6×).
const HUD_STATS_BY_SIZE = (() => {
  const groups = new Map();
  for (const s of HUD_STATS) {
    if (!groups.has(s.size)) groups.set(s.size, []);
    groups.get(s.size).push(s);
  }
  return groups;
})();

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
  if (gameState.gameFont) g.textFont(gameState.gameFont);

  const lx = 14;
  for (const stat of HUD_STATS) {
    g.fill(...stat.color);
    g.textSize(stat.size);
    g.text(stat.label, lx, stat.py);
  }

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

/**
 * Transforms world coordinates to radar-local coordinates relative to the ship.
 */
function _projectToRadar(wx, wz, ship, sinYaw, cosYaw) {
  const dx = (wx - ship.x) * RADAR_SCALE;
  const dz = (wz - ship.z) * RADAR_SCALE;
  return [
    dx * cosYaw - dz * sinYaw,
    dx * sinYaw + dz * cosYaw
  ];
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

/**
 * Renders the primary ship details text for the selection screen.
 */
function _renderShipDetails(p, design, relX, vw, vh) {
  if (!design) return;

  // Global title
  textAlign(CENTER, TOP);
  fill(255, 255, 255, 200);
  textSize(28);
  text("SELECT YOUR CRAFT", relX, -vh / 2 + 50);

  // Ship Name (Largest)
  fill(...p.labelColor);
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
  } else if (design.thrustAngle !== undefined) {
    if (design.thrustAngle > 0.1 && design.thrustAngle < 1.0) thrustType = "DIAGONAL THRUST";
    else if (design.thrustAngle >= 1.0) thrustType = "JET / FORWARD THRUST";
  }
  text(thrustType, relX, vh / 2 - 245);

  // Description (Body text, wrapped)
  fill(220);
  textSize(14);
  rectMode(CENTER);
  text(design.desc || "", relX, vh / 2 - 215, vw * 0.85);
  rectMode(CORNER);
}

/**
 * Renders ship statistics bars for the selection screen.
 */
function _drawShipStats(p, design, relX, vw, vh) {
  if (!design) return;

  const statY = vh / 2 - 195;
  const statW = vw * 0.4;
  const statX = relX - statW / 2;

  const stats = [
    { label: "ACCEL", val: (design.thrust || 0.45) / (design.mass || 1.0), max: 1.6 },
    { label: "AGILITY", val: (design.turnRate || 0.04) / (design.mass || 1.0), max: 0.12 },
    { label: "GLIDE", val: design.lift || 0.008, max: 0.02 },
    { label: "MISSILES", val: design.startingMissiles ?? design.missileCapacity ?? 1, max: 5 }
  ];

  stats.forEach((s, i) => {
    const y = statY + i * 18;
    textAlign(RIGHT, TOP);
    fill(180);
    textSize(11);
    text(s.label, statX - 10, y + 2);

    // Bar background
    fill(40);
    rect(statX, y + 3, statW, 8, 2);
    // Bar fill (using player color)
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2], 200);
    const fillW = map(s.val, 0, s.max, 0, statW, true);
    rect(statX, y + 3, fillW, 8, 2);
  });
}

/**
 * Returns a cached p5.Graphics buffer for the weapon selector UI panel
 * (weapon name text + 3 indicator bars).  The buffer is only rebuilt when
 * the player's weapon mode changes, saving 1 text() + 3 rect() calls on
 * every frame where no weapon switch occurs.
 *
 * Buffer dimensions: 220 × 50 pixels (fits weapon name + bars at textSize 18).
 * The buffer origin (0,0) matches the top-left corner of the selector so that
 * `image(g, -W/2, -h/2)` places it at the same viewport position as the
 * original direct-draw code (-h/2+10 for the name, -h/2+34 for the bars).
 *
 * @param {object} p  Player state.
 * @returns {p5.Graphics}
 */
function _getWeaponSelectorGraphic(p) {
  const W = 220, H = 50;
  const key = `${p.id}`;
  let entry = HUD_WEAPON_BUFFERS[key];

  if (!entry || entry.weaponMode !== p.weaponMode) {
    // Create or reuse the graphics buffer.
    if (!entry) {
      const g = createGraphics(W, H);
      g.pixelDensity(1);
      entry = { g, weaponMode: -1 };
      HUD_WEAPON_BUFFERS[key] = entry;
    }
    entry.weaponMode = p.weaponMode;

    const wId = p.weaponMode;
    const wName = HUD_WEAPON_LABELS[wId];
    const wCol = HUD_WEAPON_ACTIVE_COLS[wId];
    const g = entry.g;

    g.clear();
    g.noStroke();
    if (gameState.gameFont) g.textFont(gameState.gameFont);

    // Weapon name at y=10 in the buffer — matches original -h/2+10 when
    // the buffer is drawn with imageMode(CORNER) at (−W/2, −h/2).
    g.textAlign(CENTER, TOP);
    g.textSize(18);
    g.fill(wCol[0], wCol[1], wCol[2], 230);
    g.text(wName, W / 2, 10);

    // Three selector bars at y=34 — matches original -h/2+34.
    const bw = 60, bh = 6, pad = 8;
    const totalW = (bw + pad) * 3 - pad;
    const sx = (W - totalW) / 2;
    g.rectMode(CORNER);
    for (let i = 0; i < 3; i++) {
      if (i === wId) g.fill(wCol[0], wCol[1], wCol[2], 255);
      else g.fill(50, 50, 50, 150);
      g.rect(sx + i * (bw + pad), 34, bw, bh);
    }
  }

  return entry.g;
}

/**
 * Renders the weapon mode indicator and selector boxes.
 * Uses a cached p5.Graphics buffer to avoid per-frame text and rect calls
 * when the weapon mode has not changed.
 */
function _drawWeaponSelector(p, h) {
  const g = _getWeaponSelectorGraphic(p);
  // imageMode(CORNER) is already set at the start of drawPlayerHUD.
  // Position top-left at (-W/2, -h/2) so contents match the original layout.
  image(g, -110, -h / 2);
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
 *   2. Soft yellow glow behind the title (2D overlay)
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
  fill(255, 220, 10, 32 * glowPulse);
  ellipse(0, -height * 0.14, 580 * glowPulse, 170 * glowPulse);
  fill(200, 180, 5, 20 * glowPulse);
  ellipse(0, -height * 0.14, 820 * glowPulse, 240 * glowPulse);

  textAlign(CENTER, CENTER);
  noStroke();

  // Drop shadow layer
  fill(40, 80, 0, 100);
  textSize(110);
  text('V I R O N', 3, -height * 0.14 + 4);

  // Pulsing title — oscillates between the infection tile colors
  let titlePulse = sin(frameCount * 0.06) * 0.5 + 0.5;  // 0..1
  fill(
    lerp(220, 255, titlePulse),
    lerp(180, 255, titlePulse),
    lerp(0, 50, titlePulse)
  );
  textSize(110);
  text('V I R O N', 0, -height * 0.14);

  // Author credit
  textSize(22);
  fill(140, 200, 140, 210);
  text('Christian Nold, 2026', 0, -height * 0.14 + 78);

  // CRT scanline overlay — subtle dark horizontal lines for retro feel
  // LATERAL OPT: Skip this loop on mobile to save 200+ line() calls.
  if (!gameState.isMobile) {
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
  if (gameState.isMobile) {
    fill(255, 255, 255, 255 * blink1);
    text('TAP TO START', 0, optY + 25);
  } else {
    fill(255, 255, 255, 255 * blink1);
    text('PRESS 1 — SINGLE PLAYER', 0, optY);
    fill(255, 255, 255, 255 * blink2);
    text('PRESS 2 — MULTIPLAYER', 0, optY + 50);
  }

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
  drawVironProfilerOverlay();

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

  if (gameState.isMobile) {
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

    const drawConfig = (title, color, items, side) => {
      const tx = width * 0.25 * side;
      const ty = -height * 0.1;
      const my = -height * 0.02;
      const lh = 35;

      textSize(22);
      fill(...color, 200);
      text(title, tx, ty);

      textSize(18);
      fill(255, 255, 255, 180);
      textAlign(CENTER, TOP);
      items.forEach((item, i) => {
        text(item, tx, my + lh * i);
      });
    };

    if (gameState.numPlayers === 1) {
      drawConfig('MOUSE CONTROLS', [200, 255, 200], [
        'Pitch / Yaw: Move Mouse',
        'Thrust: Right-Click',
        'Shoot: Left-Click',
        'Cycle Weapon: Middle-Click'
      ], -1);

      drawConfig('KEYBOARD ALTERNATIVES', [255, 200, 200], [
        'Forward Tilt: F',
        'Backward Tilt: R',
        'Thrust: W',
        'Brake: S',
        'Shoot: Q',
        'Cycle Weapon: E'
      ], 1);
    } else {
      drawConfig('P1 CONTROLS', [200, 255, 200], [
        'Pitch / Yaw: Mouse',
        'Forward Tilt: F',
        'Backward Tilt: R',
        'Thrust: W or Right-Click',
        'Brake: S',
        'Shoot: Q or Left-Click',
        'Cycle Weapon: E or Middle-Click'
      ], -1);

      drawConfig('P2 CONTROLS', [255, 200, 200], [
        'Turn: Arrow Keys',
        'Forward Tilt: \' (Quote)',
        'Backward Tilt: ; (Semicolon)',
        'Thrust: Up Arrow',
        'Brake: Down Arrow',
        'Shoot: . (Period)',
        'Cycle Weapon: / (Slash)'
      ], 1);
    }
  }

  // Blinking continue prompt
  let blink = sin(frameCount * 0.1) * 0.5 + 0.5;
  fill(150, 255, 150, 255 * blink);
  textAlign(CENTER, CENTER);
  textSize(24);
  text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * 0.42);

  drawVironProfilerOverlay();

  pop();
}

/**
 * Draws the game-over text content.
 * Assumes the caller has already established a full-screen 2D ortho projection
 * (e.g. via setup2DViewport()).  Handles the 5-second auto-return to menu.
 *
 * Separated from drawGameOver() so it can be called inside the masterFBO
 * shared-2D-overlay section, ensuring the mobile y-flip applied by the
 * POST_FRAG post-processing shader is correctly applied to the overlay (fixing
 * the mirror-reversed / flipped text seen on some mobile platforms).
 * @private
 */
function _drawGameOverContent() {
  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);  // Prevent 3D geometry bleeding through

  if (gameState.gameFont) textFont(gameState.gameFont);
  fill(255, 60, 60);
  textAlign(CENTER, CENTER);
  textSize(80);
  text('GAME OVER', 0, -50);

  textSize(24);
  fill(180, 200, 180);
  text(gameState.gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);

  // Prompt so players know how to exit (auto-returns after 5 s regardless).
  textSize(18);
  fill(180, 200, 180, 160);
  text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * 0.35);

  // Auto-return to menu after 5 seconds.
  if (millis() - gameState.levelEndTime > 5000) {
    gameState.mode = 'menu';
  }
}

/**
 * Renders the full-screen game-over overlay.
 * Shows the game-over reason string (or a default message) and automatically
 * returns to the menu after 5 seconds.
 *
 * NOTE: On mobile, gameRenderer.renderAllPlayers() calls _drawGameOverContent()
 * inside the masterFBO so the POST_FRAG y-flip is applied uniformly (fixing
 * mirror-reversed text on mobile).  This function is kept for direct calls
 * on desktop / non-FBO code paths.
 */
function drawGameOver() {
  setup2DViewport();
  _drawGameOverContent();
  pop();
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
  gameState.menuCam.yaw += 0.0006;

  // Position camera low to the ground, panning in a circle
  let cx = gameState.menuCam.x + sin(gameState.menuCam.yaw) * 550;
  let cz = gameState.menuCam.z + cos(gameState.menuCam.yaw) * 550;
  let cy = -90;
  camera(cx, cy, cz, gameState.menuCam.x, -10, gameState.menuCam.z, 0, 1, 0);

  // Fake ship for culling / terrain logic
  let fakeShip = { x: gameState.menuCam.x, y: cy, z: gameState.menuCam.z, yaw: gameState.menuCam.yaw, pitch: 0 };

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
  if (gameState.numPlayers === 1) {
    renderShipSelectView(gameState.players[0], 0, 0, width, height, pxD);
  } else {
    let hw = floor(width / 2);
    // Left view (P1)
    renderShipSelectView(gameState.players[0], 0, 0, hw, height, pxD);
    // Right view (P2)
    renderShipSelectView(gameState.players[1], 1, hw, hw, height, pxD);

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

  // Clear depth for the ship preview
  gl.clear(gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, vw / vh, 1, 1000);
  camera(0, -15, 60, 0, 0, 0, 0, 1, 0);

  // Cinematic lighting
  directionalLight(255, 255, 255, 0.5, 1, -0.5);
  directionalLight(120, 180, 255, -0.5, -1, 0.5);
  ambientLight(45, 45, 55);

  // Rotating ship presentation
  push();
  rotateY(frameCount * 0.018);
  rotateX(sin(frameCount * 0.012) * 0.15);
  noStroke();
  drawShipPreview(p.designIndex, p.labelColor);
  pop();
  pop();

  // --- 2D Overlay ---
  setup2DViewport();
  let relX = (vx + vw / 2) - width / 2;
  noStroke();

  const design = SHIP_DESIGNS[p.designIndex];
  _renderShipDetails(p, design, relX, vw, vh);
  _drawShipStats(p, design, relX, vw, vh);

  // Selection Hints / Mobile Buttons
  if (gameState.isMobile && !p.ready) {
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
  }

  // Ready State
  if (p.ready) {
    fill(0, 255, 0);
    textSize(36);
    textAlign(CENTER, CENTER);
    text("READY", relX, 0);
  }

  drawVironProfilerOverlay();

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
  if (viewW <= 0 || viewH <= 0) return;
  let hw = viewW, h = viewH;
  let s = p.ship;

  push();
  if (gameState.gameFont) textFont(gameState.gameFont);
  // Set up an orthographic 2D projection for this viewport slice
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();

  // Reset imageMode to ensure CORNER works as expected for cached graphics
  imageMode(CORNER);

  let lx = -hw / 2 + 14;
  let ly = -h / 2;

  // 1. Draw cached static labels for stat names
  image(_getHUDLabelGraphic(hw, h), -hw / 2, -h / 2);

  // 2. Draw dynamic stat values — grouped by textSize to minimise font-size
  //    changes.  Without grouping we call textSize() once per stat (6×/frame);
  //    with grouping we call it once per unique size (3×/frame).
  const vx = -hw / 2 + 14 + 80; // Value column X offset
  const vy = -h / 2;
  textAlign(LEFT, TOP);
  for (const [sz, stats] of HUD_STATS_BY_SIZE) {
    textSize(sz);
    for (const stat of stats) {
      fill(...stat.color);
      text(stat.getVal(p, s), vx, vy + stat.py);
    }
  }

  // --- Crosshair (first-person reticle — only shown in first-person mode) ---
  if (gameState.firstPersonView) {
    stroke(0, 255, 0, 150);
    strokeWeight(2);
    noFill();
    ellipse(0, 0, 30, 30);
    line(-20, 0, 20, 0);
    line(0, -20, 0, 20);
  }

  // --- Respawn Indicator ---
  if (p.dead && !p.gameOver) {
    push();
    textAlign(CENTER);
    fill(255, 255, 0, 200);
    textSize(32);
    text('Respawning...', 0, 30);
    pop();
  }

  drawRadarForPlayer(p, hw, h);
  _drawWeaponSelector(p, h);

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
  const shouldUpdate = !gameState.isMobile || (frameCount + p.id) % 2 === 0;

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
        let bucket = infection.buckets.get(chunkKey(shipCX + dcx, shipCZ + dcz));
        if (!bucket) continue;
        for (let t of bucket) {
          const [rrx, rrz] = _projectToRadar(t.tx * TILE, t.tz * TILE, s, yawSin, yawCos);
          if (Math.abs(rrx) < RADAR_HALF && Math.abs(rrz) < RADAR_HALF) {
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
        const [rrx, rrz] = _projectToRadar(e.x, e.z, s, yawSin, yawCos);
        if (Math.abs(rrx) < RADAR_HALF && Math.abs(rrz) < RADAR_HALF) {
          gb.vertex(rrx, rrz);
        }
      }
      gb.endShape();
    }

    // 4. Launchpad centre marker (approximate world location)
    const [rlx, rlz] = _projectToRadar(420, 420, s, yawSin, yawCos);
    if (Math.abs(rlx) < RADAR_HALF && Math.abs(rlz) < RADAR_HALF) {
      gb.stroke(0, 150, 255, 220); gb.strokeWeight(5);
      gb.point(rlx, rlz);
    }

    // 5. Co-op partner
    let other = gameState.players[1 - p.id];
    if (other && !other.dead) {
      const [rox, roz] = _projectToRadar(other.ship.x, other.ship.z, s, yawSin, yawCos);
      if (Math.abs(rox) < RADAR_HALF && Math.abs(roz) < RADAR_HALF) {
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
  if (gameState.isMobile) return;
  push();
  imageMode(CENTER);
  let hints = '';
  if (gameState.numPlayers === 1) {
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

/**
 * Renders a tiny performance readout in the top-right corner if the Viron
 * profiler is enabled. Shows the latest sampled frame milliseconds.
 */
function drawVironProfilerOverlay(viewW, viewH) {
  if (typeof window === 'undefined' || !window.VIRON_PROFILE || !window.VIRON_PROFILE.enabled) return;
  
  const summary = window.__profilingSummary;
  const isSampling = !summary;
  const displayValue = isSampling ? "SAMPLING..." : summary.frameMs + "ms";

  push();
  // Using global width/height if called from global pass
  const w = viewW || width;
  const h = viewH || height;
  
  textAlign(CENTER, TOP);
  textSize(11);
  noStroke();

  // Background "pill" - brighter for mobile visibility
  fill(0, 0, 0, 180);
  rectMode(CENTER);
  rect(0, -h / 2 + 56, 100, 22, 5);

  // Text - bright neon green
  fill(0, 255, 0); 
  text(displayValue, 0, -h / 2 + 50);
  pop();
}
