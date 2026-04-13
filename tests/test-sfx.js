'use strict';

/**
 * ES-module-safe tests for GameSFX.
 *
 * Validates:
 * 1) Runtime behavior in an actual browser module context (no eval).
 * 2) Static source constraints via regex checks.
 *
 * Usage: node tests/test-sfx.js
 */

const puppeteer = require('puppeteer');
const express = require('express');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (e) {
    console.error(`  FAIL  threw unexpectedly: ${e.message}`);
    failed++;
  }
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
  return undefined;
}

async function runBrowserRuntimeChecks() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..')));

  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      let browser;
      try {
        const launchOpts = {
          headless: 'new',
          args: ['--no-sandbox']
        };
        const chromePath = findChrome();
        if (chromePath) launchOpts.executablePath = chromePath;

        browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        const port = server.address().port;

        await page.goto(`http://localhost:${port}/index.html`, {
          waitUntil: 'load',
          timeout: 20000
        });

        // Give setup() enough time to initialize p5 and game modules.
        await new Promise((r) => setTimeout(r, 1200));

        const runtime = await page.evaluate(async () => {
          const { gameSFX } = await import('/sfx.js');

          const result = {
            initialized: false,
            hasCtx: false,
            masterIsGain: false,
            noCompressorMaster: true,
            calls: {},
            repeatSafe: true,
            error: null
          };

          try {
            gameSFX.init();
            result.initialized = !!gameSFX.initialized;
            result.hasCtx = !!gameSFX.ctx;
            result.masterIsGain = !!(gameSFX.master && typeof gameSFX.master.gain !== 'undefined');
            result.noCompressorMaster = !(gameSFX.master && typeof gameSFX.master.threshold !== 'undefined');

            const calls = [
              ['playShot', () => gameSFX.playShot(0, 0, 0)],
              ['playEnemyShot-fighter', () => gameSFX.playEnemyShot('fighter', 0, 0, 0)],
              ['playEnemyShot-crab', () => gameSFX.playEnemyShot('crab', 0, 0, 0)],
              ['playExplosion-small', () => gameSFX.playExplosion(0, 0, 0, false, '')],
              ['playExplosion-large', () => gameSFX.playExplosion(0, 0, 0, true, 'bomber')],
              ['playMissileFire', () => gameSFX.playMissileFire(0, 0, 0)],
              ['playBombDrop-normal', () => gameSFX.playBombDrop('normal', 0, 0, 0)],
              ['playBombDrop-mega', () => gameSFX.playBombDrop('mega', 0, 0, 0)],
              ['playInfectionPulse', () => gameSFX.playInfectionPulse(0, 0, 0)],
              ['playInfectionSpread', () => gameSFX.playInfectionSpread(0, 0, 0)],
              ['playPowerup-good', () => gameSFX.playPowerup(true, 0, 0, 0)],
              ['playPowerup-bad', () => gameSFX.playPowerup(false, 0, 0, 0)],
              ['playClearInfection', () => gameSFX.playClearInfection(0, 0, 0)],
              ['playNewLevel', () => gameSFX.playNewLevel()],
              ['playLevelComplete', () => gameSFX.playLevelComplete()],
              ['playGameOver', () => gameSFX.playGameOver()],
              ['playAlarm', () => gameSFX.playAlarm()],
              ['playVillagerCure', () => gameSFX.playVillagerCure(0, 0, 0)],
              ['playVillagerDeath', () => gameSFX.playVillagerDeath(0, 0, 0)],
              ['updateAmbiance', () => gameSFX.updateAmbiance({ dist: 500, pulseOverlap: 0.5, scanSweepAlpha: 0.4 }, 3, 10)],
              ['updateListener', () => gameSFX.updateListener(0, 0, 0, 0, 0, -1, 0, 1, 0)],
              ['setThrust-cycle', () => { gameSFX.setThrust(0, true, 10, 50, 0); gameSFX.setThrust(0, false, 10, 50, 0); }],
              ['stopAll', () => gameSFX.stopAll()]
            ];

            for (const [name, fn] of calls) {
              try {
                fn();
                result.calls[name] = true;
              } catch (e) {
                result.calls[name] = `ERROR: ${e.message}`;
              }
            }

            try {
              for (let i = 0; i < 100; i++) {
                gameSFX.updateAmbiance(
                  { dist: 300 + i, pulseOverlap: (i % 10) / 10, scanSweepAlpha: (10 - (i % 10)) / 10 },
                  i % 6,
                  10
                );
              }
              gameSFX.stopAll();
              gameSFX.stopAll();
            } catch (e) {
              result.repeatSafe = false;
            }
          } catch (e) {
            result.error = e.message;
          }

          return result;
        });

        resolve(runtime);
      } catch (e) {
        resolve({ error: e.message, calls: {} });
      } finally {
        if (browser) await browser.close();
        server.close();
      }
    });
  });
}

