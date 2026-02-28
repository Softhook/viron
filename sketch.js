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
// =============================================================================

// ---------------------------------------------------------------------------
// Global game state
// ---------------------------------------------------------------------------

let trees = [], buildings = [], sentinelBuildings = [];

let level = 1;            // Current level number (increases on level completion)
let currentMaxEnemies = 2;         // Max simultaneous enemies for the current level

let levelComplete = false;     // True once all Viron has been cleared
let infectionStarted = false;     // Latches to true when the first tile is infected

// Barrier tile Map — mirrors `infection` but marks immune/blocked tiles.
// Stores {k, tx, tz, verts} objects using TileManager for fast iteration.
// withBuckets=true: tiles are also indexed by chunk so drawLandscape only
// iterates tiles in visible chunks instead of the entire global list.
let barrierTiles = new TileManager(true);

// In-flight barrier projectile objects — environment state, not per-player.
// Same structure as bullets/missiles: { x, y, z, vx, vy, vz, life }.
let inFlightBarriers = [];
let levelEndTime = 0;         // millis() timestamp of level completion / game over

let gameFont;                      // Loaded Impact font used for all HUD / menu text
let gameState = 'menu';    // Current game mode: 'menu' | 'playing' | 'gameover'
let gameOverReason = '';        // Human-readable reason string shown on game-over screen
let lastAlarmTime = 0;         // millis() of the last launchpad alarm SFX (rate-limited)
let gameStartTime = 0;         // millis() when the current game started

let numPlayers = 1;         // 1 or 2 — set by startGame()
let menuCam = { x: 1500, z: 1500, yaw: 0 }; // Title-screen camera state
let firstPersonView = false;  // Toggle with O key; false = behind-ship (default)
let sceneFBO = null;          // Pre-particle scene framebuffer for soft-particle depth test (WebGL2)

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
  const ua = navigator.userAgent;
  isAndroid = /Android/i.test(ua);

  // 1. Explicit UA check
  isMobile = isAndroid || /iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);

  // 2. Modern iPads (MacBook-like UA but touch-enabled)
  if (!isMobile && /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) {
    isMobile = true;
  }

  // 3. Fallback: Check for generic mobile/tablet indicators in Desktop View
  if (!isMobile && /Mobile|Tablet/i.test(ua)) {
    isMobile = true;
  }

  // 4. Fallback: Any touch device that doesn't look like a standard Desktop OS
  if (!isMobile && ('ontouchstart' in window)) {
    const isDesktopOS = /Windows NT|Macintosh|Linux/i.test(ua);
    if (!isDesktopOS) isMobile = true;
  }

  console.log(`[Viron] Device: ${isMobile ? 'MOBILE' : 'DESKTOP'} (UA: ${ua.slice(0, 50)}..., touch: ${navigator.maxTouchPoints})`);
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

const ALARM_COOLDOWN_MS = 1000;
/**
 * Plays the launchpad alarm no more than once per cooldown window.
 * @returns {boolean} true if the alarm was played and lastAlarmTime was updated.
 */
