// === CONSTANTS ===
const TILE = 120;
const SEA = 200, LAUNCH_ALT = 100, GRAV = 0.09;
// View rings: near = always drawn, outer = frustum culled (all at full tile detail)
let VIEW_NEAR = 35, VIEW_FAR = 50;
let CULL_DIST = 6000;
const SKY_R = 30, SKY_G = 60, SKY_B = 120;
const ORTHO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MAX_INF = 2000, INF_RATE = 0.01, CLEAR_R = 3;
const LAUNCH_MIN = 0, LAUNCH_MAX = 840;
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
const PITCH_RATE = 0.04;

// Mouse controls
const MOUSE_SENSITIVITY = 0.003;
const MOUSE_SMOOTHING = 0.25; // Lower is smoother (0.0 to 1.0)

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
let trees = [], particles = [], enemies = [], buildings = [], bombs = [], enemyBullets = [];
let infectedTiles = {}, level = 1, currentMaxEnemies = 2;
let levelComplete = false, infectionStarted = false, levelEndTime = 0;
let activePulses = [];
let gameFont;
let gameState = 'menu'; // 'menu' or 'playing', 'gameover'
let gameOverReason = '';
let lastAlarmTime = 0;
let gameStartTime = 0;
let numPlayers = 1;
let menuStars = []; // animated starfield for menu
let mouseReleasedSinceStart = true;
let leftMouseDown = false;
let rightMouseDown = false;

// Each player object holds their own ship + projectiles + score
let players = [];
let altCache = new Map();
let smoothedMX = 0, smoothedMY = 0;

// Terrain chunking setup
const CHUNK_SIZE = 16;
let chunkCache = new Map();
let terrainShader;

let isMobile = false;
let isAndroid = false;

function checkMobile() {
  isAndroid = /Android/i.test(navigator.userAgent);
  isMobile = isAndroid || /iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window);
}

// === HELPERS ===
const tileKey = (tx, tz) => tx + ',' + tz;
const toTile = v => Math.floor(v / TILE);
const isLaunchpad = (x, z) => x >= LAUNCH_MIN && x <= LAUNCH_MAX && z >= LAUNCH_MIN && z <= LAUNCH_MAX;
const aboveSea = y => y >= SEA - 1;
const getSpawnX = p => numPlayers === 1 ? 420 : (p.id === 0 ? 320 : 520);

function setSceneLighting() {
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);
}

function addPulse(x, z, type = 0.0) {
  activePulses = [{ x, z, start: millis() / 1000.0, type }, ...activePulses].slice(0, 5);
}

// Frustum cull: is tile roughly in front of camera?
function inFrustum(cam, tx, tz) {
  let dx = tx - cam.x, dz = tz - cam.z;
  let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
  if (fwdDist < -TILE * 5) return false;
  let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
  let aspect = (numPlayers === 1 ? width : width * 0.5) / height;
  let slope = 0.57735 * aspect + 0.3; // tan(PI/6) * aspect + safe margin
  let halfWidth = (fwdDist > 0 ? fwdDist : 0) * slope + TILE * 6;
  return Math.abs(rightDist) <= halfWidth;
}

function getCameraParams(s) {
  let fwdX = -sin(s.yaw), fwdZ = -cos(s.yaw);
  return {
    x: s.x - fwdX * 550,
    z: s.z - fwdZ * 550,
    fwdX: fwdX,
    fwdZ: fwdZ
  };
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
    let dSq = (x - e.x) ** 2 + (y - e.y) ** 2 + (z - e.z) ** 2;
    if (dSq < bestD) { bestD = dSq; best = e; }
  }
  return best;
}

// spawnProjectile is now in player.js

// === P5 LIFECYCLE ===
function preload() {
  gameFont = loadFont('Impact.ttf');
}

function setup() {
  checkMobile();
  if (isMobile) {
    VIEW_NEAR = 20;
    VIEW_FAR = 30;
    CULL_DIST = 3500;
  }
  createCanvas(windowWidth, windowHeight, WEBGL);
  document.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('mousedown', e => {
    if (e.button === 0) leftMouseDown = true;
    if (e.button === 1) e.preventDefault(); // Prevent autoscroll
    if (e.button === 2) rightMouseDown = true;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) leftMouseDown = false;
    if (e.button === 2) rightMouseDown = false;
  });

  terrainShader = createShader(TERRAIN_VERT, TERRAIN_FRAG);

  textFont(gameFont);

  // Generate trees once (reused across games)
  randomSeed(42);
  let numTrees = isMobile ? 80 : 250;
  for (let i = 0; i < numTrees; i++)
    trees.push({
      x: random(-5000, 5000), z: random(-5000, 5000),
      variant: floor(random(3)), trunkH: random(25, 50), canopyScale: random(1.0, 1.8)
    });

  // Generate starfield for menu background
  let numStars = isMobile ? 50 : 120;
  for (let i = 0; i < numStars; i++)
    menuStars.push({ x: random(-1, 1), y: random(-1, 1), s: random(1, 3), spd: random(0.3, 1.2) });

  // Generate Zarch style buildings
  randomSeed(123);
  let numBldgs = isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    buildings.push({
      x: random(-4500, 4500), z: random(-4500, 4500),
      w: random(40, 100), h: random(50, 180), d: random(40, 100),
      type: floor(random(4)),
      col: [random(80, 200), random(80, 200), random(80, 200)]
    });
  }

  gameState = 'menu';
}

