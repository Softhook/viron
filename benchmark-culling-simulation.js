/**
 * benchmark-culling-simulation.js - Simulated Renderer Benchmark
 * Projects total frame time (CPU + simulated GPU cost)
 */
'use strict';

const { performance } = require('perf_hooks');

// --- Constants ---
const TILE = 120;
const CHUNK_SIZE = 16;
const SIM_ITERS = 5000;
const GPU_COST_PER_CHUNK_US = 250; // Simulated 250μs per chunk on mid-range GPU

// --- Mocks ---
const cam = {
    x: 0, z: 0,
    fwdX: 0, fwdZ: 1,
    fovSlope: 1.2,
    skipFrustum: false
};

const vh = 1080;
const vw = 1920;
const div = 24;
const hSize = Math.ceil(vw / div);
const horizon = new Float32Array(hSize);
const mvp = new Float32Array(16);

// Set up a basic perspective-like MVP
mvp[0] = 1; mvp[5] = 1; mvp[10] = 1; mvp[15] = 1;
mvp[1] = 0.1; // Slight downward tilt to make horizon meaningful
mvp[7] = 0.1;
mvp[3] = 0.001; // W-component for perspective

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

// Scenario: A 10x10 grid of chunks.
// Chunks at cz=1 are massive mountains.
// Chunks at cz > 1 should be occluded.
const chunks = [];
for (let cz = 0; cz < 10; cz++) {
    for (let cx = -5; cx < 5; cx++) {
        const isBigMountain = (cz === 0);
        chunks.push({
            cx, cz,
            // Mountains (front row) are tall, others are low
            geom: { minY: isBigMountain ? -500 : 50, maxY: 100 },
            dist: (cz + 0.5) * CHUNK_SIZE * TILE
        });
    }
}

function runExperiment(useCulling) {
    let cpuTotalUs = 0;
    let gpuTotalUs = 0;
    let drawCount = 0;
    
    const t0 = performance.now();
    for (let it = 0; it < SIM_ITERS; it++) {
        if (!useCulling) {
            // OLD approach
            for (const c of chunks) {
                drawCount++;
                gpuTotalUs += GPU_COST_PER_CHUNK_US;
            }
        } else {
            // NEW approach
            // 1. Sort (approx dist is already set)
            chunks.sort((a, b) => a.dist - b.dist);
            
            // 2. Culling logic
            horizon.fill(vh);
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
                    const minSY = Math.min(py1, py2, py3, py4);
                    
                    const px1 = projectX(x0, g.minY, z0);
                    const px2 = projectX(x1, g.minY, z0);
                    const px3 = projectX(x0, g.minY, z1);
                    const px4 = projectX(x1, g.minY, z1);
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
                    drawCount++;
                    gpuTotalUs += GPU_COST_PER_CHUNK_US;
                    
                    // Update horizon with chunk height
                    const hx = projectX((x0+x1)*0.5, g.minY, (z0+z1)*0.5);
                    const hy = projectY((x0+x1)*0.5, g.minY, (z0+z1)*0.5);
                    const hIdx = Math.floor(hx / div);
                    if (hIdx >= 0 && hIdx < hSize) {
                        horizon[hIdx] = Math.min(horizon[hIdx], hy);
                    }
                }
            }
        }
    }
    const elapsedMs = performance.now() - t0;
    const cpuPerFrameUs = (elapsedMs * 1000) / SIM_ITERS;
    const gpuPerFrameUs = gpuTotalUs / SIM_ITERS;
    const chunkAvg = drawCount / SIM_ITERS;

    return { cpuPerFrameUs, gpuPerFrameUs, chunkAvg };
}

console.log('\n━━━ Simulated Scene: Mountain Occlusion ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log(`Scenario: 100 visible chunks, front row is tall mountains.`);
console.log(`Simulated GPU cost: ${GPU_COST_PER_CHUNK_US}μs per chunk.\n`);

const resultsOld = runExperiment(false);
const resultsNew = runExperiment(true);

function printRes(label, res) {
    const total = res.cpuPerFrameUs + res.gpuPerFrameUs;
    console.log(`${label}:`);
    console.log(`  Chunks Rendered: ${res.chunkAvg.toFixed(1)}`);
    console.log(`  CPU (Logic):     ${res.cpuPerFrameUs.toFixed(1).padStart(6)} μs`);
    console.log(`  GPU (Simulated): ${res.gpuPerFrameUs.toFixed(1).padStart(6)} μs`);
    console.log(`  Total Time:      ${total.toFixed(1).padStart(6)} μs`);
}

printRes("OLD (No Culling)", resultsOld);
console.log('');
printRes("NEW (With Culling)", resultsNew);

const speedup = (resultsOld.cpuPerFrameUs + resultsOld.gpuPerFrameUs) / (resultsNew.cpuPerFrameUs + resultsNew.gpuPerFrameUs);
console.log(`\nOverall Frame Speedup: ${speedup.toFixed(2)}x\n`);
if (speedup > 1.0) {
    console.log(`✅ Occlusion culling saved ~${((resultsOld.cpuPerFrameUs + resultsOld.gpuPerFrameUs) - (resultsNew.cpuPerFrameUs + resultsNew.gpuPerFrameUs)).toFixed(0)}μs per frame.`);
}
