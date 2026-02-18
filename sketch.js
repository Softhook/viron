// === CONSTANTS ===
const TILE = 120, SEA = 200, LAUNCH_ALT = 100, GRAV = 0.09, VIEW = 28;
const ORTHO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MAX_INF = 1600, INF_RATE = 0.01, CLEAR_R = 3;
const LAUNCH_MIN = 0, LAUNCH_MAX = 800;
const TREE_VARIANTS = [
  { infected: [180, 30, 20], healthy: [25, 130, 20], cones: [[12, 45, 20]] },
  {
    infected: [190, 35, 25], healthy: [30, 145, 25], cones: [[22, 28, 10]],
    infected2: [150, 20, 15], healthy2: [25, 120, 20], cones2: [[15, 22, 28]]
  },
  { infected: [170, 30, 22], healthy: [35, 135, 28], cones: [[9, 60, 28]] }
];

// Turn/pitch rates for keyboard steering
const YAW_RATE = 0.04;
const PITCH_RATE = 0.03;

// === KEY BINDINGS ===
// Player 1: WASD + Q/E/R/F
const P1_KEYS = {
  thrust: 87,   // W
  left: 65,     // A
  right: 68,    // D
  brake: 83,    // S
  pitchUp: 82,  // R
  pitchDown: 70,// F
  shoot: 81,    // Q
  missile: 69   // E
};
// Player 2: Arrow keys + nearby keys (raw keycodes since p5 consts unavailable at parse)
const P2_KEYS = {
  thrust: 38,     // UP_ARROW
  left: 37,       // LEFT_ARROW
  right: 39,      // RIGHT_ARROW
  brake: 40,      // DOWN_ARROW
  pitchUp: 186,   // ; (semicolon)
  pitchDown: 222, // ' (quote)
  shoot: 190,     // . (period)
  missile: 191    // / (slash)
};

// === STATE ===
let trees = [], particles = [], enemies = [];
let infectedTiles = {}, level = 1, currentMaxEnemies = 2;
let levelComplete = false, infectionStarted = false, levelEndTime = 0;
let gameFont;

// Each player object holds their own ship + projectiles + score
let players = [];



// === HELPERS ===
const tileKey = (tx, tz) => tx + ',' + tz;
const toTile = v => Math.floor(v / TILE);
const isLaunchpad = (x, z) => x >= LAUNCH_MIN && x < LAUNCH_MAX && z >= LAUNCH_MIN && z < LAUNCH_MAX;
const aboveSea = y => y >= SEA - 1;

function shipDir(s) {
  let cp = cos(s.pitch), sp = sin(s.pitch), sy = sin(s.yaw), cy = cos(s.yaw);
  return { x: cp * -sy, y: sp, z: cp * -cy };
}

function resetShip(p, offsetX) {
  Object.assign(p.ship, {
    x: 400 + (offsetX || 0), z: 400, y: LAUNCH_ALT - 20,
    vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0
  });
}

function createPlayer(id, keys, offsetX, labelColor) {
  let p = {
    id,
    keys,
    labelColor,
    ship: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 },
    bullets: [],
    homingMissiles: [],
    missilesRemaining: 1,
    score: 0,
    dead: false,
    respawnTimer: 0
  };
  resetShip(p, offsetX);
  return p;
}

function drawShadow(x, groundY, z, w, h) {
  if (aboveSea(groundY)) return;
  push();
  translate(x, groundY - 0.5, z);
  rotateX(PI / 2);
  noStroke();
  fill(0, 0, 0, 50);
  ellipse(0, 0, w, h);
  pop();
}

function drawShipShadow(x, groundY, z, yaw, alt) {
  if (aboveSea(groundY)) return;
  let spread = max(1, (groundY - alt) * 0.012);
  let alpha = map(groundY - alt, 0, 600, 60, 15, true);
  push();
  translate(x, groundY - 0.3, z);
  rotateY(yaw);
  noStroke();
  fill(0, 0, 0, alpha);
  beginShape();
  vertex(-15 * spread, 0, 15 * spread);
  vertex(15 * spread, 0, 15 * spread);
  vertex(0, 0, -25 * spread);
  endShape(CLOSE);
  pop();
}

function drawBatch(verts, r, g, b) {
  if (!verts.length) return;
  fill(r, g, b);
  beginShape(TRIANGLES);
  for (let v of verts) {
    vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
    vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
  }
  endShape();
}