function maybePlayLaunchpadAlarm() {
  const now = millis();
  if (now - lastAlarmTime <= ALARM_COOLDOWN_MS) return false;
  if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
  lastAlarmTime = now;
  return true;
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
      if (infection.remove(k)) cleared++;
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
  if (!infection.has(tileKey(tx, tz))) return false;
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
    pixelDensity(1); // CAP: Modern mobile screens have 3x resolution but 1x fill-rate.
  }
  createCanvas(windowWidth, windowHeight, WEBGL);

  // Soft-particle depth pre-pass is temporarily disabled.
  // The off-screen FBO path can produce a fully black world on some systems;
  // keep the stable single-pass renderer active until that pipeline is fixed.
  //
  // On mobile, skip initializing particle resources entirely.
  // When _cloudTex is non-null, render() uses the billboard path:
  //   • rotateY + rotateX per particle  (~130 ns of extra trig / matrix work per particle, aggregate from benchmark-particles.js)
  //   • gl.disable(DEPTH_TEST) once per frame — on tile-based mobile GPUs
  //     (Adreno, Apple A-series, Mali) this is a tile-flush barrier that stalls
  //     the GPU for ~4–16 ms while all pending terrain tiles are resolved before
  //     the depth state can change.  This alone consumes 24–96% of the 16.7 ms
  //     60fps frame budget.
  //
  // Leaving _cloudTex null routes every particle through the sphere fallback:
  //   • No orientation trig, no DEPTH_TEST toggle, no tile-flush stall.
  //   • CPU: 2.84× cheaper per particle at mobile cull radius.
  //   • GPU: eliminates the ~4–16 ms-per-frame tile-flush stall (2 DEPTH_TEST toggles) entirely.
  //   • Net: recovers ~36% of the 60fps frame budget at a 200-particle load.
  //     (Measured by benchmark-particles.js — run `node benchmark-particles.js`)
  //
  // Desktop is unaffected: immediate-mode GPUs have no tile-flush architecture,
  // billboard visuals are preserved, and DEPTH_TEST toggles cost only ~1–5 μs.
  sceneFBO = null;
  if (!isMobile) ParticleSystem.init();

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

  // Initialize Aim Assist based on platform
  if (typeof aimAssist !== 'undefined') {
    aimAssist.enabled = isMobile;
  }

  // Trees are now generated procedurally from world-space noise in terrain.js.
  // Keep the array empty so we do not maintain a global static tree map.
  trees = [];

  // menuCam starts over open terrain away from the launchpad

  // Buildings — different seed from trees so positions don't correlate
  randomSeed(123);
  let numBldgs = isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    let bx = random(-4500, 4500), bz = random(-4500, 4500);
    buildings.push({
      x: bx, z: bz,
      y: terrain.getAltitude(bx, bz),  // Cached altitude — never changes
      w: random(40, 100), h: random(50, 180), d: random(40, 100),
      type: floor(random(4)),
      col: [random(80, 200), random(80, 200), random(80, 200)]
    });
  }

  // Sentinels — one per mountain peak, staggered pulse timers so they don't all fire together
  for (let i = 0; i < MOUNTAIN_PEAKS.length; i++) {
    let peak = MOUNTAIN_PEAKS[i];
    buildings.push({
      x: peak.x, z: peak.z,
      y: terrain.getAltitude(peak.x, peak.z),  // Cached altitude — never changes
      w: 60, h: 280, d: 60,   // Larger than ordinary buildings — monumental scale
      type: 4,
      col: [0, 220, 200],
      pulseTimer: floor(i * SENTINEL_PULSE_INTERVAL / MOUNTAIN_PEAKS.length)
    });
  }

  // LATERIAL OPT: Pre-process sentinels to avoid O(N) scans in the physics update.
  sentinelBuildings = buildings.filter(b => b.type === 4);

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
  // Reset performance monitor cooldown so this new session starts without
  // carrying over a quality-reduction penalty from the previous game.
  if (window._perf) window._perf.cooldown = 0;

  startLevel(1);
  gameState = 'shipselect';
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
    infection.add(tk);
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
    p.lpDeaths = 0;
  }

  barrierTiles.clear();    // All barrier marks reset with each new level
  inFlightBarriers = [];   // Discard any in-flight barriers

  enemyManager.clear();
  particleSystem.clear();
  terrain.activePulses = [];
  infection.reset();

  // Guarantee at least one infection tile is visible from the very start
  seedInitialInfection();

  // Every 3rd level (3, 6, 9 ...) guarantees a Colossus boss alongside normal enemies
  let hasColossus = (lvl >= 3 && lvl % 3 === 0);
  for (let i = 0; i < currentMaxEnemies; i++) {
    let forceSeeder = (i === 0);
    let forceColossus = (!forceSeeder && hasColossus && i === 1);
    enemyManager.spawn(forceSeeder, forceColossus);
  }
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

  // Pre-compute camera parameters — shared between the opaque-scene pass and
  // the particle pass so both use identical view/projection matrices.
  let camNear = firstPersonView ? 5 : 50;
  let camFar = VIEW_FAR * TILE * 1.5;
  let cx, cy, cz, lx, ly, lz;
  if (firstPersonView) {
    // Cockpit eye looking along the ship's forward vector.
    let cosPitch = cos(s.pitch), sinPitch = sin(s.pitch);
    cx = s.x; cy = s.y - 25; cz = s.z;
    lx = s.x + (-sin(s.yaw) * cosPitch) * 500;
    ly = (s.y - 25) + sinPitch * 500;
    lz = s.z + (-cos(s.yaw) * cosPitch) * 500;
  } else {
    // Camera sits ~300 units behind the ship (XZ plane) at a height-capped Y, looking at the ship body.
    cy = min(s.y - 120, 140);
    cx = s.x + 300 * sin(s.yaw);
    cz = s.z + 300 * cos(s.yaw);
    lx = s.x; ly = s.y; lz = s.z;
  }

  // Update spatial audio listener once per viewport.
  if (typeof gameSFX !== 'undefined') gameSFX.updateListener(cx, cy, cz, lx, ly, lz, 0, 1, 0);

  if (sceneFBO) {
    // ═══ PASS 1 — Render opaque scene into the FBO (captures depth) ═══════
    // The depth texture is later used by the soft-particle shader so particles
    // fade out at terrain/geometry intersections instead of hard-clipping.
    sceneFBO.begin();
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    setSceneLighting();
    terrain.drawLandscape(s, viewW / viewH);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    for (let player of players) {
      if (!player.dead && (player !== p || !firstPersonView)) shipDisplay(player.ship, player.labelColor);
      renderProjectiles(player, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
    // Render hard particles (explosions, bombs, bullets) inside the FBO so
    // they depth-test correctly and are captured in the depth texture used
    // by the soft-billboard shader.
    particleSystem.renderHardParticles(s.x, s.z);
    pop();
    sceneFBO.end();

    // ═══ PASS 2 — Draw FBO colour to main canvas using a textured quad ══════
    // blitFramebuffer from a non-MSAA FBO to the MSAA default canvas is
    // GL_INVALID_OPERATION in WebGL2 (non-MSAA → MSAA blit is forbidden by
    // spec).  p5.js itself uses this same image() pattern when it faces the
    // same restriction (see p5.Framebuffer source, _beforeEnd antialias path).
    // Keep the viewport and scissor aligned with the player's view slice.
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    push();
    ortho(-viewW / 2, viewW / 2, -viewH / 2, viewH / 2, -1, 1);
    resetMatrix();
    imageMode(CORNER);
    gl.disable(gl.DEPTH_TEST);
    // Draw only the slice of the FBO that was rendered (viewX, 0, viewW, viewH)
    image(sceneFBO, -viewW / 2, -viewH / 2, viewW, viewH, viewX, 0, viewW, viewH);
    gl.enable(gl.DEPTH_TEST);
    pop();

    // ═══ PASS 3 — Render soft billboard particles atop the rendered scene ═
    // Soft billboards self-manage depth fade via the sDepth texture; DEPTH_TEST
    // is disabled inside render() for these quads and re-enabled afterwards.
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, sceneFBO);
    pop();

  } else {
    // ═══ Original single-pass rendering (WebGL1 / no-FBO fallback) ═══════
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    setSceneLighting();
    terrain.drawLandscape(s, viewW / viewH);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    for (let player of players) {
      if (!player.dead && (player !== p || !firstPersonView)) shipDisplay(player.ship, player.labelColor);
      renderProjectiles(player, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, null);
    if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
    pop();
  }

  // ═══ HUD overlay (2D pass on top of 3D scene) ═══════════════════════════
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
 * Main p5 draw loop — runs at the display refresh rate (60 / 75 / 90 / 120 / 144 Hz).
 *
 * If in 'menu' or 'gameover' state, delegates entirely to the appropriate
 * HUD function and returns early.
 *
 * In 'playing' state:
 *   1. Dynamic performance scaling: adjusts VIEW_NEAR/FAR and CULL_DIST
 *      every 2 s wall-clock time using a frame-time percentile monitor.
 *      Raw deltaTime values fill a 60-frame circular buffer; the 90th-
 *      percentile frame time is compared against the detected display
 *      budget (ms/frame).  This catches jitter that FPS averages hide,
 *      works correctly at any refresh rate, and prevents quality bouncing
 *      on mobile via a 4-second post-reduction cooldown.
 *   2. Physics update: ship input, enemy AI, collision detection, infection spread,
 *      particle physics, projectile physics.
 *   3. Render: one or two viewport passes via renderPlayerView().
 *   4. Post-render 2D pass: split-screen divider and level-complete message.
 *   5. Level logic: detect level clear, advance level after 4-second delay.
 *   6. Respawn logic: decrement respawn timers, reset dead ships.
 */
function draw() {
  if (gameState === 'menu') { drawMenu(); return; }
  if (gameState === 'shipselect') { drawShipSelect(); return; }
  if (gameState === 'gameover') { drawGameOver(); return; }
  const profiler = getVironProfiler();
  const frameStart = profiler ? performance.now() : 0;

  // --- Dynamic Performance Scaling ---
  // Approach: frame-time percentile monitor (industry-standard technique).
  //
  // Why not frameRate() / EMA:
  //   • p5's frameRate() is itself an average of recent deltaTime values —
  //     applying another EMA compounds the smoothing lag.
  //   • FPS averages mask jitter: a game averaging 60 fps but spiking to
  //     100 ms every second feels terrible; the average shows no problem.
  //   • "Every N frames" evaluates at different wall-clock rates depending
  //     on the display (75 Hz → 1.6 s, 120 Hz → 1.0 s).
  //
  // This monitor instead:
  //   • Stores every raw deltaTime in a 60-entry circular buffer.
  //   • Derives the display frame budget once from the median of the first
  //     60 samples, snapped to a standard tier (144/120/90/75/60/30 Hz).
  //   • Evaluates the 90th-percentile frame time every 2 s wall-clock — if
  //     1 in 10 frames is slow the player feels it; averages would miss it.
  //   • Enforces a 4 s cooldown after every quality reduction to prevent
  //     bouncing (critical on mobile, where thermal throttling causes brief
  //     spikes that quickly recover).

  if (!window._perf) {
    window._perf = {
      buf: new Float32Array(60), // circular buffer of raw frame times (ms)
      idx: 0,
      full: false,
      budgetMs: 1000 / 60,      // ms-per-frame budget; refined after first 60 frames
      budgetSet: false,
      nextEval: 0,              // performance.now() timestamp of next evaluation
      cooldown: 0,              // don't upgrade quality before this timestamp
      overBudgetEvals: 0,       // consecutive eval windows that exceed reduce threshold
      underBudgetEvals: 0,      // consecutive eval windows that satisfy restore threshold
    };
  }
  const _p = window._perf;

  // Record this frame's raw time (capped at 100 ms to exclude one-off load spikes).
  _p.buf[_p.idx] = Math.min(deltaTime, 100);
  _p.idx = (_p.idx + 1) % 60;
  if (_p.idx === 0) _p.full = true;

  // After the first full buffer pass, detect the display refresh rate from the
  // median frame time and snap to the nearest standard tier.
  if (!_p.budgetSet && _p.full) {
    const sorted = Array.from(_p.buf).sort((a, b) => a - b);
    const medMs = (sorted[29] + sorted[30]) / 2; // p50 of 60 samples (even-sized set)
    // ms-per-frame for standard tiers: 144 / 120 / 90 / 75 / 60 / 30 Hz
    const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
    _p.budgetMs = tierMs.reduce((b, c) => Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b);
    // Desktop monitors above 60 Hz should not force lower view distance if the
    // machine is otherwise delivering stable 60 fps gameplay.
    if (!isMobile) _p.budgetMs = Math.max(_p.budgetMs, 1000 / 60);
    _p.budgetSet = true;
  }

  const _now = performance.now();
  if (_p.full && _now >= _p.nextEval) {
    _p.nextEval = _now + 2000; // re-evaluate every 2 s wall-clock

    // 90th-percentile frame time: sort a copy and read index 53 of 60.
    // Thresholds form a dead zone that prevents quality bouncing:
    //   reduce  if p90 > budget × 1.40  (sustained stutter — 40% over budget)
    //   restore if p90 < budget × 1.15  (clear headroom — within 15% of budget)
    const sorted = Array.from(_p.buf).sort((a, b) => a - b);
    const p90ms = sorted[53];

    // Desktop quality controller: conservative downshift, very deliberate upshift.
    const reduceRatio = isMobile ? 1.40 : 1.55;
    const restoreRatio = isMobile ? 1.15 : 1.08;
    const canRestore = _now >= _p.cooldown;

    if (p90ms > _p.budgetMs * reduceRatio) {
      _p.overBudgetEvals++;
      _p.underBudgetEvals = 0;
    } else if (p90ms < _p.budgetMs * restoreRatio && canRestore) {
      _p.underBudgetEvals++;
      _p.overBudgetEvals = 0;
    } else {
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
    }

    const minNear = isMobile ? 15 : 24;
    const minFar = isMobile ? 20 : 34;
    const minCull = isMobile ? 2000 : 4200;

    if (_p.overBudgetEvals >= 2) {
      VIEW_NEAR = max(minNear, VIEW_NEAR - 1);
      VIEW_FAR = max(minFar, VIEW_FAR - 1);
      CULL_DIST = max(minCull, CULL_DIST - 250);
      _p.cooldown = _now + 6000;
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
    } else if (_p.underBudgetEvals >= 3) {
      VIEW_NEAR = min(35, VIEW_NEAR + 1);
      VIEW_FAR = min(50, VIEW_FAR + 1);
      CULL_DIST = min(6000, CULL_DIST + 150);
      _p.cooldown = _now + 4000;
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
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
  updateBarrierPhysics();  // Environment-owned in-flight barriers

  // --- Sentinel glow update ---
  // Healthy sentinels: upload their positions to the terrain shader so it can
  // draw a steady breathing ring on the ground around the building base.
  // Infected sentinels: emit the old expanding infection-blue pulse instead,
  // giving a clear visual cue that danger is spreading from this location.
  terrain.sentinelGlows = [];   // Rebuilt each frame
  for (let b of buildings) {
    if (b.type !== 4) continue;
    b.pulseTimer = (b.pulseTimer || 0) + 1;
    let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));
    if (inf) {
      // Infected — emit the classic expanding pulse every SENTINEL_PULSE_INTERVAL frames
      if (b.pulseTimer >= SENTINEL_PULSE_INTERVAL) {
        b.pulseTimer = 0;
        terrain.addPulse(b.x, b.z, 1.0);  // infection-blue expanding ring
      }
    } else {
      // Healthy — register position for the shader steady glow ring
      // Glow radius ≈ 1.4× the plinth width (b.w * 1.1) for a nice halo outside the base
      terrain.sentinelGlows.push({ x: b.x, z: b.z, radius: b.w * 1.5 });
      if (b.pulseTimer >= SENTINEL_PULSE_INTERVAL) b.pulseTimer = 0;  // prevent overflow
    }
  }

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
  if (!levelComplete) {
    let ic = infection.count;
    if (ic > 0) infectionStarted = true;
    if (infectionStarted && ic === 0) {
      levelComplete = true;
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playLevelComplete();
    }
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
  if (profiler) profiler.frameEnd(performance.now() - frameStart);
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
  const profiler = getVironProfiler();
  const profilerConfig = profiler ? profiler.config : (typeof window !== 'undefined' ? window.VIRON_PROFILE : null);
  const maxInf = (profilerConfig && profilerConfig.maxInfOverride) ? profilerConfig.maxInfOverride : MAX_INF;
  const freezeSpread = !!(profilerConfig && profilerConfig.freezeSpread);
  const shouldRun = frameCount % 5 === 0;
  if (!shouldRun) return;
  const spreadStart = profiler ? performance.now() : 0;

  // Game over — too much infection (fast path: no Object.keys allocation needed)
  if (infection.count >= maxInf) {
    if (gameState !== 'gameover') {
      gameState = 'gameover';
      gameOverReason = 'INFECTION REACHED CRITICAL MASS';
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
    }
    return;
  }

  // Game over — launchpad fully overrun (7×7 = 49 tiles)
  let lpInfected = 0;
  for (let tx = 0; tx < 7; tx++) {
    for (let tz = 0; tz < 7; tz++) {
      if (infection.has(tileKey(tx, tz))) lpInfected++;
    }
  }
  if (lpInfected >= 49) {
    if (gameState !== 'gameover') {
      gameState = 'gameover';
      gameOverReason = 'LAUNCH PAD INFECTED';
      levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
    }
    return;
  }

  if (freezeSpread) {
    if (profiler) profiler.recordSpread(performance.now() - spreadStart);
    return;
  }

  let infObjects = infection.keys();
  // Probabilistic spread to one random orthogonal neighbour per infected tile.
  let freshSet = new Set();
  for (let i = 0; i < infObjects.length; i++) {
    if (random() > INF_RATE) continue;
    let t = infObjects[i];
    let d = ORTHO_DIRS[floor(random(4))];
    let nx = t.tx + d[0], nz = t.tz + d[1], nk = tileKey(nx, nz);
    let wx = nx * TILE, wz = nz * TILE;
    if (aboveSea(terrain.getAltitude(wx, wz)) || infection.has(nk)) continue;
    freshSet.add(nk);
  }

  // Commit all new infections after the loop (avoid modifying while iterating)
  // Accelerated spread from infected sentinels — virus grows very fast around them
  // LATERIAL OPT: Use the pre-filtered sentinel list.
  for (let b of sentinelBuildings) {
    let stx = toTile(b.x), stz = toTile(b.z);
    if (!infection.has(tileKey(stx, stz))) continue;  // Only when this sentinel is infected
    // Blast outward in a ~5-tile radius circle with high per-tile probability
    for (let ddx = -SENTINEL_INFECTION_RADIUS; ddx <= SENTINEL_INFECTION_RADIUS; ddx++) {
      for (let ddz = -SENTINEL_INFECTION_RADIUS; ddz <= SENTINEL_INFECTION_RADIUS; ddz++) {
        if (ddx * ddx + ddz * ddz > SENTINEL_INFECTION_RADIUS * SENTINEL_INFECTION_RADIUS) continue;  // Circle shape
        if (random() > SENTINEL_INFECTION_PROBABILITY) continue;
        let nx = stx + ddx, nz = stz + ddz;
        let nk = tileKey(nx, nz);
        let wx = nx * TILE, wz = nz * TILE;
        if (!aboveSea(terrain.getAltitude(wx, wz)) && !infection.has(nk)) {
          freshSet.add(nk);
        }
      }
    }
  }

  let soundCount = 0;
  for (let nk of freshSet) {
    // Barrier blocking: immune tiles stop infection spread
    if (barrierTiles.has(nk)) continue;

    infection.add(nk);
    let o = infection.tiles.get(nk);
    let wx = o.tx * TILE, wz = o.tz * TILE;
    // Cap infection-spread sounds to 3 per update to avoid spawning too many audio nodes.
    if (typeof gameSFX !== 'undefined' && soundCount < 3) {
      gameSFX.playInfectionSpread(wx, terrain.getAltitude(wx, wz), wz);
      soundCount++;
    }
    if (isLaunchpad(wx, wz)) {
      maybePlayLaunchpadAlarm();
    }
  }

  if (profiler) profiler.recordSpread(performance.now() - spreadStart);
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

    // Player bullets vs enemy
    // Colossus: bullets do 1 HP damage and survive (they pass through), large hit radius
    // Other enemies: one bullet kills
    for (let i = p.bullets.length - 1; i >= 0; i--) {
      let b = p.bullets[i];
      let hitRadSq = e.type === 'colossus' ? 90000 : 6400;  // 300 vs 80 unit radius
      if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 + (b.z - e.z) ** 2 < hitRadSq) {
        if (e.type === 'colossus') {
          // Damage the Colossus — bullets don't pass through the body, consume bullet
          e.hp = (e.hp || 0) - 1;
          e.hitFlash = 12;
          p.bullets.splice(i, 1);
          p.score += 10;  // Small score per hit
          if (e.hp <= 0) {
            particleSystem.addExplosion(e.x, e.y - 100, e.z, enemyManager.getColor(e.type), e.type);
            enemyManager.enemies.splice(j, 1);
            p.score += 2000;  // Big bonus for killing the boss
            killed = true;
          }
        } else {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          enemyManager.enemies.splice(j, 1);
          p.bullets.splice(i, 1);
          p.score += 100;
          killed = true;
        }
        break;
      }
    }

    // Player missiles vs enemy (hit radius 200 px for colossus, 100 px otherwise)
    if (!killed) {
      for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
        let m = p.homingMissiles[i];
        let hitRadSq = e.type === 'colossus' ? 160000 : 10000;
        if ((m.x - e.x) ** 2 + (m.y - e.y) ** 2 + (m.z - e.z) ** 2 < hitRadSq) {
          if (e.type === 'colossus') {
            // Missiles deal 5 HP to the Colossus
            e.hp = (e.hp || 0) - 5;
            e.hitFlash = 20;
            p.homingMissiles.splice(i, 1);
            p.score += 50;
            if (e.hp <= 0) {
              particleSystem.addExplosion(e.x, e.y - 100, e.z, enemyManager.getColor(e.type), e.type);
              enemyManager.enemies.splice(j, 1);
              p.score += 2000;
              killed = true;
            }
          } else {
            particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
            enemyManager.enemies.splice(j, 1);
            p.homingMissiles.splice(i, 1);
            p.score += 250;
            killed = true;
          }
          break;
        }
      }
    }

    // Enemy body vs player ship — kills the player on contact
    // Colossus has a larger body collision radius
    let bodyRadSq = e.type === 'colossus' ? 90000 : 4900;
    if (!killed && ((s.x - e.x) ** 2 + (s.y - e.y) ** 2 + (s.z - e.z) ** 2 < bodyRadSq)) {
      killPlayer(p);
      return;
    }
  }

  // --- 5. Floating powerup (type-3 building) vs player ---
  for (let i = buildings.length - 1; i >= 0; i--) {
    let b = buildings[i];
    if (b.type === 3) {
      let floatY = b.y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
      let dx = s.x - b.x, dy = s.y - floatY, dz = s.z - b.z;
      let radiusSq = (b.w + 15) ** 2;

      if (dx * dx + dy * dy + dz * dz < radiusSq) {
        let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));
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

  // --- 6. Player bullets vs infected procedural trees ---
  // Trees are generated from deterministic tile noise, so this checks nearby
  // sample tiles around each bullet rather than iterating a global tree array.
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    let tx0 = toTile(b.x), tz0 = toTile(b.z);
    let hit = false;

    for (let tz = tz0 - 2; tz <= tz0 + 2 && !hit; tz++) {
      for (let tx = tx0 - 2; tx <= tx0 + 2; tx++) {
        let t = terrain.tryGetProceduralTree(tx, tz);
        if (!t) continue;
        let ty = terrain.getAltitude(t.x, t.z);
        if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 >= 3600) continue;
        if (b.y <= ty - t.trunkH - 30 * t.canopyScale - 10 || b.y >= ty + 10) continue;

        let k = tileKey(tx, tz);
        if (!infection.has(k)) continue;

        clearInfectionRadius(tx, tz);
        p.score += 200;
        p.bullets.splice(i, 1);
        hit = true;
        break;
      }
    }
  }

} // end checkCollisions


// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * p5 keyPressed — handles game-start key presses on the menu, and weapon
 * cycling during gameplay for both players.
 */
function keyPressed() {
  if (gameState === 'menu') {
    if (key === '1') startGame(1);
    else if (key === '2') startGame(2);
    return;
  }

  if (gameState === 'shipselect') {
    for (let p of players) {
      if (p.id === 0) {
        // P1 Selection (A/D or Arrows if 1P)
        let left = (numPlayers === 1) ? (keyCode === LEFT_ARROW || keyCode === 65) : (keyCode === 65);
        let right = (numPlayers === 1) ? (keyCode === RIGHT_ARROW || keyCode === 68) : (keyCode === 68);
        if (left) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
        if (right) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
        if (keyCode === ENTER || keyCode === 81) p.ready = true; // Enter or Q
      } else {
        // P2 Selection (Arrows)
        if (keyCode === LEFT_ARROW) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
        if (keyCode === RIGHT_ARROW) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
        if (keyCode === 190) p.ready = true; // . (period)
      }
    }

    // Check if all players are ready
    if (players.every(p => p.ready)) {
      gameState = 'playing';
      // startLevel(1) already called in startGame, but we want to ensure clean state
      startLevel(1);
    }
    return;
  }

  for (let p of players) {
    if (keyCode === p.keys.weaponCycle) {
      p.weaponMode = (p.weaponMode + 1) % WEAPON_MODES.length;
    }
  }

  // Toggle Aim Assist + Debug overlay (P key)
  if (key === 'p' || key === 'P') {
    aimAssist.enabled = !aimAssist.enabled;
    aimAssist.debug = aimAssist.enabled;
    mobileController.debug = aimAssist.enabled;
  }

  // Toggle first-person / behind-ship camera (O key)
  if (key === 'o' || key === 'O') {
    firstPersonView = !firstPersonView;
  }

  // Toggle ship design (L key)
  if (key === 'l' || key === 'L') {
    for (let p of players) {
      if (typeof SHIP_DESIGNS !== 'undefined') {
        p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
      }
    }
  }
}

