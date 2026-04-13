// =============================================================================
// enemies.js — EnemyManager class
//
// Owns the active enemy list and all AI update logic.
// Rendering has been extracted to enemyRenderer.js (EnemyRenderer class).
//
// @exports   EnemyManager       — class definition
// @exports   enemyManager       — singleton
// @exports   ENEMY_DRAW_SCALE   — constant (= 4); used by gameLoop.js collision radii
// @exports   ENEMY_TYPES        — registry of all enemy type configs
//
// Ten enemy types are implemented:
//   seeder   — slow drifter; randomly drops normal infection bombs below itself
//   bomber   — fast drifter; drops large 'mega' bombs every 600 frames (~10 s)
//   crab     — ground-hugging unit that tracks the nearest player and infects tiles
//   hunter   — fast aggressive airborne pursuer; no weapons, kills by collision
//   fighter  — switching between aggressive pursuit and wandering; shoots + drops bombs
//   squid    — medium-speed pursuer; emits a dark ink-cloud smoke trail
//   scorpion — ground-hugging; targets sentinel buildings to infect them, then launchpad
//   colossus — BOSS: giant block-humanoid ground walker; massive HP, shoots burst salvos,
//              walks on two animated legs, leaves a virus trail behind it
//   wolf     — ground-hugging predator; hunts villagers and targets villages to spread virus
//   kraken   — BOSS: giant water-bound creature; massive HP, shoots 3-bullet bursts,
//              lashes out with far-reaching tentacle strikes, only lives on water tiles
// =============================================================================

import { p } from './p5Context.js';
import { tileKey, toTile, TILE, CULL_DIST, mag3, aboveSea, isLaunchpad, SEA, infection, ENEMY_CRAB_BULLET_LIFE, ENEMY_DRAW_SCALE } from './constants.js';
import { findNearest, maybePlayLaunchpadAlarm } from './utils.js';
import { EnemyRenderer } from './enemyRenderer.js';
import { EnemyAirAI } from './enemyAirBehaviors.js';
import { EnemyGroundAI } from './enemyGroundBehaviors.js';
import { EnemyBossAI } from './enemyBossBehaviors.js';
import { gameState } from './gameState.js';
import { terrain } from './terrain.js';
import { particleSystem } from './particles.js';
import { gameSFX } from './sfx.js';
import { physicsEngine } from './PhysicsEngine.js';

// Seeder double-diamond geometry: two layers, each defined by [yOffset, r, g, b].
// Hoisted out of the draw loop so the nested array literal is not re-allocated every frame.
const SEEDER_LAYERS = [[-10, 220, 30, 30], [6, 170, 15, 15]];

// Back-compat re-export: canonical source now lives in constants.js.
export { ENEMY_DRAW_SCALE };

// (Constants removed and consolidated in constants.js)

// =============================================================================
// Enemy Type Registry — single source of truth for per-type configuration.
//
// Every enemy type's static properties (color, shadow, locomotion, boss config,
// spawn weights) are defined here, replacing the scattered ENEMY_COLORS,
// ENEMY_SHADOW_DIMS, and inline spawn checks.
// =============================================================================

export const ENEMY_TYPES = {
  seeder: {
    color: [220, 30, 30],
    shadow: [68, 50],
    locomotion: 'flying',
    spawnWeight: 0.32,
    minLevel: 0
  },
  fighter: {
    color: [255, 150, 0],
    shadow: [64, 60],
    locomotion: 'flying',
    spawnWeight: 0.22,
    minLevel: 0
  },
  bomber: {
    color: [180, 20, 180],
    shadow: [150, 85],
    locomotion: 'flying',
    spawnWeight: 0.15,
    minLevel: 0
  },
  crab: {
    color: [200, 80, 20],
    shadow: null,       // Ground-huggers cast no shadow
    locomotion: 'ground',
    spawnWeight: 0.12,
    minLevel: 0
  },
  hunter: {
    color: [40, 255, 40],
    shadow: [80, 48],
    locomotion: 'flying',
    spawnWeight: 0.06,
    minLevel: 0
  },
  yellowCrab: {
    color: [255, 255, 0],
    shadow: null,
    locomotion: 'ground',
    spawnWeight: 0.03,  // Stolen from hunters when level >= 4
    minLevel: 4
  },
  squid: {
    color: [100, 100, 150],
    shadow: [110, 72],
    locomotion: 'flying',
    spawnWeight: 0.06,
    minLevel: 0
  },
  scorpion: {
    color: [20, 180, 120],
    shadow: null,
    locomotion: 'ground',
    spawnWeight: 0.04,
    minLevel: 0
  },
  wolf: {
    color: [110, 80, 55],
    shadow: null,
    locomotion: 'ground',
    spawnWeight: 0.03,
    minLevel: 0
  },
  colossus: {
    color: [255, 60, 20],
    shadow: null,       // Colossus shadow handled specially (scaled)
    locomotion: 'ground',
    isBoss: true,
    hpBase: 30,
    hpStep: 30,
    sizeStep: 0.35,
    maxSizeMult: 2.4,
    spawnWeight: 0,     // Spawned by level rules, not random weight
    minLevel: 3
  },
  kraken: {
    color: [20, 80, 160],
    shadow: null,
    locomotion: 'water',
    isBoss: true,
    hpBase: 60,
    hpStep: 40,
    sizeStep: 0.25,
    maxSizeMult: 2.0,
    spawnWeight: 0,
    minLevel: 5
  }
};

// Legacy compatibility aliases — used by gameLoop.js, gameRenderer.js, etc.
const ENEMY_COLORS = {};
const ENEMY_SHADOW_DIMS = {};
for (const [type, cfg] of Object.entries(ENEMY_TYPES)) {
  ENEMY_COLORS[type] = cfg.color;
  if (cfg.shadow) ENEMY_SHADOW_DIMS[type] = cfg.shadow;
}

// (Scorpion constants moved to constants.js)

export class EnemyManager {
  constructor() {
    /** @type {Array<object>} Live enemy objects. Each has at minimum: x, y, z, vx, vz, type. */
    this.enemies = [];
    this.updateHandlers = {
      fighter:   (e, alivePlayers, refShip) => EnemyAirAI.updateFighter(e, alivePlayers, refShip, this),
      bomber:    (e, _alivePlayers, refShip) => EnemyAirAI.updateBomber(e, refShip, this),
      crab:      (e, alivePlayers, refShip) => EnemyGroundAI.updateCrab(e, alivePlayers, refShip, this),
      hunter:    (e, alivePlayers, refShip) => EnemyAirAI.updateHunter(e, alivePlayers, refShip, this),
      squid:     (e, alivePlayers, refShip) => EnemyAirAI.updateSquid(e, alivePlayers, refShip, this),
      scorpion:  (e, alivePlayers, refShip) => EnemyGroundAI.updateScorpion(e, alivePlayers, refShip, this),
      colossus:  (e, alivePlayers, refShip) => EnemyBossAI.updateColossus(e, alivePlayers, refShip, this),
      yellowCrab:(e, alivePlayers, refShip) => EnemyGroundAI.updateYellowCrab(e, alivePlayers, refShip, this),
      seeder:    (e, _alivePlayers, refShip) => EnemyAirAI.updateSeeder(e, refShip, this),
      wolf:      (e, alivePlayers, refShip) => EnemyGroundAI.updateWolf(e, alivePlayers, refShip, this),
      kraken:    (e, alivePlayers, refShip) => EnemyBossAI.updateKraken(e, alivePlayers, refShip, this)
    };
    // Reusable alive-player list — reset with .length=0 each frame to avoid
    // allocating a fresh array every update() call (which is called at 60 fps).
    this._alivePlayers = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Removes all enemies. Called at the start of each level. */
  clear() {
    this.enemies.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the RGB colour associated with a given enemy type.
   * Used for explosion tinting and radar dots.
   * @param {string} type  Enemy type string.
   * @returns {number[]} RGB array [r, g, b].
   */
  getColor(type) {
    const cfg = ENEMY_TYPES[type];
    return cfg ? cfg.color : [220, 30, 30];  // Default: seeder red
  }

  /** Returns nearest alive ship or fallback reference ship. */
  _getTargetShip(e, alivePlayers, refShip) {
    return findNearest(alivePlayers, e.x, e.y, e.z) || refShip;
  }

  /** Reflects enemy velocity if it moves too far from the reference ship. */
  _reflectWithinRefBounds(e, refShip, limit) {
    if (Math.abs(e.x - refShip.x) > limit) e.vx *= -1;
    if (Math.abs(e.z - refShip.z) > limit) e.vz *= -1;
  }

  /**
   * Ground infection helper used by multiple ground-based enemies.
   * @param {object} e              Enemy state.
   * @param {number} gy             Terrain altitude at enemy position.
   * @param {string} infType        Infection type key ('normal' or 'yellow').
   * @param {number} pulseType      Pulse ring type for terrain.addPulse() (0=bomb, 1=crab, etc.).
   * @param {boolean} spreadNeighbors  If true, also infects adjacent tiles probabilistically.
   */
  _tryInfectGround(e, gy, infType = 'normal', pulseType = 0.0, spreadNeighbors = false) {
    if (aboveSea(gy)) return;

    const tx = toTile(e.x), tz = toTile(e.z);
    const k = tileKey(tx, tz);
    if (infection.add(k, infType)) {
      if (isLaunchpad(e.x, e.z)) maybePlayLaunchpadAlarm();
      terrain.addPulse(e.x, e.z, pulseType);
    }

    if (!spreadNeighbors) return;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        if (p.random() < 0.25) {
          let nk = tileKey(tx + di, tz + dj);
          if (!infection.has(nk)) {
            let nx = (tx + di) * TILE, nz = (tz + dj) * TILE;
            if (!aboveSea(terrain.getAltitude(nx, nz))) infection.add(nk);
          }
        }
      }
    }
  }

  /** Common upward projectile used by crab/scorpion families. */
  _fireUpwardShot(e, shotType = 'crab', vy = -12) {
    particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy, vz: 0, life: ENEMY_CRAB_BULLET_LIFE });
    gameSFX?.playEnemyShot(shotType, e.x, e.y - 10, e.z);
  }

  /** Shared 2D pursuit steering with velocity smoothing. */
  _steer2D(e, tx, tz, speed, smooth) {
    const dx = tx - e.x, dz = tz - e.z;
    const d = Math.hypot(dx, dz);
    if (d > 0) {
      e.vx = p.lerp(e.vx || 0, (dx / d) * speed, smooth);
      e.vz = p.lerp(e.vz || 0, (dz / d) * speed, smooth);
    }
    return { dx, dz, d };
  }

  /** Shared 3D pursuit steering with velocity smoothing. */
  _steer3D(e, tx, ty, tz, speed, smooth) {
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    const d = mag3(dx, dy, dz);
    if (d > 0) {
      e.vx = p.lerp(e.vx || 0, (dx / d) * speed, smooth);
      e.vy = p.lerp(e.vy || 0, (dy / d) * speed, smooth);
      e.vz = p.lerp(e.vz || 0, (dz / d) * speed, smooth);
    }
    return { dx, dy, dz, d };
  }

  /**
   * Terrain avoidance for flying enemies.
   * Pushes the enemy upward if it is within 'margin' units of the ground.
   * @param {object} e         Enemy state.
   * @param {number} margin    Distance from ground to start pushing.
   * @param {number} strength  Upward acceleration strength.
   */
  _applyTerrainAvoidance(e, margin = 150, strength = 0.5) {
    const gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - margin) {
      // Linear repulsion that gets stronger as the enemy gets closer to the ground
      const penetration = (e.y - (gy - margin)) / margin;
      e.vy = (e.vy || 0) - strength * (1.0 + penetration);
    }
  }

  /**
   * Consolidates integration and damping for flying enemies.
   * @param {object} e         Enemy state.
   * @param {number} dampingY  Vertical velocity damping (1.0 = none).
   * @param {number} speedMult Horizontal speed multiplier.
   */
  _updateFlyingMovement(e, dampingY = 1.0, speedMult = 1.0) {
    e.x += (e.vx || 0) * speedMult;
    e.z += (e.vz || 0) * speedMult;
    e.y += e.vy || 0;
    if (e.vy) e.vy *= dampingY;
  }

  /** Drops a bomb over land; optionally requires a clean (uninfected) tile. */
  _tryDropBomb(e, type = 'normal', requireCleanTile = true) {
    const gy = terrain.getAltitude(e.x, e.z);
    if (aboveSea(gy)) return false;

    const tx = toTile(e.x), tz = toTile(e.z);
    const k = tileKey(tx, tz);
    if (requireCleanTile && infection.has(k)) return false;

    const bomb = { x: e.x, y: e.y, z: e.z, k };
    if (type !== 'normal') bomb.type = type;
    particleSystem.bombs.push(bomb);
    gameSFX?.playBombDrop(type, e.x, e.y, e.z);
    return true;
  }

  /**
   * Snaps a ground-hugging enemy to terrain altitude.
   * @param {object} e       Enemy state (mutated in place).
   * @param {number} yOffset Vertical offset below terrain (negative = above).
   * @returns {number} The raw terrain altitude at (e.x, e.z).
   */
  _snapToGround(e, yOffset = -10) {
    const gy = terrain.getAltitude(e.x, e.z);
    e.y = gy + yOffset;
    return gy;
  }

  /**
   * Applies 2D ground movement: integrate velocity + snap to terrain.
   * Consolidates the e.x += e.vx; e.z += e.vz; e.y = gy + offset pattern.
   * @param {object} e       Enemy state.
   * @param {number} yOffset Vertical offset from terrain surface.
   * @returns {number} The terrain altitude at the new position.
   */
  _moveOnGround(e, yOffset = -10) {
    e.x += e.vx;
    e.z += e.vz;
    return this._snapToGround(e, yOffset);
  }

  // ---------------------------------------------------------------------------
  // Boss helpers — shared between Colossus and Kraken
  // ---------------------------------------------------------------------------

  /**
   * Initializes boss entry data (HP, scale, tier) using the type registry config.
   * @param {object} entry     The enemy entry object being constructed.
   * @param {string} type      Boss type key ('colossus' or 'kraken').
   * @param {string} countKey  gameState property tracking spawn count.
   * @param {string} tierKey   Property name for tier on the enemy object.
   * @param {string} scaleKey  Property name for scale on the enemy object.
   */
  _initBoss(entry, type, countKey, tierKey, scaleKey) {
    const cfg = ENEMY_TYPES[type];
    gameState[countKey] = (gameState[countKey] || 0) + 1;
    const tier = gameState[countKey];
    const hp = cfg.hpBase + (tier - 1) * cfg.hpStep;
    entry[tierKey] = tier;
    entry[scaleKey] = Math.min(1 + (tier - 1) * cfg.sizeStep, cfg.maxSizeMult);
    entry.hp = hp;
    entry.maxHp = hp;
    entry.hitFlash = 0;
  }

  /**
   * Shared burst-fire logic for boss enemies.
   * Manages burst count, cooldown, and individual bullet spawning.
   * @param {object} e          Enemy state.
   * @param {object} tShip      Target ship for aiming.
   * @param {number} d          Distance to target.
   * @param {object} cfg        Burst config: { range, interval, count, spacing, speed, spread, scaleKey, muzzleYFactor, bulletLife }
   */
  _updateBurstFire(e, tShip, d, cfg) {
    e.fireTimer = (e.fireTimer || 0) + 1;
    if (d < cfg.range && e.fireTimer >= cfg.interval) {
      e.burstCount = cfg.count;
      e.burstCooldown = 0;
      e.fireTimer = 0;
    }
    if (e.burstCount > 0) {
      e.burstCooldown = (e.burstCooldown || 0) + 1;
      if (e.burstCooldown >= cfg.spacing) {
        e.burstCooldown = 0;
        e.burstCount--;
        const eScale = e[cfg.scaleKey] || 1;
        const muzzleYOffset = cfg.muzzleYFactor * eScale;
        let bdx = tShip.x - e.x;
        let bdy = tShip.y - (e.y - muzzleYOffset);
        let bdz = tShip.z - e.z;
        let bd = mag3(bdx, bdy, bdz);
        if (bd > 0) {
          particleSystem.enemyBullets.push({
            x: e.x, y: e.y - muzzleYOffset, z: e.z,
            vx: (bdx / bd) * cfg.speed + p.random(-cfg.spread, cfg.spread) * cfg.speed,
            vy: (bdy / bd) * cfg.speed,
            vz: (bdz / bd) * cfg.speed + p.random(-cfg.spread, cfg.spread) * cfg.speed,
            life: cfg.bulletLife
          });
          gameSFX?.playEnemyShot('fighter', e.x, e.y - muzzleYOffset, e.z);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /**
   * Spawns a new enemy at a random world position.
   * The first enemy of each level is forced to be a seeder so that infection
   * begins immediately.  Subsequent enemies are weighted randomly.
   *
   * Spawn probability weights (when not forced):
   *   Seeder 32% | Fighter 22% | Bomber 15% | Crab 12% | Hunter/YellowCrab 6% |
   *   Squid 6% | Scorpion 4% | Wolf 3%
   * The Colossus is guaranteed to appear once every 3 levels (not Kraken levels).
   * The Kraken appears every 5 levels as an alternative boss.
   *
   * @param {boolean} [forceSeeder=false]  If true, always spawns a seeder regardless of level.
   * @param {boolean} [forceColossus=false] If true, forces a Colossus boss spawn.
   * @param {boolean} [forceKraken=false]  If true, forces a Kraken boss spawn.
   */
  spawn(forceSeeder = false, forceColossus = false, forceKraken = false) {
    let type = 'seeder';
    if (forceKraken) {
      type = 'kraken';
    } else if (forceColossus) {
      type = 'colossus';
    } else if (!forceSeeder && gameState.level > 0) {
      type = this._rollEnemyType();
    }

    const { x: ex, y: ey, z: ez } = this._getSpawnPosition(type);

    let entry = {
      x: ex, y: ey, z: ez,
      vx: p.random(-2, 2), vz: p.random(-2, 2),
      id: p.random(),        // Unique random seed used for per-enemy animation phase offsets
      type,
      fireTimer: 0,        // Counts frames since last bullet fired
      bombTimer: 0         // Counts frames since last bomb dropped (bomber/fighter/scorpion)
    };

    // Boss initialization using unified helper
    if (type === 'colossus') {
      this._initBoss(entry, 'colossus', 'colossusSpawnCount', 'colossusTier', 'colossusScale');
    } else if (type === 'kraken') {
      this._initBoss(entry, 'kraken', 'krakenSpawnCount', 'krakenTier', 'krakenScale');
    }

    this.enemies.push(entry);
  }

  /**
   * Rolls a random enemy type based on spawn weights.
   * Reproduces the original probability distribution exactly.
   * @returns {string} Enemy type key.
   * @private
   */
  _rollEnemyType() {
    let r = p.random();
    if (r < 0.32) return 'seeder';
    if (r < 0.54) return 'fighter';
    if (r < 0.69) return 'bomber';
    if (r < 0.81) return 'crab';
    if (r < 0.87) {
      if (gameState.level >= 4 && r < 0.84) return 'yellowCrab';
      return 'hunter';
    }
    if (r < 0.93) return 'squid';
    if (r < 0.97) return 'scorpion';
    return 'wolf';
  }

  /**
   * Computes spawn position for a given enemy type.
   * @param {string} type Enemy type key.
   * @returns {{x: number, y: number, z: number}} World-space position.
   * @private
   */
  _getSpawnPosition(type) {
    if (type === 'colossus') {
      return this._getColossusSpawnPosition();
    }
    if (type === 'kraken') {
      return this._getKrakenSpawnPosition();
    }

    const cfg = ENEMY_TYPES[type];
    const ex = p.random(-4000, 4000);
    const ez = p.random(-4000, 4000);

    if (cfg && cfg.locomotion === 'ground') {
      return { x: ex, y: terrain.getAltitude(ex, ez) - 10, z: ez };
    }

    return { x: ex, y: p.random(-300, -800), z: ez };
  }

  /** @private Colossus: far polar offset so the player has time to react. */
  _getColossusSpawnPosition() {
    const angle = p.random((Math.PI * 2));
    const dist = p.random(2500, 4000);
    const ex = Math.cos(angle) * dist;
    const ez = Math.sin(angle) * dist;
    return { x: ex, y: terrain.getAltitude(ex, ez), z: ez };
  }

  /**
   * @private Kraken: must spawn on water. Uses random angular sampling (60 attempts)
   * with a grid-scan fallback to guarantee a water tile.
   */
  _getKrakenSpawnPosition() {
    let ex, ey, ez;

    // Random angular sampling — 60 attempts
    for (let attempt = 0; attempt < 60; attempt++) {
      const angle = p.random((Math.PI * 2));
      const dist = p.random(1500, 4500);
      ex = Math.cos(angle) * dist;
      ez = Math.sin(angle) * dist;
      ey = terrain.getAltitude(ex, ez);
      if (aboveSea(ey)) return { x: ex, y: ey, z: ez };
    }

    // Grid-scan fallback: guaranteed water spawn
    for (let r = 1500; r <= 5000; r += 400) {
      for (let a = 0; a < 16; a++) {
        const cx = Math.cos((a / 16) * (Math.PI * 2)) * r;
        const cz = Math.sin((a / 16) * (Math.PI * 2)) * r;
        if (aboveSea(terrain.getAltitude(cx, cz))) {
          return { x: cx, y: terrain.getAltitude(cx, cz), z: cz };
        }
      }
    }

    // Ultimate fallback — should never reach here
    return { x: 3000, y: SEA, z: 3000 };
  }

  // ---------------------------------------------------------------------------
  // Per-frame AI update
  // ---------------------------------------------------------------------------

  /**
   * Updates all enemies for the current frame.
   * Builds a list of alive player ships to use as targeting input, then
   * dispatches to the appropriate per-type update method.
   */
  update() {
    const alivePlayers = this._alivePlayers;
    alivePlayers.length = 0;
    for (let i = 0; i < gameState.players.length; i++) {
      if (!gameState.players[i].dead) alivePlayers.push(gameState.players[i].ship);
    }
    let refShip = alivePlayers[0] || gameState.players[0].ship;  // Fallback to P1 even if dead

    for (let e of this.enemies) {
      const handler = this.updateHandlers[e.type] || this.updateHandlers.seeder;
      handler(e, alivePlayers, refShip);
    }
  }



  // ---------------------------------------------------------------------------
  // Rendering — delegates to EnemyRenderer
  // ---------------------------------------------------------------------------

  /**
   * Renders all enemies visible from the given ship's position.
   * Delegates to the EnemyRenderer singleton.
   * @param {{x,y,z,yaw}} s  Ship state used as the view origin for culling.
   */
  draw(s) {
    enemyRenderer.draw(this.enemies, s);
  }
}

// Singleton instance used by all other modules
const enemyRenderer = new EnemyRenderer();
export const enemyManager = new EnemyManager();
