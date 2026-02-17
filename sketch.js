// Game Constants
const TILE_SIZE = 120;
const SEA_LEVEL = 200;
const LAUNCHPAD_ALTITUDE = 100;
const GRAVITY = 0.06;
const VIEW_RANGE = 28;
// const MAX_ENEMIES = 2; // Removed in favor of dynamic count

let ship;
let trees = [];
let particles = [];
let bullets = [];
let enemies = [];
let score = 0;
let gameFont;

// Infection system
let infectedTiles = {};
const MAX_INFECTED = 1600;
const INFECTION_SPREAD_RATE = 0.01;

let level = 1;
let currentMaxEnemies = 2;
let levelComplete = false;
let infectionStarted = false;
let levelEndTime = 0;

function preload() {
  // Load a monospace-style font for WEBGL text rendering
  gameFont = loadFont('https://cdnjs.cloudflare.com/ajax/libs/topcoat/0.8.0/font/SourceCodePro-Bold.otf');
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  textFont(gameFont);

  ship = {
    x: 400, y: LAUNCHPAD_ALTITUDE - 20, z: 400,
    vx: 0, vy: 0, vz: 0,
    pitch: 0, yaw: 0
  };

  randomSeed(42);
  // Virus-style geometric trees - more of them, bigger
  for (let i = 0; i < 250; i++) {
    trees.push({
      x: random(-5000, 5000),
      z: random(-5000, 5000),
      variant: floor(random(3)),
      trunkH: random(25, 50),
      canopyScale: random(1.0, 1.8)
    });
  }

  startLevel(1);
}

function startLevel(lvl) {
  level = lvl;
  levelComplete = false;
  infectionStarted = false;
  currentMaxEnemies = 2 + (level - 1); // Add 1 enemy per level

  // Reset ship
  ship.x = 400; ship.z = 400; ship.y = LAUNCHPAD_ALTITUDE - 20;
  ship.vx = 0; ship.vy = 0; ship.vz = 0;
  ship.pitch = 0; ship.yaw = 0;

  // Clear and spawn enemies
  enemies = [];
  for (let i = 0; i < currentMaxEnemies; i++) spawnEnemy();

  // Clear any remaining infection
  infectedTiles = {};
}

function spawnEnemy() {
  enemies.push({
    x: random(-4000, 4000), y: random(-300, -800), z: random(-4000, 4000),
    vx: random(-2, 2), vz: random(-2, 2), id: random()
  });
}

function draw() {
  // Virus-style sky: deep blue-black at top, lighter at horizon
  background(30, 60, 120);

  // Handle Controls & Physics
  updateShip();
  updateEnemies();
  checkCollisions();
  spreadInfection();

  // --- 3D WORLD RENDERING ---
  push();
  // Camera Setup
  let camDist = 550;
  let camX = ship.x + sin(ship.yaw) * camDist;
  let camZ = ship.z + cos(ship.yaw) * camDist;
  let camY = ship.y - 120;
  if (camY > SEA_LEVEL - 60) camY = SEA_LEVEL - 60;
  camera(camX, camY, camZ, ship.x, ship.y, ship.z, 0, 1, 0);

  // Virus-style flat lighting
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);
  drawLandscape();
  drawSea();
  drawTrees();
  drawEnemies();
  shipDisplay();
  updateParticles();
  pop();

  // --- HUD LAYER ---
  drawRadar();
  drawScoreHUD();

  // Level Logic
  let infCount = Object.keys(infectedTiles).length;
  if (infCount > 0) infectionStarted = true;

  if (infectionStarted && infCount === 0 && !levelComplete) {
    levelComplete = true;
    levelEndTime = millis();
  }

  if (levelComplete) {
    if (millis() - levelEndTime > 4000) {
      startLevel(level + 1);
    }
  }
}