function clearInfectionRadius(tx, tz) {
  let cleared = 0;
  for (let dx = -CLEAR_R; dx <= CLEAR_R; dx++)
    for (let dz = -CLEAR_R; dz <= CLEAR_R; dz++) {
      let k = tileKey(tx + dx, tz + dz);
      if (infectedTiles[k]) { delete infectedTiles[k]; cleared++; }
    }
  return cleared;
}

function findNearest(arr, x, y, z) {
  let best = null, bestD = Infinity;
  for (let e of arr) {
    let d = dist(x, y, z, e.x, e.y, e.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  return { target: best, dist: bestD };
}

function spawnProjectile(s, power, life) {
  let d = shipDir(s);
  return {
    x: s.x, y: s.y, z: s.z,
    vx: d.x * power + s.vx, vy: d.y * power + s.vy, vz: d.z * power + s.vz,
    life
  };
}

// === P5 LIFECYCLE ===
function preload() {
  gameFont = loadFont('https://cdnjs.cloudflare.com/ajax/libs/topcoat/0.8.0/font/SourceCodePro-Bold.otf');
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  textFont(gameFont);

  players = [
    createPlayer(0, P1_KEYS, -100, [80, 180, 255]),   // P1 blue tint
    createPlayer(1, P2_KEYS, 100, [255, 180, 80])      // P2 orange tint
  ];

  randomSeed(42);
  for (let i = 0; i < 250; i++)
    trees.push({
      x: random(-5000, 5000), z: random(-5000, 5000),
      variant: floor(random(3)), trunkH: random(25, 50), canopyScale: random(1.0, 1.8)
    });
  startLevel(1);
}

function startLevel(lvl) {
  level = lvl;
  levelComplete = false;
  infectionStarted = false;
  currentMaxEnemies = 1 + level;
  for (let p of players) {
    resetShip(p, p.id === 0 ? -100 : 100);
    p.homingMissiles = [];
    p.missilesRemaining = 1;
    p.dead = false;
    p.respawnTimer = 0;
  }
  enemies = [];
  for (let i = 0; i < currentMaxEnemies; i++) spawnEnemy();
  infectedTiles = {};
}

function spawnEnemy() {
  enemies.push({
    x: random(-4000, 4000), y: random(-300, -800), z: random(-4000, 4000),
    vx: random(-2, 2), vz: random(-2, 2), id: random()
  });
}

function draw() {
  let gl = drawingContext;

  // Shared world updates (once per frame)
  for (let p of players) updateShipInput(p);
  updateEnemies();
  for (let p of players) checkCollisions(p);
  spreadInfection();

  // Update particle physics once (not per-viewport)
  updateParticlePhysics();
  for (let p of players) updateProjectilePhysics(p);

  // Draw split screen — left half for P1, right half for P2
  let hw = floor(width / 2);
  let h = height;
  let pxDensity = pixelDensity();

  for (let pi = 0; pi < 2; pi++) {
    let p = players[pi];
    let s = p.ship;
    let xOff = pi * hw;

    // Set the GL viewport and scissor for this player's half
    gl.viewport(xOff * pxDensity, 0, hw * pxDensity, h * pxDensity);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(xOff * pxDensity, 0, hw * pxDensity, h * pxDensity);

    // Clear just this half with the sky colour
    gl.clearColor(30 / 255, 60 / 255, 120 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Begin a fresh 3D scene for this half
    push();
    let fov = PI / 3;
    let aspect = hw / h;
    perspective(fov, aspect, 1, 15000);

    // Camera follows this player's ship
    let cd = 550;
    let camY = min(s.y - 120, SEA - 60);
    camera(
      s.x + sin(s.yaw) * cd, camY, s.z + cos(s.yaw) * cd,
      s.x, s.y, s.z,
      0, 1, 0
    );
    directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
    ambientLight(60, 60, 70);

    drawLandscape(s);
    drawSea(s);
    drawTrees(s);
    drawEnemies();

    // Draw THIS player's ship
    if (!p.dead) shipDisplay(s, p.labelColor);

    // Draw THE OTHER player's ship (as seen from this camera)
    let other = players[1 - pi];
    if (!other.dead) shipDisplay(other.ship, other.labelColor);

    // Render particles and projectiles (already updated above)
    renderParticles();
    renderProjectiles(players[0]);
    renderProjectiles(players[1]);

    pop();

    // HUD overlay for this player
    drawPlayerHUD(p, pi, hw, h);

    gl.disable(gl.SCISSOR_TEST);
  }

  // Reset viewport to full canvas for the divider line
  let pxD = pixelDensity();
  gl.viewport(0, 0, width * pxD, height * pxD);
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();
  stroke(0, 255, 0, 180);
  strokeWeight(2);
  line(0, -height / 2, 0, height / 2);

  // Level complete text
  if (levelComplete) {
    noStroke();
    fill(0, 255, 0);
    textAlign(CENTER, CENTER);
    textSize(40);
    text("LEVEL " + level + " COMPLETE", 0, 0);
  }
  pop();

  // Level logic
  let ic = Object.keys(infectedTiles).length;
  if (ic > 0) infectionStarted = true;
  if (infectionStarted && ic === 0 && !levelComplete) { levelComplete = true; levelEndTime = millis(); }
  if (levelComplete && millis() - levelEndTime > 4000) startLevel(level + 1);

  // Respawn dead players
  for (let p of players) {
    if (p.dead) {
      p.respawnTimer--;
      if (p.respawnTimer <= 0) {
        p.dead = false;
        resetShip(p, p.id === 0 ? -100 : 100);
      }
    }
  }
}

// === INFECTION ===
function spreadInfection() {
  if (frameCount % 5 !== 0) return;
  let keys = Object.keys(infectedTiles);
  if (keys.length >= MAX_INF) return;
  let fresh = [];
  for (let k of keys) {
    if (random() > INF_RATE) continue;
    let [tx, tz] = k.split(',').map(Number);
    let d = ORTHO_DIRS[floor(random(4))];
    let nx = tx + d[0], nz = tz + d[1], nk = tileKey(nx, nz);
    let wx = nx * TILE, wz = nz * TILE;
    if (isLaunchpad(wx, wz) || aboveSea(getAltitude(wx, wz)) || infectedTiles[nk]) continue;
    fresh.push(nk);
  }
  for (let k of fresh) infectedTiles[k] = { tick: frameCount };
}

function clearInfectionAt(wx, wz, p) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infectedTiles[tileKey(tx, tz)]) return false;
  let cleared = clearInfectionRadius(tx, tz);
  if (cleared > 0) { explosion(wx, getAltitude(wx, wz) - 10, wz); if (p) p.score += 100; }
  return cleared > 0;
}

// === SHIP INPUT (keyboard-only) ===
function updateShipInput(p) {
  let s = p.ship;
  if (p.dead) return;

  let k = p.keys;

  // Yaw (turn left/right) — use keyIsDown() to avoid stuck-key issues
  if (keyIsDown(k.left)) s.yaw += YAW_RATE;
  if (keyIsDown(k.right)) s.yaw -= YAW_RATE;

  // Pitch (tilt up/down)
  if (keyIsDown(k.pitchUp)) s.pitch = constrain(s.pitch - PITCH_RATE, -PI / 2.2, PI / 2.2);
  if (keyIsDown(k.pitchDown)) s.pitch = constrain(s.pitch + PITCH_RATE, -PI / 2.2, PI / 2.2);

  // Gravity
  s.vy += GRAV;

  // Thrust (forward along current heading)
  if (keyIsDown(k.thrust)) {
    let pw = 0.45;
    let dx = sin(s.pitch) * -sin(s.yaw);
    let dy = -cos(s.pitch);
    let dz = sin(s.pitch) * -cos(s.yaw);
    s.vx += dx * pw; s.vy += dy * pw; s.vz += dz * pw;
    if (frameCount % 2 === 0)
      particles.push({
        x: s.x, y: s.y, z: s.z,
        vx: -dx * 8 + random(-1, 1), vy: -dy * 8 + random(-1, 1), vz: -dz * 8 + random(-1, 1), life: 255
      });
  }

  // Brake / reverse thrust
  if (keyIsDown(k.brake)) {
    s.vx *= 0.96; s.vy *= 0.96; s.vz *= 0.96;
  }

  // Shoot
  if (keyIsDown(k.shoot) && frameCount % 6 === 0)
    p.bullets.push(spawnProjectile(s, 25, 300));

  // Damping
  s.vx *= 0.985; s.vy *= 0.985; s.vz *= 0.985;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  // Water crash
  if (s.y > SEA - 12) {
    explosion(s.x, SEA, s.z);
    killPlayer(p);
    return;
  }

  // Ground collision
  let g = getAltitude(s.x, s.z);
  if (s.y > g - 12) {
    if (s.vy > 2.8) killPlayer(p);
    else { s.y = g - 12; s.vy = 0; s.vx *= 0.8; s.vz *= 0.8; }
  }
}

function killPlayer(p) {
  p.dead = true;
  p.respawnTimer = 120; // ~2 seconds at 60fps
  p.bullets = [];
}

// === COLLISIONS ===
function checkCollisions(p) {
  if (p.dead) return;
  let s = p.ship;

  // Bullets vs enemies
  for (let j = enemies.length - 1; j >= 0; j--) {
    let e = enemies[j], killed = false;
    for (let i = p.bullets.length - 1; i >= 0; i--) {
      if (dist(p.bullets[i].x, p.bullets[i].y, p.bullets[i].z, e.x, e.y, e.z) < 80) {
        explosion(e.x, e.y, e.z);
        enemies.splice(j, 1); p.bullets.splice(i, 1);
        p.score += 100; killed = true; break;
      }
    }
    if (!killed && dist(s.x, s.y, s.z, e.x, e.y, e.z) < 70) killPlayer(p);
  }

  // Bullet-tree: only infected trees absorb bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    for (let t of trees) {
      let ty = getAltitude(t.x, t.z);
      let dxz = dist(b.x, b.z, t.x, t.z);
      if (dxz < 60 && b.y > ty - t.trunkH - 30 * t.canopyScale - 10 && b.y < ty + 10) {
        let tx = toTile(t.x), tz = toTile(t.z);
        if (infectedTiles[tileKey(tx, tz)]) {
          clearInfectionRadius(tx, tz);
          explosion(t.x, ty - t.trunkH, t.z);
          p.score += 200;
          p.bullets.splice(i, 1);
          break;
        }
      }
    }
  }
}

