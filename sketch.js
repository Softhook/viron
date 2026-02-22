// === CONSTANTS ===
let TILE = 120;
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
let trees = [], particles = [], enemies = [], buildings = [], bombs = [], enemyBullets = [];
let infectedTiles = {}, level = 1, currentMaxEnemies = 2;
let levelComplete = false, infectionStarted = false, levelEndTime = 0;
let activePulses = [];
let gameFont;
let gameState = 'menu'; // 'menu' or 'playing'
let gameStartTime = 0;
let numPlayers = 1;
let menuStars = []; // animated starfield for menu
let mouseReleasedSinceStart = true;
let leftMouseDown = false;
let rightMouseDown = false;

// Each player object holds their own ship + projectiles + score
let players = [];
let altCache = new Map();

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

function shipUpDir(s) {
  let sp = sin(s.pitch), cp = cos(s.pitch), sy = sin(s.yaw), cy = cos(s.yaw);
  return { x: sp * -sy, y: -cp, z: sp * -cy };
}

function resetShip(p, offsetX) {
  p.ship = { x: offsetX, y: LAUNCH_ALT, z: 420, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 };
}

function createPlayer(id, keys, offsetX, labelColor) {
  let p = {
    id, keys, labelColor, score: 0, dead: false, respawnTimer: 0,
    bullets: [], homingMissiles: [], missilesRemaining: 1, mobileMissilePressed: false
  };
  resetShip(p, offsetX);
  return p;
}

function fireMissile(p) {
  if (p.missilesRemaining > 0 && !p.dead) {
    p.missilesRemaining--;
    p.homingMissiles.push(spawnProjectile(p.ship, 8, 300));
  }
}