// --- INFECTION SYSTEM ---
// Orthogonal spread only (up/down/left/right)
const ORTHO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function spreadInfection() {
  if (frameCount % 5 !== 0) return;
  if (Object.keys(infectedTiles).length >= MAX_INFECTED) return;

  let newInfections = [];
  let keys = Object.keys(infectedTiles);

  for (let k of keys) {
    if (random() > INFECTION_SPREAD_RATE) continue;
    let parts = k.split(',');
    let tx = int(parts[0]);
    let tz = int(parts[1]);

    // Pick one random orthogonal direction
    let dir = ORTHO_DIRS[floor(random(4))];
    let nx = tx + dir[0];
    let nz = tz + dir[1];
    let nKey = nx + ',' + nz;

    let wx = nx * TILE_SIZE;
    let wz = nz * TILE_SIZE;
    if (wx >= 0 && wx < 800 && wz >= 0 && wz < 800) continue;
    let alt = getAltitude(wx, wz);
    if (alt >= SEA_LEVEL - 1) continue;

    if (!infectedTiles[nKey]) {
      newInfections.push({ key: nKey, tick: frameCount });
    }
  }

  for (let inf of newInfections) {
    infectedTiles[inf.key] = { tick: inf.tick };
  }
}

function updateShip() {
  if (document.pointerLockElement) {
    ship.yaw -= movedX * 0.003;
    ship.pitch = constrain(ship.pitch + movedY * 0.003, -PI / 2.2, PI / 2.2);
  }

  ship.vy += GRAVITY;

  if (mouseIsPressed && document.pointerLockElement) {
    let power = 0.45;
    let dirX = sin(ship.pitch) * -sin(ship.yaw);
    let dirY = -cos(ship.pitch);
    let dirZ = sin(ship.pitch) * -cos(ship.yaw);

    ship.vx += dirX * power;
    ship.vy += dirY * power;
    ship.vz += dirZ * power;

    if (frameCount % 2 == 0) {
      particles.push({
        x: ship.x, y: ship.y, z: ship.z,
        vx: -dirX * 8 + random(-1, 1),
        vy: -dirY * 8 + random(-1, 1),
        vz: -dirZ * 8 + random(-1, 1),
        life: 255
      });
    }
  }

  if (keyIsDown(SHIFT) && frameCount % 6 === 0) {
    let bPower = 25;
    bullets.push({
      x: ship.x, y: ship.y, z: ship.z,
      vx: cos(ship.pitch) * -sin(ship.yaw) * bPower + ship.vx,
      vy: sin(ship.pitch) * bPower + ship.vy,
      vz: cos(ship.pitch) * -cos(ship.yaw) * bPower + ship.vz,
      life: 100
    });
  }

  ship.vx *= 0.985; ship.vy *= 0.985; ship.vz *= 0.985;
  ship.x += ship.vx; ship.y += ship.vy; ship.z += ship.vz;

  let ground = getAltitude(ship.x, ship.z);
  if (ship.y > ground - 12) {
    if (ship.vy > 2.8) resetGame();
    else { ship.y = ground - 12; ship.vy = 0; ship.vx *= 0.8; ship.vz *= 0.8; }
  }
}

function drawRadar() {
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();

  translate(width / 2 - 100, -height / 2 + 100, 0);

  fill(0, 150); stroke(0, 255, 0); strokeWeight(2);
  rectMode(CENTER);
  rect(0, 0, 160, 160);

  rotateZ(ship.yaw);

  // Infected tile indicators on radar (subtle red glow)
  fill(180, 0, 0, 80); noStroke();
  let keys = Object.keys(infectedTiles);
  for (let k of keys) {
    let parts = k.split(',');
    let itx = int(parts[0]) * TILE_SIZE;
    let itz = int(parts[1]) * TILE_SIZE;
    let rx = (itx - ship.x) * 0.015;
    let rz = (itz - ship.z) * 0.015;
    if (abs(rx) < 75 && abs(rz) < 75) {
      rect(rx, rz, 3, 3);
    }
  }

  fill(255, 0, 0); noStroke();
  enemies.forEach(e => {
    let rx = (e.x - ship.x) * 0.015;
    let rz = (e.z - ship.z) * 0.015;
    if (abs(rx) < 75 && abs(rz) < 75) {
      rect(rx, rz, 4, 4);
    }
  });

  rotateZ(-ship.yaw);
  fill(255, 255, 0);
  rect(0, 0, 6, 6);

  pop();
}

