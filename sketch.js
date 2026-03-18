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
// Fixed-timestep physics
//
// Game logic (bullets, enemies, infection) runs at a fixed 60 Hz tick rate
// regardless of the display refresh rate.  The accumulator collects elapsed
// wall-clock time each draw() call; whole ticks are drained from it before
// the frame is rendered.  This keeps gameplay identical on 60, 75, 144 Hz
// and throttled-mobile screens.
//
//   _SIM_DT   — physics step duration in ms (1000 / 60 ≈ 16.667 ms)
//   _physAccum — leftover ms not yet consumed by a completed physics tick
//   _simTick  — monotonically incrementing tick counter (replaces frameCount
//               inside every physics function so timing is Hz-independent)
// ---------------------------------------------------------------------------
const _SIM_DT = 1000 / 60;     // ~16.667 ms per physics step
const _MAX_PHYSICS_STEP_MS = 100; // deltaTime cap — prevents spiral-of-death on tab-switch / GC pauses
let _physAccum = 0;
let _simTick = 0;

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
    VIEW_NEAR = MOBILE_VIEW_LIMITS.near;
    VIEW_FAR = MOBILE_VIEW_LIMITS.far;
    CULL_DIST = MOBILE_VIEW_LIMITS.cull;
    pixelDensity(1);
  } else {
    VIEW_NEAR = DESKTOP_VIEW_LIMITS.near;
    VIEW_FAR = DESKTOP_VIEW_LIMITS.far;
    CULL_DIST = DESKTOP_VIEW_LIMITS.cull;
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

  // Handle backgrounding/pause
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) gameState.pauseGame();
  });
  window.addEventListener('blur', () => {
    gameState.pauseGame();
  });

  terrain.init();
  textFont(gameState.gameFont);

  if (typeof aimAssist !== 'undefined') {
    aimAssist.enabled = gameState.isMobile;
  }

  // Initial world generation for the menu view
  gameState.worldSeed = 12345; // Default menu seed
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
  _physAccum = 0;
  _simTick = 0;
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
  if (typeof HUD_Manager !== 'undefined') HUD_Manager.update();

  if (gameState.mode === 'menu') { drawMenu(); return; }
  if (gameState.mode === 'mission') { drawMission(); return; }
  if (gameState.mode === 'instructions') { drawInstructions(); return; }
  if (gameState.mode === 'cockpitSelection') { 
    if (typeof HUD_Screens !== 'undefined' && HUD_Screens.drawCockpitSelection) {
      HUD_Screens.drawCockpitSelection(); 
    }
    return; 
  }
  if (gameState.mode === 'shipselect') { drawShipSelect(); return; }

  
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

  gameRenderer.updatePerformanceScaling();
  terrain.clearCaches();

  if (gameState.isMobile && gameState.numPlayers === 1 && typeof mobileController !== 'undefined') {
    mobileController.update(touches, width, height);
  }

  // Fixed-timestep physics accumulator.
  // Cap raw delta to _MAX_PHYSICS_STEP_MS to avoid a spiral-of-death after
  // tab switches, debugger pauses, or severe thermal throttle spikes.
  const rawDt = Math.min(deltaTime, _MAX_PHYSICS_STEP_MS);
  _physAccum += rawDt;
  while (_physAccum >= _SIM_DT) {
    _physAccum -= _SIM_DT;
    _simTick++;

    // Physics update pipeline (runs at a steady 60 Hz equivalent)
    for (let p of gameState.players) updateShipInput(p);
    enemyManager.update();
    for (let p of gameState.players) GameLoop.checkCollisions(p);
    GameLoop.spreadInfection();
    particleSystem.updatePhysics();
    for (let p of gameState.players) updateProjectilePhysics(p);
    updateBarrierPhysics();
    GameLoop.updateLevelAndRespawn();
  }

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
function keyPressed() {
  if (gameState.mode === 'menu') {
    if (key === '1') startGame(1);
    else if (key === '2') startGame(2);
    return;
  }

  // Toggle pause with Esc
  if (keyCode === 27) {
    if (gameState.mode === 'playing') {
      gameState.pauseGame();
    } else if (gameState.mode === 'paused') {
      gameState.resumeGame();
      if (!isMobile) requestPointerLock();
    }
    return;
  }

  if (gameState.mode === 'paused') return; // Ignore other keys while paused

  if (gameState.mode === 'mission') {
    gameState.mode = 'instructions';
    return;
  }

  if (gameState.mode === 'instructions') {
    // Any relevant key on desktop moves past instructions to ship selection
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

    // Check if all players are ready -> move to view selection
    if (gameState.players.every(p => p.ready)) {
      gameState.mode = 'cockpitSelection';
    }
    return;
  }

  if (gameState.mode === 'cockpitSelection') {
    if (keyCode === ENTER || key === ' ' || key === '1' || key === '2') {
      gameState.activatePlayingMode();
    } else if (key === 'o' || key === 'O') {
      gameState.firstPersonView = !gameState.firstPersonView;
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
  if (event.target.tagName !== 'CANVAS') return true;

  if (gameState.mode === 'menu' || gameState.mode === 'instructions') {
    if (typeof shouldRequestFullscreen === 'function' && shouldRequestFullscreen()) {
      fullscreen(true);
    }
  }

  if (gameState.mode === 'menu') { startGame(1); return false; }
  if (gameState.mode === 'mission') {
    gameState.mode = 'instructions';
    return false;
  }
  if (gameState.mode === 'instructions') {
    if (typeof mobileController !== 'undefined') {
      let hit = mobileController.checkSettingsHit(mouseX, mouseY);
      if (hit === 'continue') {
        gameState.mode = 'shipselect';
      }
    }
    return false;
  }
  if (gameState.mode === 'shipselect') {
    let vw = width / gameState.numPlayers;
    let pIdx = floor(mouseX / vw);
    if (pIdx >= gameState.players.length) return false;
    let p = gameState.players[pIdx];
    if (p.ready) return false;

    let localX = mouseX % vw;
    // Regions match hudScreens.js button rendering
    if (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130) {
      p.ready = true;
    } else if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
      const centerX = vw / 2;
      const arrowOffset = 220;
      const arrowHitWidth = 120; // More generous hit area for touch

      if (localX > centerX - arrowOffset - arrowHitWidth/2 && localX < centerX - arrowOffset + arrowHitWidth/2) {
        p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
      } else if (localX > centerX + arrowOffset - arrowHitWidth/2 && localX < centerX + arrowOffset + arrowHitWidth/2) {
        p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
      }
    }

    if (gameState.players.every(p => p.ready)) {
      gameState.mode = 'cockpitSelection';
    }
    return false;
  }
  if (gameState.mode === 'cockpitSelection') {
    if (typeof mobileController !== 'undefined') {
      let hit = mobileController.checkSettingsHit(mouseX, mouseY);
      if (hit === 'continue') {
        gameState.activatePlayingMode();
      }
    }
    return false;
  }
  if (gameState.mode === 'paused') {
    // Buttons are at center X (0 in 2D viewport, which is width/2 here)
    // Resume at y=20 (center Y is height/2)
    // btnW=280, btnH=60
    let mx = mouseX - width / 2;
    let my = mouseY - height / 2;
    // Resume Button (y=20 relative to center)
    if (mx > -140 && mx < 140 && my > -10 && my < 50) {
      gameState.resumeGame();
    }
    // Restart Button (y=120 relative to center: resumeY=20 + btnH=60 + spacing=40)
    else if (mx > -140 && mx < 140 && my > 90 && my < 150) {
      gameState.mode = 'menu';
      gameState.pauseSnapshot = null;
    }
    return false;
  }
  if (typeof handleTouchStarted === 'function') return handleTouchStarted();
  return false;
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
function mousePressed() {
  if (!isMobile) {
    if (gameState.mode === 'menu' && !gameState.hasClickedOnce) {
      if (typeof shouldRequestFullscreen === 'function' && shouldRequestFullscreen()) {
        fullscreen(true);
      }
      gameState.hasClickedOnce = true;
      return; // Do not advance game on first click
    }

    if (gameState.mode === 'menu') {
      startGame(1);
    } else if (gameState.mode === 'mission') {
      gameState.mode = 'instructions';
    } else if (gameState.mode === 'instructions') {
      if (typeof mobileController !== 'undefined') {
        let hit = mobileController.checkSettingsHit(mouseX, mouseY);
        if (hit === 'continue') {
          gameState.mode = 'shipselect';
          return;
        }
        if (hit) return;
      }
      // On desktop, clicking anywhere else advances to ship selection
      gameState.mode = 'shipselect';
    } else if (gameState.mode === 'shipselect') {
      let vw = width / gameState.numPlayers;
      let pIdx = floor(mouseX / vw);
      if (pIdx < gameState.players.length) {
        let p = gameState.players[pIdx];
        if (!p.ready) {
          let localX = mouseX % vw;
          let arrowHit = false;

          // Side arrows (Cycle designs) - matching hudScreens.js rendering (centered around ship)
          if (mouseY > height / 2 - 60 && mouseY < height / 2 + 60) {
            const centerX = vw / 2;
            const arrowOffset = 220;
            const arrowHitWidth = 80; // slightly generous hit area

            if (localX > centerX - arrowOffset - arrowHitWidth/2 && localX < centerX - arrowOffset + arrowHitWidth/2) {
              p.designIndex = (p.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
              arrowHit = true;
            } else if (localX > centerX + arrowOffset - arrowHitWidth/2 && localX < centerX + arrowOffset + arrowHitWidth/2) {
              p.designIndex = (p.designIndex + 1) % SHIP_DESIGNS.length;
              arrowHit = true;
            }
          } 
          
          // If not an arrow, check for the "CONFIRM" button or broad click on desktop
          if (!arrowHit) {
            let isConfirmHit = (mouseY > height - 110 && localX > vw / 2 - 130 && localX < vw / 2 + 130);
            if (isConfirmHit || !gameState.isMobile) {
              p.ready = true;
            }
          }
          
          if (gameState.players.every(p => p.ready)) {
            gameState.mode = 'cockpitSelection';
          }
        }
      }
    } else if (gameState.mode === 'cockpitSelection') {
      if (typeof mobileController !== 'undefined') {
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
      return;
    } else if (gameState.mode === 'paused') {
      let mx = mouseX - width / 2;
      let my = mouseY - height / 2;
      // Resume Button (y=20 relative to center)
      if (mx > -140 && mx < 140 && my > -10 && my < 50) {
        gameState.resumeGame();
        requestPointerLock();
      }
      // Restart Button (y=120 relative to center)
      else if (mx > -140 && mx < 140 && my > 90 && my < 150) {
        gameState.mode = 'menu';
        gameState.pauseSnapshot = null;
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
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  // Clear pause snapshot on resize to avoid stretched background
  if (gameState.pauseSnapshot) {
    gameState.pauseSnapshot = null;
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

/**
 * Randomizes the number, position, and strength of mountain peaks.
 * Updates the global MOUNTAIN_PEAKS array and re-initializes terrain state.
 */
function randomizeMountainPeaks() {
  const count = floor(random(0, 11)); // 0 to 10 peaks
  const newPeaks = [];

  for (let i = 0; i < count; i++) {
    newPeaks.push({
      x: random(-4500, 4500),
      z: random(-4500, 4500),
      strength: random(300, 550),
      sigma: random(600, 1400)
    });
  }

  MOUNTAIN_PEAKS = newPeaks;
  
  if (typeof initializeMountainPeaks === 'function') {
    initializeMountainPeaks();
  }

  // Clear terrain cache so altitude changes take effect
  if (typeof terrain !== 'undefined' && terrain.reset) {
    terrain.reset();
  }

  console.log(`[Viron] Generated ${count} mountain peaks.`);
}

/**
 * Initializes the entire world state including terrain peaks and building placement.
 * Uses the provided seed for deterministic variety.
 */
function initWorld(seed) {
  const finalSeed = seed !== undefined ? seed : floor(millis() + second() * 1000 + minute() * 60000);
  randomSeed(finalSeed);
  gameState.worldSeed = finalSeed;
  
  console.log(`%c[Viron] WORLD SEED: ${finalSeed}`, 'color: #00ffcc; font-weight: bold; font-size: 1.2em;');

  // 1. Randomize Mountain Peaks
  randomizeMountainPeaks();

  // 2. Populate standard buildings (including villages)
  let numBldgs = gameState.isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    let bx = random(-4500, 4500), bz = random(-4500, 4500);
    // Avoid placing buildings directly on the launchpad
    if (isLaunchpad(bx, bz)) {
      i--; // Try again
      continue;
    }
    
    // 30% chance to spawn a village instead of a single building
    if (random() < 0.3) {
      spawnVillage(bx, bz);
      // Villages count as 3-5 buildings for density purposes
    } else {
      let bType = [0, 1, 2, 3, 5][floor(random(5))]; // Includes 3 (Powerup), excludes 4 (Sentinel)
      gameState.buildings.push({
        x: bx, z: bz,
        y: terrain.getAltitude(bx, bz),
        w: 80, h: random(120, 160), d: 80,
        type: bType,
        col: [random(100, 160), random(100, 160), random(100, 160)]
      });
    }
  }

  // 3. Place Sentinels at the new mountain peak centers
  for (let i = 0; i < MOUNTAIN_PEAKS.length; i++) {
    let peak = MOUNTAIN_PEAKS[i];
    gameState.buildings.push({
      x: peak.x, z: peak.z,
      y: terrain.getAltitude(peak.x, peak.z),
      w: 60, h: 280, d: 60,
      type: 4,
      col: [0, 220, 200],
      pulseTimer: floor(i * SENTINEL_PULSE_INTERVAL / Math.max(1, MOUNTAIN_PEAKS.length))
    });
  }

  gameState.sentinelBuildings = gameState.buildings.filter(b => b.type === 4);
}

/**
 * Spawns a cluster of Chinese buildings (one Pagoda and multiple Huts) to form a village.
 */
function spawnVillage(cx, cz) {
  // Center Pagoda
  gameState.buildings.push({
    x: cx, z: cz,
    y: terrain.getAltitude(cx, cz),
    w: 80, h: 200, d: 80,
    type: 2, // Pagoda
    col: [200, 50, 50] // Traditional Red
  });

  // Surround with huts
  let numHuts = floor(random(3, 6));
  for (let i = 0; i < numHuts; i++) {
    let angle = random(TWO_PI);
    let dist = random(120, 300);
    let hx = cx + cos(angle) * dist;
    let hz = cz + sin(angle) * dist;
    
    if (!isLaunchpad(hx, hz)) {
      gameState.buildings.push({
        x: hx, z: hz,
        y: terrain.getAltitude(hx, hz),
        w: 50, h: random(60, 75), d: 50,
        type: 5, // Small Hut
        col: [120, 100, 80]
      });
    }
  }
}