function drawShadow(x, groundY, z, w, h) {
  if (aboveSea(groundY)) return;
  push();
  translate(x, groundY - 0.5, z);
  rotateX(PI / 2);
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

function setup2DViewport() {
  let pxD = pixelDensity();
  drawingContext.viewport(0, 0, width * pxD, height * pxD);
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();
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

function spawnProjectile(s, power, life) {
  let cp = cos(s.pitch), sp = sin(s.pitch);
  let cy = cos(s.yaw), sy = sin(s.yaw);

  // Front direction (local 0, 0, -1)
  let fx = -cp * sy;
  let fy = sp;
  let fz = -cp * cy;

  // Nose point with clearance: local (0, 10, -30)
  let lz = -30, ly = 10;
  let y1 = ly * cp - lz * sp;
  let z1 = ly * sp + lz * cp;

  return {
    x: s.x + z1 * sy,
    y: s.y + y1,
    z: s.z + z1 * cy,
    vx: fx * power + s.vx,
    vy: fy * power + s.vy,
    vz: fz * power + s.vz,
    life
  };
}

const TERRAIN_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec4 aVertexColor;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
varying vec4 vColor;
varying vec4 vWorldPos;

void main() {
  vec4 viewSpace = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * viewSpace;
  vWorldPos = vec4(aPosition, 1.0);
  vColor = aVertexColor;
}
`;

const TERRAIN_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
varying vec4 vWorldPos;
uniform float uTime;
uniform vec3 uPulses[5];
uniform vec2 uFogDist;

void main() {  
  vec3 cyberColor = vec3(0.0);
  
  // Bomb drop pulses
  for (int i = 0; i < 5; i++) {
    float age = uTime - uPulses[i].z;
    if (age >= 0.0 && age < 3.0) { // Lasts for 3 seconds
      // Scale differences by 0.01 before taking length to avoid fp16 overflow on mobile
      vec2 diff = (vWorldPos.xz - uPulses[i].xy) * 0.01;
      float distToPulse = length(diff) * 100.0;
      
      float radius = age * 800.0; // Expands fast
      float ringThickness = 80.0;
      float ring = smoothstep(radius - ringThickness, radius, distToPulse) * (1.0 - smoothstep(radius, radius + ringThickness, distToPulse));
      
      float fade = 1.0 - (age / 3.0);
      cyberColor += vec3(1.0, 0.1, 0.1) * ring * fade * 2.0; // Glowing neon red ring
    }
  }
  
  vec3 outColor = vColor.rgb + cyberColor;
  
  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  vec3 fogColor = vec3(30.0 / 255.0, 60.0 / 255.0, 120.0 / 255.0);
  outColor = mix(outColor, fogColor, fogFactor);

  gl_FragColor = vec4(outColor, vColor.a);
}
`;

// === P5 LIFECYCLE ===
function preload() {
  gameFont = loadFont('https://cdnjs.cloudflare.com/ajax/libs/topcoat/0.8.0/font/SourceCodePro-Bold.otf');
}

function setup() {
  checkMobile();
  createCanvas(windowWidth, windowHeight, WEBGL);
  document.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('mousedown', e => {
    if (e.button === 0) leftMouseDown = true;
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
  for (let i = 0; i < 250; i++)
    trees.push({
      x: random(-5000, 5000), z: random(-5000, 5000),
      variant: floor(random(3)), trunkH: random(25, 50), canopyScale: random(1.0, 1.8)
    });

  // Generate starfield for menu background
  for (let i = 0; i < 120; i++)
    menuStars.push({ x: random(-1, 1), y: random(-1, 1), s: random(1, 3), spd: random(0.3, 1.2) });

  // Generate Zarch style buildings
  randomSeed(123);
  for (let i = 0; i < 40; i++) {
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
  level = lvl;
  levelComplete = false;
  infectionStarted = false;
  currentMaxEnemies = 1 + level;
  for (let p of players) {
    resetShip(p, numPlayers === 1 ? 420 : (p.id === 0 ? 320 : 520));
    p.homingMissiles = [];
    p.missilesRemaining = 1;
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

function spawnEnemy(forceSeeder = false) {
  let type = 'seeder';
  if (!forceSeeder && level > 0) {
    let r = random();
    if (r < 0.3) type = 'fighter';
    else if (r < 0.5) type = 'bomber';
    else if (r < 0.7) type = 'crab';
    else if (r < 0.8) type = 'hunter';
  }
  let ex = random(-4000, 4000);
  let ez = random(-4000, 4000);
  let ey = random(-300, -800);
  if (type === 'crab') {
    ey = getAltitude(ex, ez) - 10;
  }
  enemies.push({
    x: ex, y: ey, z: ez,
    vx: random(-2, 2), vz: random(-2, 2), id: random(),
    type: type,
    fireTimer: 0,
    bombTimer: 0
  });
}

// === MENU ===
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

  // Title — "VIRUS"
  textAlign(CENTER, CENTER);
  noStroke();

  // Shadow
  fill(0, 180, 40, 80);
  textSize(110);
  text('V I R U S', 3, -height * 0.14 + 4);

  // Main title
  let titlePulse = sin(frameCount * 0.06) * 30;
  fill(30 + titlePulse, 255, 60 + titlePulse);
  textSize(110);
  text('V I R U S', 0, -height * 0.14);

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
    text('P1: w/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E missile', 0, height / 2 - 55);
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
  text('INFECTION REACHED CRITICAL MASS', 0, 40);
  pop();

  if (millis() - levelEndTime > 5000) {
    gameState = 'menu';
  }
}

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
  camera(s.x + sin(s.yaw) * cd, camY, s.z + cos(s.yaw) * cd, s.x, s.y, s.z, 0, 1, 0);
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);

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
  if (isMobile && numPlayers === 1) mobileControls.draw();
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

  if (isMobile && numPlayers === 1) mobileControls.update();

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
        resetShip(p, numPlayers === 1 ? 420 : (p.id === 0 ? 320 : 520));
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
      levelEndTime = millis();
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
    if (isLaunchpad(wx, wz) || aboveSea(getAltitude(wx, wz)) || infectedTiles[nk]) continue;
    fresh.push(nk);
  }
  let freshLen = fresh.length;
  for (let i = 0; i < freshLen; i++) infectedTiles[fresh[i]] = { tick: frameCount };
}

function clearInfectionAt(wx, wz, p) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infectedTiles[tileKey(tx, tz)]) return false;
  clearInfectionRadius(tx, tz);
  explosion(wx, getAltitude(wx, wz) - 10, wz);
  if (p) p.score += 100;
  return true;
}

// === MOBILE INPUT ===
const mobileControls = {
  leftTouchId: null, joyCenter: null, joyPos: null,
  btns: {
    thrust: { active: false, r: 40, col: [0, 255, 60], label: 'THR', x: 0, y: 0 },
    shoot: { active: false, r: 50, col: [255, 60, 60], label: 'SHT', x: 0, y: 0 },
    missile: { active: false, r: 35, col: [0, 200, 255], label: 'MSL', x: 0, y: 0 }
  },

  update() {
    if (!isMobile || gameState !== 'playing') return;

    let bw = width, bh = height;
    this.btns.thrust.x = bw - 180; this.btns.thrust.y = bh - 70;
    this.btns.shoot.x = bw - 70; this.btns.shoot.y = bh - 70;
    this.btns.missile.x = bw - 70; this.btns.missile.y = bh - 180;

    for (let b in this.btns) this.btns[b].active = false;

    let leftFound = false;
    for (let i = 0; i < touches.length; i++) {
      let t = touches[i];
      if (t.x > bw / 2) {
        for (let b in this.btns) {
          if (Math.hypot(t.x - this.btns[b].x, t.y - this.btns[b].y) < this.btns[b].r * 1.5) this.btns[b].active = true;
        }
      } else {
        if (this.leftTouchId === t.id) {
          this.joyPos = { x: t.x, y: t.y };
          leftFound = true;
        } else if (!this.leftTouchId) {
          this.leftTouchId = t.id;
          this.joyCenter = { x: t.x, y: t.y };
          this.joyPos = { x: t.x, y: t.y };
          leftFound = true;
        }
      }
    }

    if (!leftFound) {
      this.leftTouchId = null;
      this.joyCenter = null;
      this.joyPos = null;
    }
  },

  draw() {
    setup2DViewport();
    push();
    translate(-width / 2, -height / 2, 0);

    if (this.joyCenter && this.joyPos) {
      noStroke();
      fill(255, 255, 255, 40);
      circle(this.joyCenter.x, this.joyCenter.y, 140);
      fill(255, 255, 255, 120);
      let d = Math.hypot(this.joyPos.x - this.joyCenter.x, this.joyPos.y - this.joyCenter.y);
      let a = atan2(this.joyPos.y - this.joyCenter.y, this.joyPos.x - this.joyCenter.x);
      let r = min(d, 70);
      circle(this.joyCenter.x + cos(a) * r, this.joyCenter.y + sin(a) * r, 50);
    }

    for (let b in this.btns) {
      let btn = this.btns[b];
      stroke(btn.col[0], btn.col[1], btn.col[2], btn.active ? 200 : 80);
      strokeWeight(2);
      fill(btn.col[0], btn.col[1], btn.col[2], btn.active ? 80 : 20);
      circle(btn.x, btn.y, btn.r * 2);
      noStroke(); fill(255, btn.active ? 255 : 150);
      textAlign(CENTER, CENTER); textSize(max(10, btn.r * 0.4));
      text(btn.label, btn.x, btn.y);
    }
    pop();
  }
};

// === SHIP INPUT & PHYSICS ===
function updateShipInput(p) {
  if (p.dead) return;
  let k = p.keys;
  if (!leftMouseDown) mouseReleasedSinceStart = true;
  let isThrusting = keyIsDown(k.thrust) || (p.id === 0 && !isMobile && rightMouseDown);
  let isBraking = keyIsDown(k.brake);
  let isShooting = keyIsDown(k.shoot) || (p.id === 0 && !isMobile && leftMouseDown && mouseReleasedSinceStart);

  if (isMobile && p.id === 0) {
    isThrusting = isThrusting || mobileControls.btns.thrust.active;
    isShooting = isShooting || mobileControls.btns.shoot.active;

    if (mobileControls.btns.missile.active && !p.mobileMissilePressed) {
      fireMissile(p);
      p.mobileMissilePressed = true;
    } else if (!mobileControls.btns.missile.active) {
      p.mobileMissilePressed = false;
    }

    if (mobileControls.joyCenter && mobileControls.joyPos) {
      let dx = mobileControls.joyPos.x - mobileControls.joyCenter.x;
      let dy = mobileControls.joyPos.y - mobileControls.joyCenter.y;
      let distSq = dx * dx + dy * dy;

      if (distSq > 100) { // Deadzone
        let d = sqrt(distSq);
        let speedFactor = min(1, (d - 10) / 60);
        p.ship.yaw -= (dx / d) * YAW_RATE * speedFactor;
        let pitchChange = (dy / d) * PITCH_RATE * speedFactor * 0.5;
        p.ship.pitch = constrain(p.ship.pitch - pitchChange, -PI / 2.2, PI / 2.2);
      }
    }
  }

  if (keyIsDown(k.left)) p.ship.yaw += YAW_RATE;
  if (keyIsDown(k.right)) p.ship.yaw -= YAW_RATE;
  if (keyIsDown(k.pitchUp)) p.ship.pitch = constrain(p.ship.pitch + PITCH_RATE, -PI / 2.2, PI / 2.2);
  if (keyIsDown(k.pitchDown)) p.ship.pitch = constrain(p.ship.pitch - PITCH_RATE, -PI / 2.2, PI / 2.2);

  let s = p.ship;
  s.vy += GRAV;

  if (isThrusting) {
    let pw = 0.45;
    let dVec = shipUpDir(s);
    s.vx += dVec.x * pw; s.vy += dVec.y * pw; s.vz += dVec.z * pw;
    if (frameCount % 2 === 0) {
      particles.push({
        x: s.x, y: s.y, z: s.z,
        vx: -dVec.x * 8 + random(-1, 1), vy: -dVec.y * 8 + random(-1, 1), vz: -dVec.z * 8 + random(-1, 1), life: 255
      });
    }
  }

  if (isBraking) {
    s.vx *= 0.96; s.vy *= 0.96; s.vz *= 0.96;
  }

  if (isShooting && frameCount % 6 === 0) {
    p.bullets.push(spawnProjectile(s, 25, 300));
  }

  s.vx *= 0.985; s.vy *= 0.985; s.vz *= 0.985;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  let g = getAltitude(s.x, s.z);

  if (s.y > SEA - 12) {
    explosion(s.x, SEA, s.z);
    killPlayer(p);
    return;
  }

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

  // Enemy bullets vs player
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    let eb = enemyBullets[i];
    if ((eb.x - s.x) ** 2 + (eb.y - s.y) ** 2 + (eb.z - s.z) ** 2 < 4900) {
      explosion(s.x, s.y, s.z);
      killPlayer(p);
      enemyBullets.splice(i, 1);
      return;
    }
  }

  // Check all enemies against player projectiles and ship body
  for (let j = enemies.length - 1; j >= 0; j--) {
    let e = enemies[j];
    let killed = false;

    // Player Bullets vs Enemy
    for (let i = p.bullets.length - 1; i >= 0; i--) {
      let b = p.bullets[i];
      if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 + (b.z - e.z) ** 2 < 6400) {
        explosion(e.x, e.y, e.z);
        enemies.splice(j, 1);
        p.bullets.splice(i, 1);
        p.score += 100;
        killed = true;
        break;
      }
    }

    // Player Missiles vs Enemy
    if (!killed) {
      for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
        let m = p.homingMissiles[i];
        if ((m.x - e.x) ** 2 + (m.y - e.y) ** 2 + (m.z - e.z) ** 2 < 10000) {
          explosion(e.x, e.y, e.z);
          enemies.splice(j, 1);
          p.homingMissiles.splice(i, 1);
          p.score += 250;
          killed = true;
          break;
        }
      }
    }

    // Enemy body vs Player body
    if (!killed && ((s.x - e.x) ** 2 + (s.y - e.y) ** 2 + (s.z - e.z) ** 2 < 4900)) {
      killPlayer(p);
      return;
    }
  }

  // Bullet-tree: only infected trees absorb bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    for (let t of trees) {
      let ty = getAltitude(t.x, t.z);
      if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 < 3600 && b.y > ty - t.trunkH - 30 * t.canopyScale - 10 && b.y < ty + 10) {
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
  for (let i = bombs.length - 1; i >= 0; i--) {
    let b = bombs[i];
    b.y += 8;
    let gy = getAltitude(b.x, b.z);
    if (b.y > gy) {
      explosion(b.x, gy, b.z);
      if (!isLaunchpad(b.x, b.z)) {
        if (b.type === 'mega') {
          let tx = toTile(b.x), tz = toTile(b.z);
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              let nk = tileKey(tx + r, tz + c);
              infectedTiles[nk] = { tick: frameCount };
            }
          }
        } else {
          infectedTiles[b.k] = { tick: frameCount };
        }
        activePulses = [{ x: b.x, z: b.z, start: millis() / 1000.0 }, ...activePulses].slice(0, 5);
      }
      bombs.splice(i, 1);
    }
  }
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    let b = enemyBullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    if (b.life <= 0 || b.y > getAltitude(b.x, b.z) || b.y > SEA) {
      enemyBullets.splice(i, 1);
    }
  }
}