function drawScoreHUD() {
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();

  // Score display - top left  
  noStroke();
  fill(255, 255, 255);
  textSize(22);
  textAlign(LEFT, TOP);
  text('SCORE ' + score, -width / 2 + 20, -height / 2 + 20);

  // Level display
  text('LEVEL ' + level, -width / 2 + 200, -height / 2 + 20);

  // Altitude indicator
  let alt = max(0, floor(SEA_LEVEL - ship.y));
  fill(0, 255, 0);
  textSize(18);
  text('ALT ' + alt, -width / 2 + 20, -height / 2 + 48);

  // Infection counter
  let infCount = Object.keys(infectedTiles).length;
  fill(255, 80, 80);
  textSize(16);
  text('INFECTED ' + infCount, -width / 2 + 20, -height / 2 + 72);

  // Enemy counter
  fill(255, 100, 100);
  text('ENEMIES ' + enemies.length, -width / 2 + 20, -height / 2 + 96);

  if (levelComplete) {
    fill(0, 255, 0);
    textAlign(CENTER, CENTER);
    textSize(40);
    text("LEVEL " + level + " COMPLETE", 0, 0);
  }

  pop();
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx; p.y += p.vy; p.z += p.vz;
    p.life -= 10;

    push();
    translate(p.x, p.y, p.z);
    noStroke();
    fill(255, 150, 0, p.life);
    sphere(2);
    pop();

    if (p.life <= 0) particles.splice(i, 1);
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    let b = bullets[i]; b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 255, 0); sphere(3); pop();
    if (b.life <= 0) {
      bullets.splice(i, 1);
    } else if (b.y > getAltitude(b.x, b.z)) {
      // Bullet hit ground — check if it landed on an infected tile
      clearInfectionAt(b.x, b.z);
      bullets.splice(i, 1);
    }
  }
}

// Clear infection in a radius around world coordinates
function clearInfectionAt(wx, wz) {
  let tx = Math.floor(wx / TILE_SIZE);
  let tz = Math.floor(wz / TILE_SIZE);
  let tileKey = tx + ',' + tz;
  if (!infectedTiles[tileKey]) return false;

  let clearRadius = 3;
  let cleared = 0;
  for (let dx = -clearRadius; dx <= clearRadius; dx++) {
    for (let dz = -clearRadius; dz <= clearRadius; dz++) {
      let ck = (tx + dx) + ',' + (tz + dz);
      if (infectedTiles[ck]) {
        delete infectedTiles[ck];
        cleared++;
      }
    }
  }
  if (cleared > 0) {
    explosion(wx, getAltitude(wx, wz) - 10, wz);
    score += 100;
  }
  return cleared > 0;
}

// --- WORLD LOGIC ---

function checkCollisions() {
  // Enemy-bullet and enemy-ship collisions
  for (let j = enemies.length - 1; j >= 0; j--) {
    let enemyKilled = false;
    for (let i = bullets.length - 1; i >= 0; i--) {
      let b = bullets[i];
      if (dist(b.x, b.y, b.z, enemies[j].x, enemies[j].y, enemies[j].z) < 80) {
        explosion(enemies[j].x, enemies[j].y, enemies[j].z);
        enemies.splice(j, 1);
        bullets.splice(i, 1);
        score += 100;
        enemyKilled = true;
        break; // Enemy dead, stop checking bullets
      }
    }

    if (!enemyKilled && dist(ship.x, ship.y, ship.z, enemies[j].x, enemies[j].y, enemies[j].z) < 70) {
      resetGame();
    }
  }

  // Bullet-tree collisions (trees are never destroyed, only cured)
  for (let i = bullets.length - 1; i >= 0; i--) {
    let b = bullets[i];
    for (let j = 0; j < trees.length; j++) {
      let t = trees[j];
      let treeY = getAltitude(t.x, t.z);
      let totalH = t.trunkH + 30 * t.canopyScale;
      let dxz = dist(b.x, b.z, t.x, t.z);
      if (dxz < 60 && b.y > treeY - totalH - 10 && b.y < treeY + 10) {
        // Only react if tree is infected — cure it and clear nearby infection
        let treeTx = Math.floor(t.x / TILE_SIZE);
        let treeTz = Math.floor(t.z / TILE_SIZE);
        let tileKey = treeTx + ',' + treeTz;
        if (infectedTiles[tileKey]) {
          let clearRadius = 3;
          for (let dx = -clearRadius; dx <= clearRadius; dx++) {
            for (let dz = -clearRadius; dz <= clearRadius; dz++) {
              let ck = (treeTx + dx) + ',' + (treeTz + dz);
              if (infectedTiles[ck]) {
                delete infectedTiles[ck];
              }
            }
          }
          explosion(t.x, treeY - t.trunkH, t.z);
          score += 200;
          bullets.splice(i, 1);
          break;
        }
        // Healthy trees: bullet passes through (no break)
      }
    }
  }
}

