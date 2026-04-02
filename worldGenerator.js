// =============================================================================
// worldGenerator.js — Procedural generation of terrain, buildings, and peaks
// =============================================================================

/**
 * Randomizes the number, position, and strength of mountain peaks.
 * Updates the global MOUNTAIN_PEAKS array and re-initializes terrain state.
 */
function randomizeMountainPeaks() {
  const count = floor(random(0, 11)); // 0 to 10 peaks
  const newPeaks = [];

  for (let i = 0; i < count; i++) {
    newPeaks.push({
      x: random(-4500, 4500),
      z: random(-4500, 4500),
      strength: random(300, 550),
      sigma: random(600, 1400)
    });
  }

  MOUNTAIN_PEAKS = newPeaks;
  
  if (typeof initializeMountainPeaks === 'function') {
    initializeMountainPeaks();
  }

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
function initWorld(seed) {
  const finalSeed = seed !== undefined ? seed : floor(millis() + (typeof second === 'function' ? second() : 0) * 1000);
  randomSeed(finalSeed);
  noiseSeed(finalSeed);
  gameState.worldSeed = finalSeed;
  
  console.log(`%c[Viron] WORLD SEED: ${finalSeed}`, 'color: #00ffcc; font-weight: bold; font-size: 1.2em;');

  // 1. Randomize Mountain Peaks
  randomizeMountainPeaks();

  // 2. Populate standard buildings (including villages)
  let numBldgs = gameState.isMobile ? 15 : 40;
  for (let i = 0; i < numBldgs; i++) {
    let bx = random(-4500, 4500), bz = random(-4500, 4500);
    // Avoid placing buildings directly on the launchpad
    if (isLaunchpad(bx, bz)) {
      i--; // Try again
      continue;
    }
    
    // 30% chance to spawn a village instead of a single building
    if (random() < 0.3) {
      spawnVillage(bx, bz);
      // Villages count as 3-5 buildings for density purposes
    } else {
      let bType = [0, 1, 2, 3, 5][floor(random(5))]; // Includes 3 (Powerup), excludes 4 (Sentinel)
      gameState.buildings.push({
        x: bx, z: bz,
        y: terrain.getAltitude(bx, bz),
        w: 80, h: random(120, 160), d: 80,
        type: bType,
        col: [random(100, 160), random(100, 160), random(100, 160)]
      });
    }
  }

  // 3. Place Sentinels at the new mountain peak centers
  for (let i = 0; i < MOUNTAIN_PEAKS.length; i++) {
    let peak = MOUNTAIN_PEAKS[i];
    gameState.buildings.push({
      x: peak.x, z: peak.z,
      y: terrain.getAltitude(peak.x, peak.z),
      w: 60, h: 280, d: 60,
      type: 4,
      col: [0, 220, 200],
      pulseTimer: floor(i * SENTINEL_PULSE_INTERVAL / Math.max(1, MOUNTAIN_PEAKS.length))
    });
  }

  gameState.sentinelBuildings = gameState.buildings.filter(b => b.type === 4);
}

/**
 * Spawns a cluster of Chinese buildings (one Pagoda and multiple Huts) to form a village.
 */
function spawnVillage(cx, cz) {
  // Center Pagoda
  gameState.buildings.push({
    x: cx, z: cz,
    y: terrain.getAltitude(cx, cz),
    w: 80, h: 200, d: 80,
    type: 2, // Pagoda
    col: [200, 50, 50] // Traditional Red
  });

  // Surround with huts
  let numHuts = floor(random(3, 6));
  for (let i = 0; i < numHuts; i++) {
    let angle = random(TWO_PI);
    let dist = random(120, 300);
    let hx = cx + cos(angle) * dist;
    let hz = cz + sin(angle) * dist;
    
    if (!isLaunchpad(hx, hz)) {
      gameState.buildings.push({
        x: hx, z: hz,
        y: terrain.getAltitude(hx, hz),
        w: 50, h: random(60, 75), d: 50,
        type: 5, // Small Hut
        col: [120, 100, 80]
      });
    }
  }
}
