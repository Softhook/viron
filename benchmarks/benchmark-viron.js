/**
 * Benchmark the Viron infection pipeline (spread + overlay draw) in a real
 * headless Chrome session.  Seeds a large infected field, then reads the
 * profiler summary emitted by sketch.js / terrain.js.
 *
 * Usage:  node benchmark-viron.js
 *
 * Output format (single line):
 *   VIRON_PROFILE[...] : {"frameMs":...,"spreadMsPerFrame":...,"spreadMsPerUpdate":...,
 *                         "shaderMs":...,"vironOverlayMs":...,"vironTiles":...}
 */
'use strict';

const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');

const PORT = process.env.VIRON_PORT ? Number(process.env.VIRON_PORT) : 0;
const TARGET_TILES = Number(process.env.VIRON_TILES || 1500);
const SAMPLE_FRAMES = 120;
const MAX_INF_OVERRIDE = 5000; // Prevents instant gameover during the run
const WAIT_MS = 30000;
const LOAD_TIMEOUT = Number(process.env.VIRON_LOAD_TIMEOUT || 15000);
const STRICT_BENCH = process.env.VIRON_BENCH_STRICT === '1';

function summaryFromSnapshot(snap) {
  if (!snap) return null;
  const frames = Math.max(Number(snap.frames || 0), 1);
  const spreadSteps = Number(snap.spreadSteps || 0);
  return {
    frames,
    frameMs: +(Number(snap.frame || 0) / frames).toFixed(2),
    spreadMsPerFrame: +(Number(snap.spread || 0) / frames).toFixed(3),
    spreadMsPerUpdate: spreadSteps ? +(Number(snap.spread || 0) / spreadSteps).toFixed(3) : 0,
    shaderMs: +(Number(snap.shader || 0) / frames).toFixed(3),
    vironOverlayMs: +(Number(snap.overlayInfection || 0) / frames).toFixed(3),
    vironTiles: Math.round(Number(snap.overlayInfectionTiles || 0) / frames),
    barrierOverlayMs: +(Number(snap.overlayBarrier || 0) / frames).toFixed(3),
    barrierTiles: Math.round(Number(snap.overlayBarrierTiles || 0) / frames)
  };
}

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
  return undefined; // let puppeteer use its own managed browser
}

async function run() {
  const app = express();
  const staticMiddleware = express.static(path.join(__dirname, '..'));
  app.use((req, res, next) => {
    if (!/\.(html|js|css|ttf|wav|mp3|ogg|png|svg|json)$/i.test(req.path)) {
      return res.status(404).end();
    }
    return staticMiddleware(req, res, next);
  });

  const server = app.listen(PORT, async () => {
    const actualPort = server.address().port;
    let browser;
    try {
      const launchOpts = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      };
      const chromePath = findChrome();
      if (chromePath) launchOpts.executablePath = chromePath;
      browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();

      let profileLine = null;
      let profileResolve;
      const profilePromise = new Promise(resolve => { profileResolve = resolve; });
      page.on('console', msg => {
        const text = msg.text();
        if (!text.startsWith('VIRON_PROFILE')) console.log('[browser]', text);
        if (text.startsWith('VIRON_PROFILE')) {
          profileLine = text;
          if (profileResolve) {
            profileResolve(text);
            profileResolve = null;
          }
        }
      });
      page.on('pageerror', err => console.error('[pageerror]', err.message));

      const IS_MOBILE = !!process.env.MOBILE;
      if (IS_MOBILE) {
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1');
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        console.log('--- Simulating Mobile Environment ---');
      }

      await page.evaluateOnNewDocument((sampleFrames, maxInf, forceMobile) => {
        // Mobile mode is driven by UA/viewport so gameState.detectPlatform()
        // exercises the same path used in real gameplay.
        window.VIRON_PROFILE = {
          enabled: true,
          label: 'viron',
          sampleFrames,
          once: true,
          maxInfOverride: maxInf, // Avoid gameover while seeded infection is high
          freezeSpread: true
        };
      }, SAMPLE_FRAMES, MAX_INF_OVERRIDE, IS_MOBILE);

      await page.goto(`http://localhost:${actualPort}/index.html`, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await page.bringToFront();
      await page.waitForFunction('typeof infection !== "undefined" && typeof tileKey !== "undefined"', { timeout: 8000 });

      // Seed a block of infected tiles away from the launchpad so the renderer
      // draws a dense set of overlays without triggering immediate gameover.
      const seededCount = await page.evaluate((tileCount) => {
        startGame(1);
        gameState.mode = 'playing';
        if (typeof physicsEngine !== 'undefined' && physicsEngine.setPaused) {
          physicsEngine.setPaused(false);
        }

        let added = 0;
        for (let tz = -20; tz < 40 && added < tileCount; tz++) {
          for (let tx = -20; tx < 40 && added < tileCount; tx++) {
            if (tx >= 0 && tx < 7 && tz >= 0 && tz < 7) continue; // skip launchpad area
            infection.add(tileKey(tx, tz));
            // Seed a parallel block of barriers
            gameState.barrierTiles.add(tileKey(tx + 10, tz));
            added++;
          }
        }
        // Remove sources of noise so the profile reflects infection work.
        enemyManager.enemies = [];
        enemyManager.spawners = [];
        particleSystem.clear();

        // Keep benchmark running even if browser visibility/focus events
        // pause the game loop in headless mode.
        if (!window.__vironBenchHeartbeat) {
          window.__vironBenchHeartbeat = setInterval(() => {
            if (gameState && gameState.mode === 'paused') {
              gameState.mode = 'playing';
            }
            if (typeof physicsEngine !== 'undefined' && physicsEngine.setPaused) {
              physicsEngine.setPaused(false);
            }
          }, 100);
        }
        return infection.count;
      }, TARGET_TILES);

      const profStatus = await page.evaluate(() => ({
        hasProfiler: !!window.__vironProfiler,
        cfg: window.VIRON_PROFILE,
        infectionCount: infection.count,
        gameMode: gameState.mode,
        frameCount
      }));
      console.log('Profiler status:', profStatus);

      // Some CI/headless environments keep rAF throttled and frameCount at 0.
      // If that happens, manually invoke draw() to advance enough frames for
      // profiling instead of timing out with no summary.
      if (!profStatus.frameCount) {
        const pumpResult = await page.evaluate((framesToRun) => {
          if (typeof draw !== 'function') {
            return { ok: false, reason: 'draw-not-available' };
          }
          for (let i = 0; i < framesToRun; i++) {
            if (typeof physicsEngine !== 'undefined' && physicsEngine.setPaused) {
              physicsEngine.setPaused(false);
            }
            if (gameState && gameState.mode === 'paused') {
              gameState.mode = 'playing';
            }
            try {
              if (typeof window.redraw === 'function') {
                window.redraw();
              } else {
                if (typeof window.drawingContext === 'undefined' && typeof window._renderer !== 'undefined') {
                  window.drawingContext = window._renderer.drawingContext;
                }
                draw();
              }
            } catch (e) {
              return { ok: false, reason: e && e.message ? e.message : 'draw-failed', i };
            }
          }
          return {
            ok: true,
            frameCount: typeof frameCount === 'number' ? frameCount : 0,
            gameMode: gameState ? gameState.mode : 'unknown'
          };
        }, SAMPLE_FRAMES + 10);
        console.log('Manual frame pump:', pumpResult);
      }

      profileLine = await Promise.race([
        profilePromise,
        new Promise(resolve => setTimeout(() => resolve(null), WAIT_MS))
      ]);

      if (!profileLine) {
        let summary = await page.evaluate(() => window.__profilingSummary || null);
        if (!summary) {
          const snap = await page.evaluate(() => window.__vironProfiler ? window.__vironProfiler.snapshot() : null);
          console.log('Profiler snapshot before flush:', snap);
          if (snap && Number(snap.frames || 0) > 0) {
            summary = summaryFromSnapshot(snap);
          }
          const flushed = await page.evaluate(() => {
            if (window.__vironProfiler) {
              return { flushed: window.__vironProfiler.flush(), done: window.__profilingDone || false };
            }
            return { flushed: false, done: false };
          });
          console.log('Profiler flush invoked:', flushed);
          summary = await page.evaluate(() => window.__profilingSummary || null);
        }
        if (summary) {
          profileLine = `VIRON_PROFILE[viron]:${JSON.stringify(summary)}`;
        } else {
          profileLine = await Promise.race([
            profilePromise,
            new Promise(resolve => setTimeout(() => resolve(null), 3000))
          ]);
        }
      }

      const finalRunState = await page.evaluate(() => ({
        frameCount: typeof frameCount === 'number' ? frameCount : -1,
        gameMode: (typeof gameState !== 'undefined' && gameState.mode) ? gameState.mode : 'unknown'
      }));

      await browser.close();
      server.close();

      if (!profileLine) {
        if (!STRICT_BENCH) {
          const reason = finalRunState.frameCount <= 0
            ? 'headless runtime did not advance draw frames'
            : 'profiler summary was not emitted before timeout';
          console.warn(`Benchmark skipped: ${reason} (mode=${finalRunState.gameMode}, frameCount=${finalRunState.frameCount}).`);
          process.exit(0);
        }
        console.log('Final profileLine state:', profileLine);
        console.error('Benchmark timed out before receiving profiler output.');
        process.exit(1);
      }

      const colonIdx = profileLine.indexOf(':');
      if (colonIdx === -1) {
        console.error('Unexpected profiler output:', profileLine);
        process.exit(1);
      }
      const payload = profileLine.slice(colonIdx + 1);
      let summary;
      try {
        summary = JSON.parse(payload);
      } catch (err) {
        console.error('Failed to parse profiler output:', payload);
        process.exit(1);
      }

      console.log('\n━━ Viron spread/draw profile (seeded ' + seededCount + ' tiles) ━━');
      console.log('  frameMs:          ' + summary.frameMs + ' avg');
      console.log('  spreadMs:         ' + summary.spreadMsPerFrame + ' avg (per frame)');
      console.log('  spreadMs/update:  ' + summary.spreadMsPerUpdate + ' avg (when spread runs)');
      console.log('  shaderMs:         ' + summary.shaderMs + ' avg (terrain uniforms)');
      console.log('  vironOverlayMs:   ' + summary.vironOverlayMs + ' avg for ' + summary.vironTiles + ' tiles');
      console.log('  barrierOverlayMs: ' + summary.barrierOverlayMs + ' avg for ' + summary.barrierTiles + ' tiles');
      console.log('');
      process.exit(0);
    } catch (err) {
      console.error('Benchmark failed:', err.message);
      if (browser) await browser.close();
      server.close();
      process.exit(1);
    }
  });
}

run();