function getAltitude(x, z) {
  if (x > 0 && x < 800 && z > 0 && z < 800) return LAUNCHPAD_ALTITUDE;
  let xS = x * 0.001, zS = z * 0.001;
  let y = (2 * sin(xS - 2 * zS) + 2 * sin(4 * xS + 3 * zS) + 2 * sin(3 * zS - 5 * xS)) * 60;
  return 250 - y;
}

// --- LANDSCAPE: Virus-style checkerboard with flat-shaded tiles ---
// Batched rendering: groups same-colored tiles to reduce draw calls
function drawLandscape() {
  let gx = Math.floor(ship.x / TILE_SIZE);
  let gz = Math.floor(ship.z / TILE_SIZE);

  noStroke();

  // Collect tiles by color category, then batch-draw each category
  // Categories: 0=launchpad-light, 1=launchpad-dark, 2=green-light, 3=green-dark, 4+=infected(drawn individually due to pulsing)
  let greenLightVerts = [];
  let greenDarkVerts = [];
  let launchLightVerts = [];
  let launchDarkVerts = [];
  let infectedVerts = []; // {verts, color}

  for (let tz = gz - VIEW_RANGE; tz < gz + VIEW_RANGE; tz++) {
    for (let tx = gx - VIEW_RANGE; tx <= gx + VIEW_RANGE; tx++) {
      let xP = tx * TILE_SIZE;
      let zP = tz * TILE_SIZE;
      let xP1 = (tx + 1) * TILE_SIZE;
      let zP1 = (tz + 1) * TILE_SIZE;

      let y00 = getAltitude(xP, zP);
      let y10 = getAltitude(xP1, zP);
      let y01 = getAltitude(xP, zP1);
      let y11 = getAltitude(xP1, zP1);

      let avgY = (y00 + y10 + y01 + y11) / 4;
      if (avgY >= SEA_LEVEL - 1) continue;

      let checker = (tx + tz) % 2 === 0;
      let v = [xP, y00, zP, xP1, y10, zP, xP, y01, zP1, xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1];

      let tileKey = tx + ',' + tz;

      if (xP >= 0 && xP < 800 && zP >= 0 && zP < 800) {
        if (checker) launchLightVerts.push(v);
        else launchDarkVerts.push(v);
      } else if (infectedTiles[tileKey]) {
        let pulse = sin(frameCount * 0.08 + tx * 0.5 + tz * 0.3) * 0.5 + 0.5;
        let altFactor = map(avgY, -100, SEA_LEVEL, 1.15, 0.65);
        let r, g, b;
        if (checker) {
          r = lerp(160, 255, pulse) * altFactor;
          g = lerp(10, 40, pulse) * altFactor;
          b = lerp(10, 25, pulse) * altFactor;
        } else {
          r = lerp(120, 200, pulse) * altFactor;
          g = lerp(5, 25, pulse) * altFactor;
          b = lerp(5, 15, pulse) * altFactor;
        }
        infectedVerts.push({ v: v, r: r, g: g, b: b });
      } else {
        if (checker) greenLightVerts.push(v);
        else greenDarkVerts.push(v);
      }
    }
  }

  // Batch draw each category in one beginShape call
  // Green light tiles
  if (greenLightVerts.length > 0) {
    fill(62, 170, 62); // average green-light
    beginShape(TRIANGLES);
    for (let i = 0; i < greenLightVerts.length; i++) {
      let v = greenLightVerts[i];
      vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
      vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    }
    endShape();
  }

  // Green dark tiles
  if (greenDarkVerts.length > 0) {
    fill(38, 120, 38); // average green-dark
    beginShape(TRIANGLES);
    for (let i = 0; i < greenDarkVerts.length; i++) {
      let v = greenDarkVerts[i];
      vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
      vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    }
    endShape();
  }

  // Launchpad light
  if (launchLightVerts.length > 0) {
    fill(125, 125, 120);
    beginShape(TRIANGLES);
    for (let i = 0; i < launchLightVerts.length; i++) {
      let v = launchLightVerts[i];
      vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
      vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    }
    endShape();
  }

  // Launchpad dark
  if (launchDarkVerts.length > 0) {
    fill(110, 110, 105);
    beginShape(TRIANGLES);
    for (let i = 0; i < launchDarkVerts.length; i++) {
      let v = launchDarkVerts[i];
      vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
      vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    }
    endShape();
  }

  // Infected tiles - each unique color, but batch nearby similar ones
  for (let i = 0; i < infectedVerts.length; i++) {
    let inf = infectedVerts[i];
    fill(inf.r, inf.g, inf.b);
    beginShape(TRIANGLES);
    let v = inf.v;
    vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
    vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    endShape();
  }
}

