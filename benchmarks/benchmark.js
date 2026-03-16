const puppeteer = require('puppeteer');
const express = require('express');
const path = require('path');

const BENCHMARK_CONFIGS = [
    { name: 'Baseline (Default)', config: {} },
    { name: 'No Checkerboard', config: { disableCheckerboard: true } },
    { name: 'Simple Colors (No random patch)', config: { simpleColors: true } },
    { name: 'No Shadows', config: { disableShadows: true } },
    { name: 'No Trees', config: { disableTrees: true } },
    { name: 'No Buildings', config: { disableBuildings: true } },
    { name: 'Simple Noise (1 Octave)', config: { simpleNoise: true } },
    { name: 'Double Tile Size (240)', config: { tileSize: 240 } },
    { name: 'Near View Dist (Near 10, Far 15)', config: { viewNear: 10, viewFar: 15 } },
    {
        name: 'Minimal (No details, near view)',
        config: {
            disableCheckerboard: true, disableTrees: true, disableBuildings: true,
            disableEnemies: true, simpleColors: true, disableShadows: true, simpleNoise: true,
            viewNear: 10, viewFar: 15
        }
    }
];

async function runBenchmark(url, configName, config) {
    const browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
    const page = await browser.newPage();

    let fpsResult = null;
    const resultPromise = new Promise(resolve => {
        page.on('console', msg => {
            const text = msg.text();
            if (text.startsWith('BENCHMARK_DONE:')) {
                fpsResult = text.split(':')[1];
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

    await page.goto(url, { waitUntil: 'load' });

    await Promise.race([
        resultPromise,
        new Promise(r => setTimeout(r, 10000))
    ]);

    await browser.close();
    return fpsResult;
}

async function start() {
    const app = express();
    app.use(express.static(path.join(__dirname, '..')));
    const server = app.listen(3000, async () => {
        console.log('Starting Benchmark Suite...\n');
        console.log('----------------------------------------------------');
        console.log(String('Configuration').padEnd(40) + ' | Avg draw() ms');
        console.log('----------------------------------------------------');

        for (const bcfg of BENCHMARK_CONFIGS) {
            const drawMs = await runBenchmark('http://localhost:3000/index.html', bcfg.name, bcfg.config);
            if (drawMs) {
                console.log(String(bcfg.name).padEnd(40) + ' | ' + drawMs + ' ms');
            } else {
                console.log(String(bcfg.name).padEnd(40) + ' | TIMEOUT / ERROR');
            }
        }

        console.log('----------------------------------------------------');
        console.log('\nBenchmark Suite Finished.');
        server.close();
        process.exit(0);
    });
}

start();
