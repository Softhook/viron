'use strict';

// =============================================================================
// benchmark-runtime-breakdown.js
//
// End-to-end runtime benchmark that instruments major update/render functions
// inside the live game loop and compares scenario toggles to isolate where
// frame time is spent.
//
// Usage:
//   node benchmark-runtime-breakdown.js
// =============================================================================

const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');

const LOAD_TIMEOUT = Number(process.env.RUNTIME_LOAD_TIMEOUT || 15000);
const SAMPLE_MS = Number(process.env.RUNTIME_SAMPLE_MS || 7000);
const PORT = process.env.RUNTIME_PORT ? Number(process.env.RUNTIME_PORT) : 0;
const FREEZE_ADAPTIVE_SCALING = process.env.RUNTIME_FREEZE_ADAPTIVE === '1';
const STRICT_SCENARIOS = process.env.RUNTIME_STRICT === '1';
const SCENARIO_RETRIES = Number(process.env.RUNTIME_RETRIES || 1);
const SCENARIO_FILTER = process.env.RUNTIME_SCENARIOS
  ? new Set(process.env.RUNTIME_SCENARIOS.split(',').map(s => s.trim()).filter(Boolean))
  : null;

const SCENARIOS = [
  { id: 'baseline', title: 'Baseline (default game loop)' },
  { id: 'no-hud', title: 'HUD disabled' },
  { id: 'no-radar', title: 'Radar disabled' },
  { id: 'no-trees', title: 'Trees disabled' },
  { id: 'no-particles', title: 'Particles disabled' },
  { id: 'no-enemies', title: 'Enemies disabled' },
  { id: 'no-infection', title: 'Infection spread disabled' },
  { id: 'no-scenery', title: 'Trees/Buildings disabled' },
  { id: 'low-view', title: 'Reduced view distance (30/20/3500)' },
  { id: 'no-lighting', title: 'Scene lighting disabled (setSceneLighting stub)' },
  { id: 'no-shadows', title: 'Shadow polygons disabled (stencil stubs)' },
  { id: 'cockpit-mode', title: 'Cockpit Mode (First Person)' },
  { id: 'no-sound', title: 'Sound disabled (GameSFX/gameSFX stubs)' },
  { id: 'no-villagers', title: 'Villagers disabled' },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/opt/google/chrome/chrome',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..')));
  return new Promise(resolve => {
    const server = app.listen(PORT, () => resolve(server));
  });
}

