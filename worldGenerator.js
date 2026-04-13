// =============================================================================
// worldGenerator.js — Procedural generation of terrain, buildings, and peaks
//
// @exports   initWorld()           — full world reset + generation (called by
//                                    gameState.startNewGame and sketch.js setup)
// @exports   randomizeMountainPeaks() — procedural peak randomisation
// =============================================================================

import {
  MOUNTAIN_PEAKS, setMountainPeaks, SENTINEL_PULSE_INTERVAL,
  TILE, tileKey, toTile, isLaunchpad
} from './constants.js';
import { terrain } from './terrain.js';
import { p } from './p5Context.js';

/**
 * Randomizes the number, position, and strength of mountain peaks.
 * Updates the global MOUNTAIN_PEAKS array and re-initializes terrain state.
 */
export function randomizeMountainPeaks() {
  const count = Math.floor(p.random(0, 11)); // 0 to 10 peaks
  const newPeaks = [];

  for (let i = 0; i < count; i++) {
    newPeaks.push({
      x: p.random(-4500, 4500),
      z: p.random(-4500, 4500),
      strength: p.random(300, 550),
      sigma: p.random(600, 1400)
    });
  }

  setMountainPeaks(newPeaks);

  // Clear terrain cache so altitude changes take effect
  if (terrain?.reset) {
    terrain.reset();
  }

  console.log(`[Viron] Generated ${count} mountain peaks.`);
}

/**
 * Initializes the entire world state including terrain peaks and building placement.
 * Uses the provided seed for deterministic variety.
 */
export function initWorld(seed, state) {
  if (!state) return;
  const finalSeed = seed !== undefined ? seed : Math.floor(performance.now());
  p.randomSeed(finalSeed);
  p.noiseSeed(finalSeed);
  state.worldSeed = finalSeed;
  
  console.log(`%c[Viron] WORLD SEED: ${finalSeed}`, 'color: #00ffcc; font-weight: bold; font-size: 1.2em;');

  // 1. Randomize Mountain Peaks
  randomizeMountainPeaks();

  // 2. Populate standard buildings (including villages)
  let numBldgs = state.isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    let bx = p.random(-4500, 4500), bz = p.random(-4500, 4500);
    // Avoid placing buildings directly on the launchpad
    if (isLaunchpad(bx, bz)) {
      i--; // Try again
      continue;
    }
    
    // 30% chance to spawn a village instead of a single building
    if (p.random() < 0.3) {
      spawnVillage(bx, bz, state);
      // Villages count as 3-5 buildings for density purposes
    } else {
      let bType = [0, 1, 2, 3, 5][Math.floor(p.random(5))]; // Includes 3 (Powerup), excludes 4 (Sentinel)
      state.buildings.push({
        x: bx, z: bz,
        y: terrain.getAltitude(bx, bz),
        w: 80, h: p.random(120, 160), d: 80,
        type: bType,
        col: [p.random(100, 160), p.random(100, 160), p.random(100, 160)]
      });
    }
  }

  // 3. Place Sentinels at the new mountain peak centers
  for (let i = 0; i < MOUNTAIN_PEAKS.length; i++) {
    let peak = MOUNTAIN_PEAKS[i];
    state.buildings.push({
      x: peak.x, z: peak.z,
      y: terrain.getAltitude(peak.x, peak.z),
      w: 60, h: 280, d: 60,
      type: 4,
      col: [0, 220, 200],
      pulseTimer: Math.floor(i * SENTINEL_PULSE_INTERVAL / Math.max(1, MOUNTAIN_PEAKS.length))
    });
  }

  state.sentinelBuildings = state.buildings.filter(b => b.type === 4);
}

/**
 * Spawns a cluster of Chinese buildings (one Pagoda and multiple Huts) to form a village.
 */
export function spawnVillage(cx, cz, state) {
  if (!state) return;
  // Center Pagoda
  state.buildings.push({
    x: cx, z: cz,
    y: terrain.getAltitude(cx, cz),
    w: 80, h: 200, d: 80,
    type: 2, // Pagoda
    col: [200, 50, 50] // Traditional Red
  });

  // Surround with huts
  let numHuts = Math.floor(p.random(3, 6));
  for (let i = 0; i < numHuts; i++) {
    let angle = p.random(2 * Math.PI);
    let dist = p.random(120, 300);
    let hx = cx + Math.cos(angle) * dist;
    let hz = cz + Math.sin(angle) * dist;
    
    if (!isLaunchpad(hx, hz)) {
      state.buildings.push({
        x: hx, z: hz,
        y: terrain.getAltitude(hx, hz),
        w: 50, h: p.random(60, 75), d: 50,
        type: 5, // Small Hut
        col: [120, 100, 80]
      });
    }
  }
}
