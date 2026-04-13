

// =============================================================================
// gameLoop.js — Physics update & collision detection
//
// Encapsulates all frame-time simulation: infection spread, collision detection,
// respawn logic, and ambiance audio updates. Manages physics state and triggers
// game-over conditions when physics constraints are violated.
//
// @exports   GameLoop         — namespace: checkCollisions(), spreadInfection(),
//                               updateLevelAndRespawn(), updateAmbianceAudio()
// =============================================================================

import { p } from './p5Context.js';
import {
  tileKey,
  toTile,
  TILE,
  ORTHO_DIRS,
  MAX_INF,
  INF_RATE,
  YELLOW_INF_RATE,
  RAPID_INF_RATE,
  SEA,
  aboveSea,
  dist3dSq,
  infection,
  LAUNCHPAD_TILE_SIZE,
  SENTINEL_INFECTION_RADIUS,
  SENTINEL_INFECTION_PROBABILITY,
  NORMAL_SHOT_MODES,
  TANK_SHELL_CLEAR_R,
  isLaunchpad,
  swapRemove,
  getVironProfiler
} from './constants.js';
import { ENEMY_DRAW_SCALE, enemyManager } from './enemies.js';
import { gameState } from './gameState.js';
import { terrain } from './terrain.js';
import { particleSystem } from './particles.js';
import { gameSFX } from './sfx.js';
import { physicsEngine } from './PhysicsEngine.js';
import { killPlayer } from './player.js';
import { clearInfectionAt, clearInfectionRadius, maybePlayLaunchpadAlarm } from './utils.js';
import { villagerManager } from './villagers.js';
import { wizardManager } from './wizards.js';
import { SfxAmbient } from './sfxAmbient.js';
import { gameRenderer } from './gameRenderer.js';

// ENEMY_DRAW_SCALE is defined in enemies.js (= 4). Precompute the squared
// half-scale used in every checkCollisions() call so Math.pow() is never
// called inside the per-enemy hot loop.
// enemies.js loads before gameLoop.js (see index.html script order).
const _ENEMY_HALF_SCALE_SQ = (ENEMY_DRAW_SCALE / 2) * (ENEMY_DRAW_SCALE / 2);

// Velocity damping applied along the collision normal to simulate inelastic impact.
// Values above 1.0 add a small bounce (1.8 ≈ slightly springy but stable).
const COLLISION_DAMPING = 1.8;

// Enemy bullet vs player kill radius squared (70² = 4900 world units).
const ENEMY_BULLET_KILL_RAD_SQ = 4900;

// Ship speed² above which a body collision is instant-kill instead of a push-back.
// 49.0 = 7² world-units/tick (≈ high-speed impact threshold).
const LETHAL_COLLISION_SPEED_SQ = 49.0;

// Body physics radii
const SHIP_COLLISION_RAD = 15;
const SHIP_COLLISION_RAD_SQ = 225;
const COLOSSUS_BROAD_PHASE_RAD = 500;
const KRAKEN_BODY_RAD = 74;

// Colossus skeleton bone positions (local-space, un-scaled).
// Hoisted from _checkEnemyBodyVsPlayer so the 11-element array is not
// re-allocated every frame for every Colossus on screen.
const _COLOSSUS_BONES = [
  { y: -160, r: 100 }, { y: -320, r: 70 }, { y: -45, r: 80 },
  { x: -50, y: 20, r: 40 }, { x: 50, y: 20, r: 40 },
  { x: -50, y: 140, r: 35 }, { x: 50, y: 140, r: 35 },
  { x: -105, y: -145, r: 40 }, { x: 105, y: -145, r: 40 },
  { x: -105, y: -25, r: 35 }, { x: 105, y: -25, r: 35 }
];

void SEA;
void clearInfectionAt;
void villagerManager;
void wizardManager;
void SfxAmbient;

const GameLoop = {
  // Cached proximity distance for ambiance audio (avoids re-scan every frame).
  _lastAmbDist: undefined,

  /** @private Returns squared size multiplier used for Colossus radius checks. */
  _colossusScaleSq(e) {
    const s = e && e.colossusScale ? e.colossusScale : 1;
    return s * s;
  },

  /** @private Returns squared size multiplier used for Kraken radius checks. */
  _krakenScaleSq(e) {
    const s = e && e.krakenScale ? e.krakenScale : 1;
    return s * s;
  },

  /**
   * Resolves a sphere-to-sphere collision by pushing the ship out along the normal.
   * @private
   */
  _resolveSphereCollision(s, ox, oy, oz, or, sr) {
    let dx = s.x - ox, dy = s.y - oy, dz = s.z - oz;
    let distSq = dx * dx + dy * dy + dz * dz;
    let minD = or + sr;
    if (distSq < minD * minD && distSq > 0) {
      let d = Math.sqrt(distSq);
      let overlap = minD - d;
      let nx = dx / d, ny = dy / d, nz = dz / d;
      s.x += nx * overlap; s.y += ny * overlap; s.z += nz * overlap;
      let dot = s.vx * nx + s.vy * ny + s.vz * nz;
      if (dot < 0) {
        s.vx -= nx * dot * COLLISION_DAMPING;
        s.vy -= ny * dot * COLLISION_DAMPING;
        s.vz -= nz * dot * COLLISION_DAMPING;
      }
      return true;
    }
    return false;
  },

  /**
   * Resolves an AABB-to-sphere collision by pushing the ship to the nearest face.
   * bX, bY, bZ is the BOX CENTER.
   * @private
   */
  _resolveAABBCollision(s, bx, by, bz, hw, hh, hd, sr) {
    let dx = s.x - bx, dy = s.y - by, dz = s.z - bz;
    let closestX = Math.min(Math.max(dx, -hw), hw);
    let closestY = Math.min(Math.max(dy, -hh), hh);
    let closestZ = Math.min(Math.max(dz, -hd), hd);
    let distVecX = dx - closestX, distVecY = dy - closestY, distVecZ = dz - closestZ;
    let distSq = distVecX * distVecX + distVecY * distVecY + distVecZ * distVecZ;

    if (distSq < sr * sr) {
      let d = Math.sqrt(distSq);
      if (d === 0) {
        let absX = hw - Math.abs(dx), absY = hh - Math.abs(dy), absZ = hd - Math.abs(dz);
        if (absX < absY && absX < absZ) { s.x += (dx > 0 ? absX + sr : -absX - sr); s.vx = 0; }
        else if (absY < absX && absY < absZ) { s.y += (dy > 0 ? absY + sr : -absY - sr); s.vy = 0; }
        else { s.z += (dz > 0 ? absZ + sr : -absZ - sr); s.vz = 0; }
      } else {
        let overlap = sr - d;
        let nx = distVecX / d, ny = distVecY / d, nz = distVecZ / d;
        s.x += nx * overlap; s.y += ny * overlap; s.z += nz * overlap;
        let dot = s.vx * nx + s.vy * ny + s.vz * nz;
        if (dot < 0) { s.vx -= nx * dot * COLLISION_DAMPING; s.vy -= ny * dot * COLLISION_DAMPING; s.vz -= nz * dot * COLLISION_DAMPING; }
      }
      return true;
    }
    return false;
  },

  /**
   * Spreads infection one step every 5 frames using 4-connected flood-fill.
   * Also checks game-over conditions.
   * @public
   */
  spreadInfection() {
    const profiler = getVironProfiler();
    const profilerConfig = profiler ? profiler.config : (typeof window !== 'undefined' ? window.VIRON_PROFILE : null);
    const maxInf = (profilerConfig && profilerConfig.maxInfOverride) ? profilerConfig.maxInfOverride : MAX_INF;
    const freezeSpread = !!(profilerConfig && profilerConfig.freezeSpread);
    const isGameOver = gameState.mode === 'gameover';
    const shouldRun = isGameOver || (physicsEngine.tickCount % 5 === 0);

    if (!shouldRun || (gameState.levelComplete && !isGameOver)) return;
    const spreadStart = profiler ? performance.now() : 0;

    if (infection.count >= maxInf) {
      gameState.setGameOver('INFECTION REACHED CRITICAL MASS');
    }

    if (infection.launchpadCount >= LAUNCHPAD_TILE_SIZE * LAUNCHPAD_TILE_SIZE) {
      gameState.setGameOver('LAUNCH PAD INFECTED');
    }

    if (freezeSpread) {
      if (profiler) profiler.recordSpread(performance.now() - (spreadStart || 0));
      return;
    }

    const rate = isGameOver ? RAPID_INF_RATE : INF_RATE;
    const yellowRate = isGameOver ? Math.min(1.0, RAPID_INF_RATE * 1.2) : YELLOW_INF_RATE;

    const active = infection.activeList;
    let soundCount = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      let t = active[i];
      let currentRate = (t.type === 'yellow') ? yellowRate : rate;

      if (p.random() > currentRate) continue;

      let d = ORTHO_DIRS[Math.floor(p.random(4))];
      let nx = t.tx + d[0], nz = t.tz + d[1], nk = tileKey(nx, nz);

      if (!infection.has(nk) && !gameState.barrierTiles.has(nk)) {
        let wx = nx * TILE, wz = nz * TILE;
        if (aboveSea(terrain.getAltitude(wx, wz))) continue;

        let nObj = infection.add(nk, t.type);
        if (nObj) {
          if (gameSFX && soundCount < 3 && p.random() < 0.1) {
            gameSFX.playInfectionSpread(wx, terrain.getAltitude(wx, wz), wz);
            soundCount++;
          }
          if (isLaunchpad(wx, wz)) maybePlayLaunchpadAlarm();
        }
      } else if (p.random() < 0.05) {
        let blocked = true;
        for (const dd of ORTHO_DIRS) {
          let nkk = tileKey(t.tx + dd[0], t.tz + dd[1]);
          if (!infection.has(nkk) && !gameState.barrierTiles.has(nkk)) {
            blocked = false;
            break;
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
            if (p.random() > SENTINEL_INFECTION_PROBABILITY) continue;

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
  },

  /**
   * Checks whether any projectile in `projectiles` hits enemy `e` (at enemies[j]).
   * Removes the matched projectile (and enemy, if not a boss type) on hit.
   * Returns true when the enemy was destroyed; returns false when a boss was
   * hit but survived (so other weapon types are still tested this frame).
   * @private
   */
  _checkProjectileArrayVsEnemy(
    projectiles, player, e, j, enemyScaleSq,
    normalRadSq, colossusRadSq,
    shakeAmt, normalScore,
    colossusDmg, colossusFlash, colossusHitScore
  ) {
    const isColossus = e.type === 'colossus';
    const isKraken = e.type === 'kraken';
    const isBoss = isColossus || isKraken;
    let hitRadSq;
    if (isColossus) {
      hitRadSq = colossusRadSq * this._colossusScaleSq(e) * enemyScaleSq;
    } else if (isKraken) {
      hitRadSq = colossusRadSq * this._krakenScaleSq(e) * enemyScaleSq;
    } else {
      hitRadSq = normalRadSq * enemyScaleSq;
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      const dx = proj.x - e.x, dy = proj.y - e.y, dz = proj.z - e.z;
      if (dx * dx + dy * dy + dz * dz < hitRadSq) {
        if (isBoss) {
          swapRemove(projectiles, i);
          return this._damageBoss(player, j, colossusDmg, colossusFlash, colossusHitScore, 2000);
        }
        particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
        gameRenderer?.setShake(shakeAmt);
        swapRemove(enemyManager.enemies, j);
        swapRemove(projectiles, i);
        player.score += normalScore;
        return true;
      }
    }
    return false;
  },

  /**
   * Applies damage to a boss enemy (Colossus or Kraken) from a weapon hit.
   * Removes enemy and awards kill bonus if HP drops to zero.
   * @private
   */
  _damageBoss(player, enemyIdx, dmg, flashDur, hitScore, killBonus) {
    let e = enemyManager.enemies[enemyIdx];
    e.hp = (e.hp || 0) - dmg;
    e.hitFlash = flashDur;
    player.score += hitScore;
    if (e.hp <= 0) {
      particleSystem.addExplosion(e.x, e.y - 100, e.z, enemyManager.getColor(e.type), e.type);
      gameRenderer?.setShake(60);
      swapRemove(enemyManager.enemies, enemyIdx);
      player.score += killBonus;
      return true;
    }
    return false;
  },

  /**
   * Shared helper: tests `projectiles` against infected procedural trees in the
   * tile grid. For each projectile, searches a `searchR`-tile square around the
   * projectile's tile; removes and calls `onHit(proj, tx, tz)` on the first match.
   * @private
   */
  _checkProjectilesVsTreeType(projectiles, searchR, hitRadSq, yTolHi, yTolLo, onHit) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      if (proj.y < -300) continue;

      const tx0 = toTile(proj.x), tz0 = toTile(proj.z);
      outer: for (let tz = tz0 - searchR; tz <= tz0 + searchR; tz++) {
        for (let tx = tx0 - searchR; tx <= tx0 + searchR; tx++) {
          const t = terrain.tryGetProceduralTree(tx, tz);
          if (!t) continue;
          const ty = terrain.getAltitude(t.x, t.z);
          if (proj.y <= ty - t.trunkH - 30 * t.canopyScale - yTolLo || proj.y >= ty + yTolHi) continue;
          const tdx = proj.x - t.x, tdz = proj.z - t.z;
          if (tdx * tdx + tdz * tdz >= hitRadSq) continue;
          if (!infection.has(tileKey(tx, tz))) continue;
          onHit(proj, tx, tz);
          swapRemove(projectiles, i);
          break outer;
        }
      }
    }
  },

  /**
   * Tests projectiles against procedural infected trees.
   * @private
   */
  _checkProjectilesVsTrees(player) {
    this._checkProjectilesVsTreeType(player.bullets, 1, 3600, 10, 10, (_bullet, tx, tz) => {
      clearInfectionRadius(tx, tz);
      player.score += 200;
    });

    this._checkProjectilesVsTreeType(player.tankShells, 2, 10000, 20, 20, (shell, tx, tz) => {
      clearInfectionRadius(tx, tz, TANK_SHELL_CLEAR_R);
      terrain.addPulse(shell.x, shell.z, 2.0);
      particleSystem.addExplosion(shell.x, shell.y, shell.z);
    });
  },

  /**
   * Evaluates exact Kraken tentacle geometry for collision detection.
   * @private
   */
  _checkKrakenTentacles(s, e, kScale, shipRadSq) {
    const maxReach = 362 * kScale;
    let dx = s.x - e.x, dy = s.y - e.y, dz = s.z - e.z;
    let md = maxReach + Math.sqrt(shipRadSq);
    if (dx * dx + dy * dy + dz * dz > md * md) return false;

    const phase = physicsEngine.tickCount * 0.02 + (e.id || 0) * 0.15;

    if (this._traceKrakenArms(6, 8, 28, 74, 5, 0.82, 0, phase, 1.0, e, s, kScale, shipRadSq)) return true;
    if (this._traceKrakenArms(2, 10, 30, 62, 4, 1.08, Math.PI / 6, phase + 1.8, 1.1, e, s, kScale, shipRadSq)) return true;
    return false;
  },

  _traceKrakenArms(numArms, numSegs, segLen, tx, ty, rotX1, angleOffset, tPhaseBase, waveSpeed, e, s, kScale, shipRadSq) {
    const shipRad = Math.sqrt(shipRadSq);
    const PI2 = Math.PI * 2;
    const isMain = numArms === 6;
    const phaseStep = isMain ? (PI2 / 6) : Math.PI;
    const waveAmpZ = isMain ? 0.22 : 0.20;
    const waveAmpX = 0.08;
    const waveOffX = isMain ? 0.07 : 0.06;
    const segFreqZ = 0.5 * waveSpeed;
    const segFreqX = isMain ? 0.4 : 0.38;

    const rotX1_c = Math.cos(rotX1), rotX1_s = Math.sin(rotX1);
    const sx = s.x, sy = s.y, sz = s.z;
    const ex = e.x, ey = e.y, ez = e.z;
    const segLenScale = segLen * kScale;
    const hitPad = segLenScale * 0.5 + shipRad;
    const invSegs = 1 / (numSegs - 1);
    const wBase = isMain ? 21 : 15;
    const wTip = isMain ? 3 : 2;

    for (let i = 0; i < numArms; i++) {
      const a = (i / numArms) * PI2 + angleOffset;
      const tPhase = tPhaseBase + i * phaseStep;
      const acos = Math.cos(a), asin = Math.sin(a);

      let px = acos * tx, py = ty, pz = -asin * tx;
      let ux = acos, uy = 0, uz = -asin;
      let vx = asin * rotX1_s, vy = rotX1_c, vz = acos * rotX1_s;
      let wx = asin * rotX1_c, wy = -rotX1_s, wz = acos * rotX1_c;

      for (let seg = 0; seg < numSegs; seg++) {
        const sw = Math.sin(tPhase + seg * segFreqZ) * waveAmpZ;
        const rx2 = Math.sin(tPhase * 0.6 + seg * segFreqX) * waveAmpX - waveOffX;

        const cZ = Math.cos(sw), sZ = Math.sin(sw);
        const cX = Math.cos(rx2), sX = Math.sin(rx2);

        let nux = ux * cZ + vx * sZ, nuy = uy * cZ + vy * sZ, nuz = uz * cZ + vz * sZ;
        let nvx = -ux * sZ + vx * cZ, nvy = -uy * sZ + vy * cZ, nvz = -uz * sZ + vz * cZ;
        ux = nux;
        uy = nuy;
        uz = nuz;

        let nvx2 = nvx * cX + wx * sX, nvy2 = nvy * cX + wy * sX, nvz2 = nvz * cX + wz * sX;
        let nwx2 = -nvx * sX + wx * cX, nwy2 = -nvy * sX + wy * cX, nwz2 = -nvz * sX + wz * cX;
        vx = nvx2;
        vy = nvy2;
        vz = nvz2;
        wx = nwx2;
        wy = nwy2;
        wz = nwz2;

        px += wx * segLen;
        py += wy * segLen;
        pz += wz * segLen;

        const distX = sx - (ex + px * kScale);
        const distY = sy - (ey + py * kScale);
        const distZ = sz - (ez + pz * kScale);

        const t = seg * invSegs;
        const width = wBase * (1 - t) + wTip * t;
        const r = width * kScale + hitPad;

        if (distX * distX + distY * distY + distZ * distZ < r * r) return true;
      }
    }
    return false;
  },

  // Per-weapon collision config — replaces raw magic-number arguments in
  // checkCollisions() with named, self-documenting objects.
  // normalRadSq:      squared hit radius for normal enemies
  // colossusRadSq:    squared hit radius for boss enemies (Colossus/Kraken)
  // shakeAmt:         camera shake frames on kill
  // normalScore:      score awarded for killing a normal enemy
  // colossusDmg:      HP damage dealt to boss per hit
  // colossusFlash:    hit-flash duration (frames)
  // colossusHitScore: score per boss hit (not kill)
  _BULLET_CFG:  { normalRadSq: 6400,  colossusRadSq: 90000,  shakeAmt: 5,  normalScore: 100, colossusDmg: 1,  colossusFlash: 12, colossusHitScore: 10  },
  _MISSILE_CFG: { normalRadSq: 10000, colossusRadSq: 160000, shakeAmt: 8,  normalScore: 250, colossusDmg: 5,  colossusFlash: 20, colossusHitScore: 50  },
  _TANK_CFG:    { normalRadSq: 22500, colossusRadSq: 250000, shakeAmt: 10, normalScore: 300, colossusDmg: 15, colossusFlash: 30, colossusHitScore: 100 },

  /**
   * Runs all collision tests for one player each frame.
   * @public
   */
  checkCollisions(player) {
    if (player.dead) return;
    let s = player.ship;

    if (this._checkEnemyBulletsVsPlayer(player, s)) return;

    const enemyScaleSq = _ENEMY_HALF_SCALE_SQ;
    for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
      let e = enemyManager.enemies[j];
      let killed = false;

      const B = this._BULLET_CFG;
      killed = this._checkProjectileArrayVsEnemy(
        player.bullets, player, e, j, enemyScaleSq,
        B.normalRadSq, B.colossusRadSq, B.shakeAmt, B.normalScore,
        B.colossusDmg, B.colossusFlash, B.colossusHitScore);
      if (!killed) {
        const M = this._MISSILE_CFG;
        killed = this._checkProjectileArrayVsEnemy(
          player.homingMissiles, player, e, j, enemyScaleSq,
          M.normalRadSq, M.colossusRadSq, M.shakeAmt, M.normalScore,
          M.colossusDmg, M.colossusFlash, M.colossusHitScore);
      }
      if (!killed) {
        const T = this._TANK_CFG;
        killed = this._checkProjectileArrayVsEnemy(
          player.tankShells, player, e, j, enemyScaleSq,
          T.normalRadSq, T.colossusRadSq, T.shakeAmt, T.normalScore,
          T.colossusDmg, T.colossusFlash, T.colossusHitScore);
      }

      if (!killed && this._checkEnemyBodyVsPlayer(player, s, e)) return;
    }

    this._checkPowerupsVsPlayer(player, s);
    this._checkProjectilesVsTrees(player);
  },

  _checkEnemyBulletsVsPlayer(player, s) {
    for (let i = particleSystem.enemyBullets.length - 1; i >= 0; i--) {
      let eb = particleSystem.enemyBullets[i];
      let dx = eb.x - s.x, dy = eb.y - s.y, dz = eb.z - s.z;
      if (dx * dx + dy * dy + dz * dz < ENEMY_BULLET_KILL_RAD_SQ) {
        killPlayer(player);
        swapRemove(particleSystem.enemyBullets, i);
        return true;
      }
    }
    return false;
  },

  _checkEnemyBodyVsPlayer(player, s, e) {
    let speedSq = s.vx * s.vx + s.vy * s.vy + s.vz * s.vz;
    if (e.type === 'colossus') {
      const cScale = (e.colossusScale || 1) * ENEMY_DRAW_SCALE;
      const broadRad = COLOSSUS_BROAD_PHASE_RAD * cScale;
      let bx = s.x - e.x, by = s.y - e.y, bz = s.z - e.z;
      let brSum = broadRad + SHIP_COLLISION_RAD;
      if (bx * bx + by * by + bz * bz > brSum * brSum) return false;

      let yaw = Math.atan2(e.vx || 0, e.vz || 0);
      let cosY = Math.cos(yaw), sinY = Math.sin(yaw);

      const bones = _COLOSSUS_BONES;
      for (let b of bones) {
        let lx = (b.x || 0) * cScale;
        let lz = 0;
        let cx = e.x + lx * cosY + lz * sinY;
        let cy = e.y + (b.y || 0) * cScale;
        let cz = e.z + lz * cosY - lx * sinY;
        let br = b.r * cScale;
        let pdist = br + SHIP_COLLISION_RAD;
        if (dist3dSq(s.x, s.y, s.z, cx, cy, cz) < pdist * pdist) {
          if (speedSq > LETHAL_COLLISION_SPEED_SQ) { killPlayer(player); return true; }
          this._resolveSphereCollision(s, cx, cy, cz, br, SHIP_COLLISION_RAD);
          break;
        }
      }
    } else if (e.type === 'kraken') {
      const kScale = (e.krakenScale || 1) * ENEMY_DRAW_SCALE;
      const bodyRad = KRAKEN_BODY_RAD * kScale;
      const dSq = dist3dSq(s.x, s.y, s.z, e.x, e.y, e.z);
      const bdSum = bodyRad + SHIP_COLLISION_RAD;

      if (dSq < bdSum * bdSum) {
        if (speedSq > LETHAL_COLLISION_SPEED_SQ) { killPlayer(player); return true; }
        this._resolveSphereCollision(s, e.x, e.y, e.z, bodyRad, SHIP_COLLISION_RAD);
      } else if (this._checkKrakenTentacles(s, e, kScale, SHIP_COLLISION_RAD_SQ)) {
        killPlayer(player);
        return true;
      }
    } else {
      let bodyRad = 7 * (ENEMY_DRAW_SCALE / 2);
      const normSum = bodyRad + SHIP_COLLISION_RAD;
      if (dist3dSq(s.x, s.y, s.z, e.x, e.y, e.z) < normSum * normSum) {
        const isLethalType = e.type === 'hunter' || e.type === 'squid';
        if (isLethalType || speedSq > LETHAL_COLLISION_SPEED_SQ) { killPlayer(player); return true; }
        this._resolveSphereCollision(s, e.x, e.y, e.z, bodyRad, SHIP_COLLISION_RAD);
      }
    }
    return false;
  },

  _checkPowerupsVsPlayer(player, s) {
    for (let i = gameState.buildings.length - 1; i >= 0; i--) {
      let b = gameState.buildings[i];
      if (b.type !== 3) continue;

      let floatY = b.y - b.h - 100 - Math.sin(physicsEngine.tickCount * 0.02 + b.x) * 50;
      let dx = s.x - b.x, dy = s.y - floatY, dz = s.z - b.z;
      let rSum = b.w + 15;

      if (dx * dx + dy * dy + dz * dz < rSum * rSum) {
        if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
        let inf = infection.has(b._tileKey);
        if (inf) {
          if (player.missilesRemaining > 0) player.missilesRemaining--;
          gameSFX?.playPowerup(false, b.x, floatY, b.z);
        } else {
          if (p.random() < 0.5) player.missilesRemaining++;
          else player.normalShotMode = NORMAL_SHOT_MODES[1 + Math.floor(p.random(3))];
          player.score += 500;
          gameSFX?.playPowerup(true, b.x, floatY, b.z);
        }
        swapRemove(gameState.buildings, i);
        for (let j = 0; j < 20; j++) {
          particleSystem.particles.push({
            x: b.x, y: floatY, z: b.z,
            vx: p.random(-4, 4), vy: p.random(-4, 4), vz: p.random(-4, 4),
            life: 255, decay: 12, size: p.random(4, 9),
            color: inf ? [200, 50, 50] : [60, 180, 240]
          });
        }
      }
    }
  },

  /**
   * Computes infection proximity, pulse overlap, and scan-sweep for ambiance audio.
   * @public
   */
  updateAmbianceAudio() {
    if (!gameSFX) return;

    let player0 = gameState.players[0];
    let proximityData = { dist: 10000 };

    if (player0 && !player0.dead && player0.ship) {
      if (physicsEngine.tickCount % 10 !== 0 && GameLoop._lastAmbDist !== undefined) {
        proximityData.dist = GameLoop._lastAmbDist;
      } else {
        let px = toTile(player0.ship.x), pz = toTile(player0.ship.z);
        let minDistSq = 1000000;
        for (let dz = -8; dz <= 8; dz++) {
          for (let dx = -8; dx <= 8; dx++) {
            let tx = px + dx, tz = pz + dz;
            if (infection.has(tileKey(tx, tz))) {
              let wx = tx * TILE + 60, wz = tz * TILE + 60;
              let wy = terrain.getAltitude(wx, wz);
              let sdx = player0.ship.x - wx, sdy = player0.ship.y - wy, sdz = player0.ship.z - wz;
              let dSq = sdx * sdx + sdy * sdy + sdz * sdz;
              if (dSq < minDistSq) minDistSq = dSq;
            }
          }
        }
        GameLoop._lastAmbDist = Math.sqrt(minDistSq);
        proximityData.dist = GameLoop._lastAmbDist;
      }

      let nowSec = p.millis() / 1000.0;
      let maxScan = 0;
      for (let pulse of terrain.activePulses) {
        let age = nowSec - pulse.start;
        if (age < 0 || age > 3.0) continue;
        let radius = pulse.type === 1.0 ? age * 300.0 : (pulse.type === 2.0 ? age * 1200.0 : age * 800.0);
        let dist2D = Math.hypot(player0.ship.x - pulse.x, player0.ship.z - pulse.z);
        let groundY = terrain.getAltitude(player0.ship.x, player0.ship.z);
        let dy = player0.ship.y - groundY;
        let drD = dist2D - radius;
        let distToRing3D = Math.sqrt(drD * drD + dy * dy);
        if (distToRing3D < 120) {
          let intensity = 1.0 - (distToRing3D / 120);
          if (intensity > maxScan) maxScan = intensity;
        }
      }
      proximityData.pulseOverlap = maxScan;

      let xP = player0.ship.x / TILE, zP = player0.ship.z / TILE;
      let scanPos = nowSec / 10.0;
      let val = 1.0 - Math.abs(((xP * 0.02 + zP * 0.01 - scanPos) % 1.0 + 1.0) % 1.0 - 0.5) * 2.0;
      proximityData.scanSweepAlpha = Math.max(0, (val - 0.98) / (1.0 - 0.98));
    }

    gameSFX.updateAmbiance(proximityData, infection.count, MAX_INF);
  },

  /**
   * Checks level-clear and respawn conditions each frame.
   * @public
   */
  updateLevelAndRespawn() {
    if (!gameState.levelComplete && gameState.isLevelClearable()) {
      gameState.completeLevelSequence();
    }

    if (gameState.levelComplete && p.millis() - gameState.levelEndTime > 4000) {
      gameState.startLevel(gameState.level + 1);
    }

    gameState.updateRespawns();
  }
};

export { GameLoop };
