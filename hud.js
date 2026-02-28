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
  textSize(13);
  fill(100, 140, 100, 150);
  if (isMobile) {
    text('Use virtual joystick and buttons to play', 0, height / 2 - 40);
  } else {
    text('P1: w/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB cycle weapon  S brake  (Click to lock mouse)', 0, height / 2 - 55);
    text('P2: ARROWS + ;/\' pitch  . shoot  / cycle weapon  \u2193 brake', 0, height / 2 - 35);
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
    if (design.thrustAngle > 0.1 && design.thrustAngle < 1.0) thrustType = "DIAGONAL THRUST";
    if (design.thrustAngle >= 1.0) thrustType = "JET / FORWARD THRUST";
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
    textSize(16);
    fill(200, 200, 200, 150);
    let hint = (pi === 0) ? "A / D TO CYCLE \u2022 ENTER TO READY" : "ARROWS TO CYCLE \u2022 . TO READY";
    if (numPlayers === 1) hint = "LEFT / RIGHT TO CYCLE \u2022 ENTER TO START";
    text(hint, relX, vh / 2 - 35);
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


  // Compute infection keys once — reused for both the stats count and the radar loop below
  let infKeys = infection.keys();

  // Stat lines: [size, [r,g,b], text, x, y]
  let lines = [
    [20, [255, 255, 255], 'SCORE ' + p.score, lx, ly + 8],
    [16, [0, 255, 0], 'ALT ' + max(0, floor(SEA - s.y)), lx, ly + 32],
    [14, [255, 60, 60], 'VIRON ' + infKeys.length, lx, ly + 54],
    [14, [255, 100, 100], 'ENEMIES ' + enemyManager.enemies.length, lx, ly + 72],
    [14, [0, 200, 255], 'MISSILES ' + p.missilesRemaining, lx, ly + 90]
  ];
  for (let [sz, c, txt, x, y] of lines) {
    textSize(sz); fill(c[0], c[1], c[2]); text(txt, x, y);
  }

  // --- Crosshair (first-person reticle — only shown in first-person mode) ---
  if (typeof firstPersonView !== 'undefined' && firstPersonView) {
    let cw = 12, gap = 4;
    stroke(255, 255, 255, 200); strokeWeight(1.5); noFill();
    line(-cw - gap, 0, -gap, 0);
    line(gap, 0, cw + gap, 0);
    line(0, -cw - gap, 0, -gap);
    line(0, gap, 0, cw + gap);
    noStroke(); fill(255, 255, 255, 200);
    ellipse(0, 0, 3, 3);
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

  drawRadarForPlayer(p, hw, h, infKeys);
  drawControlHints(p, pi, hw, h);

  // --- Weapon Selector Indicator (top-centre) ---
  // Three pills horizontally: NORMAL | MISSILE | BARRIER
  // Active pill: solid white box with black label.
  // Inactive pill: dim outline with grey label.
  {
    let pillW = 82, pillH = 22, pillGap = 8;
    let totalW = 3 * pillW + 2 * pillGap;
    let startX = -totalW / 2;
    let pillY = -h / 2 + 8;   // Near the very top of the viewport
    const labels = ['\u25CF NORMAL', '\uD83D\uDE80 MISSILE', '\u25A0 BARRIER'];
    const activeCols = [[255, 255, 255], [0, 220, 255], [255, 160, 20]];
    const labelBlacks = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    textAlign(CENTER, TOP);
    for (let i = 0; i < 3; i++) {
      let px = startX + i * (pillW + pillGap);
      let active = (p.weaponMode === i);
      if (active) {
        // Filled pill
        fill(activeCols[i][0], activeCols[i][1], activeCols[i][2], 230);
        noStroke();
        rect(px, pillY, pillW, pillH, 4);
        // Label in dark ink
        fill(labelBlacks[i][0], labelBlacks[i][1], labelBlacks[i][2]);
        textSize(11);
        text(labels[i], px + pillW / 2, pillY + 5);
      } else {
        // Outline pill
        noFill();
        stroke(180, 180, 180, 130);
        strokeWeight(1);
        rect(px, pillY, pillW, pillH, 4);
        noStroke();
        fill(180, 180, 180, 130);
        textSize(11);
        text(labels[i], px + pillW / 2, pillY + 5);
      }
    }
  }

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
 * @param {object} p        Player state.
 * @param {number} hw       Viewport half-width.
 * @param {number} h        Viewport height.
 * @param {string[]} infKeys Pre-computed infection.keys() from drawPlayerHUD.
 */
function drawRadarForPlayer(p, hw, h, infKeys) {
  let s = p.ship;
  push();
  // Position the radar in the top-right corner
  let radarSize = 150;
  translate(hw / 2 - radarSize / 2 - 4, -h / 2 + radarSize / 2 + 4, 0);
  fill(0, 150); stroke(0, 255, 0); strokeWeight(1.5);
  rectMode(CENTER);
  rect(0, 0, radarSize, radarSize);   // Radar frame
  rotateZ(s.yaw);          // Rotate so ship forward faces up

  // Viron tiles (small red squares) — use the objects computed in drawPlayerHUD
  fill(255, 60, 60, 80); noStroke();
  // LATERIAL OPT: Cap radar tiles to 100 on desktop, 40 on mobile to avoid building 1000s of quads.
  let tilesDrawn = 0;
  let maxRadarTiles = isMobile ? 40 : 120;
  for (let t of infKeys) {
    let rx = (t.tx * TILE - s.x) * 0.012, rz = (t.tz * TILE - s.z) * 0.012;
    // Squared check — faster than building hundreds of quads and clipping them.
    if (rx * rx + rz * rz < 4200) {
      rect(rx, rz, 2, 2);
      tilesDrawn++;
      if (tilesDrawn >= maxRadarTiles) break;
    }
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
    hints = 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB cycle weapon  S brake  (Click to lock mouse)';
  } else {
    hints = pi === 0
      ? 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E/MMB cycle weapon  S brake  (Click lock)'
      : '\u2191 thrust  \u2190/\u2192 turn  ;/\' pitch  . shoot  / cycle weapon  \u2193 brake';
  }
  text(hints, 0, h / 2 - 8);
  pop();
}
