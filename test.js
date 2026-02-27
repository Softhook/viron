'use strict';

/**
 * Smoke test – verifies the game loads and runs for several frames without
 * any WebGL errors or unhandled JavaScript exceptions.
 *
 * Usage:  node test.js
 * Exit 0 = PASS, Exit 1 = FAIL (errors found or game failed to load).
 *
 * Uses the same puppeteer + express pattern as benchmark.js so no new
 * dependencies are required.
 *
 * Chrome path resolution order:
 *   1. CHROME_PATH environment variable
 *   2. Common Linux system paths
 *   3. Puppeteer's own managed browser (fallback)
 */

const puppeteer = require('puppeteer');
const express   = require('express');
const fs        = require('fs');

// How long (ms) to let the game run before checking for errors.
// ~6 s gives >300 frames at 60 fps – enough to exercise the full
// sceneFBO → image() → soft-particle rendering pipeline many times.
const RUN_DURATION_MS = 6000;

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

async function runTest() {
    const app = express();
    app.use(express.static(__dirname));

    return new Promise((resolve) => {
        const server = app.listen(3000, async () => {
            let browser;
            const errors = [];

            try {
                const launchOpts = {
                    headless: 'new',
                    args: ['--no-sandbox']
                };
                const chromePath = findChrome();
                if (chromePath) launchOpts.executablePath = chromePath;

                browser = await puppeteer.launch(launchOpts);

                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 720 });

                // Collect WebGL errors (Chrome logs them as console warnings
                // with text like "GL_INVALID_OPERATION: …").
                page.on('console', msg => {
                    const text = msg.text();
                    if (
                        text.includes('GL_INVALID_OPERATION') ||
                        text.includes('GL_INVALID_VALUE')     ||
                        text.includes('GL_INVALID_ENUM')      ||
                        text.includes('GL_OUT_OF_MEMORY')
                    ) {
                        errors.push('[WebGL] ' + text);
                    }
                });

                // Collect unhandled JavaScript exceptions.
                page.on('pageerror', err => {
                    errors.push('[JS exception] ' + err.message);
                });

                await page.goto('http://localhost:3000/index.html', {
                    waitUntil: 'load',
                    timeout: 15000
                });

                // Let the game run for several frames.
                await new Promise(r => setTimeout(r, RUN_DURATION_MS));

            } catch (err) {
                errors.push('[test setup] ' + err.message);
            } finally {
                if (browser) await browser.close();
                server.close();
            }

            if (errors.length > 0) {
                console.error('FAIL – errors detected while the game was running:');
                errors.forEach(e => console.error('  ' + e));
                resolve(1);
            } else {
                console.log('PASS – game ran for ' + RUN_DURATION_MS + ' ms without WebGL errors or JS exceptions.');
                resolve(0);
            }
        });
    });
}

runTest().then(code => process.exit(code));
