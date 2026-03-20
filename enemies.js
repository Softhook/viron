// =============================================================================
// enemies.js — EnemyManager class
//
// Owns the active enemy list and all AI update + rendering logic.
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

// Seeder double-diamond geometry: two layers, each defined by [yOffset, [r, g, b]].
// Hoisted out of the draw loop so the nested array literal is not re-allocated every frame.
const SEEDER_LAYERS = [[-10, 220, 30, 30], [6, 170, 15, 15]];

// Uniform scale applied to every enemy mesh in both rendering passes.
const ENEMY_DRAW_SCALE = 4;

// Colossus progression: HP increases by 30 each spawn. Size scales linearly by tier,
// but is capped to avoid runaway boss dimensions that break camera/collision fairness.
const COLOSSUS_HP_BASE = 30;
const COLOSSUS_HP_STEP = 30;
const COLOSSUS_SIZE_STEP = 0.35;
const COLOSSUS_MAX_SIZE_MULT = 2.4;

// Kraken progression: HP increases by 40 each spawn. Larger than colossus base, but
// movement is restricted to water so the player can use land as a refuge.
const KRAKEN_HP_BASE = 60;
const KRAKEN_HP_STEP = 40;
const KRAKEN_SIZE_STEP = 0.25;
const KRAKEN_MAX_SIZE_MULT = 2.0;

// Scorpion stuck-detection: if the same sentinel is targeted for this many ticks
// without being infected the scorpion adds it to a temporary skip-list.
const SCORPION_STUCK_THRESHOLD_TICKS = 600;   // ~10 s at 60 Hz
const SCORPION_SKIP_DURATION_TICKS   = 1800;  // ~30 s skip window

const ENEMY_COLORS = {
  fighter: [255, 150, 0],
  bomber: [180, 20, 180],
  crab: [200, 80, 20],
  hunter: [40, 255, 40],
  squid: [100, 100, 150],
  scorpion: [20, 180, 120],
  colossus: [255, 60, 20],
  yellowCrab: [255, 255, 0],
  wolf: [110, 80, 55],
  kraken: [20, 80, 160]
};

// Shadow dimensions [width, height] for each airborne enemy type.
// Ground-huggers (crab, scorpion, yellowCrab) are excluded — they cast no shadow.
// Colossus is handled separately because its size scales with tier.
const ENEMY_SHADOW_DIMS = {
  bomber: [150, 85],
  fighter: [64, 60],
  hunter: [80, 48],
  squid: [110, 72],
  seeder: [68, 50]
};

// Pre-allocated edge vectors for _drawTri() — eliminates 2 array literal allocations
// per call (one per call site × 12 calls for fighter = 24 allocations/fighter/frame).
// Safe: _drawTri() is non-re-entrant (single-threaded JS; never called from a callback).
const _triV1 = [0, 0, 0];
const _triV2 = [0, 0, 0];

class EnemyManager {
  constructor() {
    /** @type {Array<object>} Live enemy objects. Each has at minimum: x, y, z, vx, vz, type. */
    this.enemies = [];
    this.updateHandlers = {
      fighter: (e, alivePlayers, refShip) => this.updateFighter(e, alivePlayers, refShip),
      bomber: (e, _alivePlayers, refShip) => this.updateBomber(e, refShip),
      crab: (e, alivePlayers, refShip) => this.updateCrab(e, alivePlayers, refShip),
      hunter: (e, alivePlayers, refShip) => this.updateHunter(e, alivePlayers, refShip),
      squid: (e, alivePlayers, refShip) => this.updateSquid(e, alivePlayers, refShip),
      scorpion: (e, alivePlayers, refShip) => this.updateScorpion(e, alivePlayers, refShip),
      colossus: (e, alivePlayers, refShip) => this.updateColossus(e, alivePlayers, refShip),
      yellowCrab: (e, alivePlayers, refShip) => this.updateYellowCrab(e, alivePlayers, refShip),
      seeder: (e, _alivePlayers, refShip) => this.updateSeeder(e, refShip),
      wolf: (e, alivePlayers, refShip) => this.updateWolf(e, alivePlayers, refShip),
      kraken: (e, alivePlayers, refShip) => this.updateKraken(e, alivePlayers, refShip)
    };
    // Reusable alive-player list — reset with .length=0 each frame to avoid
    // allocating a fresh array every update() call (which is called at 60 fps).
    this._alivePlayers = [];

    // Dispatch tables for the two rendering passes in draw().
    // Keyed by enemy type string — avoids repeated if-else chains every frame.
    this._fillColorDrawHandlers = {
      crab:       (e) => this._drawCrab(e),
      yellowCrab: (e) => this._drawCrab(e),
      squid:      (e) => this._drawSquid(e),
      scorpion:   (e) => this._drawScorpion(e),
      colossus:   (e) => this._drawColossus(e),
      wolf:       (e) => this._drawWolf(e),
      kraken:     (e) => this._drawKraken(e)
    };
    this._vertexDrawHandlers = {
      fighter: (e) => this._drawFighter(e),
      bomber:  (e) => this._drawBomber(e),
      hunter:  (e) => this._drawHunter(e),
      seeder:  (e) => this._drawSeeder(e)
    };
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
    return ENEMY_COLORS[type] || [220, 30, 30];  // Default: seeder red
  }

  /** Returns nearest alive ship or fallback reference ship. */
  _getTargetShip(e, alivePlayers, refShip) {
    return findNearest(alivePlayers, e.x, e.y, e.z) || refShip;
  }

  /**
   * Sets both the p5 fill colour and the terrain shader uniform in one call.
   * All box/cylinder draw methods must call this instead of the two-call pair
   * `fill(r,g,b); terrain.setFillColor(r,g,b)` to keep them in sync.
   * @private
   */
  _setColor(r, g, b) {
    fill(r, g, b);
    terrain.setFillColor(r, g, b);
  }

  /** Reflects enemy velocity if it moves too far from the reference ship. */
  _reflectWithinRefBounds(e, refShip, limit) {
    if (abs(e.x - refShip.x) > limit) e.vx *= -1;
    if (abs(e.z - refShip.z) > limit) e.vz *= -1;
  }

  /** Ground infection helper used by multiple ground-based enemies. */
  _tryInfectGround(e, gy, infType = 'normal', pulseScale = 1.0, spreadNeighbors = false) {
    if (aboveSea(gy)) return;

    const tx = toTile(e.x), tz = toTile(e.z);
    const k = tileKey(tx, tz);
    if (infection.add(k, infType)) {
      if (isLaunchpad(e.x, e.z)) maybePlayLaunchpadAlarm();
      terrain.addPulse(e.x, e.z, pulseScale);
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
    particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy, vz: 0, life: 1000 });
    if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot(shotType, e.x, e.y - 10, e.z);
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
    if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop(type, e.x, e.y, e.z);
    return true;
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
      let r = random();
      if (r < 0.32) type = 'seeder';
      else if (r < 0.54) type = 'fighter';
      else if (r < 0.69) type = 'bomber';
      else if (r < 0.81) type = 'crab';
      else if (r < 0.87) {
        if (gameState.level >= 4 && r < 0.84) type = 'yellowCrab'; // Steal 3% from hunters for yellow crab
        else type = 'hunter';
      }
      else if (r < 0.93) type = 'squid';
      else if (r < 0.97) type = 'scorpion';
      else type = 'wolf';
    }

    // Colossus spawns must be far enough from the centre so the player has time to react
    let ex, ez, ey;
    if (type === 'colossus') {
      let angle = random(TWO_PI);
      let dist = random(2500, 4000);
      ex = cos(angle) * dist;
      ez = sin(angle) * dist;
      ey = terrain.getAltitude(ex, ez);  // On the ground — will be adjusted each frame
    } else if (type === 'kraken') {
      // Spawn on a water tile, far enough from centre for the player to react.
      // Uses random angle/distance sampling (60 attempts) to maximise chance of
      // landing on the ocean, with a grid-scan fallback if all attempts miss.
      let angle = random(TWO_PI);
      let dist = random(2000, 3500);
      let attempts = 0;
      let foundWater = false;
      do {
        angle = random(TWO_PI);
        dist = random(1500, 4500);
        ex = cos(angle) * dist;
        ez = sin(angle) * dist;
        ey = terrain.getAltitude(ex, ez);
        attempts++;
        if (aboveSea(ey)) { foundWater = true; break; }
      } while (attempts < 60);
      // Hard fallback: scan a grid of candidate positions to guarantee water spawn
      if (!foundWater) {
        outer: for (let r = 1500; r <= 5000; r += 400) {
          for (let a = 0; a < 16; a++) {
            const cx = cos((a / 16) * TWO_PI) * r;
            const cz = sin((a / 16) * TWO_PI) * r;
            if (aboveSea(terrain.getAltitude(cx, cz))) {
              ex = cx; ez = cz;
              ey = terrain.getAltitude(ex, ez);
              break outer;
            }
          }
        }
      }
    } else {
      ex = random(-4000, 4000);
      ez = random(-4000, 4000);
      ey = random(-300, -800);
      if (type === 'crab' || type === 'scorpion' || type === 'yellowCrab' || type === 'wolf') {
        // Ground-hugging enemies spawn ON the ground surface rather than at altitude
        ey = terrain.getAltitude(ex, ez) - 10;
      }
    }

    let entry = {
      x: ex, y: ey, z: ez,
      vx: random(-2, 2), vz: random(-2, 2),
      id: random(),        // Unique random seed used for per-enemy animation phase offsets
      type,
      fireTimer: 0,        // Counts frames since last bullet fired
      bombTimer: 0         // Counts frames since last bomb dropped (bomber/fighter/scorpion)
    };

    // Colossus progression across a run: +30 HP per spawn, and larger body each time.
    if (type === 'colossus') {
      gameState.colossusSpawnCount = (gameState.colossusSpawnCount || 0) + 1;
      const tier = gameState.colossusSpawnCount;
      const hp = COLOSSUS_HP_BASE + (tier - 1) * COLOSSUS_HP_STEP;
      entry.colossusTier = tier;
      entry.colossusScale = min(1 + (tier - 1) * COLOSSUS_SIZE_STEP, COLOSSUS_MAX_SIZE_MULT);
      entry.hp = hp;
      entry.maxHp = hp;
      entry.hitFlash = 0; // frames of bright flash after being hit
    }

    // Kraken progression: +40 HP per spawn, larger body each time.
    if (type === 'kraken') {
      gameState.krakenSpawnCount = (gameState.krakenSpawnCount || 0) + 1;
      const tier = gameState.krakenSpawnCount;
      const hp = KRAKEN_HP_BASE + (tier - 1) * KRAKEN_HP_STEP;
      entry.krakenTier = tier;
      entry.krakenScale = min(1 + (tier - 1) * KRAKEN_SIZE_STEP, KRAKEN_MAX_SIZE_MULT);
      entry.hp = hp;
      entry.maxHp = hp;
      entry.hitFlash = 0;
    }

    this.enemies.push(entry);
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
    e.y += sin(_simTick * 0.02 + e.id);  // Gentle vertical oscillation

    // Terrain avoidance: push up to maintain clearance over mountains
    this._applyTerrainAvoidance(e, 200, 0.4);

    // Integrate vertical physics with 0.92 damping and 1.5x horizontal speed
    this._updateFlyingMovement(e, 0.92, 1.5);

    // Reflect velocity when too far from the reference ship
    this._reflectWithinRefBounds(e, refShip, 4000);

    e.bombTimer++;
    if (e.bombTimer > 600) {
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
    this._updateCrabAI(e, alivePlayers, refShip, 1.5, 0.04, 'yellow', 2.0);
  }

  /**
   * Shared logic for ground-hugging crab enemies.
   * @param {object} e            Enemy state.
   * @param {object[]} alivePlayers Alive ships.
   * @param {object} refShip      Fallback.
   * @param {number} speed        Movement speed factor.
   * @param {number} infProb      Probability of tile infection per frame.
   * @param {string} infType      Type of virus to spread ('normal' or 'yellow' [yellow virus]).
   * @param {number} pulseScale   Visual pulse feedback intensity.
   */
  _updateCrabAI(e, alivePlayers, refShip, speed, infProb, infType, pulseScale) {
    let tShip = this._getTargetShip(e, alivePlayers, refShip);

    let { d } = this._steer2D(e, tShip.x, tShip.z, speed, 0.05);

    e.x += e.vx; e.z += e.vz;

    const gyC = terrain.getAltitude(e.x, e.z);
    e.y = gyC - 10;

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      this._fireUpwardShot(e, 'crab');
    }

    if (random() < infProb) {
      this._tryInfectGround(e, gyC, infType, pulseScale);
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

    // State machine: toggle aggressive/wandering every 120 frames
    e.stateTimer = (e.stateTimer || 0) + 1;
    if (e.stateTimer > 120) {
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
        // use long lifetime for better reach
        life: 1000
      });
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, e.y, e.z);
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
    e.y += sin(_simTick * 0.05 + e.id) * 2;  // Gentle vertical oscillation

    // Terrain avoidance: maintain flight level over mountains
    this._applyTerrainAvoidance(e, 250, 0.3);

    // Integrate vertical physics with 0.92 damping
    this._updateFlyingMovement(e, 0.92);

    this._reflectWithinRefBounds(e, refShip, 5000);

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
        if (_simTick >= expiry) e._skipSentinels.delete(s);
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

      // Stuck detection: if the same sentinel has been targeted for too long
      // without being infected, skip it temporarily to avoid getting stuck.
      if (chosen !== e._scorpionTarget) {
        e._scorpionTarget = chosen;
        e._scorpionStuckTicks = 0;
      } else if (chosen !== null) {
        e._scorpionStuckTicks = (e._scorpionStuckTicks || 0) + 1;
        if (e._scorpionStuckTicks > SCORPION_STUCK_THRESHOLD_TICKS) {
          e._skipSentinels.set(chosen, _simTick + SCORPION_SKIP_DURATION_TICKS);
          e._scorpionTarget = null;
          e._scorpionStuckTicks = 0;
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

    e.x += e.vx; e.z += e.vz;
    // Snap to ground surface
    const gyS = terrain.getAltitude(e.x, e.z);
    e.y = gyS - 20;

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
    let { d } = this._steer2D(e, tShip.x, tShip.z, 1.2, 0.025);  // Slower than most enemies — weight of a giant
    e.x += e.vx; e.z += e.vz;

    // Snap to ground surface — the Colossus always walks on land
    const gyCo = terrain.getAltitude(e.x, e.z);
    e.y = gyCo;

    // Tick down the hit-flash timer
    if (e.hitFlash > 0) e.hitFlash--;

    // --- Burst fire: 3 bullets spaced 8 frames apart every 120 frames ---
    e.fireTimer = (e.fireTimer || 0) + 1;
    if (d < 2500 && e.fireTimer >= 120) {
      // Queue a burst of 3 shots (stagger them via burstCount)
      if (!e.burstCount) e.burstCount = 0;
      e.burstCount = 3;
      e.burstCooldown = 0;
      e.fireTimer = 0;
    }
    if (e.burstCount > 0) {
      e.burstCooldown = (e.burstCooldown || 0) + 1;
      if (e.burstCooldown >= 8) {
        e.burstCooldown = 0;
        e.burstCount--;
        // Re-calculate direction each burst shot (target may have moved)
        const colScale = e.colossusScale || 1;
        const muzzleYOffset = 240 * colScale;
        let bdx = tShip.x - e.x, bdy = tShip.y - (e.y - muzzleYOffset), bdz = tShip.z - e.z;
        let bd = mag3(bdx, bdy, bdz);
        if (bd > 0) {
          let spread = 0.12;
          particleSystem.enemyBullets.push({
            x: e.x, y: e.y - muzzleYOffset, z: e.z,
            vx: (bdx / bd) * 14 + random(-spread, spread) * 14,
            vy: (bdy / bd) * 14,
            vz: (bdz / bd) * 14 + random(-spread, spread) * 14,
            // colossus bullets now persist longer
            life: 1000
          });
          if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, e.y - muzzleYOffset, e.z);
        }
      }
    }

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
    if (typeof villagerManager !== 'undefined') {
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
      if (typeof villagerManager !== 'undefined') {
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
          // from it that it's fair game again (prevents getting glued to one pagoda).
          if (b === e._wolfLastVillage) {
            const d2ToLast = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
            if (d2ToLast < 250 * 250) continue;  // Still close — skip it
            else e._wolfLastVillage = null;       // Moved away — clear the block
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
    e.x += e.vx; e.z += e.vz;

    // Snap to ground
    const gyW = terrain.getAltitude(e.x, e.z);
    e.y = gyW - 10;

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

    // --- Burst fire: 3 bullets spaced 10 frames apart every 150 frames ---
    e.fireTimer = (e.fireTimer || 0) + 1;
    if (d < 3000 && e.fireTimer >= 150) {
      e.burstCount = 3;
      e.burstCooldown = 0;
      e.fireTimer = 0;
    }
    if (e.burstCount > 0) {
      e.burstCooldown = (e.burstCooldown || 0) + 1;
      if (e.burstCooldown >= 10) {
        e.burstCooldown = 0;
        e.burstCount--;
        const kScale = e.krakenScale || 1;
        const muzzleYOffset = 80 * kScale;
        let bdx = tShip.x - e.x, bdy = tShip.y - (e.y - muzzleYOffset), bdz = tShip.z - e.z;
        let bd = mag3(bdx, bdy, bdz);
        if (bd > 0) {
          let spread = 0.14;
          particleSystem.enemyBullets.push({
            x: e.x, y: e.y - muzzleYOffset, z: e.z,
            vx: (bdx / bd) * 12 + random(-spread, spread) * 12,
            vy: (bdy / bd) * 12,
            vz: (bdz / bd) * 12 + random(-spread, spread) * 12,
            life: 1200
          });
          if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, e.y - muzzleYOffset, e.z);
        }
      }
    }

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
          life: 900
        });
      }
      // One aimed tentacle strike at the player
      const adx = tShip.x - e.x, adz = tShip.z - e.z;
      const ad = mag2(adx, adz);
      if (ad > 0) {
        particleSystem.enemyBullets.push({
          x: e.x, y: lashY, z: e.z,
          vx: (adx / ad) * 10, vy: -0.5, vz: (adz / ad) * 10,
          life: 900
        });
      }
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, lashY, e.z);
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
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Emits three vertices for a triangle and auto-computes its face normal.
   * Must be called between beginShape(TRIANGLES) / endShape().
   * @param {number[]} p0  [x,y,z] of first vertex.
   * @param {number[]} p1  [x,y,z] of second vertex.
   * @param {number[]} p2  [x,y,z] of third vertex.
   */
  _drawTri(p0, p1, p2) {
    _triV1[0] = p1[0] - p0[0]; _triV1[1] = p1[1] - p0[1]; _triV1[2] = p1[2] - p0[2];
    _triV2[0] = p2[0] - p0[0]; _triV2[1] = p2[1] - p0[1]; _triV2[2] = p2[2] - p0[2];
    let nx = _triV1[1] * _triV2[2] - _triV1[2] * _triV2[1];
    let ny = _triV1[2] * _triV2[0] - _triV1[0] * _triV2[2];
    let nz = _triV1[0] * _triV2[1] - _triV1[1] * _triV2[0];
    let m = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (m > 0) normal(nx / m, ny / m, nz / m);
    vertex(p0[0], p0[1], p0[2]);
    vertex(p1[0], p1[1], p1[2]);
    vertex(p2[0], p2[1], p2[2]);
  }

  /** @private Renders a crab or yellowCrab enemy (articulated body with animated legs). */
  _drawCrab(e) {
    let yaw = atan2(e.vx || 0, e.vz || 0);
    rotateY(yaw);
    noStroke();
    const isYellow = e.type === 'yellowCrab';
    const ccR = isYellow ? 255 : 200, ccG = isYellow ? 255 : 80, ccB = isYellow ? 0 : 20;
    const ccDR = isYellow ? 100 : 150, ccDG = isYellow ? 100 : 40, ccDB = isYellow ? 0 : 10;
    if (isYellow) {
      // Luminous glow for yellow crab
      let glow = sin(frameCount * 0.1) * 30 + 30;
      let yR = Math.min(255, ccR + glow), yG = Math.min(255, ccG + glow);
      this._setColor(yR, yG, ccB);
    } else {
      this._setColor(ccR, ccG, ccB);
    }
    push(); box(36, 16, 30); pop();
    push(); translate(0, -8, 0); box(24, 8, 20); pop();
    push();
    this._setColor(12, 12, 12);
    translate(-8, -10, 15); box(4, 8, 4);
    translate(16, 0, 0); box(4, 8, 4);
    pop();
    this._setColor(ccDR, ccDG, ccDB);
    let walkPhase = frameCount * 0.3 + e.id;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = -1; i <= 1; i++) {
        let legPhase = walkPhase + i * PI / 3 * side;
        let lift = max(0, sin(legPhase));
        let stride = cos(legPhase);
        push();
        translate(side * 16, 0, i * 10);
        rotateZ(side * (-0.2 - lift * 0.4));
        rotateY(stride * 0.3);
        translate(side * 10, -3, 0); box(20, 6, 6);
        translate(side * 8, 0, 0);
        rotateZ(side * 0.8);
        translate(side * 10, 0, 0); box(22, 4, 4);
        pop();
      }
    }
    if (isYellow) {
      let glow = sin(frameCount * 0.1) * 30 + 30;
      let yR = Math.min(255, ccR + glow), yG = Math.min(255, ccG + glow);
      this._setColor(yR, yG, ccB);
    } else {
      this._setColor(ccR, ccG, ccB);
    }
    for (let side = -1; side <= 1; side += 2) {
      let pincerLift = sin(frameCount * 0.1 + e.id) * 0.1;
      push();
      translate(side * 16, 0, 14);
      rotateY(side * -0.6);
      rotateZ(side * (-0.3 + pincerLift));
      translate(side * 10, 0, 0); box(20, 6, 8);
      translate(side * 10, 0, 0);
      rotateY(side * -1.2);
      translate(side * 8, 0, 0); box(16, 8, 10);
      translate(side * 10, 0, 0); box(12, 10, 12);
      let nip = abs(sin(frameCount * 0.2 + e.id * 3)) * 0.5;
      push(); translate(side * 6, 0, -4); rotateY(side * -nip); translate(side * 8, 0, 0); box(16, 5, 4); pop();
      push(); translate(side * 6, 0, 4); rotateY(side * nip); translate(side * 8, 0, 0); box(16, 5, 4); pop();
      pop();
    }
  }

  /** @private Renders a squid enemy (cylinder body + 8 animated tentacles). */
  _drawSquid(e) {
    let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
    let d = mag3(fvX, fvY, fvZ);
    if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
    noStroke();
    this._setColor(30, 30, 35);
    push();
    let squeeze = (e.inkSqueeze || 0) / 12;
    scale(1.0 + squeeze * 0.20, 1.0 - squeeze * 0.25, 1.0 + squeeze * 0.20);
    rotateX(PI / 2);
    cylinder(12, 40, 8, 1);
    let tentaclePhase = frameCount * 0.1 + e.id;
    for (let i = 0; i < 8; i++) {
      let a = (i / 8) * TWO_PI;
      push();
      translate(sin(a) * 8, 20, cos(a) * 8);
      rotateX(sin(tentaclePhase + a) * 0.4);
      rotateZ(cos(tentaclePhase + a) * 0.4);
      translate(0, 15, 0);
      cylinder(2, 30, 4, 1);
      pop();
    }
    pop();
  }

  /** @private Renders a scorpion enemy (armoured body, 4-pair legs, segmented tail + stinger). */
  _drawScorpion(e) {
    let yaw = atan2(e.vx || 0, e.vz || 0);
    rotateY(yaw);
    noStroke();
    const scR = 22, scG = 180, scB = 120;
    const scDR = 6, scDG = 100, scDB = 60;
    const scGR = 80, scGG = 255, scGB = 160;

    // Main body + armour plates
    this._setColor(scR, scG, scB);
    push(); box(30, 10, 26); pop();
    this._setColor(scDR, scDG, scDB);
    push(); translate(0, -5, 2); box(24, 2, 20); pop();
    push(); translate(0, -4, -8); box(20, 2, 10); pop();

    // Head/Front
    this._setColor(scR, scG, scB);
    push(); translate(0, -1, 14); box(18, 6, 12); pop();
    this._setColor(80, 255, 80); // Eyes
    push(); translate(-6, -5, 18); box(3, 3, 3); pop();
    push(); translate(6, -5, 18); box(3, 3, 3); pop();

    // Articulated pincers
    this._setColor(scR, scG, scB);
    for (let side = -1; side <= 1; side += 2) {
      let pPhase = frameCount * 0.1 + e.id * side;
      push();
      translate(side * 12, -4, 16);
      rotateY(side * 0.4 + sin(pPhase) * 0.2);
      translate(side * 8, 0, 6); box(16, 6, 6);
      translate(side * 8, 0, 6);
      rotateY(side * -0.8 + cos(pPhase) * 0.3);
      translate(side * 10, 0, 6); box(20, 8, 10);
      let nip = abs(sin(frameCount * 0.2 + e.id * 2)) * 0.4;
      push(); translate(side * 6, 0, 4); rotateY(side * nip); translate(side * 6, 0, 0); box(12, 5, 3); pop();
      push(); translate(side * 6, 0, -4); rotateY(side * -nip); translate(side * 6, 0, 0); box(12, 5, 3); pop();
      pop();
    }

    // Articulated legs (4 pairs, metachronal wave gait)
    this._setColor(scDR, scDG, scDB);
    let walkSpeed = mag2(e.vx || 0, e.vz || 0);
    let animationSpeed = walkSpeed > 0.1 ? 0.15 : 0;
    let walkPhase = frameCount * animationSpeed + e.id;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 4; i++) {
        let lp = walkPhase + i * 0.8 + (side > 0 ? PI : 0);
        let lift = max(0, sin(lp));
        let stride = cos(lp);
        push();
        translate(side * 15, 2, 8 - i * 11);
        rotateZ(side * (-0.2 - lift * 0.4));
        rotateY(stride * 0.35);
        translate(side * 8, -1, 0); box(16, 5, 5);
        translate(side * 8, 0, 0);
        rotateZ(side * 1.1 + lift * 0.5);
        translate(side * 10, 0, 0); box(22, 4, 4);
        pop();
      }
    }

    // Segmented tail + stinger
    this._setColor(scR, scG, scB);
    push(); translate(0, -5, -15);
    for (let i = 0; i < 6; i++) {
      let wave = sin(frameCount * 0.1 + e.id + i * 0.5) * 0.1;
      rotateX(-0.35 + wave);
      translate(0, -7, -4);
      box(14 - i * 2, 8 - i, 8 - i);
    }
    this._setColor(scGR, scGG, scGB);
    translate(0, -6, -3);
    rotateX(-0.6);
    box(5, 12, 5);
    pop();
  }

  /** @private Renders a colossus BOSS (giant block-humanoid with walking legs and glowing eyes). */
  _drawColossus(e) {
    let yaw = atan2(e.vx || 0, e.vz || 0);
    rotateY(yaw);
    noStroke();
    let hitT = e.hitFlash > 0 ? min(1, e.hitFlash / 8) : 0;
    let bodyR = lerp(40, 255, hitT), bodyG = lerp(40, 255, hitT), bodyB = lerp(55, 255, hitT);
    let accR = lerp(255, 255, hitT), accG = lerp(60, 255, hitT), accB = lerp(20, 0, hitT);
    const fcR = bodyR, fcG = bodyG, fcB = bodyB;
    const acR = accR, acG = accG, acB = accB;
    const dkR = 22, dkG = 22, dkB = 30;
    const glR = 255, glG = 120, glB = 0;
    let walkSpeed = mag2(e.vx || 0, e.vz || 0);
    let walkCycle = frameCount * 0.08 * (walkSpeed > 0.1 ? 1 : 0) + (e.id || 0);
    for (let side = -1; side <= 1; side += 2) {
      let legPhase = walkCycle * side;
      let thighSwing = sin(legPhase) * 0.4;
      let shinBend = max(0, -cos(legPhase)) * 0.5;
      push();
      translate(side * 50, -40, 0);
      this._setColor(fcR, fcG, fcB);
      rotateX(thighSwing);
      push(); translate(0, 60, 0); box(50, 120, 50); pop();
      translate(0, 120, 0);
      rotateX(-shinBend);
      push(); translate(0, 60, 0); box(40, 120, 40); pop();
      this._setColor(dkR, dkG, dkB);
      translate(0, 120, 0);
      push(); translate(0, 12, side * -6); box(60, 24, 75); pop();
      pop();
    }
    this._setColor(dkR, dkG, dkB);
    push(); translate(0, -45, 0); box(130, 36, 90); pop();
    this._setColor(fcR, fcG, fcB);
    push(); translate(0, -160, 0); box(160, 200, 110); pop();
    this._setColor(dkR, dkG, dkB);
    push(); translate(-105, -210, 0); box(50, 50, 65); pop();
    push(); translate(105, -210, 0); box(50, 50, 65); pop();
    for (let side = -1; side <= 1; side += 2) {
      let armSwing = sin(walkCycle * side + PI) * 0.15;
      push();
      translate(side * 105, -210, 0);
      rotateX(armSwing);
      this._setColor(fcR, fcG, fcB);
      push(); translate(0, 65, 0); box(45, 120, 45); pop();
      this._setColor(dkR, dkG, dkB);
      push(); translate(0, 125, 0); box(40, 30, 40); pop();
      this._setColor(fcR, fcG, fcB);
      push(); translate(0, 185, 0); box(36, 100, 36); pop();
      this._setColor(acR, acG, acB);
      push(); translate(0, 245, 0); box(55, 55, 55); pop();
      pop();
    }
    this._setColor(dkR, dkG, dkB);
    push(); translate(0, -270, 0); box(65, 40, 60); pop();
    this._setColor(fcR, fcG, fcB);
    push(); translate(0, -320, 0); box(100, 90, 100); pop();
    this._setColor(glR, glG, glB);
    push(); translate(-25, -330, 51); box(25, 18, 8); pop();
    push(); translate(25, -330, 51); box(25, 18, 8); pop();
    this._setColor(dkR, dkG, dkB);
    push(); translate(0, -348, 51); box(104, 15, 8); pop();
  }

  /** @private Renders a wolf enemy (quadruped predator with animated four-legged gait and tail). */
  _drawWolf(e) {
    let yaw = atan2(e.vx || 0, e.vz || 0);
    rotateY(yaw);
    noStroke();

    const wfR = 110, wfG = 80, wfB = 55;    // Main fur
    const wdR = 70, wdG = 50, wdB = 35;     // Darker underbelly / legs
    const weR = 255, weG = 80, weB = 0;     // Glowing amber eyes
    const wsR = 200, wsG = 200, wsB = 220;  // Teeth / snout highlight

    let walkSpeed = mag2(e.vx || 0, e.vz || 0);
    let walkCycle = frameCount * 0.18 * (walkSpeed > 0.1 ? 1 : 0) + (e.id || 0);

    // Body (elongated, low to the ground)
    this._setColor(wfR, wfG, wfB);
    push(); translate(0, -8, 0); box(14, 10, 30); pop();

    // Shoulder hump
    push(); translate(0, -14, 8); box(12, 8, 12); pop();

    // Neck
    this._setColor(wfR, wfG, wfB);
    push(); translate(0, -16, 17); rotateX(-0.35); box(9, 14, 8); pop();

    // Head
    push(); translate(0, -22, 25);
    this._setColor(wfR, wfG, wfB);
    box(12, 10, 14);
    // Snout
    this._setColor(wdR, wdG, wdB);
    push(); translate(0, 2, 8); box(7, 6, 8); pop();
    // Ears
    this._setColor(wdR, wdG, wdB);
    push(); translate(-5, -7, 2); rotateZ(0.3); box(4, 8, 3); pop();
    push(); translate(5, -7, 2); rotateZ(-0.3); box(4, 8, 3); pop();
    // Eyes (glowing amber)
    this._setColor(weR, weG, weB);
    push(); translate(-4, -3, 7); box(3, 3, 3); pop();
    push(); translate(4, -3, 7); box(3, 3, 3); pop();
    pop();

    // Animated tail (arched, wagging)
    let tailWag = sin(frameCount * 0.2 + e.id) * 0.4;
    this._setColor(wfR, wfG, wfB);
    push(); translate(0, -10, -14);
    for (let i = 0; i < 4; i++) {
      let tw = tailWag * (1 + i * 0.3);
      rotateX(-0.25);
      rotateY(tw);
      translate(0, -4, -4);
      box(6 - i, 6 - i, 6);
    }
    pop();

    // Four animated legs
    this._setColor(wdR, wdG, wdB);
    const legPairs = [{ z: 12, phase: 0 }, { z: -10, phase: PI }];
    for (let pair of legPairs) {
      for (let side = -1; side <= 1; side += 2) {
        let lp = walkCycle + pair.phase + side * 0.5;
        let lift = max(0, sin(lp)) * 4;
        let stride = cos(lp) * 0.3;
        push();
        translate(side * 7, -3, pair.z);
        rotateX(stride);
        translate(0, 6, 0); box(5, 12, 5);
        translate(0, lift > 1 ? -lift : 0, 6);
        box(4, 10, 4);
        pop();
      }
    }
  }

  /**
   * @private Renders a kraken BOSS.
   *
   * Visual design:
   *   - Body: a wide flat half-dome sitting ON the water surface, with large
   *     glowing eyes on its front face.
   *   - Tentacles: 6 main arms + 2 long reach arms that emerge from below
   *     the waterline, rise up into the air, then arc outward.  They move
   *     very slowly for a menacing, atmospheric feel.
   *
   * All geometry is in local-space units; the caller applies
   * scale(ENEMY_DRAW_SCALE * krakenScale) before invoking this.
   *
   * Performance notes:
   *   - 6×8 + 2×10 = 68 tentacle box() calls + 7 body/eye calls = 75 total.
   *   - Trig phase is computed once per tentacle, not per segment.
   *   - Colors are pre-lerped at each segment index before the inner draw
   *     (p5 fill() can accept floats, so no floor() needed in the hot path).
   */
  _drawKraken(e) {
    noStroke();
    const hitT = e.hitFlash > 0 ? min(1, e.hitFlash / 8) : 0;

    // --- Colour palette (deep-sea bioluminescent; flashes bright on hit) ---
    const domeR = lerp(20,  180, hitT), domeG = lerp(75,  200, hitT), domeB = lerp(155, 255, hitT);
    const darkR = lerp(6,   80,  hitT), darkG = lerp(14,  80,  hitT), darkB = lerp(42,  120, hitT);
    const eyeG  = lerp(220, 255, hitT), eyeB  = lerp(160, 230, hitT);
    const tb0   = lerp(18,  140, hitT), tb1   = lerp(50,  140, hitT), tb2   = lerp(110, 185, hitT);
    const tt0   = lerp(55,  200, hitT), tt1   = lerp(190, 235, hitT), tt2   = lerp(185, 255, hitT);

    // ── BODY: flat half-dome at the water surface ────────────────────────────
    // Dark collar / skirt at and just below the waterline
    this._setColor(darkR, darkG, darkB);
    push(); rotateX(PI / 2); cylinder(82, 26, 10, 1); pop();

    // Main dome — a sphere squished to half height so it looks like a dome
    // protruding from the surface rather than a full ball.
    // translate(-26) places the sphere centre 26 units above the waterline
    // (local y < 0 = above sea in p5 WebGL where Y-down).
    this._setColor(domeR, domeG, domeB);
    push();
    translate(0, -26, 0);
    scale(1.0, 0.52, 1.0);
    sphere(74, 8, 6);
    pop();

    // Ridge ring where dome meets waterline
    this._setColor(darkR, darkG, darkB);
    push(); translate(0, -8, 0); rotateX(PI / 2); cylinder(80, 14, 10, 1); pop();

    // ── EYES: large glowing ovals on the dome's forward face ─────────────────
    this._setColor(0, eyeG, eyeB);
    push(); translate(-24, -32, 64); sphere(14, 6, 4); pop();
    push(); translate( 24, -32, 64); sphere(14, 6, 4); pop();
    this._setColor(0, 18, 12);
    push(); translate(-24, -32, 75); sphere(7, 5, 3); pop();
    push(); translate( 24, -32, 75); sphere(7, 5, 3); pop();

    // ── TENTACLES ─────────────────────────────────────────────────────────────
    // Tentacles start just below the waterline at the body's outer edge and are
    // initially angled upward with rotateX(+angle) so they RISE out of the water
    // before curling back outward. In p5 WebGL (Y-down), rotateX(+θ) rotates the
    // +Z axis toward −Y (upward), so the tentacle emerges above sea level.
    //
    // Per-segment: a slow sinusoidal side-wave (rotateZ) + a small downward drift
    // (rotateX per step) gradually brings the tip from vertical to roughly
    // horizontal, creating a natural arc.
    //
    // Animation phase runs at 0.02 rad/frame (≈ 3.5 × slower than before).

    const phase   = frameCount * 0.02 + (e.id || 0) * 0.15;
    const SEG_LEN = 28;   // local units per tentacle segment

    // 6 main tentacles (8 segments each)
    const NUM_MAIN  = 6;
    const MAIN_SEGS = 8;
    for (let i = 0; i < NUM_MAIN; i++) {
      const a      = (i / NUM_MAIN) * TWO_PI;
      const tPhase = phase + i * (TWO_PI / NUM_MAIN);
      push();
      rotateY(a);
      translate(74, 5, 0);  // body edge, slightly below waterline
      rotateX(0.82);         // tilt upward — tentacle rises out of the water
      for (let seg = 0; seg < MAIN_SEGS; seg++) {
        const t  = seg / (MAIN_SEGS - 1);
        const sw = sin(tPhase + seg * 0.5) * 0.22;   // side-to-side wave
        const cr = lerp(tb0, tt0, t), cg = lerp(tb1, tt1, t), cb = lerp(tb2, tt2, t);
        this._setColor(cr, cg, cb);
        rotateZ(sw);
        rotateX(sin(tPhase * 0.6 + seg * 0.4) * 0.08 - 0.07);  // gentle downward arc
        translate(0, 0, SEG_LEN);
        const w = lerp(21, 3, t);
        box(w, w * 0.7, SEG_LEN + 4);
      }
      pop();
    }

    // 2 long "reach" tentacles (10 segments each) — steeper initial rise,
    // longer reach, used for dramatic visual presence above the waterline.
    const NUM_LONG  = 2;
    const LONG_SEGS = 10;
    const LONG_LEN  = 30;
    for (let i = 0; i < NUM_LONG; i++) {
      const a      = (i / NUM_LONG) * TWO_PI + PI / 6;
      const tPhase = phase + i * PI + 1.8;
      push();
      rotateY(a);
      translate(62, 4, 0);
      rotateX(1.08);  // steeper upward angle for extra height
      for (let seg = 0; seg < LONG_SEGS; seg++) {
        const t  = seg / (LONG_SEGS - 1);
        const sw = sin(tPhase + seg * 0.45) * 0.20;
        const cr = lerp(tb0, tt0, t), cg = lerp(tb1, tt1, t), cb = lerp(tb2, tt2, t);
        this._setColor(cr, cg, cb);
        rotateZ(sw);
        rotateX(sin(tPhase * 0.55 + seg * 0.38) * 0.08 - 0.06);
        translate(0, 0, LONG_LEN);
        const w = lerp(15, 2, t);
        box(w, w * 0.7, LONG_LEN + 4);
      }
      pop();
    }
  }

  /** @private Renders a fighter enemy (arrowhead body, fins, animated tail — yaw/pitch aligned). */
  _drawFighter(e) {
    let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
    let d = mag3(fvX, fvY, fvZ);
    if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
    noStroke();
    fill(255, 150, 0);
    beginShape(TRIANGLES);
    this._drawTri([0, 0, 25], [-8, 0, 0], [0, 8, 0]);
    this._drawTri([0, 0, 25], [8, 0, 0], [0, 8, 0]);
    this._drawTri([0, 0, 25], [-8, 0, 0], [0, -8, 0]);
    this._drawTri([0, 0, 25], [8, 0, 0], [0, -8, 0]);
    this._drawTri([-8, 0, 0], [0, 0, -15], [0, 8, 0]);
    this._drawTri([8, 0, 0], [0, 0, -15], [0, 8, 0]);
    this._drawTri([-8, 0, 0], [0, 0, -15], [0, -8, 0]);
    this._drawTri([8, 0, 0], [0, 0, -15], [0, -8, 0]);
    endShape();
    fill(255, 100, 0); // Dorsal fin
    beginShape(TRIANGLES);
    this._drawTri([-1, 8, 5], [-1, 18, -10], [-1, 8, -12]);
    this._drawTri([1, 8, 5], [1, 18, -10], [1, 8, -12]);
    this._drawTri([-1, 8, 5], [1, 8, 5], [0, 18, -10]);
    endShape();
    fill(255, 180, 50); // Pectoral fins
    let finWarp = sin(frameCount * 0.15 + e.id) * 0.2;
    beginShape(TRIANGLES);
    this._drawTri([-8, 0, 5], [-22, -2, -8 + finWarp * 10], [-8, 0, -10]);
    this._drawTri([-8, -2, 5], [-22, -2, -8 + finWarp * 10], [-8, -2, -10]);
    this._drawTri([8, 0, 5], [22, -2, -8 + finWarp * 10], [8, 0, -10]);
    this._drawTri([8, -2, 5], [22, -2, -8 + finWarp * 10], [8, -2, -10]);
    endShape();
    let tailSwing = sin(frameCount * 0.2 + e.id) * 12;
    fill(255, 80, 0); // Animated tail
    beginShape(TRIANGLES);
    this._drawTri([-1, 0, -15], [tailSwing, 15, -35], [-1, 0, -22]);
    this._drawTri([1, 0, -15], [tailSwing, 15, -35], [1, 0, -22]);
    this._drawTri([-1, 0, -15], [tailSwing, -15, -35], [-1, 0, -22]);
    this._drawTri([1, 0, -15], [tailSwing, -15, -35], [1, 0, -22]);
    endShape();
  }

  /** @private Renders a bomber enemy (rotating bipyramid).
   *
   * The bipyramid geometry is static — only the rotation changes frame to frame.
   * The mesh is baked once into a cached p5.Geometry on first draw and re-used
   * thereafter, replacing 8 _drawTri() calls (16 array allocs + 24 vertex() calls)
   * per enemy per frame with a single model() draw call.
   */
  _drawBomber(e) {
    rotateY(frameCount * 0.05);
    noStroke();
    if (!EnemyManager._bomberGeom) {
      EnemyManager._bomberGeom = _safeBuildGeometry(() => {
        fill(180, 20, 180);
        beginShape(TRIANGLES);
        this._drawTri([0, -40, 0], [-40, 0, -40], [40, 0, -40]);
        this._drawTri([0, -40, 0], [-40, 0, 40], [40, 0, 40]);
        this._drawTri([0, -40, 0], [-40, 0, -40], [-40, 0, 40]);
        this._drawTri([0, -40, 0], [40, 0, -40], [40, 0, 40]);
        this._drawTri([0, 40, 0], [-40, 0, -40], [40, 0, -40]);
        this._drawTri([0, 40, 0], [-40, 0, 40], [40, 0, 40]);
        this._drawTri([0, 40, 0], [-40, 0, -40], [-40, 0, 40]);
        this._drawTri([0, 40, 0], [40, 0, -40], [40, 0, 40]);
        endShape();
      });
    }
    if (EnemyManager._bomberGeom) model(EnemyManager._bomberGeom);
  }

  /** @private Renders a hunter enemy (small teardrop arrowhead + flapping wings — yaw/pitch aligned). */
  _drawHunter(e) {
    let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
    let d = mag3(fvX, fvY, fvZ);
    if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
    noStroke();
    fill(40, 255, 40);
    beginShape(TRIANGLES);
    this._drawTri([0, 0, 25], [-5, 0, 5], [0, 5, 5]);
    this._drawTri([0, 0, 25], [5, 0, 5], [0, 5, 5]);
    this._drawTri([0, 0, 25], [-5, 0, 5], [0, -3, 5]);
    this._drawTri([0, 0, 25], [5, 0, 5], [0, -3, 5]);
    this._drawTri([-5, 0, 5], [0, 0, -15], [0, 5, 5]);
    this._drawTri([5, 0, 5], [0, 0, -15], [0, 5, 5]);
    endShape();
    let flap = sin(frameCount * 0.3 + e.id) * 20;
    fill(30, 200, 30); // Wings
    beginShape(TRIANGLES);
    this._drawTri([-5, 0, 5], [-35, flap, -10], [-5, 0, -5]);
    this._drawTri([-5, -1, 5], [-35, flap - 1, -10], [-5, -1, -5]);
    this._drawTri([5, 0, 5], [35, flap, -10], [5, 0, -5]);
    this._drawTri([5, -1, 5], [35, flap - 1, -10], [5, -1, -5]);
    endShape();
    fill(20, 150, 20); // Tail feathers
    beginShape(TRIANGLES);
    this._drawTri([0, 0, -15], [-12, 0, -30], [12, 0, -30]);
    this._drawTri([0, -1, -15], [-12, -1, -30], [12, -1, -30]);
    endShape();
  }

  /** @private Renders a seeder enemy (rotating double-diamond + vertical antenna).
   *
   * The double-diamond and antenna geometry are static — only the rotation changes.
   * The mesh is baked once into a cached p5.Geometry on first draw, replacing
   * 8 _drawTri() calls (16 array allocs + 24 vertex() calls) + 1 box() per seeder
   * per frame with a single model() draw call.
   */
  _drawSeeder(e) {
    rotateY(frameCount * 0.15); noStroke();
    if (!EnemyManager._seederGeom) {
      EnemyManager._seederGeom = _safeBuildGeometry(() => {
        for (let i = 0; i < SEEDER_LAYERS.length; i++) {
          const layer = SEEDER_LAYERS[i];
          const yOff = layer[0];
          fill(layer[1], layer[2], layer[3]);
          beginShape(TRIANGLES);
          this._drawTri([0, yOff, -25], [-22, 0, 0], [22, 0, 0]);
          this._drawTri([0, yOff, 25], [-22, 0, 0], [22, 0, 0]);
          this._drawTri([0, yOff, -25], [-22, 0, 0], [0, yOff, 25]);
          this._drawTri([0, yOff, -25], [22, 0, 0], [0, yOff, 25]);
          endShape();
        }
        fill(255, 60, 60);
        push(); translate(0, -14, 0); box(3, 14, 3); pop();
      });
    }
    if (EnemyManager._seederGeom) model(EnemyManager._seederGeom);
  }

  /**
   * Renders all enemies visible from the given ship's position.
   * Each enemy type has a distinct 3D mesh.  All meshes cast a ground shadow.
   *
   * Two rendering passes are required because p5.js box()/cylinder() primitives
   * need the default shader to respect fill() colours, while vertex-based enemies
   * use the terrain shader for fog and rim-lighting effects.
   *
   * Culling is done once upfront to avoid three separate O(n) sweeps with
   * the same distance predicate.
   *
   * @param {{x,y,z,yaw}} s  Ship state used as the view origin for culling.
   */
  draw(s) {
    if (this.enemies.length === 0) return;

    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    const cullSq = CULL_DIST * CULL_DIST;
    const sx = s.x, sz = s.z;

    // Single culling pass — build list of enemies visible this frame.
    const vis = [];
    const cam = terrain._cam;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      let localCullSq = cullSq;
      if (e.type === 'colossus') {
        const colScale = e.colossusScale || 1;
        localCullSq = (CULL_DIST * (1.5 + (colScale - 1) * 0.4)) ** 2;
        e._shadowCullSq = localCullSq; // cache enlarged radius for shadow pass
      } else if (e.type === 'kraken') {
        const kScale = e.krakenScale || 1;
        localCullSq = (CULL_DIST * (1.4 + (kScale - 1) * 0.3)) ** 2;
        e._shadowCullSq = localCullSq;
      }
      if ((e.x - sx) ** 2 + (e.z - sz) ** 2 > localCullSq) continue;
      if (cam && !terrain.inFrustum(cam, e.x, e.z)) continue;
      vis.push(e);
    }

    if (vis.length === 0) return;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PASS 1: Box/cylinder-based enemies.
    //
    // p5.js box() and cylinder() do NOT forward fill() into aVertexColor when
    // a custom shader is active; the vertex-colour buffer retains its baked-in
    // default, so the entity appears black if drawn with the terrain shader.
    //
    // Fix: bind the fill-colour shader (FILL_COLOR_FRAG) which reads colour
    // from a uFillColor uniform instead of aVertexColor.  Each body part calls
    // terrain.setFillColor() alongside fill() to push the correct colour into
    // that uniform.  This gives box/cylinder enemies the same fog, Lambert
    // lighting and shockwave pulse effects as vertex-based enemies.
    //
    // Falls back to the p5 default shader (setSceneLighting) when fillShader
    // is not yet compiled (first frame) or if it fails to link.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (terrain.fillShader) {
      terrain.applyFillColorShader();
    } else {
      setSceneLighting();
    }

    for (let i = 0; i < vis.length; i++) {
      const e = vis[i];
      const handler = this._fillColorDrawHandlers[e.type];
      if (!handler) continue; // vertex enemies go in PASS 2

      push();
      translate(e.x, e.y, e.z);
      if (e.type === 'crab' || e.type === 'yellowCrab') translate(0, -10, 0);
      if (e.type === 'colossus') scale(ENEMY_DRAW_SCALE * (e.colossusScale || 1));
      else if (e.type === 'kraken') scale(ENEMY_DRAW_SCALE * (e.krakenScale || 1));
      else scale(ENEMY_DRAW_SCALE);
      handler(e);
      pop();
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PASS 2: Vertex-based enemies — terrain shader for fog, lighting & rim effects.
    // These use beginShape(TRIANGLES) with explicit vertex calls, which correctly
    // populate aVertexColor with the current fill() colour.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    terrain.applyShader();

    for (let i = 0; i < vis.length; i++) {
      const e = vis[i];
      const handler = this._vertexDrawHandlers[e.type];
      if (!handler) continue; // box/cylinder enemies already drawn in PASS 1

      push(); translate(e.x, e.y, e.z); scale(ENEMY_DRAW_SCALE);
      handler(e);
      pop();
    }

    resetShader();
    setSceneLighting();

    // Shadow pass — ground-hugging enemies have no meaningful airborne shadow.
    // Wolf hugs the ground like crab/scorpion; kraken sits at sea level so its shadow
    // would fall at the same Y — skip it too.
    for (let i = 0; i < vis.length; i++) {
      const e = vis[i];
      if (e.type === 'crab' || e.type === 'scorpion' || e.type === 'yellowCrab' ||
          e.type === 'wolf' || e.type === 'kraken') continue;
      const gy = terrain.getAltitude(e.x, e.z);
      const casterH = max(24, gy - e.y);
      let sw, sh;
      if (e.type === 'colossus') {
        const colScale = e.colossusScale || 1;
        sw = 320 * colScale;
        sh = 230 * colScale;
      } else {
        const dims = ENEMY_SHADOW_DIMS[e.type];
        sw = dims ? dims[0] : 80;
        sh = dims ? dims[1] : 50;
      }
      drawShadow(e.x, gy, e.z, sw, sh, casterH);
    }

    if (profiler) profiler.record('enemies', performance.now() - start);
  }
}

// Static geometry caches shared across all EnemyManager instances.
// Populated on first draw() call once the WebGL canvas exists.
// null = not yet built; p5.Geometry = cached mesh for that enemy type.
/** @type {p5.Geometry|null} */ EnemyManager._bomberGeom = null;
/** @type {p5.Geometry|null} */ EnemyManager._seederGeom = null;

// Singleton instance used by all other modules
const enemyManager = new EnemyManager();
