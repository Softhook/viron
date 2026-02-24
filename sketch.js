// =============================================================================
// sketch.js — Game state, p5 lifecycle, main loop and event handlers
//
// This file is the "controller" of the game.  It owns the top-level mutable
// state and orchestrates the update / render pipeline each frame by calling
// into the specialised modules:
//   constants.js → pure constants and helpers
//   terrain.js   → Terrain class (world rendering + altitude queries)
//   particles.js → ParticleSystem class (VFX, bombs, enemy bullets)
//   enemies.js   → EnemyManager class (AI update + rendering)
//   player.js    → ship physics, input, and projectile functions
//   hud.js       → HUD, radar, menu and game-over overlays
//   sfx.js       → GameSFX class (unchanged)
//   mobileControls.js → MobileController class (unchanged)
// =============================================================================

// ---------------------------------------------------------------------------
// Global game state
// ---------------------------------------------------------------------------

let trees = [], buildings = [];    // Static world objects populated in setup()

let infectedTiles = {};           // Map of tileKey → {tick} for infected land tiles
let level = 1;            // Current level number (increases on level completion)
let currentMaxEnemies = 2;         // Max simultaneous enemies for the current level

let levelComplete = false;     // True once all infection has been cleared
let infectionStarted = false;     // Latches to true when the first tile is infected
let levelEndTime = 0;         // millis() timestamp of level completion / game over

let gameFont;                      // Loaded Impact font used for all HUD / menu text
let gameState = 'menu';    // Current game mode: 'menu' | 'playing' | 'gameover'
let gameOverReason = '';        // Human-readable reason string shown on game-over screen
let lastAlarmTime = 0;         // millis() of the last launchpad alarm SFX (rate-limited)
let gameStartTime = 0;         // millis() when the current game started

let numPlayers = 1;         // 1 or 2 — set by startGame()
let menuCam = { x: 1500, z: 1500, yaw: 0 }; // Title-screen camera state

// Mouse state tracked via raw DOM events so they work before pointer-lock
let mouseReleasedSinceStart = true;
let leftMouseDown = false;
let rightMouseDown = false;

let players = [];                // Array of player objects; length = numPlayers
let smoothedMX = 0, smoothedMY = 0; // Smoothed mouse deltas for mouse-look steering

let isMobile = false;             // True on any touch-capable device
let isAndroid = false;             // True on Android (affects some edge-case behaviour)

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Detects whether the current device is a mobile/touch device and sets the
 * isMobile and isAndroid flags accordingly.
 */
function checkMobile() {
  isAndroid = /Android/i.test(navigator.userAgent);
  isMobile = isAndroid || /iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window);
}

/**
 * Applies directional + ambient lighting for the 3D scene.
 * Called after resetShader() so p5's built-in lighting uniforms are active again.
 */
function setSceneLighting() {
  directionalLight(240, 230, 210, 0.5, 0.8, -0.3);
  ambientLight(60, 60, 70);
}

/**
 * Switches the p5 renderer into a full-canvas 2D orthographic projection.
 * Sets the GL viewport to cover the full canvas, then pushes a new matrix
 * state with an ortho(-w/2..w/2, -h/2..h/2) projection and a reset modelview.
 * Callers MUST call pop() when finished.
 */
function setup2DViewport() {
  let pxD = pixelDensity();
  drawingContext.viewport(0, 0, width * pxD, height * pxD);
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
  resetMatrix();
}

/**
 * Finds the element in arr closest to (x, y, z) by 3D squared distance.
 * Used for enemy targeting and missile homing — each element must have x, y, z.
 * @param {Array}  arr  Array of objects with x, y, z properties.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {object|null}  Closest element, or null if arr is empty.
 */
function findNearest(arr, x, y, z) {
  let best = null, bestD = Infinity;
  for (let e of arr) {
    let dSq = (x - e.x) ** 2 + (y - e.y) ** 2 + (z - e.z) ** 2;
    if (dSq < bestD) { bestD = dSq; best = e; }
  }
  return best;
}

/**
 * Removes all infected tiles within a CLEAR_R-tile square around (tx, tz).
 * Returns the number of tiles that were cleared.
 * @param {number} tx  Centre tile X.
 * @param {number} tz  Centre tile Z.
 * @returns {number}   Count of tiles cleared.
 */