function updateProjectilePhysics(p) {
  // Bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    if (b.life <= 0) {
      p.bullets.splice(i, 1);
    } else if (b.y > getAltitude(b.x, b.z)) {
      clearInfectionAt(b.x, b.z, p);
      p.bullets.splice(i, 1);
    }
  }

  // Homing missiles
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i];
    const maxSpd = 10;

    let target = findNearest(enemies, m.x, m.y, m.z);
    if (target) {
      let dx = target.x - m.x, dy = target.y - m.y, dz = target.z - m.z;
      let mg = Math.hypot(dx, dy, dz);
      if (mg > 0) {
        let bl = 0.12;
        m.vx = lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = lerp(m.vz, (dz / mg) * maxSpd, bl);
      }
    }

    let sp = Math.hypot(m.vx, m.vy, m.vz);
    if (sp > 0) {
      m.vx = (m.vx / sp) * maxSpd;
      m.vy = (m.vy / sp) * maxSpd;
      m.vz = (m.vz / sp) * maxSpd;
    }

    m.x += m.vx; m.y += m.vy; m.z += m.vz; m.life--;

    if (frameCount % 2 === 0) {
      particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5),
        life: 120
      });
    }

    let gnd = getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        explosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, p);
      }
      p.homingMissiles.splice(i, 1);
    }
  }
}