// === PARTICLES & PROJECTILES ===
// Physics: run once per frame
function updateParticlePhysics() {
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx; p.y += p.vy; p.z += p.vz; p.life -= 10;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function updateProjectilePhysics(p) {
  // Bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    if (b.life <= 0) p.bullets.splice(i, 1);
    else if (b.y > getAltitude(b.x, b.z)) { clearInfectionAt(b.x, b.z, p); p.bullets.splice(i, 1); }
  }

  // Homing missiles
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i], maxSpd = 10;
    let { target } = findNearest(enemies, m.x, m.y, m.z);
    if (target) {
      let dx = target.x - m.x, dy = target.y - m.y, dz = target.z - m.z;
      let mg = sqrt(dx * dx + dy * dy + dz * dz);
      if (mg > 0) {
        let bl = 0.12;
        m.vx = lerp(m.vx, dx / mg * maxSpd, bl);
        m.vy = lerp(m.vy, dy / mg * maxSpd, bl);
        m.vz = lerp(m.vz, dz / mg * maxSpd, bl);
      }
    }
    let sp = sqrt(m.vx * m.vx + m.vy * m.vy + m.vz * m.vz);
    if (sp > 0) { m.vx = m.vx / sp * maxSpd; m.vy = m.vy / sp * maxSpd; m.vz = m.vz / sp * maxSpd; }
    m.x += m.vx; m.y += m.vy; m.z += m.vz; m.life--;

    if (frameCount % 2 === 0)
      particles.push({ x: m.x, y: m.y, z: m.z, vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5), life: 120 });

    let hit = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      if (dist(m.x, m.y, m.z, enemies[j].x, enemies[j].y, enemies[j].z) < 100) {
        explosion(enemies[j].x, enemies[j].y, enemies[j].z);
        enemies.splice(j, 1); p.score += 250; hit = true; break;
      }
    }
    let gnd = getAltitude(m.x, m.z);
    if (hit || m.life <= 0 || m.y > gnd) {
      if (!hit && m.y > gnd) { explosion(m.x, m.y, m.z); clearInfectionAt(m.x, m.z, p); }
      p.homingMissiles.splice(i, 1);
    }
  }
}