// --- SEA: single flat plane ---
function drawSea() {
  noStroke();
  let seaPulse = sin(frameCount * 0.03) * 8;
  fill(15, 45 + seaPulse, 150 + seaPulse);
  push();
  translate(ship.x, SEA_LEVEL, ship.z);
  box(VIEW_RANGE * TILE_SIZE * 2, 2, VIEW_RANGE * TILE_SIZE * 2);
  pop();
}

// --- TREES: Virus-style geometric trees ---
function drawTrees() {
  let treeCullDist = 2500 * 2500; // squared distance for perf
  trees.forEach(t => {
    let dx = ship.x - t.x, dz = ship.z - t.z;
    if (dx * dx + dz * dz < treeCullDist) {
      let y = getAltitude(t.x, t.z);
      if (y >= SEA_LEVEL - 1) return;
      if (t.x >= 0 && t.x < 800 && t.z >= 0 && t.z < 800) return;

      push();
      translate(t.x, y, t.z);
      noStroke();

      let trunkH = t.trunkH;
      let sc = t.canopyScale;

      // Check if tree is on an infected tile
      let treeTx = Math.floor(t.x / TILE_SIZE);
      let treeTz = Math.floor(t.z / TILE_SIZE);
      let isInfected = !!infectedTiles[treeTx + ',' + treeTz];

      // Brown trunk (slightly darker if infected)
      fill(isInfected ? color(80, 40, 20) : color(100, 65, 25));
      push();
      translate(0, -trunkH / 2, 0);
      box(5, trunkH, 5);
      pop();

      // Canopy - red if infected, green if healthy
      if (t.variant === 0) {
        // Tall narrow cypress-like tree
        fill(isInfected ? color(180, 30, 20) : color(25, 130, 20));
        push();
        translate(0, -trunkH - 20 * sc, 0);
        cone(12 * sc, 45 * sc);
        pop();
      } else if (t.variant === 1) {
        // Wide bushy tree - two layered cones
        fill(isInfected ? color(190, 35, 25) : color(30, 145, 25));
        push();
        translate(0, -trunkH - 10 * sc, 0);
        cone(22 * sc, 28 * sc);
        pop();
        fill(isInfected ? color(150, 20, 15) : color(25, 120, 20));
        push();
        translate(0, -trunkH - 28 * sc, 0);
        cone(15 * sc, 22 * sc);
        pop();
      } else {
        // Very tall narrow spire
        fill(isInfected ? color(170, 30, 22) : color(35, 135, 28));
        push();
        translate(0, -trunkH - 28 * sc, 0);
        cone(9 * sc, 60 * sc);
        pop();
      }

      // Draw shadow on ground
      push();
      translate(0, -0.5, 8);
      rotateX(PI / 2);
      fill(0, 0, 0, 40);
      ellipse(0, 0, 20 * sc, 12 * sc);
      pop();

      pop();
    }
  });
}