async function setupPlayableState(page, scenarioId) {
  await page.waitForFunction(
    'typeof window.startGame === "function" && typeof window.gameState !== "undefined"',
    { timeout: LOAD_TIMEOUT }
  );

  await page.evaluate((id, freezeAdaptiveScaling) => {
    window.__runtimeBench = null;
    window.__runtimeBenchSetup = { state: 'pending', error: null, result: null, scenarioId: id };

    (async () => {
      try {
        const constantsMod = await import('/constants.js');
        const gameStateMod = await import('/gameState.js');
        const enemyMod = await import('/enemies.js');
        const particlesMod = await import('/particles.js');
        const gameLoopMod = await import('/gameLoop.js');
        const terrainMod = await import('/terrain.js');
        const rendererMod = await import('/gameRenderer.js');
        const villagersMod = await import('/villagers.js');
        const sfxMod = await import('/sfx.js');
        const p5ContextMod = await import('/p5Context.js');

        const gameState = gameStateMod.gameState;
        const infection = constantsMod.infection;
        const tileKey = constantsMod.tileKey;
        const setViewDistances = constantsMod.setViewDistances;
        const enemyManager = enemyMod.enemyManager;
        const particleSystem = particlesMod.particleSystem;
        const GameLoop = gameLoopMod.GameLoop;
        const terrain = terrainMod.terrain;
        const gameRenderer = rendererMod.gameRenderer;
        const villagerManager = villagersMod.villagerManager;
        const gameSFX = sfxMod.gameSFX;
        const p = p5ContextMod.p;
        const initVironProfiler = constantsMod.initVironProfiler;

        if (!gameState || !infection || !enemyManager || !particleSystem || !GameLoop || !terrain || !gameRenderer) {
          throw new Error('benchmark setup: missing required module exports');
        }

        window.startGame(1);
        for (const player of gameState.players) player.ready = true;
        gameState.mode = 'playing';
        window.startLevel(1);
        if (typeof gameState.activatePlayingMode === 'function') gameState.activatePlayingMode();
        else gameState.mode = 'playing';

        if (freezeAdaptiveScaling) {
          window._perf = {
            buf: new Float32Array(60),
            idx: 0,
            full: false,
            budgetMs: 1000 / 60,
            budgetSet: true,
            nextEval: Number.POSITIVE_INFINITY,
            cooldown: Number.POSITIVE_INFINITY,
            overBudgetEvals: 0,
            underBudgetEvals: 0,
          };
        }

        if (typeof infection.reset === 'function') infection.reset();
        if (gameState.barrierTiles && typeof gameState.barrierTiles.reset === 'function') gameState.barrierTiles.reset();
        particleSystem.clear();
        enemyManager.clear();

        let seeded = 0;
        for (let tz = -20; tz < 40 && seeded < 1400; tz++) {
          for (let tx = -20; tx < 40 && seeded < 1400; tx++) {
            if (tx >= 0 && tx < 7 && tz >= 0 && tz < 7) continue;
            infection.add(tileKey(tx, tz));
            if (gameState.barrierTiles && typeof gameState.barrierTiles.add === 'function') {
              gameState.barrierTiles.add(tileKey(tx + 8, tz));
            }
            seeded++;
          }
        }

        if (p && typeof p.randomSeed === 'function') p.randomSeed(1234);
        else if (typeof window.randomSeed === 'function') window.randomSeed(1234);
        for (let i = 0; i < 10; i++) enemyManager.spawn(false, false);

        for (let i = 0; i < 220; i++) {
          const x = 420 + (i % 22) * 35 - 350;
          const z = 420 + Math.floor(i / 22) * 30 - 150;
          const y = -180 - (i % 8) * 10;
          particleSystem.particles.push({
            x, y, z,
            vx: ((i % 7) - 3) * 0.12,
            vy: -0.2 - (i % 3) * 0.04,
            vz: ((i % 5) - 2) * 0.10,
            life: 10000,
            decay: 0,
            size: 6 + (i % 4),
            seed: (i % 100) / 100,
            isThrust: (i % 2) === 0,
            isFog: (i % 9) === 0,
            isInkBurst: false,
            color: [130 + (i % 30), 130 + (i % 30), 130 + (i % 30)]
          });
        }

        if (id === 'no-particles') {
          particleSystem.clear();
          particleSystem.updatePhysics = function () { };
          particleSystem.render = function () { };
          particleSystem.renderHardParticles = function () { };
        } else if (id === 'no-hud') {
          window.drawPlayerHUD = function () { };
        } else if (id === 'no-radar') {
          window.drawRadarForPlayer = function () { };
        } else if (id === 'no-trees') {
          terrain.drawTrees = function () { };
        } else if (id === 'no-enemies') {
          enemyManager.enemies = [];
          enemyManager.update = function () { };
          enemyManager.draw = function () { };
        } else if (id === 'no-infection') {
          if (typeof infection.reset === 'function') infection.reset();
          if (gameState.barrierTiles && typeof gameState.barrierTiles.reset === 'function') gameState.barrierTiles.reset();
          GameLoop.spreadInfection = function () { };
        } else if (id === 'no-scenery') {
          terrain.drawTrees = function () { };
          terrain.drawBuildings = function () { };
        } else if (id === 'low-view') {
          setViewDistances(20, 30, 3500);
        } else if (id === 'no-lighting') {
          gameRenderer.setSceneLighting = function () { };
        } else if (id === 'no-shadows') {
          window._beginShadowStencil = function () { };
          window._endShadowStencil = function () { };
        } else if (id === 'cockpit-mode') {
          gameState.firstPersonView = true;
        } else if (id === 'no-sound') {
          if (typeof gameSFX !== 'undefined') {
            gameSFX.updateAmbiance = function () { };
            gameSFX.updateListener = function () { };
            gameSFX.playShot = function () { };
            gameSFX.playExplosion = function () { };
            gameSFX.playInfectionSpread = function () { };
            gameSFX.playInfectionPulse = function () { };
            gameSFX.setThrust = function () { };
          }
        } else if (id === 'no-villagers') {
          if (typeof villagerManager !== 'undefined') {
            villagerManager.villagers = [];
            villagerManager.update = function () { };
            villagerManager.draw = function () { };
          }
        }

        const stats = Object.create(null);
        const counts = Object.create(null);
        let benchFrameCount = 0;
        let wrappedDrawMs = 0;
        let wrappedDrawFrames = 0;

        function record(label, dt) {
          stats[label] = (stats[label] || 0) + dt;
          counts[label] = (counts[label] || 0) + 1;
        }

        function wrapFunction(target, key, label) {
          if (!target) return;
          const original = target[key];
          if (typeof original !== 'function') return;
          target[key] = function (...args) {
            const t0 = performance.now();
            try {
              return original.apply(this, args);
            } finally {
              record(label, performance.now() - t0);
            }
          };
        }

        wrapFunction(window, 'updateShipInput', 'updateShipInput');
        wrapFunction(enemyManager, 'update', 'enemyManager.update');
        wrapFunction(GameLoop, 'checkCollisions', 'checkCollisions');
        wrapFunction(GameLoop, 'spreadInfection', 'spreadInfection');
        wrapFunction(particleSystem, 'updatePhysics', 'particleSystem.updatePhysics');
        wrapFunction(window, 'updateProjectilePhysics', 'updateProjectilePhysics');
        wrapFunction(window, 'updateBarrierPhysics', 'updateBarrierPhysics');
        if (typeof villagerManager !== 'undefined') wrapFunction(villagerManager, 'update', 'villagerManager.update');

        wrapFunction(gameRenderer, 'renderAllPlayers', 'gameRenderer.renderAllPlayers');
        wrapFunction(gameRenderer, 'renderPlayerView', 'renderPlayerView');
        wrapFunction(terrain, 'drawLandscape', 'terrain.drawLandscape');
        wrapFunction(terrain, 'drawTrees', 'terrain.drawTrees');
        wrapFunction(terrain, 'drawBuildings', 'terrain.drawBuildings');
        wrapFunction(enemyManager, 'draw', 'enemyManager.draw');
        if (typeof villagerManager !== 'undefined') wrapFunction(villagerManager, 'draw', 'villagerManager.draw');
        wrapFunction(particleSystem, 'render', 'particleSystem.render');
        wrapFunction(particleSystem, 'renderHardParticles', 'particleSystem.renderHardParticles');
        wrapFunction(gameRenderer, 'setSceneLighting', 'setSceneLighting');
        wrapFunction(window, 'renderProjectiles', 'renderProjectiles');
        wrapFunction(window, 'renderInFlightBarriers', 'renderInFlightBarriers');
        wrapFunction(window, 'drawPlayerHUD', 'drawPlayerHUD');
        wrapFunction(window, 'drawRadarForPlayer', 'drawRadarForPlayer');
        wrapFunction(window, 'shipDisplay', 'shipDisplay');

        if (typeof gameSFX !== 'undefined') {
          wrapFunction(gameSFX, 'updateAmbiance', 'gameSFX.updateAmbiance');
          wrapFunction(gameSFX, 'updateListener', 'gameSFX.updateListener');
          wrapFunction(gameSFX, 'playShot', 'gameSFX.playShot');
          wrapFunction(gameSFX, 'playExplosion', 'gameSFX.playExplosion');
          wrapFunction(gameSFX, 'playInfectionSpread', 'gameSFX.playInfectionSpread');
          wrapFunction(gameSFX, 'playInfectionPulse', 'gameSFX.playInfectionPulse');
          wrapFunction(gameSFX, 'setThrust', 'gameSFX.setThrust');
        }

        if (typeof window.draw === 'function') {
          const originalDraw = window.draw;
          window.draw = function (...args) {
            const t0 = performance.now();
            try {
              return originalDraw.apply(this, args);
            } finally {
              wrappedDrawMs += (performance.now() - t0);
              wrappedDrawFrames++;
            }
          };
        }

        if (typeof gameRenderer.renderAllPlayers === 'function') {
          const originalRenderAllPlayers = gameRenderer.renderAllPlayers;
          gameRenderer.renderAllPlayers = function (...args) {
            benchFrameCount++;
            return originalRenderAllPlayers.apply(this, args);
          };
        }

        window.VIRON_PROFILE = { enabled: true, sampleFrames: 120, label: 'bench' };
        initVironProfiler();

        window.__runtimeBench = {
          scenarioId: id,
          startedAt: performance.now(),
          startedFrame: (p && typeof p.frameCount === 'number') ? p.frameCount : 0,
          getSummary: function (forceFlush = false) {
            if (forceFlush && window.__vironProfiler && typeof window.__vironProfiler.flush === 'function') {
              try { window.__vironProfiler.flush(); } catch (_ignored) { }
            }
            const elapsed = performance.now() - this.startedAt;
            const p5Frames = (p && typeof p.frameCount === 'number') ? (p.frameCount - this.startedFrame) : 0;
            const producedFrames = Math.max(benchFrameCount, p5Frames);
            const fps = producedFrames > 0 && elapsed > 0 ? (producedFrames * 1000 / elapsed) : 0;
            const profilerSummary = window.__profilingSummary || null;
            const profilerFrameMs = profilerSummary ? Number(profilerSummary.frameMs || 0) : 0;
            const fallbackDrawMs = profilerFrameMs > 0 ? (profilerFrameMs * producedFrames) : 0;
            const effectiveDrawMs = wrappedDrawMs > 0 ? wrappedDrawMs : fallbackDrawMs;
            const effectiveDrawFrames = wrappedDrawFrames > 0 ? wrappedDrawFrames : producedFrames;
            return {
              scenarioId: this.scenarioId,
              elapsedMs: elapsed,
              producedFrames,
              fps,
              wrappedDrawMs: effectiveDrawMs,
              wrappedDrawFrames: effectiveDrawFrames,
              stats,
              counts,
              infectionTiles: infection.count,
              enemies: enemyManager.enemies.length,
              particles: particleSystem.particles.length,
              viewNear: constantsMod.VIEW_NEAR,
              viewFar: constantsMod.VIEW_FAR,
              cullDist: constantsMod.CULL_DIST,
              budgetMs: (window._perf && window._perf.budgetMs) || 0,
              profiler: profilerSummary
            };
          }
        };

        window.__runtimeBenchSetup.state = 'ready';
        window.__runtimeBenchSetup.result = {
          gameMode: gameState.mode,
          scenarioId: id,
          level: gameState.level,
          players: gameState.players.length,
          infectionTiles: infection.count,
          enemies: enemyManager.enemies.length,
        };
      } catch (err) {
        window.__runtimeBenchSetup.state = 'error';
        window.__runtimeBenchSetup.error = err && err.message ? err.message : String(err);
      }
    })();
  }, scenarioId, FREEZE_ADAPTIVE_SCALING);

  await page.waitForFunction(
    'window.__runtimeBenchSetup && (window.__runtimeBenchSetup.state === "ready" || window.__runtimeBenchSetup.state === "error")',
    { timeout: LOAD_TIMEOUT }
  );

  const setupState = await page.evaluate(() => window.__runtimeBenchSetup);
  if (!setupState || setupState.state !== 'ready') {
    throw new Error((setupState && setupState.error) || 'benchmark setup failed');
  }

  // Let the browser advance a couple of frames before timed sampling begins.
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));

  return setupState.result;
}

function formatTop(summary) {
  const drawFrames = Math.max(summary.wrappedDrawFrames, 1);
  const avgDrawMs = summary.wrappedDrawMs / drawFrames;

  const entries = Object.keys(summary.stats).map(k => {
    const total = summary.stats[k] || 0;
    const calls = summary.counts[k] || 0;
    const perFrame = total / drawFrames;
    const pct = avgDrawMs > 0 ? (perFrame / avgDrawMs * 100) : 0;
    return { k, total, calls, perFrame, pct };
  });

  entries.sort((a, b) => b.perFrame - a.perFrame);

  // Estimate overhead inside renderPlayerView not attributable to wrapped subcalls
  // (viewport/scissor/clear, camera setup, matrix ops, loop/control flow, etc.).
  const rpvTotal = (summary.stats['renderPlayerView'] || 0) / drawFrames;
  const rpvChildren = [
    'terrain.drawLandscape',
    'terrain.drawTrees',
    'terrain.drawBuildings',
    'enemyManager.draw',
    'particleSystem.render',
    'particleSystem.renderHardParticles',
    'villagerManager.draw',
    'setSceneLighting',
    'renderProjectiles',
    'renderInFlightBarriers',
    'shipDisplay',
    // drawRadarForPlayer is nested under drawPlayerHUD,
    // so only include drawPlayerHUD here to avoid double counting.
    'drawPlayerHUD'
  ];
  let rpvAttributed = 0;
  for (const k of rpvChildren) rpvAttributed += (summary.stats[k] || 0) / drawFrames;
  const rpvUnattributed = Math.max(0, rpvTotal - rpvAttributed);
  const rpvUnattributedPct = rpvTotal > 0 ? (rpvUnattributed / rpvTotal * 100) : 0;

  entries.unshift({
    k: 'renderPlayerView.unattributed',
    total: rpvUnattributed * drawFrames,
    calls: summary.counts['renderPlayerView'] || 0,
    perFrame: rpvUnattributed,
    pct: rpvUnattributedPct,
  });

  return {
    avgDrawMs,
    rpv: {
      totalPerFrame: rpvTotal,
      attributedPerFrame: rpvAttributed,
      unattributedPerFrame: rpvUnattributed,
      unattributedPct: rpvUnattributedPct,
    },
    top: entries.slice(0, 10),
  };
}

async function runScenario(url, launchOpts, scenario) {
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT);

  try {
    const IS_MOBILE = !!process.env.MOBILE;
    if (IS_MOBILE) {
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      console.log('--- Simulating Mobile Environment ---');
    } else {
      await page.setViewport({ width: 1600, height: 900 });
    }

    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });

    const setupState = await setupPlayableState(page, scenario.id);

    await new Promise(r => setTimeout(r, SAMPLE_MS));

    const summary = await page.evaluate(() => {
      return window.__runtimeBench ? window.__runtimeBench.getSummary(true) : null;
    });

    if (!summary) throw new Error('Missing runtime summary from page context');

    await browser.close();

    const formatted = formatTop(summary);
    return {
      scenario,
      setupState,
      summary,
      formatted,
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function runScenarioWithRetries(url, launchOpts, scenario) {
  let lastErr = null;
  for (let attempt = 0; attempt <= SCENARIO_RETRIES; attempt++) {
    try {
      return await runScenario(url, launchOpts, scenario);
    } catch (err) {
      lastErr = err;
      if (attempt < SCENARIO_RETRIES) {
        console.warn(`  retrying ${scenario.id} (attempt ${attempt + 2}/${SCENARIO_RETRIES + 1}) after: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

function printScenarioResult(r) {
  const s = r.summary;
  const f = r.formatted;
  console.log(`\n━━ ${r.scenario.title} ━━`);
  console.log(`  scenario id:   ${s.scenarioId}`);
  console.log(`  frames:        ${s.producedFrames} in ${s.elapsedMs.toFixed(0)} ms`);
  console.log(`  fps:           ${s.fps.toFixed(1)} (target budget: ${s.budgetMs > 0 ? (1000 / s.budgetMs).toFixed(1) : '?'})`);
  if (s.profiler) {
    console.log(`  internal prof: frame=${s.profiler.frameMs}ms, infection=${s.profiler.vironOverlayMs}ms, barrier=${s.profiler.barrierOverlayMs}ms, shader=${s.profiler.shaderMs}ms`);
  }
  console.log(`  avg draw() ms: ${f.avgDrawMs.toFixed(3)}`);
  console.log(`  renderPlayerView: ${f.rpv.totalPerFrame.toFixed(3)} ms/frame`);
  console.log(`    attributed:     ${f.rpv.attributedPerFrame.toFixed(3)} ms/frame`);
  console.log(`    unattributed:   ${f.rpv.unattributedPerFrame.toFixed(3)} ms/frame (${f.rpv.unattributedPct.toFixed(1)}% of renderPlayerView)`);
  console.log(`  entities:      enemies=${s.enemies}, infection=${s.infectionTiles}, particles=${s.particles}`);
  console.log(`  view:          VIEW_NEAR=${s.viewNear}, VIEW_FAR=${s.viewFar}, CULL_DIST=${s.cullDist}`);
  console.log('  top contributors (ms/frame, % of draw):');
  for (const row of f.top) {
    console.log(`    ${row.k.padEnd(26)} ${row.perFrame.toFixed(3).padStart(7)} ms   ${row.pct.toFixed(1).padStart(5)}%   calls=${row.calls}`);
  }
}

function printDelta(base, other) {
  const delta = other.formatted.avgDrawMs - base.formatted.avgDrawMs;
  const fpsDelta = other.summary.fps - base.summary.fps;
  const sign = delta >= 0 ? '+' : '';
  const fpsSign = fpsDelta >= 0 ? '+' : '';
  console.log(`  ${other.scenario.id.padEnd(14)} vs baseline: ${sign}${delta.toFixed(3)} ms/frame JS cost, ${fpsSign}${fpsDelta.toFixed(1)} FPS`);
}

async function main() {
  const server = await createServer();
  const port = server.address().port;
  const url = `http://localhost:${port}/index.html`;

  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox'],
    protocolTimeout: Math.max(120000, LOAD_TIMEOUT * 3)
  };
  const chromePath = findChrome();
  if (chromePath) launchOpts.executablePath = chromePath;

  const activeScenarios = SCENARIO_FILTER
    ? SCENARIOS.filter(s => SCENARIO_FILTER.has(s.id))
    : SCENARIOS;
  const results = [];
  const failures = [];
  try {
    for (const scenario of activeScenarios) {
      try {
        const result = await runScenarioWithRetries(url, launchOpts, scenario);
        results.push(result);
        printScenarioResult(result);
      } catch (err) {
        failures.push({ scenario: scenario.id, error: err.message });
        console.error(`\n━━ ${scenario.title} (FAILED) ━━`);
        console.error(`  reason: ${err.message}`);
      }
    }

    const baseline = results.find(r => r.scenario.id === 'baseline');
    if (baseline) {
      console.log('\n━━ Scenario Deltas (avg draw ms/frame) ━━');
      for (const r of results) {
        if (r === baseline) continue;
        printDelta(baseline, r);
      }
    }

    if (failures.length > 0) {
      console.log('\n━━ Scenario Failures ━━');
      for (const f of failures) {
        console.log(`  ${f.scenario}: ${f.error}`);
      }
    }

    console.log('\nRuntime breakdown benchmark complete.');
    server.close();
    if (STRICT_SCENARIOS && failures.length > 0) process.exit(1);
    process.exit(0);
  } catch (err) {
    console.error('Runtime breakdown benchmark failed:', err.message);
    server.close();
    process.exit(1);
  }
}

main();
