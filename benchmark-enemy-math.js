'use strict';

/**
 * Micro-benchmark for the per-frame math helpers used in enemy AI.
 * Measures mag2 / mag3 (shared DRY helpers) versus raw Math.hypot.
 *
 * Usage: node benchmark-enemy-math.js
 * Output: timing in milliseconds for a fixed iteration count.
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const ITERATIONS = 400000;
const PORT = process.env.VIRON_PORT ? Number(process.env.VIRON_PORT) : 0;

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

(async function run() {
  const app = express();
  const ALLOWED_FILES = new Set([
    '/index.html',
    '/style.css',
    '/sketch.js',
    '/sketch.min.js',
    '/constants.js',
    '/terrain.js',
    '/particles.js',
    '/enemies.js',
    '/player.js',
    '/hud.js',
    '/sfx.js',
    '/shipDesigns.js',
    '/aimAssist.js',
    '/mobileControls.js',
    '/p5.js',
    '/p5.min.js',
    '/p5.sound.min.js',
    '/Impact.ttf'
  ]);
  const staticMiddleware = express.static(__dirname, { fallthrough: false });
  app.use((req, res, next) => {
    if (!ALLOWED_FILES.has(req.path)) {
      return res.status(404).end();
    }
    return staticMiddleware(req, res, next);
  });
  const server = app.listen(PORT, '127.0.0.1', async () => {
    let browser;
    try {
      const launchOpts = {
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-default-apps',
          '--no-first-run',
          '--metrics-recording-only',
          '--safebrowsing-disable-auto-update',
          '--disable-sync',
          '--disable-translate'
        ]
      };
      const chromePath = findChrome();
      if (chromePath) launchOpts.executablePath = chromePath;
      browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.address().port}/index.html`, {
        waitUntil: 'load',
        timeout: 15000
      });

      const stats = await page.evaluate((iterations) => {
        // Ensure helpers are present
        if (typeof mag2 !== 'function' || typeof mag3 !== 'function') {
          return { error: 'mag2/mag3 not defined' };
        }
        const rand = Math.random;
        let acc = 0;

        const t1 = performance.now();
        for (let i = 0; i < iterations; i++) {
          acc += mag2(rand() * 8000 - 4000, rand() * 8000 - 4000);
        }
        const mag2Ms = performance.now() - t1;

        const t2 = performance.now();
        for (let i = 0; i < iterations; i++) {
          acc += Math.hypot(rand() * 8000 - 4000, rand() * 8000 - 4000);
        }
        const hypot2Ms = performance.now() - t2;

        const t3 = performance.now();
        for (let i = 0; i < iterations; i++) {
          acc += mag3(rand() * 8000 - 4000, rand() * -600 - 200, rand() * 8000 - 4000);
        }
        const mag3Ms = performance.now() - t3;

        const t4 = performance.now();
        for (let i = 0; i < iterations; i++) {
          acc += Math.hypot(rand() * 8000 - 4000, rand() * -600 - 200, rand() * 8000 - 4000);
        }
        const hypot3Ms = performance.now() - t4;

        return { mag2Ms, hypot2Ms, mag3Ms, hypot3Ms, acc };
      }, ITERATIONS);

      if (stats.error) {
        console.error('Benchmark failed:', stats.error);
        process.exitCode = 1;
      } else {
        console.log('━━ Enemy math micro-benchmark ━━');
        console.log(`Iterations: ${ITERATIONS}`);
        console.log(`mag2    : ${stats.mag2Ms.toFixed(2)} ms`);
        console.log(`Math.hypot (2d): ${stats.hypot2Ms.toFixed(2)} ms`);
        console.log(`mag3    : ${stats.mag3Ms.toFixed(2)} ms`);
        console.log(`Math.hypot (3d): ${stats.hypot3Ms.toFixed(2)} ms`);
      }
      await browser.close();
      server.close();
    } catch (err) {
      console.error('Benchmark failed:', err.message);
      if (browser) await browser.close();
      server.close();
      process.exit(1);
    }
  });
})();
