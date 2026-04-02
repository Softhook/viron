// =============================================================================
// utils.js — Shared game utility functions
// =============================================================================

/**
 * Finds the element in arr closest to (x, y, z) by 3D squared distance.
 */
function findNearest(arr, x, y, z) {
  let best = null, bestD = Infinity;
  for (let e of arr) {
    let dSq = (x - e.x) ** 2 + (y - e.y) ** 2 + (z - e.z) ** 2;
    if (dSq < bestD) { bestD = dSq; best = e; }
  }
  return best;
}

const ALARM_COOLDOWN_MS = 1000;
/**
 * Plays launchpad alarm no more than once per cooldown window.
 */
function maybePlayLaunchpadAlarm() {
  const now = millis();
  if (now - gameState.lastAlarmTime <= ALARM_COOLDOWN_MS) return false;
  gameSFX?.playAlarm();
  gameState.lastAlarmTime = now;
  return true;
}

/**
 * Removes all infected tiles within a tile square around (tx, tz).
 */
function clearInfectionRadius(tx, tz, radius = CLEAR_R) {
  let cleared = 0;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++) {
      let k = tileKey(tx + dx, tz + dz);
      if (infection.remove(k)) cleared++;
    }
  return cleared;
}

/**
 * Clears infection at a world-space position.
 */
function clearInfectionAt(wx, wz, p) {
  let tx = toTile(wx), tz = toTile(wz);
  if (!infection.has(tileKey(tx, tz))) return false;
  clearInfectionRadius(tx, tz);
  if (p) p.score += 100;
  gameSFX?.playClearInfection(wx, terrain.getAltitude(wx, wz), wz);
  return true;
}
