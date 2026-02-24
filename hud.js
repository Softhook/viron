// =============================================================================
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
  // --- 3D Landscape background ---
  let gl = drawingContext;
  let pxD = pixelDensity();
  gl.viewport(0, 0, width * pxD, height * pxD);
  gl.clearColor(30 / 255, 60 / 255, 120 / 255, 1);   // sky colour
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, width / height, 50, VIEW_FAR * TILE * 1.5);

  // Slowly pan the camera yaw around the landscape
  menuCam.yaw += 0.0006;

  // Camera sits 550 units "behind" the look-at point, low to the ground
  let cx = menuCam.x + sin(menuCam.yaw) * 550;
  let cz = menuCam.z + cos(menuCam.yaw) * 550;
  let cy = -90;   // below horizon for dramatic low-angle view
  camera(cx, cy, cz, menuCam.x, -10, menuCam.z, 0, 1, 0);

  // Fake ship object used by terrain culling helpers
  let fakeShip = {
    x: menuCam.x, y: cy, z: menuCam.z,
    yaw: menuCam.yaw, pitch: 0
  };

  setSceneLighting();
  terrain.drawLandscape(fakeShip);
  terrain.drawTrees(fakeShip);
  terrain.drawBuildings(fakeShip);

  pop();

  // Clear depth so 2D overlays always appear on top
  gl.clear(gl.DEPTH_BUFFER_BIT);

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
  for (let y = -height / 2; y < height / 2; y += 4) {
    stroke(0, 0, 0, 20); strokeWeight(1);
    line(-width / 2, y, width / 2, y);
  }
  noStroke();

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
  textSize(13);
  fill(100, 140, 100, 150);
  if (isMobile) {
    text('Use virtual joystick and buttons to play', 0, height / 2 - 40);
  } else {
    text('P1: w/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB missile', 0, height / 2 - 55);
    text('P2: ARROWS + ;/\' pitch  . shoot  / missile', 0, height / 2 - 35);
  }

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
function drawPlayerHUD(p, pi, hw, h) {
  let s = p.ship;

  push();
  // Set up an orthographic 2D projection for this viewport slice
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();

  noStroke();
  textAlign(LEFT, TOP);

  let lx = -hw / 2 + 14;
  let ly = -h / 2;
  let col = p.labelColor;


  // Stat lines: [size, [r,g,b], text, x, y]
  let lines = [
    [20, [255, 255, 255], 'SCORE ' + p.score, lx, ly + 8],
    [16, [0, 255, 0], 'ALT ' + max(0, floor(SEA - s.y)), lx, ly + 32],
    [14, [255, 80, 80], 'INF ' + Object.keys(infectedTiles).length, lx, ly + 54],
    [14, [255, 100, 100], 'ENEMIES ' + enemyManager.enemies.length, lx, ly + 72],
    [14, [0, 200, 255], 'MISSILES ' + p.missilesRemaining, lx, ly + 90]
  ];
  for (let [sz, c, txt, x, y] of lines) {
    textSize(sz); fill(c[0], c[1], c[2]); text(txt, x, y);
  }

  // Death / respawn overlay
  if (p.dead) {
    fill(255, 0, 0, 200);
    textAlign(CENTER, CENTER);
    textSize(28);
    text('DESTROYED', 0, 0);
    textSize(16);
    fill(200);
    text('Respawning...', 0, 30);
  }

  drawRadarForPlayer(p, hw, h);
  drawControlHints(p, pi, hw, h);

  pop();
}

/**
 * Renders a circular mini-map radar in the top-right corner of the player's viewport.
 *
 * The radar rotates with the player's yaw so forward is always up.
 * Contents:
 *   • Red squares — infected tiles (scaled to fit the 110×110 radar area)
 *   • Yellow square — launchpad centre (if in range)
 *   • Red squares / triangles — enemies (triangle when off-screen, pointing toward enemy)
 *   • Player colour square — co-op partner ship (two-player only)
 *   • Yellow centre square — own ship
 *
 * @param {object} p   Player state.
 * @param {number} hw  Viewport half-width.
 * @param {number} h   Viewport height.
 */
function drawRadarForPlayer(p, hw, h) {
  let s = p.ship;
  push();
  // Position the radar in the top-right corner
  let radarSize = 150;
  translate(hw / 2 - radarSize / 2 - 4, -h / 2 + radarSize / 2 + 4, 0);
  fill(0, 150); stroke(0, 255, 0); strokeWeight(1.5);
  rectMode(CENTER);
  rect(0, 0, radarSize, radarSize);   // Radar frame
  rotateZ(s.yaw);          // Rotate so ship forward faces up

  // Infected tiles (small red squares)
  fill(180, 0, 0, 80); noStroke();
  for (let k of Object.keys(infectedTiles)) {
    let comma = k.indexOf(',');
    let tx = +k.slice(0, comma), tz = +k.slice(comma + 1);
    let rx = (tx * TILE - s.x) * 0.012, rz = (tz * TILE - s.z) * 0.012;
    if (abs(rx) < 68 && abs(rz) < 68) rect(rx, rz, 2, 2);
  }

  // Launchpad centre marker (yellow square if in radar range)
  let lx = (420 - s.x) * 0.012, lz = (420 - s.z) * 0.012;
  if (abs(lx) < 68 && abs(lz) < 68) {
    fill(255, 255, 0, 150); noStroke(); rect(lx, lz, 4, 4);
  }

  // Enemy markers (square when in range, directional triangle when off-screen)
  fill(255, 0, 0); noStroke();
  for (let e of enemyManager.enemies) {
    let rx = (e.x - s.x) * 0.012, rz = (e.z - s.z) * 0.012;
    if (abs(rx) < 68 && abs(rz) < 68) {
      rect(rx, rz, 3, 3);
    } else {
      // Off-screen: draw a directional arrow clamped to the radar boundary
      push();
      translate(constrain(rx, -67, 67), constrain(rz, -67, 67), 0);
      rotateZ(atan2(rz, rx));
      fill(255, 0, 0, 180);
      triangle(3, 0, -2, -2, -2, 2);
      pop();
    }
  }

  // Co-op partner ship (two-player only)
  let other = players[1 - p.id];
  if (other && !other.dead) {
    let ox = (other.ship.x - s.x) * 0.012, oz = (other.ship.z - s.z) * 0.012;
    fill(other.labelColor[0], other.labelColor[1], other.labelColor[2], 200);
    noStroke();
    if (abs(ox) < 68 && abs(oz) < 68) rect(ox, oz, 4, 4);
  }

  // Own ship — always at radar centre
  rotateZ(-s.yaw);
  fill(255, 255, 0);
  rect(0, 0, 4, 4);
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
  textAlign(CENTER, BOTTOM);
  textSize(11);
  fill(255, 255, 255, 120);
  let hints = '';
  if (numPlayers === 1) {
    hints = 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB missile  S brake  (Click to lock mouse)';
  } else {
    hints = pi === 0
      ? 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB missile  S brake  (Click lock)'
      : '↑ thrust  ←/→ turn  ;/\' pitch  . shoot  / missile  ↓ brake';
  }
  text(hints, 0, h / 2 - 8);
  pop();
}
