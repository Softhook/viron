// =============================================================================
// gameLoop.js — Physics update & collision detection
//
// Encapsulates all frame-time simulation: infection spread, collision detection,
// respawn logic, and ambiance audio updates. Manages physics state and triggers
// game-over conditions when physics constraints are violated.
// =============================================================================

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
    const isGameOver = gameState.mode === 'gameover';
    const shouldRun = isGameOver || (frameCount % 5 === 0);

    if (!shouldRun || (gameState.levelComplete && !isGameOver)) return;
    const spreadStart = profiler ? performance.now() : 0;

    // Check: Too much infection?
    if (infection.count >= maxInf) {
      gameState.setGameOver('INFECTION REACHED CRITICAL MASS');
    }

    // Check: Launchpad fully overrun?
    let lpInfected = 0;
    for (let tx = 0; tx < 7; tx++) {
      for (let tz = 0; tz < 7; tz++) {
        if (infection.has(tileKey(tx, tz))) lpInfected++;
      }
    }
    if (lpInfected >= 49) {
      gameState.setGameOver('LAUNCH PAD INFECTED');
    }

    if (freezeSpread) {
      if (profiler) profiler.recordSpread(performance.now() - spreadStart);
      return;
    }

    let infObjects = infection.keys();
    let freshMap = new Map();
    const normalRate = isGameOver ? RAPID_INF_RATE : INF_RATE;
    const yellowRate = isGameOver ? RAPID_INF_RATE : YELLOW_INF_RATE;

    // Standard spread: 4-connected from existing infections
    for (let i = 0; i < infObjects.length; i++) {
      let t = infObjects[i];
      const currentRate = (t.type === 'yellow') ? yellowRate : normalRate;
      if (random() > currentRate) continue;

      let d = ORTHO_DIRS[floor(random(4))];
      let nx = t.tx + d[0], nz = t.tz + d[1], nk = tileKey(nx, nz);
      let wx = nx * TILE, wz = nz * TILE;
      if (aboveSea(terrain.getAltitude(wx, wz)) || infection.has(nk)) continue;
      freshMap.set(nk, t.type);
    }

    // Accelerated spread from infected sentinels
    for (let b of gameState.sentinelBuildings) {
      let stx = toTile(b.x), stz = toTile(b.z);
      let sInf = infection.get(tileKey(stx, stz));
      if (!sInf) continue;
      const sType = sInf.type;
      for (let ddx = -SENTINEL_INFECTION_RADIUS; ddx <= SENTINEL_INFECTION_RADIUS; ddx++) {
        for (let ddz = -SENTINEL_INFECTION_RADIUS; ddz <= SENTINEL_INFECTION_RADIUS; ddz++) {
          if (ddx * ddx + ddz * ddz > SENTINEL_INFECTION_RADIUS * SENTINEL_INFECTION_RADIUS) continue;
          if (random() > SENTINEL_INFECTION_PROBABILITY) continue;
          let nx = stx + ddx, nz = stz + ddz;
          let nk = tileKey(nx, nz);
          let wx = nx * TILE, wz = nz * TILE;
          if (!aboveSea(terrain.getAltitude(wx, wz)) && !infection.has(nk)) {
            freshMap.set(nk, sType);
          }
        }
      }
    }

    // Commit new infections
    let soundCount = 0;
    for (let [nk, nType] of freshMap) {
      if (gameState.barrierTiles.has(nk)) continue;
      const o = infection.add(nk, nType);
      if (!o) continue;
      let wx = o.tx * TILE, wz = o.tz * TILE;
      if (typeof gameSFX !== 'undefined' && soundCount < 3) {
        gameSFX.playInfectionSpread(wx, terrain.getAltitude(wx, wz), wz);
        soundCount++;
      }
      if (isLaunchpad(wx, wz)) {
        maybePlayLaunchpadAlarm();
      }
    }

    if (profiler) profiler.recordSpread(performance.now() - spreadStart);
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
    // Bullets vs infected trees (2-tile search radius)
    for (let i = player.bullets.length - 1; i >= 0; i--) {
      let b = player.bullets[i];
      let tx0 = toTile(b.x), tz0 = toTile(b.z);
      let hit = false;
      for (let tz = tz0 - 2; tz <= tz0 + 2 && !hit; tz++) {
        for (let tx = tx0 - 2; tx <= tx0 + 2; tx++) {
          let t = terrain.tryGetProceduralTree(tx, tz);
          if (!t) continue;
          let ty = terrain.getAltitude(t.x, t.z);
          if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 >= 3600) continue;
          if (b.y <= ty - t.trunkH - 30 * t.canopyScale - 10 || b.y >= ty + 10) continue;
          if (!infection.has(tileKey(tx, tz))) continue;
          clearInfectionRadius(tx, tz);
          player.score += 200;
          swapRemove(player.bullets, i);
          hit = true;
          break;
        }
      }
    }

    // Tank shells vs infected trees (3-tile search radius)
    for (let j = player.tankShells.length - 1; j >= 0; j--) {
      let ts = player.tankShells[j];
      let tx0 = toTile(ts.x), tz0 = toTile(ts.z);
      let hitTree = false;
      for (let tz = tz0 - 3; tz <= tz0 + 3 && !hitTree; tz++) {
        for (let tx = tx0 - 3; tx <= tx0 + 3; tx++) {
          let t = terrain.tryGetProceduralTree(tx, tz);
          if (!t) continue;
          let ty = terrain.getAltitude(t.x, t.z);
          if ((ts.x - t.x) ** 2 + (ts.z - t.z) ** 2 >= 10000) continue;
          if (ts.y <= ty - t.trunkH - 30 * t.canopyScale - 20 || ts.y >= ty + 20) continue;
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
    let enemyScaleSq = Math.pow(ENEMY_DRAW_SCALE / 2, 2);
    for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
      let e = enemyManager.enemies[j];
      let killed = false;

      // Player bullets/missiles vs enemy (unchanged hit detection)
      for (let i = player.bullets.length - 1; i >= 0; i--) {
        let b = player.bullets[i];
        let hitRadSq = (e.type === 'colossus' ? (90000 * this._colossusScaleSq(e)) : 6400) * enemyScaleSq;
        if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 + (b.z - e.z) ** 2 < hitRadSq) {
          if (e.type === 'colossus') {
            swapRemove(player.bullets, i);
            killed = this._damageColossus(player, j, 1, 12, 10, 2000);
          } else {
            particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
            if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(5);
            swapRemove(enemyManager.enemies, j); swapRemove(player.bullets, i);
            player.score += 100; killed = true;
          }
          break;
        }
      }
      if (!killed) {
        for (let i = player.homingMissiles.length - 1; i >= 0; i--) {
          let m = player.homingMissiles[i];
          let hitRadSq = (e.type === 'colossus' ? (160000 * this._colossusScaleSq(e)) : 10000) * enemyScaleSq;
          if ((m.x - e.x) ** 2 + (m.y - e.y) ** 2 + (m.z - e.z) ** 2 < hitRadSq) {
            if (e.type === 'colossus') {
              swapRemove(player.homingMissiles, i);
              killed = this._damageColossus(player, j, 5, 20, 50, 2000);
            } else {
              particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
              if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(8);
              swapRemove(enemyManager.enemies, j); swapRemove(player.homingMissiles, i);
              player.score += 250; killed = true;
            }
            break;
          }
        }
      }
      if (!killed) {
        for (let i = player.tankShells.length - 1; i >= 0; i--) {
          let s2 = player.tankShells[i];
          let hitRadSq = (e.type === 'colossus' ? (250000 * this._colossusScaleSq(e)) : 22500) * enemyScaleSq;
          if ((s2.x - e.x) ** 2 + (s2.y - e.y) ** 2 + (s2.z - e.z) ** 2 < hitRadSq) {
            if (e.type === 'colossus') {
              swapRemove(player.tankShells, i);
              killed = this._damageColossus(player, j, 15, 30, 100, 2000);
            } else {
              particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
              if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(10);
              swapRemove(enemyManager.enemies, j); swapRemove(player.tankShells, i);
              player.score += 300; killed = true;
            }
            break;
          }
        }
      }

      // --- Body-to-Body Collision & Resolution ---
      if (!killed) {
        let shipRad = 15;
        let speedSq = s.vx * s.vx + s.vy * s.vy + s.vz * s.vz;
        if (e.type === 'colossus') {
          // Multi-part collision for Colossus
          const cScale = (e.colossusScale || 1) * ENEMY_DRAW_SCALE;
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
            if ((s.x - bx) ** 2 + (s.y - by) ** 2 + (s.z - bz) ** 2 < (br + shipRad) ** 2) {
              if (speedSq > 49.0) { killPlayer(player); return; } // Threshold raised from 4.2 (17.6) to 7.0 (49.0)
              this._resolveSphereCollision(s, bx, by, bz, br, shipRad);
            }
          }
        } else {
          // Normal enemy check + resolution
          let bodyRad = 7 * (ENEMY_DRAW_SCALE / 2); // Radius in world units
          if ((s.x - e.x) ** 2 + (s.y - e.y) ** 2 + (s.z - e.z) ** 2 < (bodyRad + shipRad) ** 2) {
            if (speedSq > 49.0) { killPlayer(player); return; }
            this._resolveSphereCollision(s, e.x, e.y, e.z, bodyRad, shipRad);
          }
        }
      }
    }

    // 5. Environment Collisions: Buildings
    let shipRadEnv = 15;
    let speedSqEnv = s.vx * s.vx + s.vy * s.vy + s.vz * s.vz;
    for (let b of gameState.buildings) {
      if (b.type === 3) continue; // UFO: ignore in blocking collision (handled in collection pass below)
      if (Math.abs(s.x - b.x) > (b.w + 200) || Math.abs(s.z - b.z) > (b.d + 200)) continue;

      let hw = b.w / 2, hh = b.h / 2, hd = b.d / 2;
      let by = b.y - hh; // Center Y is ground - half height
      let collided = this._resolveAABBCollision(s, b.x, by, b.z, hw, hh, hd, shipRadEnv);
      if (collided && speedSqEnv > 49.0) { killPlayer(player); return; }
    }

    // 6. Environment Collisions: Trees
    let tx0 = toTile(s.x), tz0 = toTile(s.z);
    for (let tz = tz0 - 2; tz <= tz0 + 2; tz++) {
      for (let tx = tx0 - 2; tx <= tx0 + 2; tx++) {
        let t = terrain.tryGetProceduralTree(tx, tz);
        if (!t) continue;
        let ty = terrain.getAltitude(t.x, t.z);
        // Trunk collision (tall thin cylinder)
        let trunkHW = 5, trunkHH = t.trunkH / 2;
        if (this._resolveAABBCollision(s, t.x, ty - trunkHH, t.z, trunkHW, trunkHH, trunkHW, shipRadEnv)) {
          if (speedSqEnv > 49.0) { killPlayer(player); return; }
        }
        // Canopy collision (sphere)
        let canopyY = ty - t.trunkH; // Center of canopy cone/sphere
        let canopyR = 30 * t.canopyScale;
        if (this._resolveSphereCollision(s, t.x, canopyY, t.z, canopyR, shipRadEnv)) {
          if (speedSqEnv > 49.0) { killPlayer(player); return; }
        }
      }
    }

    // 7. Floating powerup vs player
    for (let i = gameState.buildings.length - 1; i >= 0; i--) {
      let b = gameState.buildings[i];
      if (b.type === 3) {
        let floatY = b.y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
        let dx = s.x - b.x, dy = s.y - floatY, dz = s.z - b.z;
        let radiusSq = (b.w + 15) ** 2;

        if (dx * dx + dy * dy + dz * dz < radiusSq) {
          let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));
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

    // 8. Projectiles vs infected procedural trees
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
