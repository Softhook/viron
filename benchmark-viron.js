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
const puppeteer = require('puppeteer');
const fs = require('fs');

const PORT = process.env.VIRON_PORT ? Number(process.env.VIRON_PORT) : 0;
const TARGET_TILES = Number(process.env.VIRON_TILES || 1500);
const SAMPLE_FRAMES = 120;
const MAX_INF_OVERRIDE = 5000; // Prevents instant gameover during the run
const WAIT_MS = 30000;
const LOAD_TIMEOUT = Number(process.env.VIRON_LOAD_TIMEOUT || 15000);

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
  const staticMiddleware = express.static(__dirname);
  app.use((req, res, next) => {
    if (!/\.(html|js|css|ttf|wav|mp3|ogg|png)$/i.test(req.path)) {
      return res.status(404).end();
    }
    return staticMiddleware(req, res, next);
  });

  const server = app.listen(PORT, async () => {
    const actualPort = server.address().port;
    let browser;
    try {
      const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
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

      await page.evaluateOnNewDocument((sampleFrames, maxInf) => {
        window.VIRON_PROFILE = {
          enabled: true,
          label: 'viron',
          sampleFrames,
          once: true,
          maxInfOverride: maxInf, // Avoid gameover while seeded infection is high
          freezeSpread: true
        };
      }, SAMPLE_FRAMES, MAX_INF_OVERRIDE);

      await page.goto(`http://localhost:${actualPort}/index.html`, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
      await page.waitForFunction('typeof infection !== "undefined" && typeof tileKey !== "undefined"', { timeout: 8000 });

      // Seed a block of infected tiles away from the launchpad so the renderer
      // draws a dense set of overlays without triggering immediate gameover.
      const seededCount = await page.evaluate((tileCount) => {
        startGame(1);
        gameState = 'playing';

        let added = 0;
        for (let tz = -20; tz < 40 && added < tileCount; tz++) {
          for (let tx = -20; tx < 40 && added < tileCount; tx++) {
            if (tx >= 0 && tx < 7 && tz >= 0 && tz < 7) continue; // skip launchpad area
            infection.add(tileKey(tx, tz));
            // Seed a parallel block of barriers
            barrierTiles.set(tileKey(tx + 10, tz), { k: tileKey(tx + 10, tz), tx: tx + 10, tz: tz, verts: null });
            added++;
          }
        }
        // Remove sources of noise so the profile reflects infection work.
        enemyManager.enemies = [];
        enemyManager.spawners = [];
        particleSystem.clear();
        return infection.count;
      }, TARGET_TILES);

      const profStatus = await page.evaluate(() => ({
        hasProfiler: !!window.__vironProfiler,
        cfg: window.VIRON_PROFILE,
        infectionCount: infection.count,
        gameState,
        frameCount
      }));
      console.log('Profiler status:', profStatus);

      profileLine = await Promise.race([
        profilePromise,
        new Promise(resolve => setTimeout(() => resolve(null), WAIT_MS))
      ]);

      if (!profileLine) {
        let summary = await page.evaluate(() => window.__profilingSummary || null);
        if (!summary) {
          const snap = await page.evaluate(() => window.__vironProfiler ? window.__vironProfiler.snapshot() : null);
          console.log('Profiler snapshot before flush:', snap);
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

      await browser.close();
      server.close();

      if (!profileLine) {
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
