// =============================================================================
// projectiles.js — Physics and rendering logic for player weapons and barriers
// =============================================================================

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
function updateProjectilePhysics(p) {
  // --- Bullets ---
  let assistEnabled = aimAssist.enabled;
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];

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
        if (!bestTarget && _simTick % 2 === 0) {
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
        b.vx = lerp(b.vx, (dx / d) * speed, steer);
        b.vy = lerp(b.vy, (dy / d) * speed, steer);
        b.vz = lerp(b.vz, (dz / d) * speed, steer);
      }
    }

    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life -= 2;
    if (b.life <= 0) {
      swapRemove(p.bullets, i);
    } else if (b.y > terrain.getAltitude(b.x, b.z)) {
      clearInfectionAt(b.x, b.z, p);
      swapRemove(p.bullets, i);
    }
  }

  // --- Homing missiles ---
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i];
    const maxSpd = 30;
    let target = p.aimTarget || findNearest(enemyManager.enemies, m.x, m.y, m.z);

    if (target) {
      let dest = aimAssist.enabled ? aimAssist._getPredictedPos(m, target, maxSpd) : target;
      let dx = dest.x - m.x, dy = dest.y - m.y, dz = dest.z - m.z;
      let dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > 0) {
        let mg = Math.sqrt(dSq);
        let bl = 0.12;
        m.vx = lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = lerp(m.vz, (dz / mg) * maxSpd, bl);
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

    if (_simTick % 2 === 0) {
      particleSystem.particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5),
        life: 120, decay: 5, seed: random(1.0), size: random(2, 5)
      });
    }

    let gnd = terrain.getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        particleSystem.addExplosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, p);
      }
      swapRemove(p.homingMissiles, i);
    }
  }

  // --- Tank Shells ---
  for (let i = p.tankShells.length - 1; i >= 0; i--) {
    let s = p.tankShells[i];
    s.vy += 0.15; // Gravity
    s.x += s.vx; s.y += s.vy; s.z += s.vz;
    s.life--;

    let g = terrain.getAltitude(s.x, s.z);
    if (s.life <= 0 || s.y > g) {
      // AOE Destruction of infection and enemies
      let impactRad = TANK_SHELL_CLEAR_R * TILE;
      let impactRadSq = impactRad * impactRad;

      // Kill nearby enemies
      for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
        let e = enemyManager.enemies[j];
        let dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;
        if (dx * dx + dy * dy + dz * dz < impactRadSq) {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          swapRemove(enemyManager.enemies, j);
          p.score += 300;
        }
      }

      let tx = toTile(s.x), tz = toTile(s.z);
      let cleared = clearInfectionRadius(tx, tz, TANK_SHELL_CLEAR_R);
      if (cleared > 0) {
        p.score += cleared * 50;
      }
      terrain.addPulse(s.x, s.z, 2.0);
      gameRenderer?.setShake(15);
      gameSFX?.setThrust(p.id, false);
      gameSFX?.playClearInfection(s.x, g, s.z);
      swapRemove(p.tankShells, i);
    }
  }
}

/**
 * Advances all in-flight barrier projectiles one frame.
 * On landing, snaps to tile grid and adds key to barrierTiles (dedup is automatic).
 */
function updateBarrierPhysics() {
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
      swapRemove(gameState.inFlightBarriers, i);
    }
  }
}

/**
 * Renders all in-flight barrier projectiles as small white cubes.
 * Called once per viewport from the main render loop.
 * @param {number} camX  Camera world X.
 * @param {number} camZ  Camera world Z.
 */
function renderInFlightBarriers(camX, camZ) {
  if (!gameState.inFlightBarriers.length) return;
  const cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  noStroke(); fill(255, 255, 255, 220);
  for (let b of gameState.inFlightBarriers) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); box(8); pop();
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
function renderProjectiles(p, camX, camZ) {
  let cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  let bulletR = 4; // Player bullet size control (sphere radius)
  let bulletDetailX = 4;
  let bulletDetailY = 3;
  let br = p.labelColor[0], bg = p.labelColor[1], bb = p.labelColor[2];

  // Bullets use low-poly flat spheres for a simple explosion-like look.
  noLights();
  noStroke();
  fill(br, bg, bb);

  for (let b of p.bullets) {
    let dx = b.x - camX;
    let dz = b.z - camZ;
    if (dx * dx + dz * dz > cullSq) continue;
    push(); translate(b.x, b.y, b.z);
    sphere(bulletR, bulletDetailX, bulletDetailY);
    pop();
  }

  for (let m of p.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;

    push();
    translate(m.x, m.y, m.z);

    // Direct orientation toward velocity vector
    let h = Math.sqrt(m.vx * m.vx + m.vz * m.vz);
    rotateY(Math.atan2(m.vx, m.vz));
    rotateX(Math.atan2(-m.vy, h));

    noStroke();

    // Body (Main Fuselage)
    fill(0, 180, 255);
    box(3, 3, 14);

    // Nose Cone (Pointed Tip)
    push();
    translate(0, 0, 10);
    rotateX(PI / 2);
    fill(255);
    cone(2, 6, 4); // Low-poly pyramid-like nose
    pop();

    // Faint Glow / Core
    fill(255, 255, 255, 100);
    box(1, 1, 16);

    // Fins (Tail stabilizers)
    fill(0, 100, 255);
    translate(0, 0, -6);
    box(10, 1, 4); // Horizontal fins
    box(1, 10, 4); // Vertical fins

    pop();
  }

  // Draw Tank Shells
  for (let s of p.tankShells) {
    if ((s.x - camX) ** 2 + (s.z - camZ) ** 2 > cullSq) continue;
    push();
    translate(s.x, s.y, s.z);
    // Draw as a larger, glowing grey "shell"
    noStroke();
    fill(100, 100, 110);
    sphere(8, 6, 4); // Larger than bullets
    fill(255, 150, 50, 200); // Glow
    sphere(5, 4, 3);
    pop();
  }
}
