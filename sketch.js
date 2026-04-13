// =============================================================================
// sketch.js — p5 lifecycle, orchestration, and event handlers
// =============================================================================

import { initP5, p } from './p5Context.js';
import {
  WEAPON_MODES, updateTimeOfDay, currentTimeStep,
  MOBILE_VIEW_LIMITS, DESKTOP_VIEW_LIMITS,
  setViewDistances
} from './constants.js';
import { SHIP_DESIGNS } from './shipDesigns.js';
import { gameState } from './gameState.js';
import { gameRenderer } from './gameRenderer.js';
import { GameLoop } from './gameLoop.js';
import { physicsEngine } from './PhysicsEngine.js';
import { inputManager } from './InputManager.js';
import { enemyManager } from './enemies.js';
import { terrain } from './terrain.js';
import { mobileController, handleTouchStarted, shouldRequestFullscreen } from './mobileControls.js';
import { aimAssist } from './aimAssist.js';
import { particleSystem } from './particles.js';
import { villagerManager } from './villagers.js';
import { wizardManager } from './wizards.js';
import { updateShipInput } from './player.js';
import { updateProjectilePhysics, updateBarrierPhysics } from './projectiles.js';
import {
  drawMenu, drawMission, drawInstructions, drawShipSelect,
  drawGameOver, drawPauseScreen, HUD_Screens, _shipSelectHit
} from './hudScreens.js';
import { HUD_Manager } from './hudCore.js';
import { initWorld } from './worldGenerator.js';
import { getVironProfiler } from './constants.js';
import { gameSFX } from './sfx.js';

export function startGame(np) {
  physicsEngine.setPaused(false);
  physicsEngine.reset(true);
  gameState.startNewGame(np);
}

export function startLevel(lvl) {
  gameState.startLevel(lvl);
}

function _handlePauseScreenHit(mx, my) {
  const cx = mx - p.width / 2;
  const cy = my - p.height / 2;
  if (cx > -140 && cx < 140 && cy > -10 && cy < 50) return 'resume';
  if (cx > -140 && cx < 140 && cy > 90 && cy < 150) return 'restart';
  return null;
}

export function spawnYellowCrab(wx = undefined, wz = undefined) {
  if (gameState.mode !== 'playing') {
    console.warn('[spawnYellowCrab] Game not in playing mode');
    return;
  }

  const spawnX = wx !== undefined ? wx : p.random(-4000, 4000);
  const spawnZ = wz !== undefined ? wz : p.random(-4000, 4000);
  const spawnY = terrain.getAltitude(spawnX, spawnZ) - 10;

  const entry = {
    x: spawnX,
    y: spawnY,
    z: spawnZ,
    vx: p.random(-2, 2),
    vz: p.random(-2, 2),
    id: p.random(),
    type: 'yellowCrab',
    fireTimer: 0,
    bombTimer: 0
  };

  enemyManager.enemies.push(entry);
  console.log(`[spawnYellowCrab] Spawned at (${spawnX.toFixed(0)}, ${spawnY.toFixed(0)}, ${spawnZ.toFixed(0)})`);
}

// Back-compat shims for modules that still reference global helpers.
if (typeof window !== 'undefined') {
  window.startGame = startGame;
  window.startLevel = startLevel;
  window.spawnYellowCrab = spawnYellowCrab;
  window._handlePauseScreenHit = _handlePauseScreenHit;
}

inputManager.setTransitionHandlers({
  startGame,
  pauseScreenHit: _handlePauseScreenHit,
  shouldRequestFullscreen
});

const sketch = (inst) => {
  initP5(inst);

  inst.preload = function () {
    gameState.gameFont = inst.loadFont('Impact.ttf');
  };

  inst.setup = function () {
    inputManager.initialize();

    if (gameState.isMobile) {
      setViewDistances(MOBILE_VIEW_LIMITS.near, MOBILE_VIEW_LIMITS.far, MOBILE_VIEW_LIMITS.cull);
      inst.pixelDensity(1);
    } else {
      setViewDistances(DESKTOP_VIEW_LIMITS.near, DESKTOP_VIEW_LIMITS.far, DESKTOP_VIEW_LIMITS.cull);
    }

    inst.setAttributes({ stencil: true });
    inst.createCanvas(inst.windowWidth, inst.windowHeight, inst.WEBGL);

    gameRenderer.sceneFBO = null;
    gameRenderer.initialize(gameState.isMobile);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) gameState.pauseGame();
    });
    window.addEventListener('blur', () => {
      gameState.pauseGame();
    });

    terrain.init();
    inst.textFont(gameState.gameFont);

    // Initialize audio system after p5.sound is loaded
    gameSFX.init();

    if (aimAssist) {
      aimAssist.enabled = gameState.isMobile;
    }

    gameState.worldSeed = inst.floor(inst.random(1, 1000000));
    initWorld(gameState.worldSeed, gameState);

    gameState.mode = 'menu';
    if (window.BENCHMARK && typeof window.BENCHMARK === 'object' && window.BENCHMARK.setup) {
      startGame(1);
      gameState.activatePlayingMode();
    }
  };

  inst.draw = function () {
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

    if (window.BENCHMARK && typeof window.BENCHMARK === 'object' && window.BENCHMARK.active) {
      if (!window.BENCHMARK.frames) window.BENCHMARK.frames = 0;
      if (!window.BENCHMARK.startTime) window.BENCHMARK.startTime = performance.now();
      window.BENCHMARK.frames++;
      if (window.BENCHMARK.frames === 120) {
        const totalTime = performance.now() - window.BENCHMARK.startTime;
        const avgMs = totalTime / 120;
        console.log('BENCHMARK_DONE:' + avgMs.toFixed(2));
        window.BENCHMARK.active = false;
      }
    }

    const profiler = getVironProfiler();
    const frameStart = profiler ? performance.now() : 0;

    const inputStart = profiler ? performance.now() : 0;
    inputManager.update();
    if (profiler) profiler.record('input', performance.now() - inputStart);

    const perfScaleStart = profiler ? performance.now() : 0;
    gameRenderer.updatePerformanceScaling();
    if (profiler) profiler.record('perfScale', performance.now() - perfScaleStart);

    const cacheStart = profiler ? performance.now() : 0;
    terrain.clearCaches();
    if (profiler) profiler.record('cacheGc', performance.now() - cacheStart);

    physicsEngine.update(inst.deltaTime, () => {
      for (const player of gameState.players) updateShipInput(player);
      enemyManager.update();
      villagerManager?.update();
      wizardManager?.update();
      for (const player of gameState.players) GameLoop.checkCollisions(player);
      GameLoop.spreadInfection();
      particleSystem.updatePhysics();
      for (const player of gameState.players) updateProjectilePhysics(player);
      updateBarrierPhysics();
      GameLoop.updateLevelAndRespawn();
    });

    const sentinelStart = profiler ? performance.now() : 0;
    gameRenderer.updateSentinelGlows();
    if (profiler) profiler.record('sentinel', performance.now() - sentinelStart);

    const ambianceStart = profiler ? performance.now() : 0;
    GameLoop.updateAmbianceAudio();
    if (profiler) profiler.record('ambiance', performance.now() - ambianceStart);
    gameRenderer.renderAllPlayers(inst.drawingContext);

    if (gameState.shouldCapture) {
      gameState.pauseSnapshot = inst.get();
      gameState.shouldCapture = false;
    }

    if (gameState.mode === 'paused') {
      drawPauseScreen();
    }

    if (profiler) profiler.frameEnd(performance.now() - frameStart);
  };

  inst.keyPressed = function (event) {
    if (inputManager.handleTransition('key', event)) return;

    if (gameState.mode === 'paused') return;

    if (gameState.mode === 'shipselect') {
      for (const player of gameState.players) {
        if (player.id === 0) {
          const left =
            gameState.numPlayers === 1
              ? (inst.keyCode === inst.LEFT_ARROW || inst.keyCode === 65)
              : inst.keyCode === 65;
          const right =
            gameState.numPlayers === 1
              ? (inst.keyCode === inst.RIGHT_ARROW || inst.keyCode === 68)
              : inst.keyCode === 68;
          if (left) player.designIndex = (player.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
          if (right) player.designIndex = (player.designIndex + 1) % SHIP_DESIGNS.length;
          if (inst.keyCode === inst.ENTER || inst.keyCode === 81) player.ready = true;
        } else {
          if (inst.keyCode === inst.LEFT_ARROW) {
            player.designIndex = (player.designIndex - 1 + SHIP_DESIGNS.length) % SHIP_DESIGNS.length;
          }
          if (inst.keyCode === inst.RIGHT_ARROW) {
            player.designIndex = (player.designIndex + 1) % SHIP_DESIGNS.length;
          }
          if (inst.keyCode === 190) player.ready = true;
        }
      }

      if (gameState.players.every((player) => player.ready)) {
        gameState.mode = 'cockpitSelection';
      }
      return;
    }

    for (const player of gameState.players) {
      if (inst.keyCode === player.keys.weaponCycle) {
        player.weaponMode = (player.weaponMode + 1) % WEAPON_MODES.length;
      }
    }

    if (inst.key === 'p' || inst.key === 'P') {
      aimAssist.enabled = !aimAssist.enabled;
      aimAssist.debug = aimAssist.enabled;
    }

    if (inst.key === 'o' || inst.key === 'O') {
      gameState.firstPersonView = !gameState.firstPersonView;
    }

    if (inst.key === 'l' || inst.key === 'L') {
      for (const player of gameState.players) {
        player.designIndex = (player.designIndex + 1) % SHIP_DESIGNS.length;
      }
    }

    if (inst.key === 'n' || inst.key === 'N') {
      updateTimeOfDay(currentTimeStep - 1);
    }
    if (inst.key === 'm' || inst.key === 'M') {
      updateTimeOfDay(currentTimeStep + 1);
      if (gameState.mode === 'playing') {
        startLevel(gameState.level + 1);
      }
    }
  };

  inst.touchStarted = function (event) {
    if (event.target.tagName !== 'CANVAS') return true;
    if (inputManager.handleTransition('touch', event)) return false;

    if (gameState.mode === 'shipselect') {
      _shipSelectHit(inst.mouseX, inst.mouseY, true);
      return false;
    }
    if (gameState.mode === 'cockpitSelection') {
      if (mobileController) {
        const hit = mobileController.checkSettingsHit(inst.mouseX, inst.mouseY);
        if (hit === 'continue') {
          gameState.activatePlayingMode();
        }
      }
      return false;
    }
    return handleTouchStarted?.(event) ?? false;
  };

  inst.touchEnded = function (event) {
    if (event.target.tagName !== 'CANVAS') return true;
    return false;
  };

  inst.touchMoved = function (event) {
    if (event.target.tagName !== 'CANVAS') return true;
    return false;
  };

  inst.mousePressed = function (event) {
    if (inputManager.handleTransition('mouse', event)) return;

    if (gameState.mode === 'shipselect') {
      _shipSelectHit(inst.mouseX, inst.mouseY, false);
    } else if (gameState.mode === 'cockpitSelection') {
      if (mobileController) {
        const hit = mobileController.checkSettingsHit(inst.mouseX, inst.mouseY);
        if (hit === 'continue') {
          gameState.activatePlayingMode();
          return;
        }
        if (hit) return;
      }
      if (!gameState.isMobile) {
        gameState.activatePlayingMode();
      }
    }
  };

  inst.windowResized = function () {
    inst.resizeCanvas(inst.windowWidth, inst.windowHeight);
    if (gameState.pauseSnapshot) {
      gameState.pauseSnapshot = null;
    }
  };
};

new window.p5(sketch);

