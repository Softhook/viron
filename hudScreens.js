// =============================================================================
// hudScreens.js — Full-screen UI logic and game state screens
// =============================================================================

/**
 * Renders the primary ship details text for the selection screen.
 * @private
 */
function _renderShipDetails(p, design, relX, vw, vh) {
  if (!design) return;

  textAlign(CENTER, TOP);
  fill(255, 255, 255, 200);
  textSize(UI_TYPE_HEADER);
  text("SELECT YOUR CRAFT", relX, height * UI_LAYOUT_TITLE_Y);

  fill(...p.labelColor);
  textSize(UI_TYPE_TITLE);
  text(design.name.toUpperCase(), relX, vh / 2 - 320);

  fill(220);
  textSize(UI_TYPE_BODY);
  rectMode(CENTER);
  text(design.desc || "", relX, vh / 2 - 215, vw * 0.85);
  rectMode(CORNER);
}

/**
 * Renders ship statistics bars for the selection screen.
 * @private
 */
function _drawShipStats(p, design, relX, vw, vh) {
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
    textAlign(RIGHT, TOP);
    fill(180);
    textSize(UI_TYPE_HINT);
    text(s.label, statX - 10, y + 2);

    fill(40);
    rect(statX, y + 3, statW, 8, 2);
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2], 200);
    const fillW = map(s.val, 0, s.max, 0, statW, true);
    rect(statX, y + 3, fillW, 8, 2);
  });
}

/**
 * Renders the animated title / start screen.
 */
function drawMenu() {
  drawBackgroundLandscape();
  setup2DViewport();

  // Handle smooth transitions (e.g. fading back from shadowed screens)
  HUD_Manager.drawDimOverlay();

  let glowPulse = sin(frameCount * 0.04) * 0.3 + 0.7;

  noStroke();
  fill(255, 220, 10, 32 * glowPulse);
  ellipse(0, -height * 0.14, 580 * glowPulse, 170 * glowPulse);
  fill(200, 180, 5, 20 * glowPulse);
  ellipse(0, -height * 0.14, 820 * glowPulse, 240 * glowPulse);

  textAlign(CENTER, CENTER);
  noStroke();

  fill(40, 80, 0, 100);
  textSize(110);
  text('V I R O N', 3, -height * 0.14 + 4);

  let titlePulse = sin(frameCount * 0.06) * 0.5 + 0.5;
  fill(lerp(220, 255, titlePulse), lerp(180, 255, titlePulse), lerp(0, 50, titlePulse));
  textSize(110);
  text('V I R O N', 0, -height * 0.14);

  textSize(22);
  fill(140, 200, 140, 210);
  text('Christian Nold, 2026', 0, -height * 0.14 + 78);

  if (!gameState.isMobile) {
    stroke(0, 0, 0, 20); strokeWeight(1);
    for (let y = -height / 2; y < height / 2; y += 4) {
      line(-width / 2, y, width / 2, y);
    }
    noStroke();
  }

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
    text('PRESS 2 — SPLIT SCREEN 2 PLAYER', 0, optY + 50);
  }
  pop();
}

/**
 * Renders the Mission Briefing screen.
 */
function drawMission() {
  drawBackgroundLandscape();
  setup2DViewport();
  HUD_Manager.drawDimOverlay();

  textAlign(CENTER, CENTER);

  const titleSize = gameState.isMobile ? UI_TYPE_TITLE * 0.6 : UI_TYPE_TITLE * 0.8;
  const headerSize = gameState.isMobile ? UI_TYPE_HEADER * 0.7 : UI_TYPE_HEADER;
  const bodySize = gameState.isMobile ? UI_TYPE_BODY * 0.85 : UI_TYPE_BODY;

  fill(255, 255, 255, 220);
  textSize(titleSize);
  text('MISSION BRIEFING', 0, height * UI_LAYOUT_TITLE_Y);

  fill(200, 255, 200, 200);
  textSize(headerSize);
  text('OBJECTIVE: VIRAL CONTAINMENT', 0, height * UI_LAYOUT_HEADER_Y);

  fill(220, 220, 220);
  textSize(bodySize);
  textAlign(CENTER, TOP);
  rectMode(CENTER);
  let briefing =
    "A silicon-based virus is being spread by aliens. " +
    "Left unchecked, it will take over the planet.\n\n" +
    "Your mission:\n\n" +
    "1. ELIMINATE aliens spreading the virus.\n" +
    "2. CONTAIN the virus spread\n" +
    "3. PROTECT the temples.";

  text(briefing, 0, height * UI_LAYOUT_BODY_Y, min(width * 0.85, 800));
  rectMode(CORNER);

  let blink = sin(frameCount * 0.1) * 0.5 + 0.5;
  fill(150, 255, 150, 255 * blink);
  textAlign(CENTER, CENTER);
  textSize(gameState.isMobile ? UI_TYPE_PROMPT * 0.8 : UI_TYPE_PROMPT);
  text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * UI_LAYOUT_PROMPT_Y);

  pop();
}