// Rendering: run once per viewport
function renderParticles() {
  for (let p of particles) {
    push(); translate(p.x, p.y, p.z); noStroke(); fill(255, 150, 0, p.life); sphere(2); pop();
  }
}

function renderProjectiles(p) {
  // Bullets
  for (let b of p.bullets) {
    push(); translate(b.x, b.y, b.z); noStroke();
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2]);
    sphere(3); pop();
  }

  // Homing missiles
  for (let m of p.homingMissiles) {
    push(); translate(m.x, m.y, m.z); noStroke(); fill(0, 200, 255); sphere(5); pop();
  }
}

// === HUD (per-player, rendered in their viewport) ===
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
  let lx = (400 - s.x) * 0.012, lz = (400 - s.z) * 0.012;
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
  if (!other.dead) {
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
  push();
  textAlign(CENTER, BOTTOM);
  textSize(11);
  fill(255, 255, 255, 120);
  let hints = pi === 0
    ? 'W thrust  A/D turn  R/F pitch  Q shoot  E missile  S brake'
    : '↑ thrust  ←/→ turn  ;/\' pitch  . shoot  / missile  ↓ brake';
  text(hints, 0, h / 2 - 8);
  pop();
}

// === WORLD ===
function getAltitude(x, z) {
  if (isLaunchpad(x, z)) return LAUNCH_ALT;
  let xs = x * 0.001, zs = z * 0.001;
  return 250 - (2 * sin(xs - 2 * zs) + 2 * sin(4 * xs + 3 * zs) + 2 * sin(3 * zs - 5 * xs)) * 60;
}