// Rendering: run once per viewport (with distance culling)
function renderParticles(camX, camZ) {
  let cullSq = (CULL_DIST * 0.6) * (CULL_DIST * 0.6);
  for (let p of particles) {
    if ((p.x - camX) ** 2 + (p.z - camZ) ** 2 > cullSq) continue;
    push(); translate(p.x, p.y, p.z); noStroke(); fill(255, 150, 0, p.life); box(4); pop();
  }
  for (let b of bombs) {
    push(); translate(b.x, b.y, b.z); noStroke(); fill(200, 50, 50); box(8, 20, 8); pop();
  }
  for (let b of enemyBullets) {
    push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 80, 80); box(6); pop();
  }
}

function renderProjectiles(p, camX, camZ) {
  let cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  // Bullets
  for (let b of p.bullets) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); noStroke();
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2]);
    box(6); pop();
  }

  // Homing missiles
  for (let m of p.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;
    push(); translate(m.x, m.y, m.z); noStroke(); fill(0, 200, 255); box(10); pop();
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
  push();
  textAlign(CENTER, BOTTOM);
  textSize(11);
  fill(255, 255, 255, 120);
  let hints = '';
  if (numPlayers === 1) {
    hints = 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E missile  S brake  (Click to lock mouse)';
  } else {
    hints = pi === 0
      ? 'W/RMB thrust  Mouse pitch/yaw  Q/LMB shoot  E missile  S brake  (Click lock)'
      : '↑ thrust  ←/→ turn  ;/\' pitch  . shoot  / missile  ↓ brake';
  }
  text(hints, 0, h / 2 - 8);
  pop();
}

// === WORLD ===
// Multi-sine terrain: irrational frequency ratios ensure non-repetition
function getGridAltitude(tx, tz) {
  let key = tileKey(tx, tz);
  let cached = altCache.get(key);
  if (cached !== undefined) return cached;

  let x = tx * TILE, z = tz * TILE;
  let alt;
  if (isLaunchpad(x, z)) {
    alt = LAUNCH_ALT;
  } else {
    let xs = x * 0.0008, zs = z * 0.0008;
    let elevation = noise(xs, zs) + 0.5 * noise(xs * 2.5, zs * 2.5) + 0.25 * noise(xs * 5, zs * 5);
    alt = 300 - Math.pow(elevation / 1.75, 2.0) * 550;
  }

  altCache.set(key, alt);
  return alt;
}

function getAltitude(x, z) {
  if (isLaunchpad(x, z)) return LAUNCH_ALT;

  let tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  let fx = (x - tx * TILE) / TILE, fz = (z - tz * TILE) / TILE;

  if (fx === 0 && fz === 0) return getGridAltitude(tx, tz);

  let y00 = getGridAltitude(tx, tz);
  let y10 = getGridAltitude(tx + 1, tz);
  let y01 = getGridAltitude(tx, tz + 1);
  let y11 = getGridAltitude(tx + 1, tz + 1);

  if (fx + fz <= 1) return y00 + (y10 - y00) * fx + (y01 - y00) * fz;
  return y11 + (y01 - y11) * (1 - fx) + (y10 - y11) * (1 - fz);
}

