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
const puppeteer = require('puppeteer');
const fs = require('fs');

const LOAD_TIMEOUT = Number(process.env.RUNTIME_LOAD_TIMEOUT || 15000);
const SAMPLE_MS = Number(process.env.RUNTIME_SAMPLE_MS || 7000);
const PORT = process.env.RUNTIME_PORT ? Number(process.env.RUNTIME_PORT) : 0;

const SCENARIOS = [
  { id: 'baseline', title: 'Baseline (default game loop)' },
  { id: 'no-particles', title: 'Particles disabled' },
  { id: 'no-enemies', title: 'Enemies disabled' },
  { id: 'no-infection', title: 'Infection spread disabled' },
  { id: 'no-scenery', title: 'Trees/Buildings disabled' },
  { id: 'low-view', title: 'Reduced view distance (30/20/3500)' },
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
  app.use(express.static(__dirname));
  return new Promise(resolve => {
    const server = app.listen(PORT, () => resolve(server));
  });
}

async function setupPlayableState(page, scenarioId) {
  await page.waitForFunction(
    'typeof startGame === "function" && typeof players !== "undefined" && typeof draw !== "undefined"',
    { timeout: 10000 }
  );

  const res = await page.evaluate((id) => {
    // Start game and force immediate entry into gameplay state.
    startGame(1);
    for (const p of players) p.ready = true;
    gameState = 'playing';
    startLevel(1);

    // Lock adaptive quality scaling so scenario deltas remain comparable.
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

    // Build a deterministic, representative workload so each scenario starts
    // from the same state and deltas are meaningful.
    infection.reset();
    barrierTiles.clear();
    particleSystem.clear();
    enemyManager.clear();

    // Seed infection/barrier tiles in a fixed square away from launchpad.
    let seeded = 0;
    for (let tz = -20; tz < 40 && seeded < 1400; tz++) {
      for (let tx = -20; tx < 40 && seeded < 1400; tx++) {
        if (tx >= 0 && tx < 7 && tz >= 0 && tz < 7) continue;
        infection.add(tileKey(tx, tz));
        barrierTiles.add(tileKey(tx + 8, tz));
        seeded++;
      }
    }

    // Deterministic enemy wave.
    randomSeed(1234);
    for (let i = 0; i < 10; i++) enemyManager.spawn(false, false);

    // Deterministic particle load: mixed thrust/fog-like particles.
    for (let i = 0; i < 220; i++) {
      const x = 420 + (i % 22) * 35 - 350;
      const z = 420 + Math.floor(i / 22) * 30 - 150;
      const y = -180 - (i % 8) * 10;
      particleSystem.particles.push({
        x, y, z,
        vx: ((i % 7) - 3) * 0.12,
        vy: -0.2 - (i % 3) * 0.04,
        vz: ((i % 5) - 2) * 0.10,
        life: 140 + (i % 80),
        decay: 1.8 + (i % 5) * 0.25,
        size: 6 + (i % 4),
        seed: (i % 100) / 100,
        isThrust: (i % 2) === 0,
        isFog: (i % 9) === 0,
        isInkBurst: false,
        color: [130 + (i % 30), 130 + (i % 30), 130 + (i % 30)]
      });
    }

    // Apply scenario toggles.
    if (id === 'no-particles') {
      particleSystem.clear();
      particleSystem.updatePhysics = function () {};
      particleSystem.render = function () {};
      particleSystem.renderHardParticles = function () {};
    } else if (id === 'no-enemies') {
      enemyManager.enemies = [];
      enemyManager.update = function () {};
      enemyManager.draw = function () {};
    } else if (id === 'no-infection') {
      infection.reset();
      barrierTiles.clear();
      spreadInfection = function () {};
    } else if (id === 'no-scenery') {
      terrain.drawTrees = function () {};
      terrain.drawBuildings = function () {};
    } else if (id === 'low-view') {
      VIEW_NEAR = 20;
      VIEW_FAR = 30;
      CULL_DIST = 3500;
    }

    // Function-level instrumentation.
    const stats = Object.create(null);
    const counts = Object.create(null);
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

    // Update-phase wrappers.
    wrapFunction(window, 'updateShipInput', 'updateShipInput');
    wrapFunction(enemyManager, 'update', 'enemyManager.update');
    wrapFunction(window, 'checkCollisions', 'checkCollisions');
    wrapFunction(window, 'spreadInfection', 'spreadInfection');
    wrapFunction(particleSystem, 'updatePhysics', 'particleSystem.updatePhysics');
    wrapFunction(window, 'updateProjectilePhysics', 'updateProjectilePhysics');
    wrapFunction(window, 'updateBarrierPhysics', 'updateBarrierPhysics');

    // Render-phase wrappers.
    wrapFunction(window, 'renderPlayerView', 'renderPlayerView');
    wrapFunction(terrain, 'drawLandscape', 'terrain.drawLandscape');
    wrapFunction(terrain, 'drawTrees', 'terrain.drawTrees');
    wrapFunction(terrain, 'drawBuildings', 'terrain.drawBuildings');
    wrapFunction(enemyManager, 'draw', 'enemyManager.draw');
    wrapFunction(particleSystem, 'render', 'particleSystem.render');
    wrapFunction(window, 'renderProjectiles', 'renderProjectiles');
    wrapFunction(window, 'renderInFlightBarriers', 'renderInFlightBarriers');
    wrapFunction(window, 'shipDisplay', 'shipDisplay');

    // Wrap draw itself to estimate total JS frame cost attributable to draw().
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

    window.__runtimeBench = {
      scenarioId: id,
      startedAt: performance.now(),
      startedFrame: frameCount,
      getSummary: function () {
        const elapsed = performance.now() - this.startedAt;
        const producedFrames = frameCount - this.startedFrame;
        const fps = producedFrames > 0 && elapsed > 0 ? (producedFrames * 1000 / elapsed) : 0;
        return {
          scenarioId: this.scenarioId,
          elapsedMs: elapsed,
          producedFrames,
          fps,
          wrappedDrawMs,
          wrappedDrawFrames,
          stats,
          counts,
          infectionTiles: infection.count,
          enemies: enemyManager.enemies.length,
          particles: particleSystem.particles.length,
          viewNear: VIEW_NEAR,
          viewFar: VIEW_FAR,
          cullDist: CULL_DIST,
        };
      }
    };

    return {
      gameState,
      scenarioId: id,
      level,
      players: players.length,
      infectionTiles: infection.count,
      enemies: enemyManager.enemies.length,
    };
  }, scenarioId);

  return res;
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
  return {
    avgDrawMs,
    top: entries.slice(0, 10),
  };
}

