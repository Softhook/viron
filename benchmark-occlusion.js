/**
 * benchmark-occlusion.js - Macro-benchmark for Occlusion Culling overhead
 * Runs in Node.js: node benchmark-occlusion.js
 */
'use strict';

const { performance } = require('perf_hooks');

// --- Mocks ---
const TILE = 120;
const CHUNK_SIZE = 16;
const VIEW_FAR = 80;

function bench(label, fn, iters = 1000) {
  // Warmup
  for (let i = 0; i < 100; i++) fn();
  
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const elapsed = performance.now() - t0;
  
  const perOp = ((elapsed / iters) * 1000).toFixed(2); // microseconds
  console.log(`${label.padEnd(40)} ${elapsed.toFixed(2).padStart(8)} ms (${perOp.padStart(7)} μs/op)`);
}

// Mock chunks
const chunks = [];
for (let cz = -5; cz <= 5; cz++) {
    for (let cx = -5; cx <= 5; cx++) {
        chunks.push({
            cx, cz,
            geom: { minY: 0, maxY: 100 },
            dist: Math.sqrt(cx*cx + cz*cz) * CHUNK_SIZE * TILE
        });
    }
}

const cam = {
    x: 0, z: 0,
    fwdX: 0, fwdZ: 1,
    fovSlope: 1.5,
    skipFrustum: false
};

const mvp = new Float32Array(16).fill(0.5);
const vh = 1080;
const vw = 1920;
const div = 24;
const hSize = Math.ceil(vw / div);
const horizon = new Float32Array(hSize);

function projectY(wx, wy, wz) {
    const w = mvp[3] * wx + mvp[7] * wy + mvp[11] * wz + mvp[15];
    if (w <= 0) return -1;
    const y = mvp[1] * wx + mvp[5] * wy + mvp[9] * wz + mvp[13];
    return vh * (1.0 - (y / w * 0.5 + 0.5));
}

function projectX(wx, wy, wz) {
    const w = mvp[3] * wx + mvp[7] * wy + mvp[11] * wz + mvp[15];
    if (w <= 0) return -1;
    const x = mvp[0] * wx + mvp[4] * wy + mvp[8] * wz + mvp[12];
    return vw * (x / w * 0.5 + 0.5);
}

let drawCount = 0;
function model(g) { drawCount++; }

// --- Benchmarks ---

console.log('\n━━━ Occlusion Culling CPU Overhead ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

bench('OLD - Simple loop (no sort/no cull)', () => {
    drawCount = 0;
    for (const c of chunks) {
        model(c.geom);
    }
}, 10000);

bench('NEW - Sorting + Occlusion Logic', () => {
    drawCount = 0;
    // 2. Sort
    chunks.sort((a, b) => a.dist - b.dist);
    
    // 3. Reset horizon
    horizon.fill(vh);
    
    // 4. Loop
    for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const g = c.geom;
        const x0 = c.cx * CHUNK_SIZE * TILE;
        const x1 = x0 + CHUNK_SIZE * TILE;
        const z0 = c.cz * CHUNK_SIZE * TILE;
        const z1 = z0 + CHUNK_SIZE * TILE;

        let occluded = false;
        if (c.dist > TILE * 15) {
            const py1 = projectY(x0, g.minY, z0);
            const py2 = projectY(x1, g.minY, z0);
            const py3 = projectY(x0, g.minY, z1);
            const py4 = projectY(x1, g.minY, z1);
            
            const px1 = projectX(x0, g.minY, z0);
            const px2 = projectX(x1, g.minY, z0);
            const px3 = projectX(x0, g.minY, z1);
            const px4 = projectX(x1, g.minY, z1);

            const minSY = Math.min(py1, py2, py3, py4);
            const minSX = Math.min(px1, px2, px3, px4);
            const maxSX = Math.max(px1, px2, px3, px4);

            if (minSY > -0.5) {
                const hStart = Math.max(0, Math.floor(minSX / div));
                const hEnd = Math.min(hSize - 1, Math.floor(maxSX / div));
                
                let visible = false;
                for (let k = hStart; k <= hEnd; k++) {
                    if (minSY < horizon[k] + 4) {
                        visible = true;
                        break;
                    }
                }
                if (!visible) occluded = true;
            }
        }

        if (!occluded) {
            model(g);
            const midY = (g.minY + g.maxY) * 0.5;
            const hx = projectX((x0+x1)*0.5, midY, (z0+z1)*0.5);
            const hy = projectY((x0+x1)*0.5, midY, (z0+z1)*0.5);
            const hIdx = Math.floor(hx / div);
            if (hIdx >= 0 && hIdx < hSize) {
                horizon[hIdx] = Math.min(horizon[hIdx], hy);
            }
        }
    }
}, 10000);

console.log('\nNote: This measured the CPU overhead of the culling logic.');
console.log('The performance gain is on the GPU by reducing triangle throughput.');
console.log('If the overhead is < 100μs, it is well worth the potential ms saved on GPU.\n');
