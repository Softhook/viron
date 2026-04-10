// =============================================================================
// enemies.js — EnemyManager class
//
// Owns the active enemy list and all AI update logic.
// Rendering has been extracted to enemyRenderer.js (EnemyRenderer class).
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

// Seeder double-diamond geometry: two layers, each defined by [yOffset, r, g, b].
// Hoisted out of the draw loop so the nested array literal is not re-allocated every frame.
const SEEDER_LAYERS = [[-10, 220, 30, 30], [6, 170, 15, 15]];

// Uniform scale applied to every enemy mesh in both rendering passes.
const ENEMY_DRAW_SCALE = 4;

// Enemy projectile lifetime constants (frames).
// Centralised here so all enemy types and boss burst-fire configs reference
// the same source of truth instead of scattering raw numbers.
const ENEMY_BULLET_LIFE      = 1000;  // Standard enemy bullets (fighter, colossus)
const ENEMY_CRAB_BULLET_LIFE = 1000;  // Crab / scorpion upward shots
const BOSS_BULLET_LIFE       = 1200;  // Kraken burst projectiles (longer range)
const KRAKEN_TENTACLE_LIFE   = 900;   // Kraken tentacle lash projectiles

// Enemy Behavior Constants
const BOMBER_BOUNDARY_LIMIT      = 4000;
const BOMBER_DROP_INTERVAL_TICKS = 600;
const SEEDER_BOUNDARY_LIMIT      = 5000;
const FIGHTER_STATE_TOGGLE_TICKS = 120;

// =============================================================================
// Enemy Type Registry — single source of truth for per-type configuration.
//
// Every enemy type's static properties (color, shadow, locomotion, boss config,
// spawn weights) are defined here, replacing the scattered ENEMY_COLORS,
// ENEMY_SHADOW_DIMS, and inline spawn checks.
// =============================================================================

