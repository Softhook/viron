'use strict';

const puppeteer = require('puppeteer');
const express   = require('express');
const fs        = require('fs');
const path      = require('path');

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
    return undefined;
}

async function runTest() {
    const app = express();
    app.use(express.static(path.join(__dirname, '..')));

    return new Promise((resolve) => {
        const server = app.listen(3000, async () => {
            let browser;
            const errors = [];
            const consoleMessages = [];
            const violations = [];
            const vironLogs = [];

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

                page.on('console', msg => {
                    const text = msg.text();
                    consoleMessages.push(text);
                    
                    if (text.includes('[Violation]')) {
                        violations.push(text);
                    }
                    
                    if (text.includes('[Viron]')) {
                        vironLogs.push(text);
                    }
                    
                    if (
                        text.includes('GL_INVALID_OPERATION') ||
                        text.includes('GL_INVALID_VALUE')     ||
                        text.includes('GL_INVALID_ENUM')      ||
                        text.includes('GL_OUT_OF_MEMORY')
                    ) {
                        errors.push('[WebGL] ' + text);
                    }
                });

                page.on('pageerror', err => {
                    errors.push('[JS exception] ' + err.message);
                });

                await page.goto('http://localhost:3000/index.html', {
                    waitUntil: 'load',
                    timeout: 15000
                });

                await new Promise(r => setTimeout(r, RUN_DURATION_MS));

            } catch (err) {
                errors.push('[test setup] ' + err.message);
            } finally {
                if (browser) await browser.close();
                server.close();
            }

            // Report results
            console.log('\n=== TEST RESULTS ===');
            if (errors.length > 0) {
                console.error('FAIL – errors detected while the game was running:');
                errors.forEach(e => console.error('  ' + e));
                resolve(1);
            } else {
                console.log('PASS – game ran for ' + RUN_DURATION_MS + ' ms without WebGL errors or JS exceptions.');
                resolve(0);
            }
            
            console.log('\n=== VIOLATIONS DETECTED ===');
            if (violations.length > 0) {
                console.log('Found ' + violations.length + ' violation(s):');
                violations.forEach(v => console.log('  ' + v));
            } else {
                console.log('No violations detected.');
            }
            
            console.log('\n=== VIRON LOGS ===');
            if (vironLogs.length > 0) {
                console.log('Found ' + vironLogs.length + ' Viron log(s):');
                vironLogs.forEach(v => console.log('  ' + v));
            } else {
                console.log('No [Viron] logs detected.');
            }
        });
    });
}

runTest().then(code => process.exit(code));
