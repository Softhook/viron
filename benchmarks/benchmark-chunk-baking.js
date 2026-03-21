'use strict';
const { performance } = require('perf_hooks');

function bench(label, fn, iters = 1000) {
  const warmup = Math.min(Math.floor(iters / 10), 100);
  for (let i = 0; i < warmup; i++) fn(i);

  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  const elapsed = performance.now() - t0;

  const perOp = ((elapsed / iters) * 1000).toFixed(2); // microseconds
  process.stdout.write(
    `  ${label.padEnd(52)} ${String(elapsed.toFixed(1)).padStart(6)} ms  (${perOp} us/op)\n`
  );
  return elapsed;
}

const VIEW_FAR = 40;
const CHUNK_SIZE = 16;
const TILE = 120;
const chunkHalf = CHUNK_SIZE * TILE;

let gx = 0, gz = 0;
let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

const treesByChunk = new Map();
let numTreesTotal = 0;
for (let cz = minCz - 2; cz <= maxCz + 2; cz++) {
  for (let cx = minCx - 2; cx <= maxCx + 2; cx++) {
    const trees = [];
    const numTrees = Math.floor(10 + Math.random() * 20); // 10-30 trees per chunk
    for (let i = 0; i < numTrees; i++) {
        trees.push({
            x: (cx + Math.random()) * CHUNK_SIZE * TILE,
            y: -10,
            z: (cz + Math.random()) * CHUNK_SIZE * TILE,
            variant: 1, canopyScale: 1, trunkH: 20
        });
        numTreesTotal++;
    }
    treesByChunk.set(`${cx},${cz}`, trees);
  }
}

let _sink = 0;
function isChunkVisible(cx, cz) { return true; } 
function p5model(g) { _sink += g; }

const DRAW_CALL_OVERHEAD_US = 50; 
const GEOM_BUILD_US_PER_TREE = 150; 

console.log(`\n━━━ Benchmark: Chunk Baking vs Naive Iteration (Trees) ━━━`);
console.log(`Region: ${(maxCx - minCx + 1)}x${(maxCz - minCz + 1)} chunks (${(maxCx - minCx + 1) * (maxCz - minCz + 1)} total), ~${numTreesTotal} items.\n`);

const treeChunkMeshCache = new Map();

bench('NAIVE - Loop + multiple draw calls per chunk', () => {
    let frameDrawCalls = 0;
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!isChunkVisible(cx, cz)) continue;
        const trees = treesByChunk.get(`${cx},${cz}`) || [];
        for (let i = 0; i < trees.length; i++) {
            frameDrawCalls++;
        }
      }
    }
    const end = performance.now() + (frameDrawCalls * DRAW_CALL_OVERHEAD_US / 1000);
    while (performance.now() < end) {}
}, 500);

for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
        treeChunkMeshCache.set(`${cx},${cz}`, 1); 
    }
}

bench('BAKED (Cache Hit) - 1 draw call per chunk', () => {
    let frameDrawCalls = 0;
    for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            if (!isChunkVisible(cx, cz)) continue;
            const mesh = treeChunkMeshCache.get(`${cx},${cz}`);
            if (mesh) {
                frameDrawCalls++;
            }
        }
    }
    const end = performance.now() + (frameDrawCalls * DRAW_CALL_OVERHEAD_US / 1000);
    while (performance.now() < end) {}
}, 500);

treeChunkMeshCache.clear();

bench('BAKING (Cache Miss) - Rebuild chunks into single mesh', () => {
    let buildTimeUs = 0;
    for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            if (!isChunkVisible(cx, cz)) continue;
            
            if (!treeChunkMeshCache.has(`${cx},${cz}`)) {
                const trees = treesByChunk.get(`${cx},${cz}`) || [];
                buildTimeUs += trees.length * GEOM_BUILD_US_PER_TREE;
                treeChunkMeshCache.set(`${cx},${cz}`, 1);
            }
        }
    }
    const end = performance.now() + (buildTimeUs / 1000);
    while(performance.now() < end) {}
}, 5);
