// UI, HUD, and menu rendering
function drawMenu() {
  background(8, 12, 28);
  setup2DViewport();

  // Animated starfield
  noStroke();
  for (let st of menuStars) {
    st.y += st.spd * 0.002;
    if (st.y > 1) st.y -= 2;
    let sx = st.x * width / 2;
    let sy = st.y * height / 2;
    let twinkle = 150 + sin(frameCount * 0.05 + st.x * 100) * 105;
    fill(twinkle, twinkle, twinkle + 30, twinkle);
    ellipse(sx, sy, st.s, st.s);
  }

  // Pulsing glow behind title
  let glowPulse = sin(frameCount * 0.04) * 0.3 + 0.7;
  noStroke();
  fill(0, 255, 60, 18 * glowPulse);
  ellipse(0, -height * 0.14, 500 * glowPulse, 140 * glowPulse);
  fill(0, 255, 60, 10 * glowPulse);
  ellipse(0, -height * 0.14, 700 * glowPulse, 200 * glowPulse);

  // Title — "VIRON"
  textAlign(CENTER, CENTER);
  noStroke();

  // Shadow
  fill(0, 180, 40, 80);
  textSize(110);
  text('V I R O N', 3, -height * 0.14 + 4);

  // Main title
  let titlePulse = sin(frameCount * 0.06) * 30;
  fill(30 + titlePulse, 255, 60 + titlePulse);
  textSize(110);
  text('V I R O N', 0, -height * 0.14);

  // Subtitle
  textSize(16);
  fill(140, 200, 140, 180);
  text('Christian Nold, 2026', 0, -height * 0.14 + 70);

  // Scanline effect
  for (let y = -height / 2; y < height / 2; y += 4) {
    stroke(0, 0, 0, 20);
    strokeWeight(1);
    line(-width / 2, y, width / 2, y);
  }
  noStroke();

  // Menu options
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

  // Controls hint
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

function drawGameOver() {
  setup2DViewport();
  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);

  fill(255, 60, 60);
  textAlign(CENTER, CENTER);
  textSize(80);
  text('GAME OVER', 0, -50);
  textSize(24);
  fill(180, 200, 180);
  text(gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);
  pop();

  if (millis() - levelEndTime > 5000) {
    gameState = 'menu';
  }
}

function drawPlayerHUD(p, pi, hw, h) {
  let s = p.ship;

  // Viewport is already set by the draw loop (with pxDensity scaling)
  push();
  // Ortho mapped to half-width
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();

  noStroke();
  textAlign(LEFT, TOP);

  let lx = -hw / 2 + 14;
  let ly = -h / 2;
  let col = p.labelColor;

  // Player label
  textSize(16);
  fill(col[0], col[1], col[2]);
  text('P' + (pi + 1), lx, ly + 6);

  // Stats
  let lines = [
    [20, [255, 255, 255], 'SCORE ' + p.score, lx, ly + 26],
    [16, [0, 255, 0], 'ALT ' + max(0, floor(SEA - s.y)), lx, ly + 50],
    [14, [255, 80, 80], 'INF ' + Object.keys(infectedTiles).length, lx, ly + 72],
    [14, [255, 100, 100], 'ENEMIES ' + enemies.length, lx, ly + 90],
    [14, [0, 200, 255], 'MISSILES ' + p.missilesRemaining, lx, ly + 108]
  ];
  for (let [sz, c, txt, x, y] of lines) { textSize(sz); fill(c[0], c[1], c[2]); text(txt, x, y); }

  // Level indicator
  textSize(16);
  fill(255);
  textAlign(RIGHT, TOP);
  text('LVL ' + level, hw / 2 - 14, ly + 6);

  // Dead indicator
  if (p.dead) {
    fill(255, 0, 0, 200);
    textAlign(CENTER, CENTER);
    textSize(28);
    text("DESTROYED", 0, 0);
    textSize(16);
    fill(200);
    text("Respawning...", 0, 30);
  }

  // Mini radar (top-right of each panel)
  drawRadarForPlayer(p, hw, h);

  // Control hints at bottom
  drawControlHints(p, pi, hw, h);

  pop();
}

function drawRadarForPlayer(p, hw, h) {
  let s = p.ship;
  push();
  translate(hw / 2 - 70, -h / 2 + 80, 0);
  fill(0, 150); stroke(0, 255, 0); strokeWeight(1.5);
  rectMode(CENTER);
  rect(0, 0, 110, 110);
  rotateZ(s.yaw);

  // Infected tiles
  fill(180, 0, 0, 80); noStroke();
  for (let k of Object.keys(infectedTiles)) {
    let [tx, tz] = k.split(',').map(Number);
    let rx = (tx * TILE - s.x) * 0.012, rz = (tz * TILE - s.z) * 0.012;
    if (abs(rx) < 50 && abs(rz) < 50) rect(rx, rz, 2, 2);
  }

  // Launchpad
  let lx = (420 - s.x) * 0.012, lz = (420 - s.z) * 0.012;
  if (abs(lx) < 50 && abs(lz) < 50) { fill(255, 255, 0, 150); noStroke(); rect(lx, lz, 4, 4); }

  // Enemies
  fill(255, 0, 0); noStroke();
  for (let e of enemies) {
    let rx = (e.x - s.x) * 0.012, rz = (e.z - s.z) * 0.012;
    if (abs(rx) < 50 && abs(rz) < 50) rect(rx, rz, 3, 3);
    else {
      push();
      translate(constrain(rx, -49, 49), constrain(rz, -49, 49), 0);
      rotateZ(atan2(rz, rx));
      fill(255, 0, 0, 180);
      triangle(3, 0, -2, -2, -2, 2);
      pop();
    }
  }

  // Other player
  let other = players[1 - p.id];
  if (other && !other.dead) {
    let ox = (other.ship.x - s.x) * 0.012, oz = (other.ship.z - s.z) * 0.012;
    fill(other.labelColor[0], other.labelColor[1], other.labelColor[2], 200);
    noStroke();
    if (abs(ox) < 50 && abs(oz) < 50) rect(ox, oz, 4, 4);
  }

  rotateZ(-s.yaw);
  fill(255, 255, 0);
  rect(0, 0, 4, 4);
  pop();
}

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

function setup2DViewport() {
  let pxD = pixelDensity();
  drawingContext.viewport(0, 0, width * pxD, height * pxD);
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();
}