const ENEMY_TYPES = {
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

// Scorpion stuck-detection: if the scorpion stops making progress toward its chosen
// sentinel (distance is not decreasing) for this many consecutive ticks, the target
// is added to a temporary skip-list.
const SCORPION_STUCK_THRESHOLD_TICKS = 300;   // ~5 s of no progress at 60 Hz
const SCORPION_SKIP_DURATION_TICKS   = 1800;  // ~30 s skip window

class EnemyManager {
  constructor() {
    /** @type {Array<object>} Live enemy objects. Each has at minimum: x, y, z, vx, vz, type. */
    this.enemies = [];
    this.updateHandlers = {
      fighter:   (e, alivePlayers, refShip) => this.updateFighter(e, alivePlayers, refShip),
      bomber:    (e, _alivePlayers, refShip) => this.updateBomber(e, refShip),
      crab:      (e, alivePlayers, refShip) => this.updateCrab(e, alivePlayers, refShip),
      hunter:    (e, alivePlayers, refShip) => this.updateHunter(e, alivePlayers, refShip),
      squid:     (e, alivePlayers, refShip) => this.updateSquid(e, alivePlayers, refShip),
      scorpion:  (e, alivePlayers, refShip) => this.updateScorpion(e, alivePlayers, refShip),
      colossus:  (e, alivePlayers, refShip) => this.updateColossus(e, alivePlayers, refShip),
      yellowCrab:(e, alivePlayers, refShip) => this.updateYellowCrab(e, alivePlayers, refShip),
      seeder:    (e, _alivePlayers, refShip) => this.updateSeeder(e, refShip),
      wolf:      (e, alivePlayers, refShip) => this.updateWolf(e, alivePlayers, refShip),
      kraken:    (e, alivePlayers, refShip) => this.updateKraken(e, alivePlayers, refShip)
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
    if (abs(e.x - refShip.x) > limit) e.vx *= -1;
    if (abs(e.z - refShip.z) > limit) e.vz *= -1;
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
        if (random() < 0.25) {
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
    const d = mag2(dx, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, smooth);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, smooth);
    }
    return { dx, dz, d };
  }

  /** Shared 3D pursuit steering with velocity smoothing. */
  _steer3D(e, tx, ty, tz, speed, smooth) {
    const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    const d = mag3(dx, dy, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, smooth);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, smooth);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, smooth);
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
    entry[scaleKey] = min(1 + (tier - 1) * cfg.sizeStep, cfg.maxSizeMult);
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
            vx: (bdx / bd) * cfg.speed + random(-cfg.spread, cfg.spread) * cfg.speed,
            vy: (bdy / bd) * cfg.speed,
            vz: (bdz / bd) * cfg.speed + random(-cfg.spread, cfg.spread) * cfg.speed,
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
      vx: random(-2, 2), vz: random(-2, 2),
      id: random(),        // Unique random seed used for per-enemy animation phase offsets
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
    let r = random();
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
    const ex = random(-4000, 4000);
    const ez = random(-4000, 4000);

    if (cfg && cfg.locomotion === 'ground') {
      return { x: ex, y: terrain.getAltitude(ex, ez) - 10, z: ez };
    }

    return { x: ex, y: random(-300, -800), z: ez };
  }

  /** @private Colossus: far polar offset so the player has time to react. */
  _getColossusSpawnPosition() {
    const angle = random(TWO_PI);
    const dist = random(2500, 4000);
    const ex = cos(angle) * dist;
    const ez = sin(angle) * dist;
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
      const angle = random(TWO_PI);
      const dist = random(1500, 4500);
      ex = cos(angle) * dist;
      ez = sin(angle) * dist;
      ey = terrain.getAltitude(ex, ez);
      if (aboveSea(ey)) return { x: ex, y: ey, z: ez };
    }

    // Grid-scan fallback: guaranteed water spawn
    for (let r = 1500; r <= 5000; r += 400) {
      for (let a = 0; a < 16; a++) {
        const cx = cos((a / 16) * TWO_PI) * r;
        const cz = sin((a / 16) * TWO_PI) * r;
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
  // Enemy-type AI methods
  // ---------------------------------------------------------------------------

  /**
   * Bomber AI: drifts in a straight line at 1.5× base speed, bobbing vertically
   * on a sine wave.  Bounces off an invisible boundary 4000 units from the reference
   * ship.  Drops a 'mega' bomb every 600 frames when over non-sea terrain.
   * @param {object} e        Enemy state object (mutated in place).
   * @param {object} refShip  Reference ship position used for boundary checks.
   */
  updateBomber(e, refShip) {
    e.y += sin(physicsEngine.tickCount * 0.02 + e.id);  // Gentle vertical oscillation

    // Terrain avoidance: push up to maintain clearance over mountains
    this._applyTerrainAvoidance(e, 200, 0.4);

    // Integrate vertical physics with 0.92 damping and 1.5x horizontal speed
    this._updateFlyingMovement(e, 0.92, 1.5);

    // Reflect velocity when too far from the reference ship
    this._reflectWithinRefBounds(e, refShip, BOMBER_BOUNDARY_LIMIT);

    e.bombTimer++;
    if (e.bombTimer > BOMBER_DROP_INTERVAL_TICKS) {
      e.bombTimer = 0;
      this._tryDropBomb(e, 'mega', false);
    }
  }

  /**
   * Crab AI: hugs the ground and slowly steers toward the nearest alive player
   * using lerped velocity.  Fires an upward bullet when within 1500 units.
   * Randomly infects the tile below it and triggers an alarm if it reaches the
   * launchpad.
   * @param {object}   e            Enemy state.
   * @param {object[]} alivePlayers Array of alive ship state objects.
   * @param {object}   refShip      Fallback target ship.
   */
  updateCrab(e, alivePlayers, refShip) {
    this._updateCrabAI(e, alivePlayers, refShip, 1.2, 0.02, 'normal', 1.0);
  }

  /**
   * Yellow Crab AI: similar to Crab but spreads the faster-growing Yellow Virus.
   */
  updateYellowCrab(e, alivePlayers, refShip) {
    this._updateCrabAI(e, alivePlayers, refShip, 1.5, 0.04, 'yellow', 1.0);
  }

  /**
   * Shared logic for ground-hugging crab enemies.
   * @param {object} e            Enemy state.
   * @param {object[]} alivePlayers Alive ships.
   * @param {object} refShip      Fallback.
   * @param {number} speed        Movement speed factor.
   * @param {number} infProb      Probability of tile infection per frame.
   * @param {string} infType      Type of virus to spread ('normal' or 'yellow' [yellow virus]).
   * @param {number} pulseType    Pulse ring type for terrain.addPulse() (1 = blue/crab).
   */
  _updateCrabAI(e, alivePlayers, refShip, speed, infProb, infType, pulseType) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);

    let { d } = this._steer2D(e, tShip.x, tShip.z, speed, 0.05);

    const gyC = this._moveOnGround(e);

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      this._fireUpwardShot(e, 'crab');
    }

    if (random() < infProb) {
      this._tryInfectGround(e, gyC, infType, pulseType);
    }
  }

  /**
   * Hunter AI: fast 3D pursuer that homes toward the nearest alive player.
   * No weapons — kills purely by body collision.  Pushes upward when too close
   * to the ground to avoid clipping.
   * @param {object}   e            Enemy state.
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateHunter(e, alivePlayers, refShip) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);
    this._steer3D(e, tShip.x, tShip.y, tShip.z, 5.0, 0.1);

    // Terrain avoidance: push up if within 100 units of the ground
    this._applyTerrainAvoidance(e, 100, 1.0);

    this._updateFlyingMovement(e);
  }

  /**
   * Fighter AI: alternates between an aggressive pursuit phase and a wander phase
   * on a 120-frame cycle.  Fires aimed bullets with slight spread when in range.
   * Terrain avoidance prevents it from flying into the ground.
   * @param {object}   e            Enemy state (carries stateTimer, aggressive, wanderX/Z).
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateFighter(e, alivePlayers, refShip) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);

    // State machine: toggle aggressive/wandering
    e.stateTimer = (e.stateTimer || 0) + 1;
    if (e.stateTimer > FIGHTER_STATE_TOGGLE_TICKS) {
      e.stateTimer = 0;
      e.aggressive = random() > 0.5;
      if (!e.aggressive) {
        e.wanderX = e.x + random(-1500, 1500);
        e.wanderZ = e.z + random(-1500, 1500);
      }
    }

    let tx = e.aggressive ? tShip.x : (e.wanderX || e.x);
    let tz = e.aggressive ? tShip.z : (e.wanderZ || e.z);
    let ty = e.aggressive ? tShip.y : -600;  // Wander at high altitude

    let { dx, dy, dz, d } = this._steer3D(e, tx, ty, tz, 2.5, 0.05);

    // Terrain avoidance: push up if within 150 units of the ground
    this._applyTerrainAvoidance(e, 150, 0.5);

    this._updateFlyingMovement(e);

    // Fire a bullet toward the player with small random spread, every 90 frames when in range
    e.fireTimer++;
    if (e.aggressive && d < 1200 && e.fireTimer > 90) {
      e.fireTimer = 0;
      let pvx = (dx / d) + random(-0.2, 0.2);
      let pvy = (dy / d) + random(-0.2, 0.2);
      let pvz = (dz / d) + random(-0.2, 0.2);
      let pd = mag3(pvx, pvy, pvz);
      particleSystem.enemyBullets.push({
        x: e.x, y: e.y, z: e.z,
        vx: (pvx / pd) * 10, vy: (pvy / pd) * 10, vz: (pvz / pd) * 10,
        life: ENEMY_BULLET_LIFE
      });
      gameSFX?.playEnemyShot('fighter', e.x, e.y, e.z);
    }

    // While wandering, occasionally drop an infection bomb (less frequent than seeder)
    if (!e.aggressive) {
      e.bombTimer = (e.bombTimer || 0) + 1;
      if (e.bombTimer > 300 && random() < 0.002) {
        e.bombTimer = 0;
        this._tryDropBomb(e, 'normal', true);
      }
    }
  }

  /**
   * Seeder AI: slow wandering drifter that bobs on a sine wave.  Has an 0.8%
   * chance per frame of dropping a normal infection bomb on the tile below it.
   * Bounces off a 5000-unit boundary around the reference ship.
   * @param {object} e        Enemy state.
   * @param {object} refShip  Boundary reference ship.
   */
  updateSeeder(e, refShip) {
    e.y += sin(physicsEngine.tickCount * 0.05 + e.id) * 2;  // Gentle vertical oscillation

    // Terrain avoidance: maintain flight level over mountains
    this._applyTerrainAvoidance(e, 250, 0.3);

    // Integrate vertical physics with 0.92 damping
    this._updateFlyingMovement(e, 0.92);

    this._reflectWithinRefBounds(e, refShip, SEEDER_BOUNDARY_LIMIT);

    if (random() < 0.008) {
      this._tryDropBomb(e, 'normal', true);
    }
  }

  /**
   * Scorpion AI: a ground-hugging enemy with two modes.
   * Mode 1 — Sentinel hunt: steers toward the nearest uninfected sentinel building
   *           and infects the tile beneath it on contact.  Prioritises infecting
   *           sentinels because an infected sentinel spreads virus rapidly.
   * Mode 2 — Launchpad assault: if no healthy sentinels remain (or all are out of
   *           range), it crawls toward the launchpad centre and randomly infects
   *           tiles below itself, triggering the launchpad alarm.
   * The scorpion fires an upward bullet at any player within 1200 units.
   * @param {object}   e            Enemy state.
   * @param {object[]} alivePlayers Alive ship states (pre-computed by update()).
   * @param {object}   refShip      Fallback target for boundary checks.
   */
  updateScorpion(e, alivePlayers, refShip) {
    const LP_CENTER = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420

    let targetX, targetZ;

    if (isLaunchpad(e.x, e.z)) {
      // --- Mode 3: On the launchpad — hunt the nearest player like a crab ---
      let tShip = this._getTargetShip(e, alivePlayers, refShip);
      targetX = tShip.x;
      targetZ = tShip.z;
    } else {
      // Lazily evict timed-out skip entries so a previously-blocked sentinel
      // can be retried after its barrier is removed.
      if (!e._skipSentinels) e._skipSentinels = new Map();
      for (const [s, expiry] of e._skipSentinels) {
        if (physicsEngine.tickCount >= expiry) e._skipSentinels.delete(s);
      }

      // --- Mode 1: Hunt nearest healthy, reachable (unbarriered) sentinel ---
      let bestDist = Infinity;
      targetX = null; targetZ = null;
      let chosen = null;
      for (let b of gameState.buildings) {
        if (b.type !== 4) continue;
        if (e._skipSentinels.has(b)) continue;       // Temporarily skipped
        const sk = tileKey(toTile(b.x), toTile(b.z));
        if (infection.has(sk)) continue;             // Already infected — skip
        if (gameState.barrierTiles.has(sk)) continue; // Barrier-protected — can never be infected
        const distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
        if (distSq < bestDist) { bestDist = distSq; targetX = b.x; targetZ = b.z; chosen = b; }
      }

      // Stuck detection: only count ticks when the scorpion is NOT closing the
      // gap to its target.
      if (chosen !== e._scorpionTarget) {
        e._scorpionTarget = chosen;
        e._scorpionStuckTicks = 0;
        e._scorpionPrevDistSq = chosen !== null
          ? (chosen.x - e.x) ** 2 + (chosen.z - e.z) ** 2
          : Infinity;
      } else if (chosen !== null) {
        const curDistSq = (chosen.x - e.x) ** 2 + (chosen.z - e.z) ** 2;
        if (curDistSq >= (e._scorpionPrevDistSq || Infinity)) {
          e._scorpionStuckTicks = (e._scorpionStuckTicks || 0) + 1;
        } else {
          e._scorpionStuckTicks = Math.max(0, (e._scorpionStuckTicks || 0) - 1);
        }
        e._scorpionPrevDistSq = curDistSq;
        if (e._scorpionStuckTicks > SCORPION_STUCK_THRESHOLD_TICKS) {
          e._skipSentinels.set(chosen, physicsEngine.tickCount + SCORPION_SKIP_DURATION_TICKS);
          e._scorpionTarget = null;
          e._scorpionStuckTicks = 0;
          e._scorpionPrevDistSq = Infinity;
          targetX = null; targetZ = null;
          // Find next best excluding the just-skipped sentinel
          let altBest = Infinity;
          for (let b of gameState.buildings) {
            if (b.type !== 4 || e._skipSentinels.has(b)) continue;
            const sk = tileKey(toTile(b.x), toTile(b.z));
            if (infection.has(sk) || gameState.barrierTiles.has(sk)) continue;
            const distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
            if (distSq < altBest) { altBest = distSq; targetX = b.x; targetZ = b.z; }
          }
        }
      }

      // --- Mode 2: No valid sentinel — march toward the launchpad ---
      if (targetX === null) {
        targetX = LP_CENTER;
        targetZ = LP_CENTER;
      }
    }

    this._steer2D(e, targetX, targetZ, 1.5, 0.04);

    const gyS = this._moveOnGround(e, -20);

    // Infect tiles below — triggers launchpad alarm when relevant
    if (random() < 0.025) {
      this._tryInfectGround(e, gyS);
    }

    // Fire upward bullet at nearby players every 150 frames
    e.fireTimer = (e.fireTimer || 0) + 1;
    let target = this._getTargetShip(e, alivePlayers, refShip);
    if (target) {
      let pd = mag2(target.x - e.x, target.z - e.z);
      if (pd < 1200 && e.fireTimer > 150) {
        e.fireTimer = 0;
        this._fireUpwardShot(e, 'crab', -10);
      }
    }
  }

  /**
   * Colossus BOSS AI: A massive ground-walking block-humanoid.
   * - Walks slowly but relentlessly toward the nearest player on two legs.
   * - Fires burst salvos of 3 aimed bullets every 120 frames when in range.
   * - Leaves virus infection in its footsteps as it marches.
   * - HP starts at 30 and increases by +30 for each Colossus spawn in a run.
   * - Size scales by spawn tier (capped) to match increasing threat.
   * @param {object}   e            Enemy state (carries hp, maxHp, hitFlash).
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateColossus(e, alivePlayers, refShip) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);

    // Slow, deliberate movement toward the player
    let { d } = this._steer2D(e, tShip.x, tShip.z, 1.2, 0.025);

    const gyCo = this._moveOnGround(e, 0);

    // Tick down the hit-flash timer
    if (e.hitFlash > 0) e.hitFlash--;

    // --- Burst fire using shared boss helper ---
    this._updateBurstFire(e, tShip, d, {
      range: 2500,
      interval: 120,
      count: 3,
      spacing: 8,
      speed: 14,
      spread: 0.12,
      scaleKey: 'colossusScale',
      muzzleYFactor: 240,
      bulletLife: ENEMY_BULLET_LIFE
    });

    // --- Virus trail: infect tiles below the Colossus as it lumbers along ---
    if (random() < 0.06) {
      this._tryInfectGround(e, gyCo, 'normal', 1.0, true);
    }
  }

  /**
   * Wolf AI: a ground-hugging predator that hunts villagers and targets villages.
   * - Seeks out the nearest villager and kills it on contact.
   * - When no villager is nearby, it steers toward the nearest village (pagoda) to
   *   spread the virus there.
   * - Falls back to targeting the player ship if no villages exist.
   * - Leaves a virus trail in its wake, prioritising village tiles.
   * @param {object}   e            Enemy state.
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateWolf(e, alivePlayers, refShip) {
    let targetX = null, targetZ = null;
    let bestDistSq = Infinity;

    // Priority 1: seek the nearest villager
    if (villagerManager) {
      for (let v of villagerManager.villagers) {
        const d2 = (v.x - e.x) ** 2 + (v.z - e.z) ** 2;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          targetX = v.x;
          targetZ = v.z;
        }
      }
    }

    // If within striking range of a villager, kill it
    if (targetX !== null && bestDistSq < 3600) {   // ~60 units
      if (villagerManager) {
        for (let i = villagerManager.villagers.length - 1; i >= 0; i--) {
          const v = villagerManager.villagers[i];
          if ((v.x - e.x) ** 2 + (v.z - e.z) ** 2 < 3600) {
            villagerManager.killVillagerAtIndex(i);
            break;
          }
        }
      }
    }

    // Priority 2: if no villager nearby, head to a village (pagoda, type 2).
    // The wolf persists a _wolfNextVillage target across frames so the arrival
    // check can fire after the wolf has physically moved there.
    // Skips the last-visited village as long as the wolf remains close to it,
    // so it roams from village to village instead of getting stuck at one.
    if (targetX === null || bestDistSq > 800 * 800) {
      // Only pick a new village target when we don't already have one pending
      if (!e._wolfNextVillage) {
        let villageBest = Infinity;
        for (let b of gameState.buildings) {
          if (b.type !== 2) continue;
          // Skip the last village we just visited — unless we've moved far enough away
          if (b === e._wolfLastVillage) {
            const d2ToLast = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
            if (d2ToLast < 250 * 250) continue;
            else e._wolfLastVillage = null;
          }
          const d2 = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
          if (d2 < villageBest) {
            villageBest = d2;
            e._wolfNextVillage = b;
          }
        }
      }

      if (e._wolfNextVillage) {
        targetX = e._wolfNextVillage.x;
        targetZ = e._wolfNextVillage.z;
      }
    }

    // Arrived at the pending village — register it so we pick a different one next time
    if (e._wolfNextVillage) {
      const vd2 = (e._wolfNextVillage.x - e.x) ** 2 + (e._wolfNextVillage.z - e.z) ** 2;
      if (vd2 < 150 * 150) {
        e._wolfLastVillage = e._wolfNextVillage;
        e._wolfNextVillage = null;
      }
    }

    // Fallback: chase the player
    if (targetX === null) {
      const tShip = this._getTargetShip(e, alivePlayers, refShip);
      targetX = tShip.x;
      targetZ = tShip.z;
    }

    this._steer2D(e, targetX, targetZ, 2.0, 0.05);

    const gyW = this._moveOnGround(e);

    // Spread virus; higher probability near villages (infects neighbours)
    if (random() < 0.03) {
      this._tryInfectGround(e, gyW, 'normal', 1.0, true);
    }
  }

  /**
   * Kraken BOSS AI: a massive water-bound sea creature.
   * - Confined strictly to water tiles; reflects velocity when approaching land.
   * - Fires burst salvos of 3 aimed bullets every 150 frames when in range.
   * - Periodically lashes out with far-reaching tentacle strikes in all directions.
   * - HP starts at 60 and increases by +40 for each Kraken spawn in a run.
   * - Size scales by spawn tier (capped).
   * @param {object}   e            Enemy state (carries hp, maxHp, hitFlash, krakenScale).
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateKraken(e, alivePlayers, refShip) {
    const tShip = this._getTargetShip(e, alivePlayers, refShip);

    // Slow, deliberate 2D movement across the water surface
    let { d } = this._steer2D(e, tShip.x, tShip.z, 0.9, 0.018);

    // Water boundary enforcement: test each axis separately before committing
    const testX = e.x + e.vx;
    const testZ = e.z + e.vz;
    const gyTestX = terrain.getAltitude(testX, e.z);
    const gyTestZ = terrain.getAltitude(e.x, testZ);
    if (!aboveSea(gyTestX)) e.vx *= -1;
    if (!aboveSea(gyTestZ)) e.vz *= -1;

    e.x += e.vx;
    e.z += e.vz;

    // Keep at sea level (positive Y = deeper in WEBGL coords)
    e.y = SEA;

    // Tick down hit-flash timer
    if (e.hitFlash > 0) e.hitFlash--;

    // --- Burst fire using shared boss helper ---
    this._updateBurstFire(e, tShip, d, {
      range: 3000,
      interval: 150,
      count: 3,
      spacing: 10,
      speed: 12,
      spread: 0.14,
      scaleKey: 'krakenScale',
      muzzleYFactor: 80,
      bulletLife: BOSS_BULLET_LIFE
    });

    // --- Tentacle lash: 4 radial projectiles + 1 aimed at player every 220 frames ---
    e._tentacleTimer = (e._tentacleTimer || 0) + 1;
    if (d < 2800 && e._tentacleTimer >= 220) {
      e._tentacleTimer = 0;
      const kScale = e.krakenScale || 1;
      const lashY = e.y - 40 * kScale;
      // Four radial sweeps
      for (let t = 0; t < 4; t++) {
        const a = (t / 4) * TWO_PI + random(-0.3, 0.3);
        particleSystem.enemyBullets.push({
          x: e.x, y: lashY, z: e.z,
          vx: cos(a) * 8, vy: random(-1, 0), vz: sin(a) * 8,
          life: KRAKEN_TENTACLE_LIFE
        });
      }
      // One aimed tentacle strike at the player
      const adx = tShip.x - e.x, adz = tShip.z - e.z;
      const ad = mag2(adx, adz);
      if (ad > 0) {
        particleSystem.enemyBullets.push({
          x: e.x, y: lashY, z: e.z,
          vx: (adx / ad) * 10, vy: -0.5, vz: (adz / ad) * 10,
          life: KRAKEN_TENTACLE_LIFE
        });
      }
      gameSFX?.playEnemyShot('fighter', e.x, lashY, e.z);
    }
  }

  /**
   * Squid AI: medium-speed 3D pursuer with an ink-squirt ability.
   * Instead of a constant trail, it periodically releases one very large,
   * dark cloud that rapidly blooms and obscures a wide area.
   * Terrain avoidance prevents ground clipping.
   * @param {object}   e            Enemy state.
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateSquid(e, alivePlayers, refShip) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);

    let { d } = this._steer3D(e, tShip.x, tShip.y, tShip.z, 3.5, 0.05);

    this._applyTerrainAvoidance(e, 150, 1.0);

    // Squirt animation timer: short body squeeze during ink release.
    if (e.inkSqueeze && e.inkSqueeze > 0) e.inkSqueeze--;

    // Ink squirt decision: bursts of large clouds with cooldown.
    if (e.inkCooldown === undefined) e.inkCooldown = floor(random(120, 200));
    e.inkCooldown--;
    if (e.inkCooldown <= 0) {
      let shouldSquirt = (d < 1500 && random() < 0.4) || random() < 0.05;
      if (shouldSquirt) {
        let vm = Math.max(mag3(e.vx || 0, e.vy || 0, e.vz || 0), 0.001);
        let bx = -(e.vx || 0) / vm, by = -(e.vy || 0) / vm, bz = -(e.vz || 0) / vm;
        
        // Vastly increase the area by spawning a burst of multiple large particles
        const count = 3 + floor(random(3));
        for (let i = 0; i < count; i++) {
          particleSystem.addFogParticle({
            x: e.x + bx * 34 + random(-20, 20),
            y: e.y + by * 20 + random(-20, 20),
            z: e.z + bz * 34 + random(-20, 20),
            vx: bx * (1.2 + random(0.5)) + random(-0.4, 0.4),
            vy: by * (0.8 + random(0.4)) + random(-0.3, 0.3),
            vz: bz * (1.2 + random(0.5)) + random(-0.4, 0.4),
            life: random(300, 400),
            decay: 0.9 + random(0.1),
            size: random(850, 1100),
            color: [1, 1, 2],
            isInkBurst: true
          });
        }
        
        e.inkSqueeze = 14;
        // Recoil forward after squirting for a darting squid-like motion.
        const recoil = 0.35;
        e.vx += (e.vx || 0) * recoil;
        e.vy += (e.vy || 0) * recoil;
        e.vz += (e.vz || 0) * recoil;
      }
      e.inkCooldown = floor(random(180, 280));
    }

    this._updateFlyingMovement(e);
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
const enemyManager = new EnemyManager();
