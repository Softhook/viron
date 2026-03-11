// =============================================================================
// sketch.js — p5 lifecycle, orchestration, and event handlers
//
// Thin orchestration layer that:
//   • Manages p5 lifecycle (preload, setup, draw)
//   • Delegates game state to gameState.js
//   • Delegates rendering to gameRenderer.js
//   • Delegates physics/collisions to gameLoop.js
//   • Handles user input and menu flow
//
// Game logic is layered across specialized modules for testability and clarity.
// =============================================================================

// Forward declarations for global access (populated after module load)
let isMobile = false;
let isAndroid = false;

// ---------------------------------------------------------------------------
// Utility functions (module-delegated)
// ---------------------------------------------------------------------------

/**
 * Finds the element in arr closest to (x, y, z) by 3D squared distance.
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
 * Plays launchpad alarm no more than once per cooldown window.
 */
function maybePlayLaunchpadAlarm() {
  const now = millis();
  if (now - gameState.lastAlarmTime <= ALARM_COOLDOWN_MS) return false;
  if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
  gameState.lastAlarmTime = now;
  return true;
}

/**
 * Removes all infected tiles within a tile square around (tx, tz).
 */
function clearInfectionRadius(tx, tz, radius = CLEAR_R) {
  let cleared = 0;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++) {
      let k = tileKey(tx + dx, tz + dz);
      if (infection.remove(k)) cleared++;
    }
  return cleared;
}

/**
 * Clears infection at a world-space position.
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
  gameState.gameFont = loadFont('Impact.ttf');
}

/**
 * p5 setup — creates the WEBGL canvas, initializes subsystems.
 * Mobile devices receive reduced object counts and draw distances.
 */
function setup() {
  gameState.detectPlatform();
  isMobile = gameState.isMobile;
  isAndroid = gameState.isAndroid;

  if (gameState.isMobile) {
    VIEW_NEAR = 20;
    VIEW_FAR = 30;
    CULL_DIST = 3500;
    pixelDensity(1);
  }

  setAttributes('stencil', true);
  createCanvas(windowWidth, windowHeight, WEBGL);

  gameRenderer.sceneFBO = null;
  gameRenderer.initialize(gameState.isMobile);

  // Suppress context menu on right-click
  document.addEventListener('contextmenu', event => event.preventDefault());

  // Track mouse button state via DOM events
  document.addEventListener('mousedown', e => {
    if (e.button === 0) gameState.leftMouseDown = true;
    if (e.button === 2) gameState.rightMouseDown = true;
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 0) gameState.leftMouseDown = false;
    if (e.button === 2) gameState.rightMouseDown = false;
  });

  terrain.init();
  textFont(gameState.gameFont);

  if (typeof aimAssist !== 'undefined') {
    aimAssist.enabled = gameState.isMobile;
  }

  // Populate static world objects
  randomSeed(123);
  let numBldgs = gameState.isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    let bx = random(-4500, 4500), bz = random(-4500, 4500);
    gameState.buildings.push({
      x: bx, z: bz,
      y: terrain.getAltitude(bx, bz),
      w: random(40, 100), h: random(50, 180), d: random(40, 100),
      type: floor(random(4)),
      col: [random(80, 200), random(80, 200), random(80, 200)]
    });
  }

  // Sentinels at mountain peaks
  for (let i = 0; i < MOUNTAIN_PEAKS.length; i++) {
    let peak = MOUNTAIN_PEAKS[i];
    gameState.buildings.push({
      x: peak.x, z: peak.z,
      y: terrain.getAltitude(peak.x, peak.z),
      w: 60, h: 280, d: 60,
      type: 4,
      col: [0, 220, 200],
      pulseTimer: floor(i * SENTINEL_PULSE_INTERVAL / MOUNTAIN_PEAKS.length)
    });
  }

  gameState.sentinelBuildings = gameState.buildings.filter(b => b.type === 4);
  gameState.mode = 'menu';
  if (window.BENCHMARK && window.BENCHMARK.setup) {
    startGame(1);
    gameState.mode = 'playing'; // To skip shipselect usually handled by shipselect screen
    startLevel(1);
  }
}

// ---------------------------------------------------------------------------
// Game flow / state transitions
// ---------------------------------------------------------------------------

/**
 * Begins a new game with the given number of players.
 * Delegates to gameState for initialization.
 */
function startGame(np) {
  gameState.startNewGame(np);
}

/**
 * Starts a specific level.
 * Delegates to gameState for level setup.
 */
function startLevel(lvl) {
  gameState.startLevel(lvl);
}

// ---------------------------------------------------------------------------
// p5 lifecycle — draw
// ---------------------------------------------------------------------------

/**
 * Main p5 draw loop — runs at the display refresh rate.
 * Delegates to state-specific handlers or runs full gameplay frame.
 */
function draw() {
  if (gameState.mode === 'menu') { drawMenu(); return; }
  if (gameState.mode === 'instructions') { drawInstructions(); return; }
  if (gameState.mode === 'shipselect') { drawShipSelect(); return; }

  if (window.BENCHMARK && window.BENCHMARK.active) {
    if (!window.BENCHMARK.frames) window.BENCHMARK.frames = 0;
    if (!window.BENCHMARK.startTime) window.BENCHMARK.startTime = performance.now();
    window.BENCHMARK.frames++;
    if (window.BENCHMARK.frames === 120) { // Run for 120 frames
      let totalTime = performance.now() - window.BENCHMARK.startTime;
      let avgMs = totalTime / 120;
      console.log('BENCHMARK_DONE:' + avgMs.toFixed(2));
      window.BENCHMARK.active = false;
    }
  }

  const profiler = getVironProfiler();
  const frameStart = profiler ? performance.now() : 0;

  gameRenderer.updatePerformanceScaling();
  terrain.clearCaches();

  if (gameState.isMobile && gameState.numPlayers === 1 && typeof mobileController !== 'undefined') {
    mobileController.update(touches, width, height);
  }

  // Physics update pipeline
  for (let p of gameState.players) updateShipInput(p);
  enemyManager.update();
  for (let p of gameState.players) GameLoop.checkCollisions(p);
  GameLoop.spreadInfection();
  particleSystem.updatePhysics();
  for (let p of gameState.players) updateProjectilePhysics(p);
  updateBarrierPhysics();

  gameRenderer.updateSentinelGlows();
  GameLoop.updateAmbianceAudio();
  gameRenderer.renderAllPlayers(drawingContext);
  GameLoop.updateLevelAndRespawn();

  if (gameState.mode === 'gameover') drawGameOver();
  if (profiler) profiler.frameEnd(performance.now() - frameStart);
}


// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * p5 keyPressed — handles game-start key presses on the menu, and weapon
 * cycling during gameplay for both players.
 */
function keyPressed() {
  if (gameState.mode === 'menu') {
    if (key === '1') startGame(1);
    else if (key === '2') startGame(2);
    return;
  }

  if (gameState.mode === 'instructions') {
    // Any relevant key on desktop moves past instructions
    if (keyCode === ENTER || key === ' ' || key === '1' || key === '2') {
      gameState.mode = 'shipselect';
    }
    return;
  }

  if (gameState.mode === 'shipselect') {
    for (let p of gameState.players) {
      if (p.id === 0) {
        // P1 Selection (A/D or Arrows if 1P)
        let left = (gameState.numPlayers === 1) ? (keyCode === LEFT_ARROW || keyCode === 65) : (keyCode === 65);
        let right = (gameState.numPlayers === 1) ? (keyCode === RIGHT_ARROW || keyCode === 68) : (keyCode === 68);
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
    if (gameState.players.every(p => p.ready)) {
      gameState.mode = 'playing';
      // startLevel(1) already called in startGame, but we want to ensure clean state
      startLevel(1);
    }
    return;
  }

  for (let p of gameState.players) {
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
    gameState.firstPersonView = !gameState.firstPersonView;
  }

  // Toggle ship design (L key)
  if (key === 'l' || key === 'L') {
    for (let p of gameState.players) {
      if (typeof SHIP_DESIGNS !== 'undefined') {
        p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
      }
    }
  }

  // Debug step through Day/Night Cycle (N / M keys)
  if (key === 'n' || key === 'N') {
    if (typeof updateTimeOfDay === 'function' && typeof currentTimeStep !== 'undefined') {
      updateTimeOfDay(currentTimeStep - 1);
    }
  }
  if (key === 'm' || key === 'M') {
    if (typeof updateTimeOfDay === 'function' && typeof currentTimeStep !== 'undefined') {
      updateTimeOfDay(currentTimeStep + 1);
    }
    // Debug convenience: also jump to the next level in the same key press.
    if (gameState.mode === 'playing' && typeof startLevel === 'function' && typeof gameState !== 'undefined') {
      startLevel(gameState.level + 1);
    }
  }
}

/**
 * p5 touchStarted — delegates to handleTouchStarted() defined in mobileControls.js.
 * Returning false prevents the default browser scroll / zoom behaviour.
 */
function touchStarted(event) {
  if (gameState.mode === 'menu' || gameState.mode === 'instructions') {
    if (typeof shouldRequestFullscreen === 'function' && shouldRequestFullscreen()) {
      fullscreen(true);
    }
  }

  if (gameState.mode === 'menu') { startGame(1); return false; }
  if (gameState.mode === 'instructions') {
    if (typeof mobileController !== 'undefined' && mobileController.checkSettingsHit(mouseX, mouseY)) {
      return false;
    }
    gameState.mode = 'shipselect';
    return false;
  }
  if (gameState.mode === 'shipselect') {
    let vw = width / gameState.numPlayers;
    let pIdx = floor(mouseX / vw);
    if (pIdx >= gameState.players.length) return false;
    let p = gameState.players[pIdx];
    if (p.ready) return false;

    let localX = mouseX % vw;
    // Regions match hud.js button rendering
    if (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130) {
      p.ready = true;
    } else if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
      if (localX < 120) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
      else if (localX > vw - 120) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
    }

    if (gameState.players.every(p => p.ready)) {
      gameState.mode = 'playing';
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
    if (typeof shouldRequestFullscreen === 'function' && shouldRequestFullscreen()) {
      fullscreen(true);
    }

    if (gameState.mode === 'menu') {
      startGame(1);
    } else if (gameState.mode === 'instructions') {
      if (typeof mobileController !== 'undefined' && mobileController.checkSettingsHit(mouseX, mouseY)) {
        return;
      }
      gameState.mode = 'shipselect';
    } else if (gameState.mode === 'shipselect') {
      let vw = width / gameState.numPlayers;
      let pIdx = floor(mouseX / vw);
      if (pIdx < gameState.players.length) {
        let p = gameState.players[pIdx];
        if (!p.ready) {
          let localX = mouseX % vw;
          if (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130) {
            p.ready = true;
          } else if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
            if (localX < 120) p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
            else if (localX > vw - 120) p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
          }
          if (gameState.players.every(p => p.ready)) {
            gameState.mode = 'playing';
            startLevel(1);
          }
        }
      }
    } else if (gameState.mode === 'playing') {
      if (mouseButton === CENTER) {
        if (gameState.players.length > 0 && !gameState.players[0].dead) {
          gameState.players[0].weaponMode = (gameState.players[0].weaponMode + 1) % WEAPON_MODES.length;
        }
      }
      requestPointerLock();
    }
  }
}

/** Resizes the p5 canvas to match the new browser window dimensions. */
function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// ---------------------------------------------------------------------------
// Debug Console Commands
// ---------------------------------------------------------------------------

/**
 * Spawns a yellow crab enemy for testing/debugging.
 * Usage in browser console:
 *   spawnYellowCrab()          — spawn at random location
 *   spawnYellowCrab(100, 200)  — spawn at world coordinates (100, 200)
 * @param {number} wx  Optional world X coordinate (default: random)
 * @param {number} wz  Optional world Z coordinate (default: random)
 */
function spawnYellowCrab(wx = undefined, wz = undefined) {
  if (gameState.mode !== 'playing') {
    console.warn('[spawnYellowCrab] Game not in playing mode');
    return;
  }

  // Use provided coordinates or pick random location
  let spawnX = wx !== undefined ? wx : random(-4000, 4000);
  let spawnZ = wz !== undefined ? wz : random(-4000, 4000);
  let spawnY = terrain.getAltitude(spawnX, spawnZ) - 10;

  let entry = {
    x: spawnX,
    y: spawnY,
    z: spawnZ,
    vx: random(-2, 2),
    vz: random(-2, 2),
    id: random(),
    type: 'yellowCrab',
    fireTimer: 0,
    bombTimer: 0
  };

  enemyManager.enemies.push(entry);
  console.log(`[spawnYellowCrab] Spawned at (${spawnX.toFixed(0)}, ${spawnY.toFixed(0)}, ${spawnZ.toFixed(0)})`);
}