// === CHUNKS ===
function getChunkGeometry(cx, cz) {
  let key = cx + ',' + cz;
  let cached = chunkCache.get(key);
  if (cached !== undefined) return cached;

  let geom = buildGeometry(() => {
    let startX = cx * CHUNK_SIZE;
    let startZ = cz * CHUNK_SIZE;

    beginShape(TRIANGLES);

    for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
      for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
        let xP = tx * TILE, zP = tz * TILE;
        let xP1 = xP + TILE, zP1 = zP + TILE;
        let y00 = getAltitude(xP, zP), y10 = getAltitude(xP1, zP);
        let y01 = getAltitude(xP, zP1), y11 = getAltitude(xP1, zP1);
        let avgY = (y00 + y10 + y01 + y11) * 0.25;
        let minY = Math.min(y00, y10, y01, y11);
        if (aboveSea(minY)) continue;

        let chk = (tx + tz) % 2 === 0;

        if (xP >= LAUNCH_MIN && xP < LAUNCH_MAX && zP >= LAUNCH_MIN && zP < LAUNCH_MAX) {
          continue;
        }

        let baseR, baseG, baseB;

        let rand = Math.abs(Math.sin(tx * 12.9898 + tz * 78.233)) * 43758.5453 % 1;

        if (avgY > SEA - 15) {
          let colors = [[230, 210, 80], [200, 180, 60], [150, 180, 50]];
          let col = colors[Math.floor(rand * 3)];
          baseR = col[0]; baseG = col[1]; baseB = col[2];
        } else {
          let colors = [
            [60, 180, 60], [30, 120, 40], [180, 200, 50],
            [220, 200, 80], [210, 130, 140], [180, 140, 70]
          ];
          let patch = noise(tx * 0.15, tz * 0.15);
          let colIdx = Math.floor((patch * 2.0 + rand * 0.2) * 6) % 6;
          let col = colors[colIdx];
          baseR = col[0]; baseG = col[1]; baseB = col[2];
        }

        let finalR = chk ? baseR : baseR * 0.85;
        let finalG = chk ? baseG : baseG * 0.85;
        let finalB = chk ? baseB : baseB * 0.85;

        fill(finalR, finalG, finalB);
        vertex(xP, y00, zP); vertex(xP1, y10, zP); vertex(xP, y01, zP1);
        vertex(xP1, y10, zP); vertex(xP1, y11, zP1); vertex(xP, y01, zP1);
      }
    }
    endShape();
  });

  chunkCache.set(key, geom);
  return geom;
}

function getFogColor(col, depth) {
  let fogEnd = VIEW_FAR * TILE + 400; // right at the edge
  let fogStart = VIEW_FAR * TILE - 800;
  let f = constrain(map(depth, fogStart, fogEnd, 0, 1), 0, 1);
  return [
    lerp(col[0], SKY_R, f),
    lerp(col[1], SKY_G, f),
    lerp(col[2], SKY_B, f)
  ];
}

function drawLandscape(s) {
  let gx = toTile(s.x), gz = toTile(s.z);
  noStroke();

  let infected = [];
  let cam = getCameraParams(s);

  // Disable p5 lighting because it silently overrides custom shaders that don't declare lighting uniforms
  noLights();

  shader(terrainShader);
  terrainShader.setUniform('uTime', millis() / 1000.0);
  terrainShader.setUniform('uFogDist', [VIEW_FAR * TILE - 800, VIEW_FAR * TILE + 400]);

  let pulseArr = [];
  for (let i = 0; i < 5; i++) {
    if (i < activePulses.length) {
      pulseArr.push(activePulses[i].x, activePulses[i].z, activePulses[i].start);
    } else {
      pulseArr.push(0.0, 0.0, -9999.0);
    }
  }
  terrainShader.setUniform('uPulses', pulseArr);

  let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
  let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
  let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
  let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      let chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
      let chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;

      let dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
      let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
      // Frustum culling at chunk level roughly
      if (fwdDist < -CHUNK_SIZE * TILE * 1.5) continue;

      let geom = getChunkGeometry(cx, cz);
      model(geom);

      // Collect infected tiles (these update dynamically and pulse per frame)
      for (let tx = cx * CHUNK_SIZE; tx < (cx + 1) * CHUNK_SIZE; tx++) {
        for (let tz = cz * CHUNK_SIZE; tz < (cz + 1) * CHUNK_SIZE; tz++) {
          if (infectedTiles[tileKey(tx, tz)]) {
            let xP = tx * TILE, zP = tz * TILE;
            let cxTile = xP + TILE * 0.5, czTile = zP + TILE * 0.5;
            let dSq = (cam.x - cxTile) * (cam.x - cxTile) + (cam.z - czTile) * (cam.z - czTile);
            let d = Math.sqrt(dSq);

            let xP1 = xP + TILE, zP1 = zP + TILE;
            let y00 = getAltitude(xP, zP) - 0.5, y10 = getAltitude(xP1, zP) - 0.5;
            let y01 = getAltitude(xP, zP1) - 0.5, y11 = getAltitude(xP1, zP1) - 0.5;

            let avgY = (getAltitude(xP, zP) + getAltitude(xP1, zP) + getAltitude(xP, zP1) + getAltitude(xP1, zP1)) * 0.25;
            let v = [xP, y00, zP, xP1, y10, zP, xP, y01, zP1, xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1];

            let chk = (tx + tz) % 2 === 0;
            let pulse = sin(frameCount * 0.08 + tx * 0.5 + tz * 0.3) * 0.5 + 0.5;
            let af = map(avgY, -100, SEA, 1.15, 0.65);
            let base = chk ? [160, 255, 10, 40, 10, 25] : [120, 200, 5, 25, 5, 15];
            let ir = lerp(base[0], base[1], pulse) * af;
            let ig = lerp(base[2], base[3], pulse) * af;
            let ib = lerp(base[4], base[5], pulse) * af;

            infected.push({ v, r: ir, g: ig, b: ib });
          }
        }
      }
    }
  }

  // Draw infected tiles
  if (infected.length) {
    beginShape(TRIANGLES);
    for (let t of infected) {
      fill(t.r, t.g, t.b);
      let v = t.v;
      vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
      vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
    }
    endShape();
  }

  let p = sin(frameCount * 0.03) * 8;
  let seaC = [15, 45 + p, 150 + p];
  let seaSize = VIEW_FAR * TILE * 1.5;
  let seaGeom = getSeaGeometry(seaSize, seaC, s.x, s.z);
  model(seaGeom);

  // Restore lighting for standard objects
  resetShader();
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);

  // Solid launchpad base
  push();
  noStroke();
  // Draw base as simple quads directly corresponding to tiles (to ensure static mapping free of camera float precision jitter/animation)
  noLights();
  beginShape(QUADS);
  for (let px = LAUNCH_MIN; px < LAUNCH_MAX; px += TILE) {
    for (let pz = LAUNCH_MIN; pz < LAUNCH_MAX; pz += TILE) {
      let isChk = ((px / TILE) + (pz / TILE)) % 2 === 0;
      let col = isChk ? [255, 255, 255] : [220, 220, 220];
      let cx = px + TILE * 0.5;
      let cz = pz + TILE * 0.5;
      let tileDepth = (cx - cam.x) * cam.fwdX + (cz - cam.z) * cam.fwdZ;
      let fc = getFogColor(col, tileDepth);
      fill(fc[0], fc[1], fc[2]);
      vertex(px, LAUNCH_ALT, pz);
      vertex(px + TILE, LAUNCH_ALT, pz);
      vertex(px + TILE, LAUNCH_ALT, pz + TILE);
      vertex(px, LAUNCH_ALT, pz + TILE);
    }
  }
  endShape();


  pop();

  // Re-enable lighting for 3D structures on top of the pad
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);

  // Draw Zarch missiles lined up on the right side of the launchpad
  push();
  let mX = LAUNCH_MAX - 100;
  for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
    let mDepth = (mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ;
    let bCol = getFogColor([60, 60, 60], mDepth);
    let mCol = getFogColor([255, 140, 20], mDepth);
    push();
    translate(mX, LAUNCH_ALT, mZ);
    // Base/stand
    fill(bCol[0], bCol[1], bCol[2]);
    push(); translate(0, -10, 0); box(30, 20, 30); pop();
    // Missile body
    fill(mCol[0], mCol[1], mCol[2]);
    push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();
    pop();
  }
  pop();
}