async function runScenario(url, launchOpts, scenario) {
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  page.setDefaultTimeout(LOAD_TIMEOUT);

  try {
    await page.setViewport({ width: 1600, height: 900 });
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT });

    const setupState = await setupPlayableState(page, scenario.id);

    await new Promise(r => setTimeout(r, SAMPLE_MS));

    const summary = await page.evaluate(() => {
      return window.__runtimeBench ? window.__runtimeBench.getSummary() : null;
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

function printScenarioResult(r) {
  const s = r.summary;
  const f = r.formatted;
  console.log(`\n━━ ${r.scenario.title} ━━`);
  console.log(`  scenario id:   ${s.scenarioId}`);
  console.log(`  frames:        ${s.producedFrames} in ${s.elapsedMs.toFixed(0)} ms`);
  console.log(`  fps:           ${s.fps.toFixed(1)}`);
  console.log(`  avg draw() ms: ${f.avgDrawMs.toFixed(3)}`);
  console.log(`  entities:      enemies=${s.enemies}, infection=${s.infectionTiles}, particles=${s.particles}`);
  console.log(`  view:          VIEW_NEAR=${s.viewNear}, VIEW_FAR=${s.viewFar}, CULL_DIST=${s.cullDist}`);
  console.log('  top contributors (ms/frame, % of draw):');
  for (const row of f.top) {
    console.log(`    ${row.k.padEnd(26)} ${row.perFrame.toFixed(3).padStart(7)} ms   ${row.pct.toFixed(1).padStart(5)}%   calls=${row.calls}`);
  }
}

function printDelta(base, other) {
  const delta = other.formatted.avgDrawMs - base.formatted.avgDrawMs;
  const sign = delta >= 0 ? '+' : '';
  console.log(`  ${other.scenario.id.padEnd(14)} vs baseline: ${sign}${delta.toFixed(3)} ms/frame`);
}

async function main() {
  const server = await createServer();
  const port = server.address().port;
  const url = `http://localhost:${port}/index.html`;

  const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
  const chromePath = findChrome();
  if (chromePath) launchOpts.executablePath = chromePath;

  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(url, launchOpts, scenario);
      results.push(result);
      printScenarioResult(result);
    }

    const baseline = results.find(r => r.scenario.id === 'baseline');
    if (baseline) {
      console.log('\n━━ Scenario Deltas (avg draw ms/frame) ━━');
      for (const r of results) {
        if (r === baseline) continue;
        printDelta(baseline, r);
      }
    }

    console.log('\nRuntime breakdown benchmark complete.');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Runtime breakdown benchmark failed:', err.message);
    server.close();
    process.exit(1);
  }
}

main();
