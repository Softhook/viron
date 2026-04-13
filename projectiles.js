// =============================================================================
// projectiles.js — Physics and rendering logic for player weapons and barriers
//
// @exports   updateProjectilePhysics()  — called per-tick by sketch.js draw()
// @exports   updateBarrierPhysics()     — called per-tick by sketch.js draw()
// =============================================================================

import { p } from './p5Context.js';
import { TILE, CULL_DIST, infection, tileKey, mag3, TANK_SHELL_CLEAR_R } from './constants.js';
import { clearInfectionAt, clearInfectionRadius } from './utils.js';
import { aimAssist } from './aimAssist.js';
import { enemyManager } from './enemies.js';
import { terrain } from './terrain.js';
import { particleSystem } from './particles.js';
import { physicsEngine } from './PhysicsEngine.js';
import { gameState } from './gameState.js';
import { gameRenderer } from './gameRenderer.js';
import { gameSFX } from './sfx.js';

function _lerp(a, b, t) {
  return a + (b - a) * t;
}

function _swapRemove(arr, i) {
  const last = arr.pop();
  if (i < arr.length) arr[i] = last;
}

function _findNearestEnemy(arr, x, y, z) {
  let best = null;
  let bestMag = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    const d = mag3(x - e.x, y - e.y, z - e.z);
    if (d < bestMag) {
      bestMag = d;
      best = e;
    }
  }
  return best;
}

/**
 * Advances bullet and homing-missile physics for one frame.
 *
 * Bullets: linear motion, 2-life-per-frame decay.  Removed when they hit terrain
 * or expire; terrain hit attempts to clear infected tiles.
 *
 * Homing missiles: use a lerped velocity toward the nearest enemy (blend factor
 * 0.12) capped at maxSpd = 10.  Emit a smoke trail every other frame.  On terrain
 * impact they trigger an explosion and attempt to clear infection.
 *
 * @param {object} p  Player state object containing bullets[], homingMissiles[], tankShells[].
 */
export function updateProjectilePhysics(plyr) {
  // --- Bullets ---
  let assistEnabled = aimAssist.enabled;
  for (let i = plyr.bullets.length - 1; i >= 0; i--) {
    let b = plyr.bullets[i];

    if (assistEnabled && b.life > 240) {
      let bestTarget = null;
      let bestDot = 0.985;
      let speed = Math.hypot(b.vx, b.vy, b.vz);

      if (speed > 0) {
        let bDirX = b.vx / speed, bDirY = b.vy / speed, bDirZ = b.vz / speed;
        for (let e of enemyManager.enemies) {
          let dx = e.x - b.x, dy = e.y - b.y, dz = e.z - b.z;
          let dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < 1440000 && dSq > 400) {
            let d = Math.sqrt(dSq);
            let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
            if (dot > bestDot) {
              bestDot = dot;
              bestTarget = aimAssist._getPredictedPos(b, e, speed, d);
            }
          }
        }
        if (!bestTarget && physicsEngine.tickCount % 2 === 0) {
          let bTx = Math.floor(b.x / 120), bTz = Math.floor(b.z / 120);
          for (let tz = bTz - 2; tz <= bTz + 2; tz++) {
            for (let tx = bTx - 2; tx <= bTx + 2; tx++) {
              let k = tileKey(tx, tz);
              if (infection.has(k)) {
                let txPos = tx * 120 + 60, tzPos = tz * 120 + 60;
                let tyPos = terrain.getAltitude(txPos, tzPos);
                let dx = txPos - b.x, dy = tyPos - b.y, dz = tzPos - b.z;
                let dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < 360000) {
                  let d = Math.sqrt(dSq);
                  let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
                  if (dot > bestDot) {
                    bestDot = dot;
                    bestTarget = { x: txPos, y: tyPos, z: tzPos };
                  }
                }
              }
            }
          }
        }
      }

      if (bestTarget) {
        let dx = bestTarget.x - b.x, dy = bestTarget.y - b.y, dz = bestTarget.z - b.z;
        let d = Math.hypot(dx, dy, dz);
        let steer = 0.04;
        b.vx = _lerp(b.vx, (dx / d) * speed, steer);
        b.vy = _lerp(b.vy, (dy / d) * speed, steer);
        b.vz = _lerp(b.vz, (dz / d) * speed, steer);
      }
    }

    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life -= 2;
    if (b.life <= 0) {
      _swapRemove(plyr.bullets, i);
    } else if (b.y > terrain.getAltitude(b.x, b.z)) {
      clearInfectionAt(b.x, b.z, plyr);
      _swapRemove(plyr.bullets, i);
    }
  }

  // --- Homing missiles ---
  for (let i = plyr.homingMissiles.length - 1; i >= 0; i--) {
    let m = plyr.homingMissiles[i];
    const maxSpd = 30;
    let target = plyr.aimTarget || _findNearestEnemy(enemyManager.enemies, m.x, m.y, m.z);

    if (target) {
      let dest = aimAssist.enabled ? aimAssist._getPredictedPos(m, target, maxSpd) : target;
      let dx = dest.x - m.x, dy = dest.y - m.y, dz = dest.z - m.z;
      let dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > 0) {
        let mg = Math.sqrt(dSq);
        let bl = 0.12;
        m.vx = _lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = _lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = _lerp(m.vz, (dz / mg) * maxSpd, bl);
      }
    }

    let spSq = m.vx * m.vx + m.vy * m.vy + m.vz * m.vz;
    if (spSq > maxSpd * maxSpd) {
      let sp = Math.sqrt(spSq);
      m.vx = (m.vx / sp) * maxSpd;
      m.vy = (m.vy / sp) * maxSpd;
      m.vz = (m.vz / sp) * maxSpd;
    }

    m.x += m.vx; m.y += m.vy; m.z += m.vz;
    m.life--;

    if (physicsEngine.tickCount % 2 === 0) {
      particleSystem.particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: p.random(-.5, .5), vy: p.random(-.5, .5), vz: p.random(-.5, .5),
        life: 120, decay: 5, seed: p.random(1.0), size: p.random(2, 5)
      });
    }

    let gnd = terrain.getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        particleSystem.addExplosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, plyr);
      }
      _swapRemove(plyr.homingMissiles, i);
    }
  }

  // --- Tank Shells ---
  for (let i = plyr.tankShells.length - 1; i >= 0; i--) {
    let s = plyr.tankShells[i];
    s.vy += 0.15; // Gravity
    s.x += s.vx; s.y += s.vy; s.z += s.vz;
    s.life--;

    let g = terrain.getAltitude(s.x, s.z);
    if (s.life <= 0 || s.y > g) {
      // AOE Destruction of infection and enemies
      let impactRad = TANK_SHELL_CLEAR_R * TILE;
      let impactRadSq = impactRad * impactRad;

      // Kill nearby enemies (excluding bosses, which are handled by direct impact in gameLoop)
      for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
        let e = enemyManager.enemies[j];
        if (e.type === 'colossus' || e.type === 'kraken') continue;

        let dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;
        if (dx * dx + dy * dy + dz * dz < impactRadSq) {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          _swapRemove(enemyManager.enemies, j);
          plyr.score += 300;
        }
      }

      let tx = Math.floor(s.x / TILE), tz = Math.floor(s.z / TILE);
      let cleared = clearInfectionRadius(tx, tz, TANK_SHELL_CLEAR_R);
      if (cleared > 0) {
        plyr.score += cleared * 50;
      }
      terrain.addPulse(s.x, s.z, 2.0);
      gameRenderer?.setShake(15);
      gameSFX?.setThrust(plyr.id, false);
      gameSFX?.playClearInfection(s.x, g, s.z);
      _swapRemove(plyr.tankShells, i);
    }
  }
}

/**
 * Advances all in-flight barrier projectiles one frame.
 * On landing, snaps to tile grid and adds key to barrierTiles (dedup is automatic).
 */
export function updateBarrierPhysics() {
  for (let i = gameState.inFlightBarriers.length - 1; i >= 0; i--) {
    let b = gameState.inFlightBarriers[i];
    b.vy += 0.15;  // Gravity
    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life--;
    if (b.y >= terrain.getAltitude(b.x, b.z) || b.life <= 0) {
      if (b.life > 0) { // Landed (not expired)
        let tx = Math.floor(b.x / TILE), tz = Math.floor(b.z / TILE);
        gameState.barrierTiles.add(tileKey(tx, tz));
      }
      _swapRemove(gameState.inFlightBarriers, i);
    }
  }
}

/**
 * Renders all in-flight barrier projectiles as small white cubes.
 * Called once per viewport from the main render loop.
 * @param {number} camX  Camera world X.
 * @param {number} camZ  Camera world Z.
 */
export function renderInFlightBarriers(camX, camZ) {
  if (!gameState.inFlightBarriers.length) return;
  const cullDist = CULL_DIST;
  const cullSq = (cullDist * 0.8) * (cullDist * 0.8);
  p.noStroke(); p.fill(255, 255, 255, 220);
  for (let b of gameState.inFlightBarriers) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    p.push(); p.translate(b.x, b.y, b.z); p.box(8); p.pop();
  }
}

/**
 * Renders the player's bullets (small coloured spheres) and homing missiles
 * (cyan cubes) from the perspective of the given viewport camera.
 * Objects beyond 80% of CULL_DIST are skipped.
 * @param {object} p     Player state containing bullets[] and homingMissiles[].
 * @param {number} camX  Camera world X (viewport camera, not ship).
 * @param {number} camZ  Camera world Z.
 */
export function renderProjectiles(plyr, camX, camZ) {
  const cullDist = CULL_DIST;
  let cullSq = (cullDist * 0.8) * (cullDist * 0.8);
  let bulletR = 4; // Player bullet size control (sphere radius)
  let bulletDetailX = 4;
  let bulletDetailY = 3;
  let br = plyr.labelColor[0], bg = plyr.labelColor[1], bb = plyr.labelColor[2];

  // Bullets use low-poly flat spheres for a simple explosion-like look.
  p.noLights();
  p.noStroke();
  p.fill(br, bg, bb);

  for (let b of plyr.bullets) {
    let dx = b.x - camX;
    let dz = b.z - camZ;
    if (dx * dx + dz * dz > cullSq) continue;
    p.push(); p.translate(b.x, b.y, b.z);
    p.sphere(bulletR, bulletDetailX, bulletDetailY);
    p.pop();
  }

  for (let m of plyr.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;

    p.push();
    p.translate(m.x, m.y, m.z);

    // Direct orientation toward velocity vector
    let h = Math.sqrt(m.vx * m.vx + m.vz * m.vz);
    p.rotateY(Math.atan2(m.vx, m.vz));
    p.rotateX(Math.atan2(-m.vy, h));

    p.noStroke();

    // Body (Main Fuselage)
    p.fill(0, 180, 255);
    p.box(3, 3, 14);

    // Nose Cone (Pointed Tip)
    p.push();
    p.translate(0, 0, 10);
    p.rotateX(Math.PI / 2);
    p.fill(255);
    p.cone(2, 6, 4); // Low-poly pyramid-like nose
    p.pop();

    // Faint Glow / Core
    p.fill(255, 255, 255, 100);
    p.box(1, 1, 16);

    // Fins (Tail stabilizers)
    p.fill(0, 100, 255);
    p.translate(0, 0, -6);
    p.box(10, 1, 4); // Horizontal fins
    p.box(1, 10, 4); // Vertical fins

    p.pop();
  }

  // Draw Tank Shells
  for (let s of plyr.tankShells) {
    if ((s.x - camX) ** 2 + (s.z - camZ) ** 2 > cullSq) continue;
    p.push();
    p.translate(s.x, s.y, s.z);
    // Draw as a larger, glowing grey "shell"
    p.noStroke();
    p.fill(100, 100, 110);
    p.sphere(8, 6, 4); // Larger than bullets
    p.fill(255, 150, 50, 200); // Glow
    p.sphere(5, 4, 3);
    p.pop();
  }
}

