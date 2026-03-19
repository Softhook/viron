const { performance } = require('perf_hooks');

// Mocks
global.gameState = { 
    buildings: [],
    players: [{ dead: false, ship: { x: 0, z: 0 } }]
};
global.infection = { has: () => false, count: 1000, remove: () => {} };
global.terrain = { getAltitude: () => 10, addPulse: () => {} };
global.particleSystem = { particles: [] };
global.aboveSea = (y) => y > 0;
global.random = (a=1, b=0) => Math.random() * (b === 0 ? a : b - a) + (b === 0 ? 0 : a);
global.tileKey = (x, z) => `${x},${z}`;
global.toTile = (v) => Math.floor(v / 120);
global.TWO_PI = Math.PI * 2;
global.PI = Math.PI;
global.sin = Math.sin;
global.cos = Math.cos;
global.atan2 = Math.atan2;

// Load villagerManager code
const fs = require('fs');
const code = fs.readFileSync('./villagers.js', 'utf8');

// We need to provide the global consts
const TILE = 120;
const CULL_DIST = 5000;
const swapRemove = (arr, i) => {
    arr[i] = arr[arr.length - 1];
    arr.pop();
};

global.TILE = TILE;
global.CULL_DIST = CULL_DIST;
global.swapRemove = swapRemove;
global.fill = () => {};
global.push = () => {};
global.pop = () => {};
global.translate = () => {};
global.rotateY = () => {};
global.rotateX = () => {};
global.scale = () => {};
global.box = () => {};
global.noStroke = () => {};
global.resetShader = () => {};
global.setSceneLighting = () => {};

// Eval the code to instantiate villagerManager
eval(code + '; global.villagerManager = villagerManager;');

// Prepare mock data
const NUM_BUILDINGS = 50;
for (let i = 0; i < NUM_BUILDINGS; i++) {
    gameState.buildings.push({
        type: i % 5 === 0 ? 2 : 1, // Every 5th building is a pagoda (type 2)
        x: (Math.random() - 0.5) * 50000,
        z: (Math.random() - 0.5) * 50000
    });
}

villagerManager.clear();

const ITERATIONS = 1000;

const run = () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        // Mock global ship pos for culling if needed, though update() doesn't use it directly
        global.ship = { x: 0, z: 0 }; 
        villagerManager.update();
    }
    const end = performance.now();
    return end - start;
};

// Warmup
run();

const duration = run();
console.log(`VillagerManager update() took ${duration.toFixed(2)} ms for ${ITERATIONS} iterations with ${NUM_BUILDINGS} buildings.`);
console.log(`Average ms per frame: ${(duration / ITERATIONS).toFixed(3)} ms`);