/**
 * Renders the Instructions screen.
 */
function drawInstructions() {
  drawBackgroundLandscape();
  setup2DViewport();
  HUD_Manager.drawDimOverlay();

  textAlign(CENTER, CENTER);

  if (gameState.isMobile) {
    if (typeof mobileController !== 'undefined') {
      mobileController.draw(width, height, true);
    }
  } else {
    fill(255, 255, 255, 220);
    textSize(UI_TYPE_TITLE * 0.8);
    text('HOW TO PLAY', 0, height * UI_LAYOUT_TITLE_Y);

    const drawConfig = (title, color, items, side) => {
      const tx = width * 0.25 * side;
      const ty = height * UI_LAYOUT_HEADER_Y;
      const my = ty + 40;
      const lh = 36;
      textAlign(CENTER, TOP);
      textSize(UI_TYPE_HEADER * 0.7);
      fill(...color, 200);
      text(title, tx, ty);
      textSize(UI_TYPE_BODY * 0.9);
      fill(255, 255, 255, 180);
      items.forEach((item, i) => {
        text(item, tx, my + lh * i);
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

  let blink = sin(frameCount * 0.1) * 0.5 + 0.5;
  fill(150, 255, 150, 255 * blink);
  textAlign(CENTER, CENTER);
  textSize(UI_TYPE_PROMPT);
  text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * UI_LAYOUT_PROMPT_Y);
  pop();
}

/**
 * Draws the game-over text content.
 * @private
 */
function _drawGameOverContent() {
  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);

  if (gameState.gameFont) textFont(gameState.gameFont);
  fill(255, 60, 60);
  textAlign(CENTER, CENTER);
  textSize(80);
  text('GAME OVER', 0, -50);

  textSize(24);
  fill(180, 200, 180);
  text(gameState.gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);

  textSize(18);
  fill(180, 200, 180, 160);
  text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, height * 0.35);

  if (millis() - gameState.levelEndTime > 5000) {
    gameState.mode = 'menu';
  }
}

/**
 * Renders the full-screen game-over overlay.
 */
function drawGameOver() {
  setup2DViewport();
  HUD_Manager.drawDimOverlay();
  _drawGameOverContent();
  pop();
}

/**
 * Renders the Pause screen overlay.
 */
function drawPauseScreen() {
  setup2DViewport();
  if (gameState.pauseSnapshot) {
    push();
    imageMode(CENTER);
    image(gameState.pauseSnapshot, 0, 0, width, height);
    pop();
  }

  HUD_Manager.drawDimOverlay();

  textAlign(CENTER, CENTER);
  if (gameState.gameFont) textFont(gameState.gameFont);

  fill(0, 255, 136);
  textSize(80);
  text('PAUSED', 0, -100);

  const btnW = 280, btnH = 60, spacing = 40;
  _drawMenuButton('RESUME', 0, 20, btnW, btnH, [0, 255, 136]);
  _drawMenuButton('RESTART', 0, 20 + btnH + spacing, btnW, btnH, [255, 60, 60]);

  textSize(18);
  fill(255, 200);
  text(gameState.isMobile ? '' : 'PRESS ESC TO RESUME', 0, 20 + btnH + spacing + 80);
  pop();
}

/**
 * Helper to draw a styled menu button.
 * @private
 */
function _drawMenuButton(label, x, y, w, h, col) {
  rectMode(CENTER);
  fill(0, 100);
  rect(x + 4, y + 4, w, h, 12);
  fill(col[0] * 0.2, col[1] * 0.2, col[2] * 0.2, 220);
  stroke(col[0], col[1], col[2], 255);
  strokeWeight(2);
  rect(x, y, w, h, 12);
  noStroke();
  fill(255);
  textSize(28);
  text(label, x, y);
  rectMode(CORNER);
}

/**
 * Renders the shared 3D landscape background.
 */
function drawBackgroundLandscape() {
  let gl = drawingContext;
  let pxD = pixelDensity();
  gl.viewport(0, 0, width * pxD, height * pxD);
  gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, width / height, 10, VIEW_FAR * TILE * 1.5);
  gameState.menuCam.yaw += 0.0006;
  let cx = gameState.menuCam.x + sin(gameState.menuCam.yaw) * 550;
  let cz = gameState.menuCam.z + cos(gameState.menuCam.yaw) * 550;
  let terrainY = terrain.getAltitude(cx, cz);
  let cy = min(-90, terrainY - 60);
  camera(cx, cy, cz, gameState.menuCam.x, -10, gameState.menuCam.z, 0, 1, 0);

  let fakeShip = { x: gameState.menuCam.x, y: cy, z: gameState.menuCam.z, yaw: gameState.menuCam.yaw, pitch: 0 };
  setSceneLighting();
  terrain.drawLandscape(fakeShip, width / height);
  terrain.drawTrees(fakeShip);
  terrain.drawBuildings(fakeShip);
  pop();

  gl.clear(gl.DEPTH_BUFFER_BIT);
}