function getSeaGeometry(seaSize, seaC, sx, sz) {
  return buildGeometry(() => {
    fill(seaC[0], seaC[1], seaC[2]);
    beginShape(TRIANGLES);
    let y = SEA + 3;
    let cx = toTile(sx) * TILE, cz = toTile(sz) * TILE;
    vertex(cx - seaSize, y, cz - seaSize);
    vertex(cx + seaSize, y, cz - seaSize);
    vertex(cx - seaSize, y, cz + seaSize);
    vertex(cx + seaSize, y, cz - seaSize);
    vertex(cx + seaSize, y, cz + seaSize);
    vertex(cx - seaSize, y, cz + seaSize);
    endShape();
  });
}

function drawTrees(s) {
  let treeCullDist = VIEW_FAR * TILE;
  let cullSq = treeCullDist * treeCullDist;
  let cam = getCameraParams(s);

  for (let t of trees) {
    let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
    if (dSq >= cullSq || !inFrustum(cam, t.x, t.z)) continue;
    let y = getAltitude(t.x, t.z);
    if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

    push(); translate(t.x, y, t.z); noStroke();
    let { trunkH: h, canopyScale: sc, variant: vi } = t;
    let inf = !!infectedTiles[tileKey(toTile(t.x), toTile(t.z))];

    // Trunk
    let depth = (t.x - cam.x) * cam.fwdX + (t.z - cam.z) * cam.fwdZ;
    let trCol = getFogColor([inf ? 80 : 100, inf ? 40 : 65, inf ? 20 : 25], depth);
    fill(trCol[0], trCol[1], trCol[2]);
    push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

    // Canopy
    let tv = TREE_VARIANTS[vi];
    let c1Orig = inf ? tv.infected : tv.healthy;
    let c1Col = getFogColor(c1Orig, depth);
    fill(c1Col[0], c1Col[1], c1Col[2]);

    if (vi === 2) {
      push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
    } else {
      let cn = tv.cones[0];
      push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();

      if (tv.cones2) {
        let c2Orig = inf ? tv.infected2 : tv.healthy2;
        let c2Col = getFogColor(c2Orig, depth);
        fill(c2Col[0], c2Col[1], c2Col[2]);
        let cn2 = tv.cones2[0];
        push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
      }
    }

    // Shadow (only close trees)
    if (dSq < 2250000) {
      push(); translate(0, -0.5, 8); rotateX(PI / 2); fill(0, 0, 0, 40); ellipse(0, 0, 20 * sc, 12 * sc); pop();
    }
    pop();
  }
}