function clearInfectionRadius(tx, tz) {
  let cleared = 0;
  for (let dx = -CLEAR_R; dx <= CLEAR_R; dx++)
    for (let dz = -CLEAR_R; dz <= CLEAR_R; dz++) {
      let k = tileKey(tx + dx, tz + dz);
      if (infectedTiles[k]) { delete infectedTiles[k]; cleared++; }
    }
  return cleared;
}

/**
 * Clears infection at a world-space position.  Adds 100 points to the player's
 * score and plays a clear-infection sound effect if infection was actually present.
 * @param {number} wx  World X of the impact.
 * @param {number} wz  World Z of the impact.
 * @param {object} p   Player who scored the clear (may be null for missile impacts).
 * @returns {boolean}  True if any tiles were cleared.
 */
function clearInfectionAt(wx, wz, p) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infectedTiles[tileKey(tx, tz)]) return false;
  clearInfectionRadius(tx, tz);
  if (p) p.score += 100;
  if (typeof gameSFX !== 'undefined') gameSFX.playClearInfection(wx, terrain.getAltitude(wx, wz), wz);
  return true;
}

// ---------------------------------------------------------------------------
// p5 lifecycle — preload / setup
// ---------------------------------------------------------------------------

/** Loads the Impact font before setup() runs. */
function preload() {
  gameFont = loadFont('Impact.ttf');
}

/**
 * p5 setup — creates the WEBGL canvas, initialises subsystems and populates
 * the static world objects (trees, buildings).
 *
 * Mobile devices receive reduced object counts and draw distances to stay at
 * a playable frame rate.
 */
function setup() {
  checkMobile();
  if (isMobile) {
    VIEW_NEAR = 20;
    VIEW_FAR = 30;
    CULL_DIST = 3500;
  }
  createCanvas(windowWidth, windowHeight, WEBGL);

  // Suppress context menu on right-click (right mouse is used for thrust)
  document.addEventListener('contextmenu', event => event.preventDefault());

  // Track mouse button state via DOM events — more reliable than p5's mousePressed
  document.addEventListener('mousedown', e => {
    if (e.button === 0) leftMouseDown = true;
    if (e.button === 1) e.preventDefault();
    if (e.button === 2) rightMouseDown = true;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) leftMouseDown = false;
    if (e.button === 2) rightMouseDown = false;
  });

  terrain.init();  // Compile terrain GLSL shader (must happen after canvas creation)
  textFont(gameFont);

  // Trees — placed with a fixed seed for a consistent world layout
  randomSeed(42);
  let numTrees = isMobile ? 80 : 250;
  for (let i = 0; i < numTrees; i++)
    trees.push({
      x: random(-5000, 5000), z: random(-5000, 5000),
      variant: floor(random(3)), trunkH: random(25, 50), canopyScale: random(1.0, 1.8)
    });

  // menuCam starts over open terrain away from the launchpad

  // Buildings — different seed from trees so positions don't correlate
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

// ---------------------------------------------------------------------------
// Game setup functions
// ---------------------------------------------------------------------------

/**
 * Begins a new game with the given number of players.
 * Creates player objects, then calls startLevel(1).
 * @param {number} np  Number of players (1 or 2).
 */
function startGame(np) {
  numPlayers = np;
  if (typeof gameSFX !== 'undefined') gameSFX.spatialEnabled = (np === 1);
  gameStartTime = millis();
  mouseReleasedSinceStart = !leftMouseDown;  // Don't fire on the frame the game starts
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

/**
 * Places one guaranteed infected tile within a random distance of the player
 * spawn point at the start of each level.  The tile is chosen in a ring
 * between MIN_DIST and MAX_DIST world-space units from the launchpad centre.
 * We try up to MAX_TRIES random candidates and skip any that land on water or
 * on the launchpad itself, falling back silently if none is found.
 */
function seedInitialInfection() {
  const CENTER_X = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420
  const CENTER_Z = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420
  const MIN_DIST = 500;    // Closest the seed tile may be (world units)
  const MAX_DIST = 1500;   // Farthest the seed tile may be (world units)
  const MAX_TRIES = 50;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    // Pick a random angle and radius in the annular zone
    let angle = random(TWO_PI);
    let dist = random(MIN_DIST, MAX_DIST);
    let wx = CENTER_X + cos(angle) * dist;
    let wz = CENTER_Z + sin(angle) * dist;

    // Skip underwater and launchpad tiles
    if (aboveSea(terrain.getAltitude(wx, wz))) continue;
    if (isLaunchpad(wx, wz)) continue;

    // Valid land tile — infect it and stop searching
    let tk = tileKey(toTile(wx), toTile(wz));
    infectedTiles[tk] = { tick: 0 };
    return;
  }
  // (Silently give up if no valid tile found in MAX_TRIES — the seeder will
  //  create infection naturally soon after spawn.)
}