(async function main() {
  const sfxPath = path.join(__dirname, '..', 'sfx.js');
  const ambientPath = path.join(__dirname, '..', 'sfxAmbient.js');
  const weaponsPath = path.join(__dirname, '..', 'sfxWeapons.js');
  const enemiesPath = path.join(__dirname, '..', 'sfxEnemies.js');
  const tunesPath = path.join(__dirname, '..', 'sfxTunes.js');

  const sfxSrc = fs.readFileSync(sfxPath, 'utf8');
  const ambientSrc = fs.readFileSync(ambientPath, 'utf8');
  const weaponsSrc = fs.readFileSync(weaponsPath, 'utf8');
  const enemiesSrc = fs.readFileSync(enemiesPath, 'utf8');
  const tunesSrc = fs.readFileSync(tunesPath, 'utf8');
  const sfxAllSrc = [sfxSrc, ambientSrc, weaponsSrc, enemiesSrc, tunesSrc].join('\n');

  console.log('\nRuntime Checks (Browser ESM Context)');
  const runtime = await runBrowserRuntimeChecks();

  test('GameSFX runtime initializes', () => {
    assert(!runtime.error, `browser runtime has no fatal error (${runtime.error || 'ok'})`);
    assert(runtime.initialized === true, 'gameSFX.initialized is true');
    assert(runtime.hasCtx === true, 'gameSFX.ctx exists');
    assert(runtime.masterIsGain === true, 'master node has gain param (GainNode-like)');
    assert(runtime.noCompressorMaster === true, 'master is not a compressor node');
  });

  test('All public SFX calls execute without exceptions', () => {
    for (const [name, value] of Object.entries(runtime.calls || {})) {
      assert(value === true, `${name} executes without exception`);
    }
  });

  test('High-frequency ambience updates and stopAll are stable', () => {
    assert(runtime.repeatSafe === true, '100 rapid updateAmbiance calls + stopAll twice stay stable');
  });

  console.log('\nStatic Source Checks');

  test('No eval-based ESM stripping remains in this test', () => {
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    assert(!/stripEsmSyntax\(/.test(selfSrc), 'stripEsmSyntax is not used');
    assert(!/eval\(/.test(selfSrc), 'eval is not used');
  });

  test('RefDistance still covers follow camera distance', () => {
    const match = sfxAllSrc.match(/panner\.refDistance\s*=\s*(\d+)/);
    assert(match !== null, 'panner.refDistance assignment found');
    if (match) {
      const rd = Number(match[1]);
      assert(rd >= 520, `refDistance ${rd} >= 520`);
    }
  });

  test('Distortion curves expected amounts remain present', () => {
    assert(/createDistortionCurve\(400\)/.test(sfxSrc), 'main distortion amount 400 present');
    assert(/createDistortionCurve\(60\)/.test(sfxSrc), 'game-over distortion amount 60 present');
  });

  test('SFX module wiring remains explicit ESM imports', () => {
    assert(/import\s+\{\s*SfxAmbient\s*\}\s+from\s+'\.\/sfxAmbient\.js'/.test(sfxSrc), 'imports SfxAmbient');
    assert(/import\s+\{\s*SfxWeapons\s*\}\s+from\s+'\.\/sfxWeapons\.js'/.test(sfxSrc), 'imports SfxWeapons');
    assert(/import\s+\{\s*SfxEnemies\s*\}\s+from\s+'\.\/sfxEnemies\.js'/.test(sfxSrc), 'imports SfxEnemies');
  });

  console.log(`\n${'-'.repeat(60)}`);
  if (failed === 0) {
    console.log(`PASS - all ${passed} assertion(s) passed.`);
    process.exit(0);
  }

  console.error(`FAIL - ${failed} assertion(s) failed, ${passed} passed.`);
  process.exit(1);
})();