/**
 * p5 touchStarted — delegates to handleTouchStarted() defined in mobileControls.js.
 * Returning false prevents the default browser scroll / zoom behaviour.
 */
function touchStarted(event) {
  if (gameState === 'menu') { startGame(1); return false; }
  if (gameState === 'shipselect') {
    let vw = width / numPlayers;
    let pIdx = floor(mouseX / vw);
    if (pIdx >= players.length) return false;
    let p = players[pIdx];
    if (p.ready) return false;

    let localX = mouseX % vw;
    // Regions match hud.js button rendering
    if (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130) {
      p.ready = true;
    } else if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
      if (localX < 120) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
      else if (localX > vw - 120) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
    }

    if (players.every(p => p.ready)) {
      gameState = 'playing';
      startLevel(1);
    }
    return false;
  }
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
 * • Middle-click during gameplay fires the active weapon for P1.
 * • Any click during gameplay requests pointer-lock for mouse-look.
 */
function mousePressed() {
  if (!isMobile) {
    if (!fullscreen()) fullscreen(true);

    if (gameState === 'menu') {
      startGame(1);
    } else if (gameState === 'shipselect') {
      let vw = width / numPlayers;
      let pIdx = floor(mouseX / vw);
      if (pIdx < players.length) {
        let p = players[pIdx];
        if (!p.ready) {
          let localX = mouseX % vw;
          if (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130) {
            p.ready = true;
          } else if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
            if (localX < 120) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
            else if (localX > vw - 120) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
          }
          if (players.every(p => p.ready)) {
            gameState = 'playing';
            startLevel(1);
          }
        }
      }
    } else if (gameState === 'playing') {
      if (mouseButton === CENTER) {
        if (players.length > 0 && !players[0].dead) {
          players[0].weaponMode = (players[0].weaponMode + 1) % WEAPON_MODES.length;
        }
      }
      requestPointerLock();
    }
  }
}

/** Resizes the p5 canvas to match the new browser window dimensions. */
function windowResized() { resizeCanvas(windowWidth, windowHeight); }