function drawBuildings(s) {
  let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
  let cam = getCameraParams(s);

  for (let b of buildings) {
    let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
    if (dSq >= cullSq || !inFrustum(cam, b.x, b.z)) continue;
    let y = getAltitude(b.x, b.z);
    if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

    let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];

    let depth = (b.x - cam.x) * cam.fwdX + (b.z - cam.z) * cam.fwdZ;
    push(); translate(b.x, y, b.z); noStroke();

    if (b.type === 0) {
      let bCol = inf ? [200, 50, 50] : [220, 220, 220];
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();

      let rCol = inf ? [150, 30, 30] : [220, 50, 50];
      let rc = getFogColor(rCol, depth);
      fill(rc[0], rc[1], rc[2]);
      push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();

    } else if (b.type === 1) {
      let bCol = inf ? [200, 50, 50] : [150, 160, 170];
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();

      let topCol = inf ? [150, 30, 30] : [80, 180, 220];
      let tc = getFogColor(topCol, depth);
      fill(tc[0], tc[1], tc[2]);
      push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();

    } else if (b.type === 2) {
      let bCol = inf ? [200, 50, 50] : b.col;
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
      push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();

      let sCol = inf ? [120, 20, 20] : [80, 80, 80];
      let sc = getFogColor(sCol, depth);
      fill(sc[0], sc[1], sc[2]);
      push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();
    } else {
      let bCol = inf ? [200, 50, 50] : [60, 180, 240];
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push();
      let floatY = y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
      translate(0, floatY - y, 0);
      rotateY(frameCount * 0.01 + b.x);
      rotateZ(frameCount * 0.015 + b.z);
      cone(b.w, b.h / 2, 4, 1);
      rotateX(PI);
      cone(b.w, b.h / 2, 4, 1);
      pop();
    }
    pop();

    if (dSq < 2250000) {
      drawShadow(b.x, y, b.z, b.w * 1.5, b.d * 1.5);
    }
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

function drawEnemies(s) {
  let cam = getCameraParams(s);
  let cullSq = CULL_DIST * CULL_DIST;

  for (let e of enemies) {
    if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > cullSq) continue;

    let depth = (e.x - cam.x) * cam.fwdX + (e.z - cam.z) * cam.fwdZ;


    push(); translate(e.x, e.y, e.z);

    if (e.type === 'fighter') {
      let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
      let d = Math.hypot(fvX, fvY, fvZ);
      if (d > 0) {
        let yaw = atan2(fvX, fvZ);
        rotateY(yaw);
        let pitch = asin(fvY / d);
        rotateX(-pitch);
      }
      noStroke();
      let ec = getFogColor([255, 150, 0], depth);
      fill(ec[0], ec[1], ec[2]);
      beginShape(TRIANGLES);
      vertex(0, 0, 20); vertex(-15, 0, -15); vertex(15, 0, -15);
      vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, -10, 0);
      vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, -10, 0);
      vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, 10, 0);
      vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, 10, 0);
      endShape();
    } else if (e.type === 'bomber') {
      rotateY(frameCount * 0.05);
      noStroke();
      let bc = getFogColor([180, 20, 180], depth);
      fill(bc[0], bc[1], bc[2]);
      beginShape(TRIANGLES);
      vertex(0, -40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
      vertex(0, -40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
      vertex(0, -40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
      vertex(0, -40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
      vertex(0, 40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
      vertex(0, 40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
      vertex(0, 40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
      vertex(0, 40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
      endShape();
    } else if (e.type === 'crab') {
      let yaw = atan2(e.vx || 0, e.vz || 0);
      rotateY(yaw);
      noStroke();
      let cc = getFogColor([200, 80, 20], depth);
      fill(cc[0], cc[1], cc[2]);
      push(); box(30, 15, 30); pop(); // body
      let legY = sin(frameCount * 0.3 + e.id) * 10;
      push(); translate(-15, legY, -15); box(5, 20, 5); pop();
      push(); translate(15, -legY, -15); box(5, 20, 5); pop();
      push(); translate(-15, -legY, 15); box(5, 20, 5); pop();
      push(); translate(15, legY, 15); box(5, 20, 5); pop();
    } else if (e.type === 'hunter') {
      let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
      let d = Math.hypot(fvX, fvY, fvZ);
      if (d > 0) {
        rotateY(atan2(fvX, fvZ));
        rotateX(-asin(fvY / d));
      }
      noStroke();
      let hc = getFogColor([40, 255, 40], depth);
      fill(hc[0], hc[1], hc[2]);
      beginShape(TRIANGLES);
      vertex(0, 0, 30); vertex(-8, 0, -20); vertex(8, 0, -20);
      vertex(0, 0, 30); vertex(-8, 0, -20); vertex(0, -10, 0);
      vertex(0, 0, 30); vertex(8, 0, -20); vertex(0, -10, 0);
      endShape();
    } else {
      rotateY(frameCount * 0.15); noStroke();
      for (let [yOff, col] of [[-10, [220, 30, 30]], [6, [170, 15, 15]]]) {
        let oc = getFogColor(col, depth);
        fill(oc[0], oc[1], oc[2]);
        beginShape(TRIANGLES);
        vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
        vertex(0, yOff, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
        vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(0, yOff, 25);
        vertex(0, yOff, -25); vertex(22, 0, 0); vertex(0, yOff, 25);
        endShape();
      }
      let cc = getFogColor([255, 60, 60], depth);
      fill(cc[0], cc[1], cc[2]);
      push(); translate(0, -14, 0); box(3, 14, 3); pop();
    }
    pop();

    let sSize = e.type === 'bomber' ? 60 : (e.type === 'fighter' || e.type === 'hunter' ? 25 : 40);
    drawShadow(e.x, getAltitude(e.x, e.z), e.z, sSize, sSize);
  }
}

function updateEnemies() {
  let alivePlayers = players.filter(p => !p.dead).map(p => p.ship);
  let refShip = alivePlayers[0] || players[0].ship;

  for (let e of enemies) {
    if (e.type === 'fighter') updateFighter(e, alivePlayers, refShip);
    else if (e.type === 'bomber') updateBomber(e, refShip);
    else if (e.type === 'crab') updateCrab(e, alivePlayers, refShip);
    else if (e.type === 'hunter') updateHunter(e, alivePlayers, refShip);
    else updateSeeder(e, refShip);
  }
}

function updateBomber(e, refShip) {
  e.x += e.vx * 0.5; e.z += e.vz * 0.5; e.y += sin(frameCount * 0.02 + e.id);
  if (abs(e.x - refShip.x) > 4000) e.vx *= -1;
  if (abs(e.z - refShip.z) > 4000) e.vz *= -1;

  e.bombTimer++;
  if (e.bombTimer > 600) {
    e.bombTimer = 0;
    let gy = getAltitude(e.x, e.z);
    if (!aboveSea(gy)) {
      let tx = toTile(e.x), tz = toTile(e.z);
      let wx = tx * TILE, wz = tz * TILE;
      if (!isLaunchpad(wx, wz)) {
        bombs.push({ x: e.x, y: e.y, z: e.z, k: tileKey(tx, tz), type: 'mega' });
      }
    }
  }
}

function updateCrab(e, alivePlayers, refShip) {
  let target = findNearest(alivePlayers, e.x, e.y, e.z);
  let tShip = target || refShip;

  let dx = tShip.x - e.x, dz = tShip.z - e.z;
  let d = Math.hypot(dx, dz);
  if (d > 0) {
    e.vx = lerp(e.vx || 0, (dx / d) * 3, 0.05);
    e.vz = lerp(e.vz || 0, (dz / d) * 3, 0.05);
  }

  e.x += e.vx; e.z += e.vz;

  let gy = getAltitude(e.x, e.z);
  e.y = gy - 10;

  e.fireTimer++;
  if (d < 1500 && e.fireTimer > 180) {
    e.fireTimer = 0;
    enemyBullets.push({
      x: e.x, y: e.y - 10, z: e.z,
      vx: 0, vy: -12, vz: 0, life: 100
    });
  }

  if (random() < 0.05) { // 5% chance per frame to drop a virus
    if (!aboveSea(gy)) {
      let tx = toTile(e.x), tz = toTile(e.z);
      let wx = tx * TILE, wz = tz * TILE;
      if (!isLaunchpad(wx, wz)) {
        let k = tileKey(tx, tz);
        if (!infectedTiles[k]) {
          infectedTiles[k] = { tick: frameCount };
          activePulses = [{ x: e.x, z: e.z, start: millis() / 1000.0 }, ...activePulses].slice(0, 5);
        }
      }
    }
  }
}

function updateHunter(e, alivePlayers, refShip) {
  let target = findNearest(alivePlayers, e.x, e.y, e.z);
  let tShip = target || refShip;

  let dx = tShip.x - e.x, dy = tShip.y - e.y, dz = tShip.z - e.z;
  let d = Math.hypot(dx, dy, dz);
  let speed = 5.0;
  if (d > 0) {
    e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.1);
    e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.1);
    e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.1);
  }
  let gy = getAltitude(e.x, e.z);
  if (e.y > gy - 50) e.vy -= 1.0;

  e.x += e.vx; e.y += e.vy; e.z += e.vz;
}

function updateFighter(e, alivePlayers, refShip) {
  let target = findNearest(alivePlayers, e.x, e.y, e.z);
  let tShip = target || refShip;

  e.stateTimer = (e.stateTimer || 0) + 1;
  if (e.stateTimer > 120) {
    e.stateTimer = 0;
    e.aggressive = random() > 0.5; // 50% chance to hunt, 50% chance to drift
    if (!e.aggressive) {
      e.wanderX = e.x + random(-1500, 1500);
      e.wanderZ = e.z + random(-1500, 1500);
    }
  }

  let tx = e.aggressive ? tShip.x : (e.wanderX || e.x);
  let tz = e.aggressive ? tShip.z : (e.wanderZ || e.z);
  let ty = e.aggressive ? tShip.y : -600;

  let dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
  let d = Math.hypot(dx, dy, dz);

  let speed = 2.5;
  if (d > 0) {
    // smooth steering
    e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
    e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.05);
    e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
  }

  let gy = getAltitude(e.x, e.z);
  if (e.y > gy - 150) e.vy -= 0.5; // Steering constraint to avoid crash

  e.x += e.vx; e.y += e.vy; e.z += e.vz;

  e.fireTimer++;
  if (e.aggressive && d < 1200 && e.fireTimer > 90) {
    e.fireTimer = 0;
    // Inaccuracy in shooting
    let pvx = (dx / d) + random(-0.2, 0.2);
    let pvy = (dy / d) + random(-0.2, 0.2);
    let pvz = (dz / d) + random(-0.2, 0.2);
    let pd = Math.hypot(pvx, pvy, pvz);
    enemyBullets.push({
      x: e.x, y: e.y, z: e.z,
      vx: (pvx / pd) * 10, vy: (pvy / pd) * 10, vz: (pvz / pd) * 10, life: 120
    });
  }
}

function updateSeeder(e, refShip) {
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
        if (!infectedTiles[k]) bombs.push({ x: e.x, y: e.y, z: e.z, k: k });
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
  if (gameState === 'menu') {
    if (isAndroid && !fullscreen()) fullscreen(true);
    setTimeout(() => { startGame(1); }, 50);
  } else if (gameState === 'playing' && isAndroid) {
    if (!fullscreen()) fullscreen(true);
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
      requestPointerLock();
    }
  }
}

function mouseDragged() { mouseMoved(); }

function mouseMoved() {
  if (gameState === 'playing' && !players[0].dead && !isMobile) {
    // Mouse X controls yaw (turn left/right)
    players[0].ship.yaw -= movedX * 0.003;
    // Mouse Y controls pitch (up/down)
    players[0].ship.pitch = constrain(players[0].ship.pitch - movedY * 0.003, -PI / 2.2, PI / 2.2);
  }
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }