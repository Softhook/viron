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

// ---------------------------------------------------------------------------
// Orchestration Layers
// ---------------------------------------------------------------------------

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
  inputManager.initialize();

  if (gameState.isMobile) {
    VIEW_NEAR = MOBILE_VIEW_LIMITS.near;
    VIEW_FAR = MOBILE_VIEW_LIMITS.far;
    CULL_DIST = MOBILE_VIEW_LIMITS.cull;
    pixelDensity(1);
  } else {
    VIEW_NEAR = DESKTOP_VIEW_LIMITS.near;
    VIEW_FAR = DESKTOP_VIEW_LIMITS.far;
    CULL_DIST = DESKTOP_VIEW_LIMITS.cull;
  }

  setAttributes({ stencil: true });
  createCanvas(windowWidth, windowHeight, WEBGL);

  gameRenderer.sceneFBO = null;
  gameRenderer.initialize(gameState.isMobile);

  // Handle backgrounding/pause
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) gameState.pauseGame();
  });
  window.addEventListener('blur', () => {
    gameState.pauseGame();
  });

  terrain.init();
  textFont(gameState.gameFont);

  if (aimAssist) {
    aimAssist.enabled = gameState.isMobile;
  }

  // Randomize the initial world seed so the menu and first gameplay session are unique and reusable
  gameState.worldSeed = floor(random(1, 1000000)); 
  initWorld(gameState.worldSeed);

  gameState.mode = 'menu';
  if (window.BENCHMARK && window.BENCHMARK.setup) {
    startGame(1);
    gameState.activatePlayingMode();
  }
}

// ---------------------------------------------------------------------------
// Game flow / state transitions
// ---------------------------------------------------------------------------

/**
 * Begins a new game with the given number of players.
 * Delegates to gameState for initialization.
 * Resets the physics accumulator so stale menu time does not cause a burst
 * of extra ticks on the first gameplay frame.
 */
function startGame(np) {
  physicsEngine.setPaused(false);
  physicsEngine.reset(true);
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
 *
 * Physics is advanced in fixed 16.667 ms steps via the accumulator so
 * gameplay runs identically on any display refresh rate (60, 75, 144 Hz…).
 * Rendering always executes once per display frame.
 */
function draw() {
  HUD_Manager?.update();

  if (gameState.mode === 'menu') { drawMenu(); return; }
  if (gameState.mode === 'mission') { drawMission(); return; }
  if (gameState.mode === 'instructions') { drawInstructions(); return; }
  if (gameState.mode === 'cockpitSelection') { 
    HUD_Screens?.drawCockpitSelection();
    return; 
  }
  if (gameState.mode === 'shipselect') { drawShipSelect(); return; }
  if (gameState.mode === 'gameover') { drawGameOver(); return; }

  
  if (gameState.mode === 'paused' && !gameState.shouldCapture) {
    drawPauseScreen();
    return;
  }

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

  inputManager.update();
  gameRenderer.updatePerformanceScaling();
  terrain.clearCaches();

  // Fixed-timestep physics update
  physicsEngine.update(deltaTime, (tick) => {
    // Physics update pipeline (runs at a steady 60 Hz equivalent)
    for (let p of gameState.players) updateShipInput(p);
    enemyManager.update();
    villagerManager?.update();
    wizardManager?.update();
    for (let p of gameState.players) GameLoop.checkCollisions(p);
    GameLoop.spreadInfection();
    particleSystem.updatePhysics();
    for (let p of gameState.players) updateProjectilePhysics(p);
    updateBarrierPhysics();
    GameLoop.updateLevelAndRespawn();
  });

  // Rendering — executes once per display frame regardless of Hz
  gameRenderer.updateSentinelGlows();
  GameLoop.updateAmbianceAudio();
  gameRenderer.renderAllPlayers(drawingContext);
  
  if (gameState.shouldCapture) {
    gameState.pauseSnapshot = get(); // Captures the fully rendered frame (incl. HUD)
    gameState.shouldCapture = false;
  }

  if (gameState.mode === 'paused') {
    drawPauseScreen();
  }

  if (profiler) profiler.frameEnd(performance.now() - frameStart);
}


// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * p5 keyPressed — handles game-start key presses on the menu, and weapon
 * cycling during gameplay for both players.
 */
function keyPressed(event) {
  if (inputManager.handleTransition('key', event)) return;

  if (gameState.mode === 'paused') return; // Ignore other keys while paused

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

    // Check if all players are ready -> move to cockpit selection
    if (gameState.players.every(p => p.ready)) {
      gameState.mode = 'cockpitSelection';
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
  }

  // Toggle first-person / behind-ship camera (O key)
  if (key === 'o' || key === 'O') {
    gameState.firstPersonView = !gameState.firstPersonView;
  }

  // Toggle ship design (L key)
  if (key === 'l' || key === 'L') {
    for (let p of gameState.players) {
      p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
    }
  }

  // Debug step through Day/Night Cycle (N / M keys)
  if (key === 'n' || key === 'N') {
    updateTimeOfDay(currentTimeStep - 1);
  }
  if (key === 'm' || key === 'M') {
    updateTimeOfDay(currentTimeStep + 1);
    // Debug convenience: also jump to the next level in the same key press.
    if (gameState.mode === 'playing') {
      startLevel(gameState.level + 1);
    }
  }
}

/**
 * p5 touchStarted — delegates to handleTouchStarted() defined in mobileControls.js.
 * Returning false prevents the default browser scroll / zoom behaviour.
 */
function touchStarted(event) {
  if (event.target.tagName !== 'CANVAS') return true;
  if (inputManager.handleTransition('touch', event)) return false;

  if (gameState.mode === 'shipselect') {
    _shipSelectHit(mouseX, mouseY, true);
    return false;
  }
  if (gameState.mode === 'cockpitSelection') {
    if (mobileController) {
      let hit = mobileController.checkSettingsHit(mouseX, mouseY);
      if (hit === 'continue') {
        gameState.activatePlayingMode();
      }
    }
    return false;
  }
  return handleTouchStarted?.() ?? false;
}

/** Prevents default on touch end so scrolling doesn't resume. */
function touchEnded(event) {
  if (event.target.tagName !== 'CANVAS') return true;
  return false;
}

/** Prevents default on touch move (stops page scrolling during gameplay). */
function touchMoved(event) {
  if (event.target.tagName !== 'CANVAS') return true;
  return false;
}

/**
 * p5 mousePressed — desktop only.
 * • Any click on the menu enters fullscreen and starts a 1-player game.
 * • Middle-click during gameplay fires the active weapon for P1.
 * • Any click during gameplay requests pointer-lock for mouse-look.
 */
function mousePressed(event) {
  if (inputManager.handleTransition('mouse', event)) return;

  if (gameState.mode === 'shipselect') {
    _shipSelectHit(mouseX, mouseY, false);
  } else if (gameState.mode === 'cockpitSelection') {
    if (mobileController) {
      let hit = mobileController.checkSettingsHit(mouseX, mouseY);
      if (hit === 'continue') {
        gameState.activatePlayingMode();
        return;
      }
      if (hit) return;
    }
    // On desktop, clicking anywhere else advances to playing
    if (!gameState.isMobile) {
      gameState.activatePlayingMode();
    }
  }
}

/** Resizes the p5 canvas to match the new browser window dimensions. */
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Clear pause snapshot on resize to avoid stretched background
  if (gameState.pauseSnapshot) {
    gameState.pauseSnapshot = null;
  }
}