function startGame(np) {
  numPlayers = np;
  gameStartTime = millis();
  mouseReleasedSinceStart = !leftMouseDown;
  if (np === 1) {
    players = [createPlayer(0, P1_KEYS, 420, [80, 180, 255])];
  } else {
    players = [
      createPlayer(0, P1_KEYS, 300, [80, 180, 255]),
      createPlayer(1, P2_KEYS, 500, [255, 180, 80])
    ];
  }
  startLevel(1);
  gameState = 'playing';
}

function startLevel(lvl) {
  if (typeof gameSFX !== 'undefined') gameSFX.playNewLevel();
  level = lvl;
  levelComplete = false;
  infectionStarted = false;
  currentMaxEnemies = 1 + level;
  for (let p of players) {
    resetShip(p, getSpawnX(p));
    p.homingMissiles = [];
    if (lvl > 1) {
      p.missilesRemaining++;
    } else {
      p.missilesRemaining = 1; // Reset to 1 on game start
    }
    p.dead = false;
    p.respawnTimer = 0;
  }
  enemies = [];
  bombs = [];
  enemyBullets = [];
  activePulses = [];
  for (let i = 0; i < currentMaxEnemies; i++) spawnEnemy(i === 0);
  infectedTiles = {};
}

// Menu and game over screens are now in ui.js

function renderPlayerView(gl, p, pi, viewX, viewW, viewH, pxDensity) {
  let s = p.ship;
  let vx = viewX * pxDensity, vw = viewW * pxDensity, vh = viewH * pxDensity;

  gl.viewport(vx, 0, vw, vh);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vx, 0, vw, vh);
  gl.clearColor(30 / 255, 60 / 255, 120 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, viewW / viewH, 50, VIEW_FAR * TILE * 1.5);
  let cd = 550, camY = min(s.y - 120, SEA - 60);
  let cx = s.x + sin(s.yaw) * cd;
  let cy = camY;
  let cz = s.z + cos(s.yaw) * cd;
  camera(cx, cy, cz, s.x, s.y, s.z, 0, 1, 0);
  if (typeof gameSFX !== 'undefined') gameSFX.updateListener(cx, cy, cz, s.x, s.y, s.z, 0, 1, 0);
  setSceneLighting();

  drawLandscape(s);
  drawTrees(s);
  drawBuildings(s);
  drawEnemies(s);

  for (let player of players) {
    if (!player.dead) shipDisplay(player.ship, player.labelColor);
    renderProjectiles(player, s.x, s.z);
  }
  renderParticles(s.x, s.z);
  pop();

  gl.clear(gl.DEPTH_BUFFER_BIT);
  drawPlayerHUD(p, pi, viewW, viewH);
  if (isMobile && numPlayers === 1 && typeof mobileController !== 'undefined') mobileController.draw(width, height);
  gl.disable(gl.SCISSOR_TEST);
}

function draw() {
  if (gameState === 'menu') { drawMenu(); return; }
  if (gameState === 'gameover') { drawGameOver(); return; }

  // --- Dynamic Performance Scaling ---
  if (frameCount > 60 && frameCount % 120 === 0) {
    let fps = frameRate();
    if (!window.maxObservedFPS) window.maxObservedFPS = 60;
    if (fps > window.maxObservedFPS + 2) window.maxObservedFPS = fps;

    let targetFPS = window.maxObservedFPS > 70 ? 75 : 60;

    if (fps < targetFPS * 0.9) {
      VIEW_NEAR = max(15, VIEW_NEAR - 2);
      VIEW_FAR = max(20, VIEW_FAR - 2);
      CULL_DIST = max(2000, CULL_DIST - 400);
    } else if (fps >= targetFPS * 0.95) {
      VIEW_NEAR = min(35, VIEW_NEAR + 1);
      VIEW_FAR = min(50, VIEW_FAR + 1);
      CULL_DIST = min(6000, CULL_DIST + 200);
    }
  }
  // -----------------------------------

  if (altCache.size > 10000) altCache.clear();
  if (chunkCache.size > 200) chunkCache.clear();

  let gl = drawingContext;

  if (isMobile && numPlayers === 1 && typeof mobileController !== 'undefined') mobileController.update(touches, width, height);

  for (let p of players) updateShipInput(p);
  updateEnemies();
  for (let p of players) checkCollisions(p);
  spreadInfection();

  updateParticlePhysics();
  for (let p of players) updateProjectilePhysics(p);

  let h = height;
  let pxDensity = pixelDensity();

  if (numPlayers === 1) {
    renderPlayerView(gl, players[0], 0, 0, width, h, pxDensity);
  } else {
    let hw = floor(width / 2);
    for (let pi = 0; pi < 2; pi++) {
      renderPlayerView(gl, players[pi], pi, pi * hw, hw, h, pxDensity);
    }
  }

  setup2DViewport();
  if (numPlayers === 2) {
    stroke(0, 255, 0, 180); strokeWeight(2);
    line(0, -height / 2, 0, height / 2);
  }
  if (levelComplete) {
    noStroke(); fill(0, 255, 0); textAlign(CENTER, CENTER); textSize(40);
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
        resetShip(p, getSpawnX(p));
      }
    }
  }
}