function drawLandscape(s) {
  let gx = toTile(s.x), gz = toTile(s.z);
  noStroke();

  let batches = { gl: [], gd: [], ll: [], ld: [] };
  let infected = [];

  for (let tz = gz - VIEW; tz < gz + VIEW; tz++) {
    for (let tx = gx - VIEW; tx <= gx + VIEW; tx++) {
      let xP = tx * TILE, zP = tz * TILE, xP1 = xP + TILE, zP1 = zP + TILE;
      let y00 = getAltitude(xP, zP), y10 = getAltitude(xP1, zP);
      let y01 = getAltitude(xP, zP1), y11 = getAltitude(xP1, zP1);
      let avgY = (y00 + y10 + y01 + y11) / 4;
      if (aboveSea(avgY)) continue;

      let chk = (tx + tz) % 2 === 0;
      let v = [xP, y00, zP, xP1, y10, zP, xP, y01, zP1, xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1];

      if (isLaunchpad(xP, zP)) {
        (chk ? batches.ll : batches.ld).push(v);
      } else if (infectedTiles[tileKey(tx, tz)]) {
        let pulse = sin(frameCount * 0.08 + tx * 0.5 + tz * 0.3) * 0.5 + 0.5;
        let af = map(avgY, -100, SEA, 1.15, 0.65);
        let base = chk ? [160, 255, 10, 40, 10, 25] : [120, 200, 5, 25, 5, 15];
        infected.push({
          v,
          r: lerp(base[0], base[1], pulse) * af,
          g: lerp(base[2], base[3], pulse) * af,
          b: lerp(base[4], base[5], pulse) * af
        });
      } else {
        (chk ? batches.gl : batches.gd).push(v);
      }
    }
  }

  drawBatch(batches.gl, 62, 170, 62);
  drawBatch(batches.gd, 38, 120, 38);
  drawBatch(batches.ll, 125, 125, 120);
  drawBatch(batches.ld, 110, 110, 105);

  // Solid launchpad base
  push();
  noStroke();
  fill(80, 80, 75);
  let padW = LAUNCH_MAX - LAUNCH_MIN;
  let padTop = LAUNCH_ALT + 2;
  let padH = SEA - padTop + 10;
  translate(
    (LAUNCH_MIN + LAUNCH_MAX) / 2,
    padTop + padH / 2,
    (LAUNCH_MIN + LAUNCH_MAX) / 2
  );
  box(padW, padH, padW);
  pop();

  for (let inf of infected) {
    fill(inf.r, inf.g, inf.b);
    beginShape(TRIANGLES);
    let v = inf.v;
    vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
    vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    endShape();
  }
}

function drawSea(s) {
  noStroke();
  let p = sin(frameCount * 0.03) * 8;
  fill(15, 45 + p, 150 + p);
  push(); translate(s.x, SEA, s.z); box(VIEW * TILE * 2, 2, VIEW * TILE * 2); pop();
}