function shipDisplay() {
  push();
  translate(ship.x, ship.y, ship.z);
  rotateY(ship.yaw); rotateX(ship.pitch);

  // Ship shadow on ground
  let groundY = getAltitude(ship.x, ship.z);

  stroke(0);
  fill(240); beginShape(); vertex(-15, 10, 15); vertex(15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(200); beginShape(); vertex(0, -10, 5); vertex(-15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(180); beginShape(); vertex(0, -10, 5); vertex(15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(150); beginShape(); vertex(0, -10, 5); vertex(-15, 10, 15); vertex(15, 10, 15); endShape(CLOSE);
  pop();

  // Ship shadow on ground
  if (groundY < SEA_LEVEL - 1) {
    push();
    translate(ship.x, groundY - 0.5, ship.z);
    rotateX(PI / 2);
    noStroke();
    fill(0, 0, 0, 50);
    let shadowDist = max(10, (groundY - ship.y) * 0.3);
    ellipse(0, 0, 30 + shadowDist, 20 + shadowDist);
    pop();
  }
}

// --- ENEMIES: Virus-style flat diamond shapes ---
function drawEnemies() {
  enemies.forEach(e => {
    push();
    translate(e.x, e.y, e.z);
    rotateY(frameCount * 0.15);
    noStroke();

    // Diamond/saucer shape - top half
    fill(220, 30, 30);
    beginShape(TRIANGLES);
    vertex(0, -10, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
    vertex(0, -10, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
    vertex(0, -10, -25); vertex(-22, 0, 0); vertex(0, -10, 25);
    vertex(0, -10, -25); vertex(22, 0, 0); vertex(0, -10, 25);
    endShape();

    // Bottom half (darker)
    fill(170, 15, 15);
    beginShape(TRIANGLES);
    vertex(0, 6, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
    vertex(0, 6, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
    vertex(0, 6, -25); vertex(-22, 0, 0); vertex(0, 6, 25);
    vertex(0, 6, -25); vertex(22, 0, 0); vertex(0, 6, 25);
    endShape();

    // Antenna
    fill(255, 60, 60);
    push();
    translate(0, -14, 0);
    box(3, 14, 3);
    pop();

    pop();

    // Shadow on ground
    let groundY = getAltitude(e.x, e.z);
    if (groundY < SEA_LEVEL - 1) {
      push();
      translate(e.x, groundY - 0.5, e.z);
      rotateX(PI / 2);
      noStroke();
      fill(0, 0, 0, 50);
      ellipse(0, 0, 40, 40);
      pop();
    }
  });
}

function updateEnemies() {
  enemies.forEach(e => {
    e.x += e.vx; e.z += e.vz; e.y += sin(frameCount * 0.05 + e.id) * 2;
    if (abs(e.x - ship.x) > 5000) e.vx *= -1;
    if (abs(e.z - ship.z) > 5000) e.vz *= -1;

    // Enemies drop infection bombs periodically
    if (random() < 0.008) {
      let groundY = getAltitude(e.x, e.z);
      if (groundY < SEA_LEVEL - 1) {
        let tx = Math.floor(e.x / TILE_SIZE);
        let tz = Math.floor(e.z / TILE_SIZE);
        // Don't infect launchpad
        let wx = tx * TILE_SIZE;
        let wz = tz * TILE_SIZE;
        if (!(wx >= 0 && wx < 800 && wz >= 0 && wz < 800)) {
          let key = tx + ',' + tz;
          if (!infectedTiles[key]) {
            infectedTiles[key] = { tick: frameCount };
          }
        }
      }
    }
  });
}

function explosion(x, y, z) {
  for (let i = 0; i < 20; i++) particles.push({ x: x, y: y, z: z, vx: random(-5, 5), vy: random(-5, 5), vz: random(-5, 5), life: 200 });
}

function resetGame() {
  ship.x = 400; ship.z = 400; ship.y = LAUNCHPAD_ALTITUDE - 20;
  ship.vx = ship.vy = ship.vz = 0;
}

function mousePressed() {
  let fs = fullscreen();
  if (!fs) {
    fullscreen(true);
  }

  if (!document.pointerLockElement) {
    requestPointerLock();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}