/**
 * Resets the world for a new level.
 * Respawns all ships on the launchpad, clears enemies/particles/infection,
 * then spawns the new wave of enemies (first enemy is always a seeder to
 * ensure infection starts immediately).
 *
 * Each level beyond level 1 awards one bonus missile per player.
 *
 * @param {number} lvl  The level number to start (1-indexed).
 */
function startLevel(lvl) {
  if (typeof gameSFX !== 'undefined') gameSFX.playNewLevel();
  level = lvl;
  levelComplete = false;
  infectionStarted = false;
  currentMaxEnemies = 1 + level;  // Enemy count scales linearly with level

  for (let p of players) {
    resetShip(p, getSpawnX(p));
    p.homingMissiles = [];
    if (lvl > 1) {
      p.missilesRemaining++;   // Bonus missile for completing the previous level
    } else {
      p.missilesRemaining = 1;
    }
    p.dead = false;
    p.respawnTimer = 0;
  }

  enemyManager.clear();
  particleSystem.clear();
  terrain.activePulses = [];
  infectedTiles = {};

  // Guarantee at least one infection tile is visible from the very start
  seedInitialInfection();

  for (let i = 0; i < currentMaxEnemies; i++) enemyManager.spawn(i === 0);
}

// ---------------------------------------------------------------------------
// Per-player 3D viewport render
// ---------------------------------------------------------------------------

/**
 * Renders the complete 3D scene for one player's viewport using WebGL scissor
 * testing to confine drawing to the player's half of the canvas.
 *
 * Render order:
 *   1. Clear colour + depth for this viewport (sky colour background)
 *   2. Set up perspective camera positioned 550 units behind the ship
 *   3. Terrain (drawLandscape + drawTrees + drawBuildings)
 *   4. Enemies
 *   5. All player ships and projectiles
 *   6. Particles
 *   7. Clear depth buffer, then draw 2D HUD on top
 *   8. Mobile on-screen controls (single-player mobile only)
 *
 * @param {WebGLRenderingContext} gl        Raw WebGL context.
 * @param {object}                p         Player whose point-of-view to render.
 * @param {number}                pi        Player index (0 or 1).
 * @param {number}                viewX     Left pixel of this viewport.
 * @param {number}                viewW     Width  of this viewport in CSS pixels.
 * @param {number}                viewH     Height of this viewport in CSS pixels.
 * @param {number}                pxDensity devicePixelRatio from p5's pixelDensity().
 */
function renderPlayerView(gl, p, pi, viewX, viewW, viewH, pxDensity) {
  let s = p.ship;
  let vx = viewX * pxDensity, vw = viewW * pxDensity, vh = viewH * pxDensity;

  gl.viewport(vx, 0, vw, vh);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(vx, 0, vw, vh);
  gl.clearColor(30 / 255, 60 / 255, 120 / 255, 1);  // Sky colour (matches fog end)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  push();
  perspective(PI / 3, viewW / viewH, 50, VIEW_FAR * TILE * 1.5);

  // Camera position: 550 units behind the ship at a slightly raised height
  let cd = 550;
  let camY = min(s.y - 120, SEA - 60);  // Clamp camera above sea so it doesn't clip
  let cx = s.x + sin(s.yaw) * cd;
  let cy = camY;
  let cz = s.z + cos(s.yaw) * cd;
  camera(cx, cy, cz, s.x, s.y, s.z, 0, 1, 0);

  // Update spatial audio listener to match this camera position
  if (typeof gameSFX !== 'undefined') gameSFX.updateListener(cx, cy, cz, s.x, s.y, s.z, 0, 1, 0);

  setSceneLighting();
  terrain.drawLandscape(s);
  terrain.drawTrees(s);
  terrain.drawBuildings(s);
  enemyManager.draw(s);

  // Draw all ships from this viewport's perspective (including the current player)
  for (let player of players) {
    if (!player.dead) shipDisplay(player.ship, player.labelColor);
    renderProjectiles(player, s.x, s.z);
  }
  particleSystem.render(s.x, s.z);

  // 3D Visual Debugging
  if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);

  pop();

  // Overlay HUD (2D pass on top of the 3D scene)
  gl.clear(gl.DEPTH_BUFFER_BIT);
  drawPlayerHUD(p, pi, viewW, viewH);
  if ((isMobile || (typeof mobileController !== 'undefined' && mobileController.debug)) && numPlayers === 1 && typeof mobileController !== 'undefined') {
    mobileController.draw(width, height);
  }
  gl.disable(gl.SCISSOR_TEST);
}

// ---------------------------------------------------------------------------
// p5 lifecycle — draw
// ---------------------------------------------------------------------------

/**
 * Main p5 draw loop — runs at ~60 fps.
 *
 * If in 'menu' or 'gameover' state, delegates entirely to the appropriate
 * HUD function and returns early.
 *
 * In 'playing' state:
 *   1. Dynamic performance scaling: adjusts VIEW_NEAR/FAR and CULL_DIST
 *      every 120 frames to maintain the target frame rate.
 *   2. Physics update: ship input, enemy AI, collision detection, infection spread,
 *      particle physics, projectile physics.
 *   3. Render: one or two viewport passes via renderPlayerView().
 *   4. Post-render 2D pass: split-screen divider and level-complete message.
 *   5. Level logic: detect level clear, advance level after 4-second delay.
 *   6. Respawn logic: decrement respawn timers, reset dead ships.
 */
function draw() {
  if (gameState === 'menu') { drawMenu(); return; }
  if (gameState === 'gameover') { drawGameOver(); return; }

  // --- Dynamic Performance Scaling ---
  // Every 2 seconds, compare actual FPS to the target and shrink or grow the
  // draw distances to keep the game smooth on a wide range of hardware.
  if (frameCount > 60 && frameCount % 120 === 0) {
    let fps = frameRate();
    if (!window.maxObservedFPS) window.maxObservedFPS = 60;
    if (fps > window.maxObservedFPS + 2) window.maxObservedFPS = fps;

    let targetFPS = window.maxObservedFPS > 70 ? 75 : 60;

    if (fps < targetFPS * 0.9) {
      // Underperforming: shrink draw distances
      VIEW_NEAR = max(15, VIEW_NEAR - 2);
      VIEW_FAR = max(20, VIEW_FAR - 2);
      CULL_DIST = max(2000, CULL_DIST - 400);
    } else if (fps >= targetFPS * 0.95) {
      // Plenty of headroom: try restoring draw distances
      VIEW_NEAR = min(35, VIEW_NEAR + 1);
      VIEW_FAR = min(50, VIEW_FAR + 1);
      CULL_DIST = min(6000, CULL_DIST + 200);
    }
  }

  terrain.clearCaches();  // Evict caches if they exceed their size limits

  let gl = drawingContext;

  // Process mobile touch joystick before ship input so the inputs are ready
  if (isMobile && numPlayers === 1 && typeof mobileController !== 'undefined') mobileController.update(touches, width, height);

  // --- Physics update ---
  for (let p of players) updateShipInput(p);
  enemyManager.update();
  for (let p of players) checkCollisions(p);
  spreadInfection();
  particleSystem.updatePhysics();
  for (let p of players) updateProjectilePhysics(p);

  // --- Render ---
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

  // --- Shared 2D overlay (split-screen divider + level-complete banner) ---
  setup2DViewport();
  if (numPlayers === 2) {
    stroke(0, 255, 0, 180); strokeWeight(2);
    line(0, -height / 2, 0, height / 2);
  }
  if (levelComplete) {
    noStroke(); fill(0, 255, 0); textAlign(CENTER, CENTER); textSize(40);
    text('LEVEL ' + level + ' COMPLETE', 0, 0);
  }
  pop();

  // --- Level progression ---
  let ic = Object.keys(infectedTiles).length;
  if (ic > 0) infectionStarted = true;
  if (infectionStarted && ic === 0 && !levelComplete) {
    levelComplete = true;
    levelEndTime = millis();
    if (typeof gameSFX !== 'undefined') gameSFX.playLevelComplete();
  }
  if (levelComplete && millis() - levelEndTime > 4000) startLevel(level + 1);

  // --- Respawn dead players after their timer expires ---
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

// ---------------------------------------------------------------------------
// Infection spread simulation
// ---------------------------------------------------------------------------

/**
 * Spreads infection one step every 5 frames using a 4-connected flood-fill with
 * probability INF_RATE per infected tile per update.
 *
 * Also checks two game-over conditions on every call:
 *   1. Total infected tile count ≥ MAX_INF
 *   2. All 7×7 launchpad tiles are infected (launchpad destroyed)
 */
function spreadInfection() {
  if (frameCount % 5 !== 0) return;  // Throttle to once every 5 frames

  let keys = Object.keys(infectedTiles);
  let keysLen = keys.length;

  // Game over — too much infection
  if (keysLen >= MAX_INF) {
    if (gameState !== 'gameover') {
      gameState = 'gameover';
      gameOverReason = 'INFECTION REACHED CRITICAL MASS';
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
    }
    return;
  }

  // Game over — launchpad fully overrun
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

  // Probabilistic spread to one random orthogonal neighbour per infected tile
  let fresh = [];
  for (let i = 0; i < keysLen; i++) {
    if (random() > INF_RATE) continue;
    let parts = keys[i].split(',');
    let tx = +parts[0], tz = +parts[1];
    let d = ORTHO_DIRS[floor(random(4))];
    let nx = tx + d[0], nz = tz + d[1], nk = tileKey(nx, nz);
    let wx = nx * TILE, wz = nz * TILE;
    if (aboveSea(terrain.getAltitude(wx, wz)) || infectedTiles[nk]) continue;
    fresh.push(nk);
  }

  // Commit all new infections after the loop (avoid modifying while iterating)
  for (let i = 0; i < fresh.length; i++) {
    let nk = fresh[i];
    infectedTiles[nk] = { tick: frameCount };
    let parts = nk.split(',');
    let ptx = +parts[0], ptz = +parts[1];
    if (typeof gameSFX !== 'undefined') gameSFX.playInfectionSpread(ptx * TILE, terrain.getAltitude(ptx * TILE, ptz * TILE), ptz * TILE);
    if (isLaunchpad(ptx * TILE, ptz * TILE)) {
      if (millis() - lastAlarmTime > 1000) {
        if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
        lastAlarmTime = millis();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

/**
 * Runs all collision tests for one player each frame.
 * Returns early if the player is already dead.
 *
 * Tests performed (in priority order):
 *   1. Enemy bullets vs player ship      (radius 70 units squared)
 *   2. Player bullets vs each enemy      (radius 80 units squared, +100 score)
 *   3. Player missiles vs each enemy     (radius 100 units squared, +250 score)
 *   4. Enemy body vs player ship body    (radius 70 units squared)
 *   5. Floating powerup (type-3 building) vs player ship (radius = building width + 15)
 *   6. Player bullets vs infected trees  (radius 60 units XZ + height range check)
 *
 * @param {object} p  Player state object.
 */
function checkCollisions(p) {
  if (p.dead) return;
  let s = p.ship;

  // --- 1. Enemy bullets vs player ---
  for (let i = particleSystem.enemyBullets.length - 1; i >= 0; i--) {
    let eb = particleSystem.enemyBullets[i];
    if ((eb.x - s.x) ** 2 + (eb.y - s.y) ** 2 + (eb.z - s.z) ** 2 < 4900) {
      killPlayer(p);
      particleSystem.enemyBullets.splice(i, 1);
      return;
    }
  }

  // --- 2 & 3 & 4. Player weapons vs enemies / enemy body vs player ---
  for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
    let e = enemyManager.enemies[j];
    let killed = false;

    // Player bullets vs enemy (hit radius 80 px)
    for (let i = p.bullets.length - 1; i >= 0; i--) {
      let b = p.bullets[i];
      if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 + (b.z - e.z) ** 2 < 6400) {
        particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
        enemyManager.enemies.splice(j, 1);
        p.bullets.splice(i, 1);
        p.score += 100;
        killed = true;
        break;
      }
    }

    // Player missiles vs enemy (hit radius 100 px) — checked only if not yet killed
    if (!killed) {
      for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
        let m = p.homingMissiles[i];
        if ((m.x - e.x) ** 2 + (m.y - e.y) ** 2 + (m.z - e.z) ** 2 < 10000) {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          enemyManager.enemies.splice(j, 1);
          p.homingMissiles.splice(i, 1);
          p.score += 250;
          killed = true;
          break;
        }
      }
    }

    // Enemy body vs player ship — kills the player on contact
    if (!killed && ((s.x - e.x) ** 2 + (s.y - e.y) ** 2 + (s.z - e.z) ** 2 < 4900)) {
      killPlayer(p);
      return;
    }
  }

  // --- 5. Floating powerup (type-3 building) vs player ---
  for (let i = buildings.length - 1; i >= 0; i--) {
    let b = buildings[i];
    if (b.type === 3) {
      let bGnd = terrain.getAltitude(b.x, b.z);
      let floatY = bGnd - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
      let dx = s.x - b.x, dy = s.y - floatY, dz = s.z - b.z;
      let radiusSq = (b.w + 15) ** 2;

      if (dx * dx + dy * dy + dz * dz < radiusSq) {
        let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];
        if (inf) {
          // Infected powerup — penalty: lose a missile
          if (p.missilesRemaining > 0) p.missilesRemaining--;
          if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(false, b.x, floatY, b.z);
        } else {
          // Healthy powerup — reward: gain a missile and score 500
          p.missilesRemaining++;
          p.score += 500;
          if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(true, b.x, floatY, b.z);
        }
        buildings.splice(i, 1);  // Consume the powerup

        // Spawn a burst of colour-coded particles at the collection point
        for (let j = 0; j < 20; j++) {
          particleSystem.particles.push({
            x: b.x, y: floatY, z: b.z,
            vx: random(-4, 4), vy: random(-4, 4), vz: random(-4, 4),
            life: 255, decay: 12, size: random(4, 9),
            color: inf ? [200, 50, 50] : [60, 180, 240]
          });
        }
      }
    }
  }

  // --- 6. Player bullets vs infected trees ---
  // Only infected trees clear infection; bullets don't damage healthy trees.
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    for (let t of trees) {
      let ty = terrain.getAltitude(t.x, t.z);
      if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 < 3600 &&
        b.y > ty - t.trunkH - 30 * t.canopyScale - 10 &&
        b.y < ty + 10) {
        let tx = toTile(t.x), tz = toTile(t.z);
        if (infectedTiles[tileKey(tx, tz)]) {
          clearInfectionRadius(tx, tz);
          p.score += 200;
          p.bullets.splice(i, 1);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * p5 keyPressed — handles game-start key presses on the menu, and missile
 * firing during gameplay for both players.
 */
function keyPressed() {
  if (gameState === 'menu') {
    if (key === '1') startGame(1);
    else if (key === '2') startGame(2);
    return;
  }

  for (let p of players) {
    if (keyCode === p.keys.missile) fireMissile(p);
  }

  // Toggle Aim Assist + Debug overlay (P key)
  if (key === 'p' || key === 'P') {
    mobileController.debug = !mobileController.debug;
    aimAssist.debug = mobileController.debug;
    aimAssist.enabled = mobileController.debug; // Sync assist on/off with debug for testing
  }
}

/**
 * p5 touchStarted — delegates to handleTouchStarted() defined in mobileControls.js.
 * Returning false prevents the default browser scroll / zoom behaviour.
 */
function touchStarted(event) {
  if (typeof handleTouchStarted === 'function') return handleTouchStarted();
  return false;
}

/** Prevents default on touch end so scrolling doesn't resume. */
function touchEnded(event) { return false; }

/** Prevents default on touch move (stops page scrolling during gameplay). */
function touchMoved(event) { return false; }

/**
 * p5 mousePressed — desktop only.
 * • Any click on the menu enters fullscreen and starts a 1-player game.
 * • Middle-click during gameplay fires a missile for P1.
 * • Any click during gameplay requests pointer-lock for mouse-look.
 */
function mousePressed() {
  if (!isMobile) {
    if (!fullscreen()) fullscreen(true);

    if (gameState === 'menu') {
      startGame(1);
    } else if (gameState === 'playing') {
      if (mouseButton === CENTER) {
        if (players.length > 0 && !players[0].dead) fireMissile(players[0]);
      }
      requestPointerLock();
    }
  }
}

function mouseDragged() { mouseMoved(); }

function mouseMoved() { }

/** Resizes the p5 canvas to match the new browser window dimensions. */
function windowResized() { resizeCanvas(windowWidth, windowHeight); }
