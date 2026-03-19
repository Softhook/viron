// =============================================================================
// gameLoop.js — Physics update & collision detection
//
// Encapsulates all frame-time simulation: infection spread, collision detection,
// respawn logic, and ambiance audio updates. Manages physics state and triggers
// game-over conditions when physics constraints are violated.
// =============================================================================

// ENEMY_DRAW_SCALE is defined in enemies.js (= 4). Precompute the squared
// half-scale used in every checkCollisions() call so Math.pow() is never
// called inside the per-enemy hot loop.
// enemies.js loads before gameLoop.js (see index.html script order).
const _ENEMY_HALF_SCALE_SQ = (ENEMY_DRAW_SCALE / 2) * (ENEMY_DRAW_SCALE / 2);

class GameLoop {
  /** @private Returns squared size multiplier used for Colossus radius checks. */
  static _colossusScaleSq(e) {
    const s = e && e.colossusScale ? e.colossusScale : 1;
    return s * s;
  }

  /**
   * Resolves a sphere-to-sphere collision by pushing the ship out along the normal.
   * @private
   */
  static _resolveSphereCollision(s, ox, oy, oz, or, sr) {
    let dx = s.x - ox, dy = s.y - oy, dz = s.z - oz;
    let distSq = dx * dx + dy * dy + dz * dz;
    let minD = or + sr;
    if (distSq < minD * minD && distSq > 0) {
      let d = Math.sqrt(distSq);
      let overlap = minD - d;
      let nx = dx / d, ny = dy / d, nz = dz / d;
      s.x += nx * overlap; s.y += ny * overlap; s.z += nz * overlap;
      // Dampen velocity along normal
      let dot = s.vx * nx + s.vy * ny + s.vz * nz;
      if (dot < 0) {
        s.vx -= nx * dot * 1.8;
        s.vy -= ny * dot * 1.8;
        s.vz -= nz * dot * 1.8;
      }
      return true;
    }
    return false;
  }

  /**
   * Resolves an AABB-to-sphere collision by pushing the ship to the nearest face.
   * bX, bY, bZ is the BOX CENTER.
   * @private
   */
  static _resolveAABBCollision(s, bx, by, bz, hw, hh, hd, sr) {
    let dx = s.x - bx, dy = s.y - by, dz = s.z - bz;
    let closestX = constrain(dx, -hw, hw);
    let closestY = constrain(dy, -hh, hh);
    let closestZ = constrain(dz, -hd, hd);
    let distVecX = dx - closestX, distVecY = dy - closestY, distVecZ = dz - closestZ;
    let distSq = distVecX * distVecX + distVecY * distVecY + distVecZ * distVecZ;

    if (distSq < sr * sr) {
      let d = Math.sqrt(distSq);
      if (d === 0) {
        // Center of sphere is inside box; push out along the shallowest axis
        let absX = hw - Math.abs(dx), absY = hh - Math.abs(dy), absZ = hd - Math.abs(dz);
        if (absX < absY && absX < absZ) { s.x += (dx > 0 ? absX + sr : -absX - sr); s.vx = 0; }
        else if (absY < absX && absY < absZ) { s.y += (dy > 0 ? absY + sr : -absY - sr); s.vy = 0; }
        else { s.z += (dz > 0 ? absZ + sr : -absZ - sr); s.vz = 0; }
      } else {
        let overlap = sr - d;
        let nx = distVecX / d, ny = distVecY / d, nz = distVecZ / d;
        s.x += nx * overlap; s.y += ny * overlap; s.z += nz * overlap;
        let dot = s.vx * nx + s.vy * ny + s.vz * nz;
        if (dot < 0) { s.vx -= nx * dot * 1.8; s.vy -= ny * dot * 1.8; s.vz -= nz * dot * 1.8; }
      }
      return true;
    }
    return false;
  }

