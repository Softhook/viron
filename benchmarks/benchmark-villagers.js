'use strict';

const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = process.env.VIRON_PORT ? Number(process.env.VIRON_PORT) : 0;

const BENCHMARK_CONFIGS = [
  { name: 'Villagers: Baseline', config: {} },
  { name: 'Villagers: Culling OFF', config: { disableVillagerCulling: true } },
  { name: 'Villagers: Disabled', config: { disableVillagers: true } }
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

async function runBenchmark(url, config) {
  const launchOpts = {
    headless: 'new',
    args: ['--no-sandbox']
  };
  const chromePath = findChrome();
  if (chromePath) launchOpts.executablePath = chromePath;

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();

  let drawMs = null;
  const resultPromise = new Promise((resolve) => {
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('BENCHMARK_DONE:')) {
        drawMs = Number(text.split(':')[1]);
        resolve();
      }
    });
  });

  await page.evaluateOnNewDocument((benchmarkCfg) => {
    window.BENCHMARK = {
      active: true,
      setup: true,
      ...benchmarkCfg
    };
  }, config);

  await page.goto(url, { waitUntil: 'load', timeout: 20000 });

  await Promise.race([
    resultPromise,
    new Promise((r) => setTimeout(r, 15000))
  ]);

  await browser.close();
  return drawMs;
}

async function start() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..')));

  const server = app.listen(PORT, async () => {
    const baseUrl = `http://localhost:${server.address().port}/index.html`;

    console.log('Villager Benchmark Suite');
    console.log('----------------------------------------------');
    console.log(String('Configuration').padEnd(28) + ' | Avg draw() ms');
    console.log('----------------------------------------------');

    for (const bcfg of BENCHMARK_CONFIGS) {
      try {
        const drawMs = await runBenchmark(baseUrl, bcfg.config);
        if (drawMs !== null && Number.isFinite(drawMs)) {
          console.log(String(bcfg.name).padEnd(28) + ` | ${drawMs.toFixed(2)} ms`);
        } else {
          console.log(String(bcfg.name).padEnd(28) + ' | TIMEOUT');
        }
      } catch (err) {
        console.log(String(bcfg.name).padEnd(28) + ` | ERROR (${err.message})`);
      }
    }

    console.log('----------------------------------------------');
    server.close();
    process.exit(0);
  });
}

start();