/**
 * Main entry point for the Ship Select screen.
 */
function drawShipSelect() {
  drawBackgroundLandscape();
  let pxD = pixelDensity();
  if (gameState.numPlayers === 1) {
    renderShipSelectView(gameState.players[0], 0, 0, width, height, pxD);
  } else {
    let hw = floor(width / 2);
    renderShipSelectView(gameState.players[0], 0, 0, hw, height, pxD);
    renderShipSelectView(gameState.players[1], 1, hw, hw, height, pxD);
    setup2DViewport();
    stroke(0, 255, 0, 180); strokeWeight(2);
    line(0, -height / 2, 0, height / 2);
    pop();
  }
}

/**
 * Renders the 3D ship preview and 2D selection text.
 */
function renderShipSelectView(p, pi, vx, vw, vh, pxD) {
  let gl = drawingContext;
  gl.viewport(vx * pxD, 0, vw * pxD, vh * pxD);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vx * pxD, 0, vw * pxD, vh * pxD);
  gl.clear(gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, vw / vh, 1, 1000);
  camera(0, -15, 60, 0, 0, 0, 0, 1, 0);
  directionalLight(255, 255, 255, 0.5, 1, -0.5);
  directionalLight(120, 180, 255, -0.5, -1, 0.5);
  ambientLight(45, 45, 55);

  push();
  rotateY(frameCount * 0.018);
  rotateX(sin(frameCount * 0.012) * 0.15);
  noStroke();
  drawShipPreview(p.designIndex, p.labelColor);
  pop();
  pop();

  setup2DViewport();

  // Handle smooth transitions
  HUD_Manager.drawDimOverlay();

  let relX = (vx + vw / 2) - width / 2;

  noStroke();
  const design = SHIP_DESIGNS[p.designIndex];
  _renderShipDetails(p, design, relX, vw, vh);
  _drawShipStats(p, design, relX, vw, vh);

  if (gameState.isMobile && !p.ready) {
    fill(255, 40);
    rect(relX - vw / 2 + 20, -40, 60, 80, 10);
    rect(relX + vw / 2 - 80, -40, 60, 80, 10);
    fill(255); textAlign(CENTER, CENTER); textSize(40);
    text("<", relX - vw / 2 + 50, 0);
    text(">", relX + vw / 2 - 50, 0);

    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2], 120);
    rect(relX - 120, vh / 2 - 100, 240, 60, 30);
    fill(255); textSize(22);
    text("CONFIRM", relX, vh / 2 - 70);
    textAlign(CENTER, TOP);
  }

  if (p.ready) {
    fill(0, 255, 0); textSize(36); textAlign(CENTER, CENTER);
    text("READY", relX, 0);
  }
  pop();
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
  let light = [lerp(r, 255, 0.4), lerp(g, 255, 0.4), lerp(b, 255, 0.4)];
  let engineGray = [80, 80, 85];

  noStroke();
  const drawFace = (pts, col) => {
    fill(col[0], col[1], col[2], col[3] || 255);
    beginShape();
    for (let p of pts) vertex(p[0], p[1], p[2]);
    endShape(CLOSE);
  };
  const sFake = { pitch: 0, yaw: 0 };
  const transform = (pt) => pt;
  design.draw(drawFace, tintColor, engineGray, light, dark, false, sFake, transform);
}

/**
 * HUD_Screens: Collection of screen-rendering logic.
 */
const HUD_Screens = {
  drawMenu,
  drawMission,
  drawInstructions,
  drawShipSelect,
  drawGameOver,
  drawPauseScreen,
  drawBackgroundLandscape
};