function drawTrees(s) {
  let cullSq = 2500 * 2500;
  for (let t of trees) {
    let dx = s.x - t.x, dz = s.z - t.z;
    if (dx * dx + dz * dz >= cullSq) continue;
    let y = getAltitude(t.x, t.z);
    if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

    push(); translate(t.x, y, t.z); noStroke();
    let { trunkH: h, canopyScale: sc, variant: vi } = t;
    let inf = !!infectedTiles[tileKey(toTile(t.x), toTile(t.z))];

    // Trunk
    fill(inf ? color(80, 40, 20) : color(100, 65, 25));
    push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

    // Canopy
    let tv = TREE_VARIANTS[vi];
    let c1 = inf ? tv.infected : tv.healthy;
    fill(color(...c1));
    let cn = tv.cones[0];
    push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc); pop();

    if (tv.cones2) {
      fill(color(...(inf ? tv.infected2 : tv.healthy2)));
      let cn2 = tv.cones2[0];
      push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc); pop();
    }

    // Shadow
    push(); translate(0, -0.5, 8); rotateX(PI / 2); fill(0, 0, 0, 40); ellipse(0, 0, 20 * sc, 12 * sc); pop();
    pop();
  }
}

// === SHIP DISPLAY ===
function shipDisplay(s, tintColor) {
  push();
  translate(s.x, s.y, s.z);
  rotateY(s.yaw); rotateX(s.pitch);
  stroke(0);
  // Tint the ship slightly per-player
  let r = tintColor[0], g = tintColor[1], b = tintColor[2];
  let faces = [
    [lerp(200, r, 0.3), lerp(200, g, 0.3), lerp(200, b, 0.3),
    [-15, 10, 15], [15, 10, 15], [0, 10, -25]],
    [lerp(170, r, 0.2), lerp(170, g, 0.2), lerp(170, b, 0.2),
    [0, -10, 5], [-15, 10, 15], [0, 10, -25]],
    [lerp(150, r, 0.2), lerp(150, g, 0.2), lerp(150, b, 0.2),
    [0, -10, 5], [15, 10, 15], [0, 10, -25]],
    [lerp(130, r, 0.15), lerp(130, g, 0.15), lerp(130, b, 0.15),
    [0, -10, 5], [-15, 10, 15], [15, 10, 15]]
  ];
  for (let [cr, cg, cb, a, bf, d] of faces) {
    fill(cr, cg, cb); beginShape(); vertex(...a); vertex(...bf); vertex(...d); endShape(CLOSE);
  }
  pop();

  let gy = getAltitude(s.x, s.z);
  drawShipShadow(s.x, gy, s.z, s.yaw, s.y);
}

// === ENEMIES ===
function drawEnemies() {
  for (let e of enemies) {
    push(); translate(e.x, e.y, e.z); rotateY(frameCount * 0.15); noStroke();

    for (let [yOff, col] of [[-10, [220, 30, 30]], [6, [170, 15, 15]]]) {
      fill(...col);
      beginShape(TRIANGLES);
      vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
      vertex(0, yOff, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
      vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(0, yOff, 25);
      vertex(0, yOff, -25); vertex(22, 0, 0); vertex(0, yOff, 25);
      endShape();
    }

    fill(255, 60, 60);
    push(); translate(0, -14, 0); box(3, 14, 3); pop();
    pop();

    drawShadow(e.x, getAltitude(e.x, e.z), e.z, 40, 40);
  }
}

function updateEnemies() {
  // Use first alive player for distance-based enemy behaviours (or fallback)
  let refShip = players.find(p => !p.dead)?.ship || players[0].ship;

  for (let e of enemies) {
    e.x += e.vx; e.z += e.vz; e.y += sin(frameCount * 0.05 + e.id) * 2;
    if (abs(e.x - refShip.x) > 5000) e.vx *= -1;
    if (abs(e.z - refShip.z) > 5000) e.vz *= -1;

    if (random() < 0.008) {
      let gy = getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let wx = tx * TILE, wz = tz * TILE;
        if (!isLaunchpad(wx, wz)) {
          let k = tileKey(tx, tz);
          if (!infectedTiles[k]) infectedTiles[k] = { tick: frameCount };
        }
      }
    }
  }
}

// === EFFECTS & INPUT ===
function explosion(x, y, z) {
  for (let i = 0; i < 40; i++)
    particles.push({ x, y, z, vx: random(-8, 8), vy: random(-8, 8), vz: random(-8, 8), life: 255 });
}

function keyPressed() {
  // Missile launch (one-shot action, not continuous)
  for (let p of players) {
    if (keyCode === p.keys.missile && p.missilesRemaining > 0 && !p.dead) {
      p.missilesRemaining--;
      p.homingMissiles.push(spawnProjectile(p.ship, 8, 300));
    }
  }
}

function mousePressed() {
  // No pointer lock needed for keyboard-only controls,
  // but still allow fullscreen on click
  if (!fullscreen()) fullscreen(true);
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }