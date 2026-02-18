// === CONSTANTS ===
const TILE = 120, SEA = 200, LAUNCH_ALT = 100, GRAV = 0.06, VIEW = 28;
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

// === STATE ===
let ship, trees = [], particles = [], bullets = [], enemies = [];
let homingMissiles = [], missilesRemaining = 1, score = 0, gameFont;
let infectedTiles = {}, level = 1, currentMaxEnemies = 2;
let levelComplete = false, infectionStarted = false, levelEndTime = 0;

// === HELPERS ===
const tileKey = (tx, tz) => tx + ',' + tz;
const toTile = v => Math.floor(v / TILE);
const isLaunchpad = (x, z) => x >= LAUNCH_MIN && x < LAUNCH_MAX && z >= LAUNCH_MIN && z < LAUNCH_MAX;
const aboveSea = y => y >= SEA - 1;
const shipDir = () => {
  let cp = cos(ship.pitch), sp = sin(ship.pitch), sy = sin(ship.yaw), cy = cos(ship.yaw);
  return { x: cp * -sy, y: sp, z: cp * -cy };
};

function resetShip() {
  Object.assign(ship, { x: 400, z: 400, y: LAUNCH_ALT - 20, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 });
}

function beginHUD() {
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();
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

function spawnProjectile(power, life) {
  let d = shipDir();
  return {
    x: ship.x, y: ship.y, z: ship.z,
    vx: d.x * power + ship.vx, vy: d.y * power + ship.vy, vz: d.z * power + ship.vz,
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
  ship = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 };
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
  resetShip();
  enemies = [];
  for (let i = 0; i < currentMaxEnemies; i++) spawnEnemy();
  infectedTiles = {};
  homingMissiles = [];
  missilesRemaining = 1;
}

function spawnEnemy() {
  enemies.push({
    x: random(-4000, 4000), y: random(-300, -800), z: random(-4000, 4000),
    vx: random(-2, 2), vz: random(-2, 2), id: random()
  });
}

function draw() {
  background(30, 60, 120);
  updateShip();
  updateEnemies();
  checkCollisions();
  spreadInfection();

  // 3D World
  push();
  let cd = 550;
  let camY = min(ship.y - 120, SEA - 60);
  camera(ship.x + sin(ship.yaw) * cd, camY, ship.z + cos(ship.yaw) * cd, ship.x, ship.y, ship.z, 0, 1, 0);
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);
  drawLandscape();
  drawSea();
  drawTrees();
  drawEnemies();
  shipDisplay();
  updateParticles();
  pop();

  // HUD
  drawRadar();
  drawScoreHUD();

  // Level logic
  let ic = Object.keys(infectedTiles).length;
  if (ic > 0) infectionStarted = true;
  if (infectionStarted && ic === 0 && !levelComplete) { levelComplete = true; levelEndTime = millis(); }
  if (levelComplete && millis() - levelEndTime > 4000) startLevel(level + 1);
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

function clearInfectionAt(wx, wz) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infectedTiles[tileKey(tx, tz)]) return false;
  let cleared = clearInfectionRadius(tx, tz);
  if (cleared > 0) { explosion(wx, getAltitude(wx, wz) - 10, wz); score += 100; }
  return cleared > 0;
}

// === SHIP ===
function updateShip() {
  if (document.pointerLockElement) {
    ship.yaw -= movedX * 0.003;
    ship.pitch = constrain(ship.pitch + movedY * 0.003, -PI / 2.2, PI / 2.2);
  }
  ship.vy += GRAV;

  if (mouseIsPressed && document.pointerLockElement) {
    let pw = 0.45;
    let dx = sin(ship.pitch) * -sin(ship.yaw);
    let dy = -cos(ship.pitch);
    let dz = sin(ship.pitch) * -cos(ship.yaw);
    ship.vx += dx * pw; ship.vy += dy * pw; ship.vz += dz * pw;
    if (frameCount % 2 === 0)
      particles.push({
        x: ship.x, y: ship.y, z: ship.z,
        vx: -dx * 8 + random(-1, 1), vy: -dy * 8 + random(-1, 1), vz: -dz * 8 + random(-1, 1), life: 255
      });
  }

  if (keyIsDown(32) && frameCount % 6 === 0) bullets.push(spawnProjectile(25, 300));

  ship.vx *= 0.985; ship.vy *= 0.985; ship.vz *= 0.985;
  ship.x += ship.vx; ship.y += ship.vy; ship.z += ship.vz;

  let g = getAltitude(ship.x, ship.z);
  if (ship.y > g - 12) {
    if (ship.vy > 2.8) resetGame();
    else { ship.y = g - 12; ship.vy = 0; ship.vx *= 0.8; ship.vz *= 0.8; }
  }
}

// === COLLISIONS ===
function checkCollisions() {
  for (let j = enemies.length - 1; j >= 0; j--) {
    let e = enemies[j], killed = false;
    for (let i = bullets.length - 1; i >= 0; i--) {
      if (dist(bullets[i].x, bullets[i].y, bullets[i].z, e.x, e.y, e.z) < 80) {
        explosion(e.x, e.y, e.z);
        enemies.splice(j, 1); bullets.splice(i, 1);
        score += 100; killed = true; break;
      }
    }
    if (!killed && dist(ship.x, ship.y, ship.z, e.x, e.y, e.z) < 70) resetGame();
  }

  // Bullet-tree: only infected trees absorb bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    let b = bullets[i];
    for (let t of trees) {
      let ty = getAltitude(t.x, t.z);
      let dxz = dist(b.x, b.z, t.x, t.z);
      if (dxz < 60 && b.y > ty - t.trunkH - 30 * t.canopyScale - 10 && b.y < ty + 10) {
        let tx = toTile(t.x), tz = toTile(t.z);
        if (infectedTiles[tileKey(tx, tz)]) {
          clearInfectionRadius(tx, tz);
          explosion(t.x, ty - t.trunkH, t.z);
          score += 200;
          bullets.splice(i, 1);
          break;
        }
      }
    }
  }
}

// === PARTICLES, BULLETS & MISSILES ===
function updateParticles() {
  // Exhaust particles
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx; p.y += p.vy; p.z += p.vz; p.life -= 10;
    push(); translate(p.x, p.y, p.z); noStroke(); fill(255, 150, 0, p.life); sphere(2); pop();
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    let b = bullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 255, 0); sphere(3); pop();
    if (b.life <= 0) bullets.splice(i, 1);
    else if (b.y > getAltitude(b.x, b.z)) { clearInfectionAt(b.x, b.z); bullets.splice(i, 1); }
  }

  // Homing missiles
  for (let i = homingMissiles.length - 1; i >= 0; i--) {
    let m = homingMissiles[i], maxSpd = 10;
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

    push(); translate(m.x, m.y, m.z); noStroke(); fill(0, 200, 255); sphere(5); pop();
    if (frameCount % 2 === 0)
      particles.push({ x: m.x, y: m.y, z: m.z, vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5), life: 120 });

    let hit = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      if (dist(m.x, m.y, m.z, enemies[j].x, enemies[j].y, enemies[j].z) < 100) {
        explosion(enemies[j].x, enemies[j].y, enemies[j].z);
        enemies.splice(j, 1); score += 250; hit = true; break;
      }
    }
    let gnd = getAltitude(m.x, m.z);
    if (hit || m.life <= 0 || m.y > gnd) {
      if (!hit && m.y > gnd) { explosion(m.x, m.y, m.z); clearInfectionAt(m.x, m.z); }
      homingMissiles.splice(i, 1);
    }
  }
}

// === HUD ===
function drawRadar() {
  beginHUD();
  translate(width / 2 - 100, -height / 2 + 100, 0);
  fill(0, 150); stroke(0, 255, 0); strokeWeight(2);
  rectMode(CENTER);
  rect(0, 0, 160, 160);
  rotateZ(ship.yaw);

  // Infected tiles
  fill(180, 0, 0, 80); noStroke();
  for (let k of Object.keys(infectedTiles)) {
    let [tx, tz] = k.split(',').map(Number);
    let rx = (tx * TILE - ship.x) * 0.015, rz = (tz * TILE - ship.z) * 0.015;
    if (abs(rx) < 75 && abs(rz) < 75) rect(rx, rz, 3, 3);
  }

  // Launchpad
  let lx = (400 - ship.x) * 0.015, lz = (400 - ship.z) * 0.015;
  if (abs(lx) < 75 && abs(lz) < 75) { fill(255, 255, 0, 150); noStroke(); rect(lx, lz, 5, 5); }

  // Enemies
  fill(255, 0, 0); noStroke();
  for (let e of enemies) {
    let rx = (e.x - ship.x) * 0.015, rz = (e.z - ship.z) * 0.015;
    if (abs(rx) < 75 && abs(rz) < 75) rect(rx, rz, 4, 4);
    else {
      push();
      translate(constrain(rx, -74, 74), constrain(rz, -74, 74), 0);
      rotateZ(atan2(rz, rx));
      fill(255, 0, 0, 180);
      triangle(4, 0, -3, -3, -3, 3);
      pop();
    }
  }

  rotateZ(-ship.yaw);
  fill(255, 255, 0);
  rect(0, 0, 6, 6);
  pop();
}

function drawScoreHUD() {
  beginHUD();
  noStroke();
  let lx = -width / 2 + 20, ly = -height / 2;
  let lines = [
    [22, [255, 255, 255], 'SCORE ' + score, lx, ly + 20],
    [22, [255, 255, 255], 'LEVEL ' + level, lx + 180, ly + 20],
    [18, [0, 255, 0], 'ALT ' + max(0, floor(SEA - ship.y)), lx, ly + 48],
    [16, [255, 80, 80], 'INFECTED ' + Object.keys(infectedTiles).length, lx, ly + 72],
    [16, [255, 100, 100], 'ENEMIES ' + enemies.length, lx, ly + 96],
    [16, [0, 200, 255], 'MISSILES ' + missilesRemaining, lx, ly + 120]
  ];
  textAlign(LEFT, TOP);
  for (let [sz, col, txt, x, y] of lines) { textSize(sz); fill(...col); text(txt, x, y); }

  if (levelComplete) {
    fill(0, 255, 0); textAlign(CENTER, CENTER); textSize(40);
    text("LEVEL " + level + " COMPLETE", 0, 0);
  }
  pop();
}

// === WORLD ===
function getAltitude(x, z) {
  if (isLaunchpad(x, z)) return LAUNCH_ALT;
  let xs = x * 0.001, zs = z * 0.001;
  return 250 - (2 * sin(xs - 2 * zs) + 2 * sin(4 * xs + 3 * zs) + 2 * sin(3 * zs - 5 * xs)) * 60;
}

function drawLandscape() {
  let gx = toTile(ship.x), gz = toTile(ship.z);
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

  for (let inf of infected) {
    fill(inf.r, inf.g, inf.b);
    beginShape(TRIANGLES);
    let v = inf.v;
    vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
    vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    endShape();
  }
}

function drawSea() {
  noStroke();
  let p = sin(frameCount * 0.03) * 8;
  fill(15, 45 + p, 150 + p);
  push(); translate(ship.x, SEA, ship.z); box(VIEW * TILE * 2, 2, VIEW * TILE * 2); pop();
}

function drawTrees() {
  let cullSq = 2500 * 2500;
  for (let t of trees) {
    let dx = ship.x - t.x, dz = ship.z - t.z;
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
function shipDisplay() {
  push();
  translate(ship.x, ship.y, ship.z);
  rotateY(ship.yaw); rotateX(ship.pitch);
  stroke(0);
  let faces = [
    [240, [-15, 10, 15], [15, 10, 15], [0, 10, -25]],
    [200, [0, -10, 5], [-15, 10, 15], [0, 10, -25]],
    [180, [0, -10, 5], [15, 10, 15], [0, 10, -25]],
    [150, [0, -10, 5], [-15, 10, 15], [15, 10, 15]]
  ];
  for (let [c, a, b, d] of faces) {
    fill(c); beginShape(); vertex(...a); vertex(...b); vertex(...d); endShape(CLOSE);
  }
  pop();

  let gy = getAltitude(ship.x, ship.z);
  let sd = max(10, (gy - ship.y) * 0.3);
  drawShadow(ship.x, gy, ship.z, 30 + sd, 20 + sd);
}

// === ENEMIES ===
function drawEnemies() {
  for (let e of enemies) {
    push(); translate(e.x, e.y, e.z); rotateY(frameCount * 0.15); noStroke();

    // Diamond top/bottom halves
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
  for (let e of enemies) {
    e.x += e.vx; e.z += e.vz; e.y += sin(frameCount * 0.05 + e.id) * 2;
    if (abs(e.x - ship.x) > 5000) e.vx *= -1;
    if (abs(e.z - ship.z) > 5000) e.vz *= -1;

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

function resetGame() { resetShip(); }

function keyPressed() {
  if (keyCode === SHIFT && missilesRemaining > 0 && document.pointerLockElement) {
    missilesRemaining--;
    homingMissiles.push(spawnProjectile(8, 300));
  }
}

function mousePressed() {
  if (!fullscreen()) fullscreen(true);
  if (!document.pointerLockElement) requestPointerLock();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }