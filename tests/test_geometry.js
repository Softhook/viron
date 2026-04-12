'use strict';

/**
 * Geometry smoke test in a real browser runtime.
 *
 * Validates that p5 loads and exposes p5.Geometry without throwing in a
 * headless environment.
 */

const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = process.env.VIRON_PORT ? Number(process.env.VIRON_PORT) : 0;

async function run() {
  const app = express();
  const staticMiddleware = express.static(path.join(__dirname, '..'));

  app.use((req, res, next) => {
    if (!/\.(html|js|css|ttf|png|svg|json)$/i.test(req.path)) {
      return res.status(404).end();
    }
    return staticMiddleware(req, res, next);
  });

  const server = app.listen(PORT, async () => {
    let browser;
    try {
      const actualPort = server.address().port;
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });

      const page = await browser.newPage();
      await page.goto(`http://localhost:${actualPort}/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });

      await page.waitForFunction(
        'typeof window.p5 === "function" && typeof window.p5.Geometry === "function"',
        { timeout: 10000 }
      );

      console.log('PASS - p5.Geometry is available in browser runtime.');
      await browser.close();
      server.close();
      process.exit(0);
    } catch (err) {
      console.error('FAIL - geometry runtime check failed:', err.message);
      if (browser) await browser.close();
      server.close();
      process.exit(1);
    }
  });
}

run();