// ---------------------------------------------------------------------------
// Input helpers (shared by event handlers)
// ---------------------------------------------------------------------------

/**
 * Tests whether (mx, my) hits a pause-screen button.
 * Returns 'resume', 'restart', or null.
 * Coordinates are in raw canvas space (not viewport-centred).
 * @param {number} mx  Raw mouse/touch X.
 * @param {number} my  Raw mouse/touch Y.
 * @returns {'resume'|'restart'|null}
 */
function _handlePauseScreenHit(mx, my) {
  const cx = mx - width / 2;
  const cy = my - height / 2;
  // Resume button at y=20, Restart button at y=120 relative to screen centre
  if (cx > -140 && cx < 140 && cy > -10 && cy < 50)  return 'resume';
  if (cx > -140 && cx < 140 && cy > 90  && cy < 150) return 'restart';
  return null;
}

/**
 * Handles a ship-select screen tap/click for a single input point.
 * Updates the player's designIndex on arrow hits, or marks them ready on CONFIRM.
 * Called by both touchStarted() (isTouch=true) and mousePressed() (isTouch=false).
 * @param {number}  mx       Input X coordinate.
 * @param {number}  my       Input Y coordinate.
 * @param {boolean} isTouch  True for touch input (wider arrow hit area; explicit CONFIRM only).
 */
function _shipSelectHit(mx, my, isTouch) {
  const vw = width / gameState.numPlayers;
  const pIdx = floor(mx / vw);
  if (pIdx >= gameState.players.length) return;
  const p = gameState.players[pIdx];
  if (p.ready) return;

  const localX = mx % vw;
  const centerX = vw / 2;
  const arrowOffset = 220;
  const arrowHitWidth = isTouch ? 120 : 80;

  let arrowHit = false;
  if (my > height / 2 - 60 && my < height / 2 + 60) {
    if (localX > centerX - arrowOffset - arrowHitWidth / 2 && localX < centerX - arrowOffset + arrowHitWidth / 2) {
      p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
      arrowHit = true;
    } else if (localX > centerX + arrowOffset - arrowHitWidth / 2 && localX < centerX + arrowOffset + arrowHitWidth / 2) {
      p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
      arrowHit = true;
    }
  }

  if (!arrowHit) {
    // Touch input requires an explicit CONFIRM button hit.
    // Non-touch (mouse) input confirms on any non-arrow click (broad desktop hit area).
    const isConfirmHit = my > height - 110 && localX > centerX - 130 && localX < centerX + 130;
    if (isConfirmHit || !isTouch) {
      p.ready = true;
    }
  }

  if (gameState.players.every(p => p.ready)) {
    gameState.mode = 'cockpitSelection';
  }
}

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