  /**
   * Spreads infection one step every 5 frames using 4-connected flood-fill.
   * Also checks game-over conditions.
   * @public
   */
  static spreadInfection() {
    const profiler = getVironProfiler();
    const profilerConfig = profiler ? profiler.config : (typeof window !== 'undefined' ? window.VIRON_PROFILE : null);
    const maxInf = (profilerConfig && profilerConfig.maxInfOverride) ? profilerConfig.maxInfOverride : MAX_INF;
    const freezeSpread = !!(profilerConfig && profilerConfig.freezeSpread);
    const isGameOver = typeof gameState !== 'undefined' && gameState.mode === 'gameover';
    const shouldRun = isGameOver || (_simTick % 5 === 0);

    if (!shouldRun || (gameState.levelComplete && !isGameOver)) return;
    const spreadStart = profiler ? performance.now() : 0;

    // A. Check: Too much infection?
    if (infection.count >= maxInf) {
      gameState.setGameOver('INFECTION REACHED CRITICAL MASS');
    }

    // B. Check: Launchpad fully overrun?
    // infection.launchpadCount is maintained incrementally by TileManager.add()
    // and remove(), so this is O(1) instead of the previous O(LAUNCHPAD_TILE_SIZE²).
    if (infection.launchpadCount >= LAUNCHPAD_TILE_SIZE * LAUNCHPAD_TILE_SIZE) {
      gameState.setGameOver('LAUNCH PAD INFECTED');
    }

    if (freezeSpread) {
      if (profiler) profiler.recordSpread(performance.now() - (spreadStart || 0));
      return;
    }

    // C. Viral spread rates (probability per tile per frame)
    const rate = isGameOver ? RAPID_INF_RATE : INF_RATE;
    const yellowRate = isGameOver ? Math.min(1.0, RAPID_INF_RATE * 1.2) : YELLOW_INF_RATE;

    // 1. Standard spread: iterate "active" tiles that are likely to have empty neighbors.
    const active = infection.activeList;
    let soundCount = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      let t = active[i];
      let currentRate = (t.type === 'yellow') ? yellowRate : rate;
      
      if (random() > currentRate) continue;

      let d = ORTHO_DIRS[floor(random(4))];
      let nx = t.tx + d[0], nz = t.tz + d[1], nk = tileKey(nx, nz);

      if (!infection.has(nk) && !gameState.barrierTiles.has(nk)) {
        let wx = nx * TILE, wz = nz * TILE;
        if (aboveSea(terrain.getAltitude(wx, wz))) continue;

        let nObj = infection.add(nk, t.type);
        if (nObj) {
          if (typeof gameSFX !== 'undefined' && soundCount < 3 && random() < 0.1) {
            gameSFX.playInfectionSpread(wx, terrain.getAltitude(wx, wz), wz);
            soundCount++;
          }
          if (isLaunchpad(wx, wz)) maybePlayLaunchpadAlarm();
        }
      } else {
        // Optimize: if spread fails, check if this tile is now completely surrounded.
        if (random() < 0.05) {
          let blocked = true;
          for (const dd of ORTHO_DIRS) {
            let nkk = tileKey(t.tx + dd[0], t.tz + dd[1]);
            if (!infection.has(nkk) && !gameState.barrierTiles.has(nkk)) {
              blocked = false; break;
            }
          }
          if (blocked) {
            const last = active[active.length - 1];
            active[i] = last;
            last._activeIdx = i;
            active.pop();
            t._activeIdx = undefined;
          }
        }
      }
    }

    // 2. Accelerated spread from infected sentinels
    if (gameState.sentinelBuildings) {
      for (let b of gameState.sentinelBuildings) {
        let stx = toTile(b.x), stz = toTile(b.z);
        let sInf = infection.tiles.get(tileKey(stx, stz));
        if (!sInf) continue;

        const sType = sInf.type;
        const rad = SENTINEL_INFECTION_RADIUS;
        for (let ddx = -rad; ddx <= rad; ddx++) {
          for (let ddz = -rad; ddz <= rad; ddz++) {
            if (ddx * ddx + ddz * ddz > rad * rad) continue;
            if (random() > SENTINEL_INFECTION_PROBABILITY) continue;

            let nx = stx + ddx, nz = stz + ddz;
            let nk = tileKey(nx, nz);
            if (!infection.has(nk) && !gameState.barrierTiles.has(nk)) {
              let wx = nx * TILE, wz = nz * TILE;
              if (aboveSea(terrain.getAltitude(wx, wz))) continue;
              infection.add(nk, sType);
              if (isLaunchpad(wx, wz)) maybePlayLaunchpadAlarm();
            }
          }
        }
      }
    }

    if (profiler) profiler.recordSpread(performance.now() - (spreadStart || 0));
  }

  /**
   * Checks whether any projectile in `projectiles` hits enemy `e` (at enemies[j]).
   * Removes the matched projectile (and enemy, if not a Colossus) on hit.
   * Returns true when the enemy was destroyed; returns false when the Colossus was
   * hit but survived (so other weapon types are still tested this frame).
   * @private
   * @param {object[]} projectiles   Player's projectile array (mutated on hit).
   * @param {object}   player        Player state.
   * @param {object}   e             Enemy to test.
   * @param {number}   j             Index of `e` in enemyManager.enemies.
   * @param {number}   enemyScaleSq  Precomputed (ENEMY_DRAW_SCALE/2)^2.
   * @param {number}   normalRadSq   Hit-radius² for standard enemies.
   * @param {number}   colossusRadSq Hit-radius² for Colossus (multiplied by its scale²).
   * @param {number}   shakeAmt      Camera shake strength on a normal-enemy kill.
   * @param {number}   normalScore   Score awarded for a normal-enemy kill.
   * @param {number}   colossusDmg   HP damage applied to Colossus on hit.
   * @param {number}   colossusFlash Flash duration (frames) for Colossus hit feedback.
   * @param {number}   colossusHitScore Score awarded per Colossus hit.
   * @returns {boolean}
   */
  static _checkProjectileArrayVsEnemy(
    projectiles, player, e, j, enemyScaleSq,
    normalRadSq, colossusRadSq,
    shakeAmt, normalScore,
    colossusDmg, colossusFlash, colossusHitScore
  ) {
    const isColossus = e.type === 'colossus';
    const hitRadSq = (isColossus
      ? colossusRadSq * this._colossusScaleSq(e)
      : normalRadSq) * enemyScaleSq;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      const dx = proj.x - e.x, dy = proj.y - e.y, dz = proj.z - e.z;
      if (dx * dx + dy * dy + dz * dz < hitRadSq) {
        if (isColossus) {
          swapRemove(projectiles, i);
          return this._damageColossus(player, j, colossusDmg, colossusFlash, colossusHitScore, 2000);
        } else {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(shakeAmt);
          swapRemove(enemyManager.enemies, j); swapRemove(projectiles, i);
          player.score += normalScore; return true;
        }
      }
    }
    return false;
  }

  /**
   * Applies damage to a Colossus enemy from a weapon hit.
   * Removes enemy and awards kill bonus if HP drops to zero.
   * @private
   */
  static _damageColossus(player, enemyIdx, dmg, flashDur, hitScore, killBonus) {
    let e = enemyManager.enemies[enemyIdx];
    e.hp = (e.hp || 0) - dmg;
    e.hitFlash = flashDur;
    player.score += hitScore;
    if (e.hp <= 0) {
      particleSystem.addExplosion(e.x, e.y - 100, e.z, enemyManager.getColor(e.type), e.type);
      if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(60);
      swapRemove(enemyManager.enemies, enemyIdx);
      player.score += killBonus;
      return true;
    }
    return false;
  }

  /**
   * Tests projectiles against procedural infected trees.
   * @private
   */
  static _checkProjectilesVsTrees(player) {
    // Bullets vs infected trees (1-tile search radius = 3x3)
    for (let i = player.bullets.length - 1; i >= 0; i--) {
      let b = player.bullets[i];
      // Shortcut: skip check if bullet is too high (most trees are < 100 units tall)
      if (b.y < -300) continue; 

      let tx0 = toTile(b.x), tz0 = toTile(b.z);
      let hit = false;
      for (let tz = tz0 - 1; tz <= tz0 + 1 && !hit; tz++) {
        for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
          let t = terrain.tryGetProceduralTree(tx, tz);
          if (!t) continue;
          let ty = terrain.getAltitude(t.x, t.z);
          // Altitude shortcut: bullet must be within tree vertical range
          if (b.y <= ty - t.trunkH - 30 * t.canopyScale - 10 || b.y >= ty + 10) continue;
          if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 >= 3600) continue;
          if (!infection.has(tileKey(tx, tz))) continue;
          clearInfectionRadius(tx, tz);
          player.score += 200;
          swapRemove(player.bullets, i);
          hit = true;
          break;
        }
      }
    }

    // Tank shells vs infected trees (2-tile search radius = 5x5)
    for (let j = player.tankShells.length - 1; j >= 0; j--) {
      let ts = player.tankShells[j];
      if (ts.y < -300) continue;

      let tx0 = toTile(ts.x), tz0 = toTile(ts.z);
      let hitTree = false;
      for (let tz = tz0 - 2; tz <= tz0 + 2 && !hitTree; tz++) {
        for (let tx = tx0 - 2; tx <= tx0 + 2; tx++) {
          let t = terrain.tryGetProceduralTree(tx, tz);
          if (!t) continue;
          let ty = terrain.getAltitude(t.x, t.z);
          if (ts.y <= ty - t.trunkH - 30 * t.canopyScale - 20 || ts.y >= ty + 20) continue;
          if ((ts.x - t.x) ** 2 + (ts.z - t.z) ** 2 >= 10000) continue;
          if (!infection.has(tileKey(tx, tz))) continue;
          clearInfectionRadius(tx, tz, TANK_SHELL_CLEAR_R);
          terrain.addPulse(ts.x, ts.z, 2.0);
          particleSystem.addExplosion(ts.x, ts.y, ts.z);
          swapRemove(player.tankShells, j);
          hitTree = true;
          break;
        }
      }
    }
  }

  /**
   * Runs all collision tests for one player each frame.
   *
   * Tests performed (priority order):
   *   1. Enemy bullets vs player ship
   *   2. Player bullets vs each enemy
   *   3. Player missiles vs each enemy
   *   4. Enemy body vs player ship body
   *   5. Floating powerup vs player ship
   *   6. Player projectiles vs infected trees
   *
   * @public
   */
  static checkCollisions(player) {
    if (player.dead) return;
    let s = player.ship;

    // 1. Enemy bullets vs player
    for (let i = particleSystem.enemyBullets.length - 1; i >= 0; i--) {
      let eb = particleSystem.enemyBullets[i];
      if ((eb.x - s.x) ** 2 + (eb.y - s.y) ** 2 + (eb.z - s.z) ** 2 < 4900) {
        killPlayer(player);
        swapRemove(particleSystem.enemyBullets, i);
        return;
      }
    }

    // 2, 3, 4. Enemy body and weapons vs player
    const enemyScaleSq = _ENEMY_HALF_SCALE_SQ;
    for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
      let e = enemyManager.enemies[j];
      let killed = false;

      // Player bullets, missiles, and tank shells vs enemy — each weapon type is
      // tested in priority order; stop as soon as the enemy is destroyed.
      // Args: projectiles, player, e, j, enemyScaleSq,
      //       normalRadSq, colossusRadSq, shakeAmt, normalScore,
      //       colossusDmg, colossusFlash, colossusHitScore
      killed = this._checkProjectileArrayVsEnemy(
        player.bullets, player, e, j, enemyScaleSq,
        6400, 90000, 5, 100, 1, 12, 10);
      if (!killed)
        killed = this._checkProjectileArrayVsEnemy(
          player.homingMissiles, player, e, j, enemyScaleSq,
          10000, 160000, 8, 250, 5, 20, 50);
      if (!killed)
        killed = this._checkProjectileArrayVsEnemy(
          player.tankShells, player, e, j, enemyScaleSq,
          22500, 250000, 10, 300, 15, 30, 100);

      // --- Body-to-Body Collision & Resolution ---
      if (!killed) {
        let shipRad = 15;
        let speedSq = s.vx * s.vx + s.vy * s.vy + s.vz * s.vz;
        if (e.type === 'colossus') {
          // Broad-phase: skip if too far (center-to-center)
          const cScale = (e.colossusScale || 1) * ENEMY_DRAW_SCALE;
          const broadRad = 500 * cScale;
          if (dist3dSq(s.x, s.y, s.z, e.x, e.y, e.z) > (broadRad + shipRad) ** 2) continue;

          // Multi-part collision for Colossus
          // Apply enemy yaw rotation to bone offsets
          let yaw = atan2(e.vx || 0, e.vz || 0);
          let cosY = Math.cos(yaw), sinY = Math.sin(yaw);

          // Approximate bones (Y is inverted: negative is UP)
          const bones = [
            { y: -160, r: 100 }, // Torso
            { y: -320, r: 70 },  // Head
            { y: -45, r: 80 },   // Hips
            { x: -50, y: 20, r: 40 }, { x: 50, y: 20, r: 40 },   // Thighs
            { x: -50, y: 140, r: 35 }, { x: 50, y: 140, r: 35 }, // Shins
            { x: -105, y: -145, r: 40 }, { x: 105, y: -145, r: 40 }, // Upper Arms
            { x: -105, y: -25, r: 35 }, { x: 105, y: -25, r: 35 }    // Lower Arms
          ];
          for (let b of bones) {
            let lx = (b.x || 0) * cScale;
            let lz = 0; // Colossus is mostly flat in local Z
            let bx = e.x + lx * cosY + lz * sinY;
            let by = e.y + (b.y || 0) * cScale;
            let bz = e.z + lz * cosY - lx * sinY;
            let br = b.r * cScale;
            if (dist3dSq(s.x, s.y, s.z, bx, by, bz) < (br + shipRad) ** 2) {
              if (speedSq > 49.0) { killPlayer(player); return; } // Threshold raised from 4.2 (17.6) to 7.0 (49.0)
              this._resolveSphereCollision(s, bx, by, bz, br, shipRad);
              break; // One part is enough
            }
          }
        } else {
          // Normal enemy check + resolution
          let bodyRad = 7 * (ENEMY_DRAW_SCALE / 2); // Radius in world units
          if (dist3dSq(s.x, s.y, s.z, e.x, e.y, e.z) < (bodyRad + shipRad) ** 2) {
            // Hunters and Squids are lethal on contact regardless of speed
            const isLethalType = e.type === 'hunter' || e.type === 'squid';
            if (isLethalType || speedSq > 49.0) { killPlayer(player); return; }
            this._resolveSphereCollision(s, e.x, e.y, e.z, bodyRad, shipRad);
          }
        }
      }
    }

    // 5. Floating powerups vs player
    for (let i = gameState.buildings.length - 1; i >= 0; i--) {
      let b = gameState.buildings[i];
      if (b.type === 3) {
        // Floating powerup vs player
        let floatY = b.y - b.h - 100 - sin(_simTick * 0.02 + b.x) * 50;
        let dx = s.x - b.x, dy = s.y - floatY, dz = s.z - b.z;
        let radiusSq = (b.w + 15) ** 2;

        if (dx * dx + dy * dy + dz * dz < radiusSq) {
          // Cache the tile-key on the powerup building so the arithmetic is
          // only done once even if the player hovers in range for many frames.
          // Powerup positions are fixed at spawn; the building is removed on pickup.
          if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
          let inf = infection.has(b._tileKey);
          if (inf) {
            if (player.missilesRemaining > 0) player.missilesRemaining--;
            if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(false, b.x, floatY, b.z);
          } else {
            if (random() < 0.5) player.missilesRemaining++;
            else player.normalShotMode = NORMAL_SHOT_MODES[1 + floor(random(3))];
            player.score += 500;
            if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(true, b.x, floatY, b.z);
          }
          swapRemove(gameState.buildings, i);
          for (let j = 0; j < 20; j++) {
            particleSystem.particles.push({
              x: b.x, y: floatY, z: b.z, vx: random(-4, 4), vy: random(-4, 4), vz: random(-4, 4),
              life: 255, decay: 12, size: random(4, 9), color: inf ? [200, 50, 50] : [60, 180, 240]
            });
          }
        }
      }
    }

    // Projectiles vs infected procedural trees
    this._checkProjectilesVsTrees(player);
  }

  /**
   * Computes infection proximity, pulse overlap, and scan-sweep for ambiance audio.
   * Called once per frame to update audio mix based on primary player position.
   * @public
   */
  static updateAmbianceAudio() {
    if (typeof gameSFX === 'undefined') return;

    let p = gameState.players[0];
    let proximityData = { dist: 10000 };

    if (p && !p.dead && p.ship) {
      // Nearest infected tile within 8-tile radius
      let px = toTile(p.ship.x), pz = toTile(p.ship.z);
      let minDistSq = 1000000;
      for (let dz = -8; dz <= 8; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          let tx = px + dx, tz = pz + dz;
          if (infection.has(tileKey(tx, tz))) {
            let wx = tx * TILE + 60, wz = tz * TILE + 60;
            let wy = terrain.getAltitude(wx, wz);
            let dSq = (p.ship.x - wx) ** 2 + (p.ship.y - wy) ** 2 + (p.ship.z - wz) ** 2;
            if (dSq < minDistSq) minDistSq = dSq;
          }
        }
      }
      proximityData.dist = Math.sqrt(minDistSq);

      // Pulse overlap detection
      let nowSec = millis() / 1000.0;
      let maxScan = 0;
      for (let pulse of terrain.activePulses) {
        let age = nowSec - pulse.start;
        if (age < 0 || age > 3.0) continue;
        let radius = pulse.type === 1.0 ? age * 300.0 : (pulse.type === 2.0 ? age * 1200.0 : age * 800.0);
        let dist2D = dist(p.ship.x, p.ship.z, pulse.x, pulse.z);
        let groundY = terrain.getAltitude(p.ship.x, p.ship.z);
        let dy = p.ship.y - groundY;
        let distToRing3D = Math.sqrt((dist2D - radius) ** 2 + dy ** 2);
        if (distToRing3D < 120) {
          let intensity = 1.0 - (distToRing3D / 120);
          if (intensity > maxScan) maxScan = intensity;
        }
      }
      proximityData.pulseOverlap = maxScan;

      // Scan-sweep sync with terrain shader
      let xP = p.ship.x / TILE, zP = p.ship.z / TILE;
      let scanPos = nowSec / 10.0;
      let val = 1.0 - Math.abs(((xP * 0.02 + zP * 0.01 - scanPos) % 1.0 + 1.0) % 1.0 - 0.5) * 2.0;
      proximityData.scanSweepAlpha = Math.max(0, (val - 0.98) / (1.0 - 0.98));
    }

    gameSFX.updateAmbiance(proximityData, infection.count, MAX_INF);
  }

  /**
   * Checks level-clear and respawn conditions each frame.
   * @public
   */
  static updateLevelAndRespawn() {
    if (!gameState.levelComplete && gameState.isLevelClearable()) {
      gameState.completeLevelSequence();
    }

    if (gameState.levelComplete && millis() - gameState.levelEndTime > 4000) {
      gameState.startLevel(gameState.level + 1);
    }

    gameState.updateRespawns();
  }
}