// === INFECTION ===
function spreadInfection() {
  if (frameCount % 5 !== 0) return;
  let keys = Object.keys(infectedTiles);
  let keysLen = keys.length;

  if (keysLen >= MAX_INF) {
    if (gameState !== 'gameover') {
      gameState = 'gameover';
      gameOverReason = 'INFECTION REACHED CRITICAL MASS';
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
    }
    return;
  }

  // Check launchpad infection
  let lpInfected = 0, lpTotal = 0;
  for (let tx = 0; tx < 7; tx++) {
    for (let tz = 0; tz < 7; tz++) {
      lpTotal++;
      if (infectedTiles[tileKey(tx, tz)]) lpInfected++;
    }
  }
  if (lpInfected >= lpTotal) {
    if (gameState !== 'gameover') {
      gameState = 'gameover';
      gameOverReason = 'LAUNCH PAD INFECTED';
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
    }
    return;
  }

  let fresh = [];
  for (let i = 0; i < keysLen; i++) {
    if (random() > INF_RATE) continue;
    let parts = keys[i].split(',');
    let tx = +parts[0], tz = +parts[1];
    let d = ORTHO_DIRS[floor(random(4))];
    let nx = tx + d[0], nz = tz + d[1], nk = tileKey(nx, nz);
    let wx = nx * TILE, wz = nz * TILE;
    if (aboveSea(getAltitude(wx, wz)) || infectedTiles[nk]) continue;
    fresh.push(nk);
  }
  let freshLen = fresh.length;
  for (let i = 0; i < freshLen; i++) {
    let nk = fresh[i];
    infectedTiles[nk] = { tick: frameCount };
    let parts = nk.split(',');
    let ptx = +parts[0], ptz = +parts[1];
    if (typeof gameSFX !== 'undefined') gameSFX.playInfectionSpread(ptx * TILE, getAltitude(ptx * TILE, ptz * TILE), ptz * TILE);
    // Alarm if new infection is on launchpad
    if (isLaunchpad(ptx * TILE, ptz * TILE)) {
      if (millis() - lastAlarmTime > 1000) {
        if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
        lastAlarmTime = millis();
      }
    }
  }
}

function clearInfectionAt(wx, wz, p) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infectedTiles[tileKey(tx, tz)]) return false;
  clearInfectionRadius(tx, tz);
  if (p) p.score += 100;
  if (typeof gameSFX !== 'undefined') gameSFX.playClearInfection(wx, getAltitude(wx, wz), wz);
  return true;
}

// Ship input, physics, and collision handling are now in player.js


// HUD rendering is now in ui.js

// Terrain generation and rendering are now in terrain.js

// Ship display is now in player.js

function keyPressed() {
  // Menu key handling
  if (gameState === 'menu') {
    if (key === '1') startGame(1);
    else if (key === '2') startGame(2);
    return;
  }

  // Missile launch (one-shot action, not continuous)
  for (let p of players) {
    if (keyCode === p.keys.missile) {
      fireMissile(p);
    }
  }
}

function touchStarted(event) {
  if (typeof handleTouchStarted === 'function') {
    return handleTouchStarted();
  }
  return false;
}

function touchEnded(event) {
  return false;
}

function touchMoved(event) {
  return false;
}

function mousePressed() {
  if (!isMobile) {
    if (!fullscreen()) fullscreen(true);

    if (gameState === 'menu') {
      startGame(1);
    } else if (gameState === 'playing') {
      if (mouseButton === CENTER) {
        if (players.length > 0 && !players[0].dead) {
          fireMissile(players[0]);
        }
      }
      requestPointerLock();
    }
  }
}

function mouseDragged() { mouseMoved(); }

function mouseMoved() {
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }