// =============================================================================
// enemies.js — EnemyManager class
//
// Owns the active enemy list and all AI update + rendering logic.
//
// Eight enemy types are implemented:
//   seeder   — slow drifter; randomly drops normal infection bombs below itself
//   bomber   — fast drifter; drops large 'mega' bombs every 600 frames (~10 s)
//   crab     — ground-hugging unit that tracks the nearest player and infects tiles
//   hunter   — fast aggressive airborne pursuer; no weapons, kills by collision
//   fighter  — switching between aggressive pursuit and wandering; shoots + drops bombs
//   squid    — medium-speed pursuer; emits a dark ink-cloud smoke trail
//   scorpion — ground-hugging; targets sentinel buildings to infect them, then launchpad
//   colossus — BOSS: giant block-humanoid ground walker; massive HP, shoots burst salvos,
//              walks on two animated legs, leaves a virus trail behind it
// =============================================================================

// Seeder double-diamond geometry: two layers, each defined by [yOffset, [r, g, b]].
// Hoisted out of the draw loop so the nested array literal is not re-allocated every frame.
const SEEDER_LAYERS = [[-10, 220, 30, 30], [6, 170, 15, 15]];

// Uniform scale applied to every enemy mesh in both rendering passes.
const ENEMY_DRAW_SCALE = 2;

// Colossus progression: HP increases by 30 each spawn. Size scales linearly by tier,
// but is capped to avoid runaway boss dimensions that break camera/collision fairness.
const COLOSSUS_HP_BASE = 30;
const COLOSSUS_HP_STEP = 30;
const COLOSSUS_SIZE_STEP = 0.35;
const COLOSSUS_MAX_SIZE_MULT = 2.4;

class EnemyManager {
  constructor() {
    /** @type {Array<object>} Live enemy objects. Each has at minimum: x, y, z, vx, vz, type. */
    this.enemies = [];
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
    const ENEMY_COLORS = {
      fighter: [255, 150, 0],
      bomber: [180, 20, 180],
      crab: [200, 80, 20],
      hunter: [40, 255, 40],
      squid: [100, 100, 150],
      scorpion: [20, 180, 120],
      colossus: [255, 60, 20],
      yellowCrab: [255, 255, 0]
    };
    return ENEMY_COLORS[type] || [220, 30, 30];  // Default: seeder red
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
   *   Seeder 35% | Fighter 22% | Bomber 15% | Crab 12% | Hunter 6% | Squid 6% | Scorpion 4%
   * The Colossus is guaranteed to appear once every 3 levels.
   *
   * @param {boolean} [forceSeeder=false]  If true, always spawns a seeder regardless of level.
   * @param {boolean} [forceColossus=false] If true, forces a Colossus boss spawn.
   */
  spawn(forceSeeder = false, forceColossus = false) {
    let type = 'seeder';
    if (forceColossus) {
      type = 'colossus';
    } else if (!forceSeeder && gameState.level > 0) {
      let r = random();
      if (r < 0.35) type = 'seeder';
      else if (r < 0.57) type = 'fighter';
      else if (r < 0.72) type = 'bomber';
      else if (r < 0.84) type = 'crab';
      else if (r < 0.90) {
        if (gameState.level >= 4 && r < 0.87) type = 'yellowCrab'; // Steal 3% from hunters for yellow crab
        else type = 'hunter';
      }
      else if (r < 0.96) type = 'squid';
      else type = 'scorpion';
    }

    // Colossus spawns must be far enough from the centre so the player has time to react
    let ex, ez, ey;
    if (type === 'colossus') {
      let angle = random(TWO_PI);
      let dist = random(2500, 4000);
      ex = cos(angle) * dist;
      ez = sin(angle) * dist;
      ey = terrain.getAltitude(ex, ez);  // On the ground — will be adjusted each frame
    } else {
      ex = random(-4000, 4000);
      ez = random(-4000, 4000);
      ey = random(-300, -800);
      if (type === 'crab' || type === 'scorpion' || type === 'yellowCrab') {
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
    const alivePlayers = [];
    for (let i = 0; i < gameState.players.length; i++) {
      if (!gameState.players[i].dead) alivePlayers.push(gameState.players[i].ship);
    }
    let refShip = alivePlayers[0] || gameState.players[0].ship;  // Fallback to P1 even if dead

    for (let e of this.enemies) {
      if (e.type === 'fighter') this.updateFighter(e, alivePlayers, refShip);
      else if (e.type === 'bomber') this.updateBomber(e, refShip);
      else if (e.type === 'crab') this.updateCrab(e, alivePlayers, refShip);
      else if (e.type === 'hunter') this.updateHunter(e, alivePlayers, refShip);
      else if (e.type === 'squid') this.updateSquid(e, alivePlayers, refShip);
      else if (e.type === 'scorpion') this.updateScorpion(e, alivePlayers, refShip);
      else if (e.type === 'colossus') this.updateColossus(e, alivePlayers, refShip);
      else if (e.type === 'yellowCrab') this.updateYellowCrab(e, alivePlayers, refShip);
      else this.updateSeeder(e, refShip);
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
    e.x += e.vx * 1.5; e.z += e.vz * 1.5;
    e.y += sin(frameCount * 0.02 + e.id);  // Gentle vertical oscillation

    // Reflect velocity when too far from the reference ship
    if (abs(e.x - refShip.x) > 4000) e.vx *= -1;
    if (abs(e.z - refShip.z) > 4000) e.vz *= -1;

    e.bombTimer++;
    if (e.bombTimer > 600) {
      e.bombTimer = 0;
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        particleSystem.bombs.push({ x: e.x, y: e.y, z: e.z, k: tileKey(tx, tz), type: 'mega' });
        if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop('mega', e.x, e.y, e.z);
      }
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
    this._updateCrabAI(e, alivePlayers, refShip, 1.5, 0.04, 'green', 2.0);
  }

  /**
   * Shared logic for ground-hugging crab enemies.
   * @param {object} e            Enemy state.
   * @param {object[]} alivePlayers Alive ships.
   * @param {object} refShip      Fallback.
   * @param {number} speed        Movement speed factor.
   * @param {number} infProb      Probability of tile infection per frame.
   * @param {string} infType      Type of virus to spread ('normal' or 'green' [yellow virus]).
   * @param {number} pulseScale   Visual pulse feedback intensity.
   */
  _updateCrabAI(e, alivePlayers, refShip, speed, infProb, infType, pulseScale) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dz = tShip.z - e.z;
    let d = mag2(dx, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
    }

    e.x += e.vx; e.z += e.vz;

    const gyC = terrain.getAltitude(e.x, e.z);
    e.y = gyC - 10;

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy: -12, vz: 0, life: 1000 });
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('crab', e.x, e.y - 10, e.z);
    }

    if (random() < infProb) {
      if (!aboveSea(gyC)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k, infType)) {
          if (isLaunchpad(e.x, e.z)) maybePlayLaunchpadAlarm();
          terrain.addPulse(e.x, e.z, pulseScale);
        }
      }
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
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dy = tShip.y - e.y, dz = tShip.z - e.z;
    let d = mag3(dx, dy, dz);
    let speed = 5.0;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.1);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.1);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.1);
    }

    // Terrain avoidance: push up if within 50 units of the ground
    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 50) e.vy -= 1.0;

    e.x += e.vx; e.y += e.vy; e.z += e.vz;
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
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

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

    let dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    let d = mag3(dx, dy, dz);

    let speed = 2.5;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
    }

    // Terrain avoidance: push up if within 150 units of the ground
    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 150) e.vy -= 0.5;

    e.x += e.vx; e.y += e.vy; e.z += e.vz;

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
        let gy = terrain.getAltitude(e.x, e.z);
        if (!aboveSea(gy)) {
          let tx = toTile(e.x), tz = toTile(e.z);
          let k = tileKey(tx, tz);
          if (!infection.has(k)) {
            particleSystem.bombs.push({ x: e.x, y: e.y, z: e.z, k });
            if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop('normal', e.x, e.y, e.z);
          }
        }
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
    e.x += e.vx; e.z += e.vz;
    e.y += sin(frameCount * 0.05 + e.id) * 2;  // Gentle vertical oscillation

    if (abs(e.x - refShip.x) > 5000) e.vx *= -1;
    if (abs(e.z - refShip.z) > 5000) e.vz *= -1;

    if (random() < 0.008) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (!infection.has(k)) {
          particleSystem.bombs.push({ x: e.x, y: e.y, z: e.z, k });
          if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop('normal', e.x, e.y, e.z);
        }
      }
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
      let tShip = findNearest(alivePlayers, e.x, e.y, e.z) || refShip;
      targetX = tShip.x;
      targetZ = tShip.z;
    } else {
      // --- Mode 1: Hunt nearest healthy (uninfected) sentinel ---
      let bestDist = Infinity;
      targetX = null; targetZ = null;
      for (let b of gameState.buildings) {
        if (b.type !== 4) continue;
        let sk = tileKey(toTile(b.x), toTile(b.z));
        if (infection.has(sk)) continue;  // Already infected — skip
        let distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
        if (distSq < bestDist) { bestDist = distSq; targetX = b.x; targetZ = b.z; }
      }
      // --- Mode 2: No healthy sentinels left — march toward the launchpad ---
      if (targetX === null) {
        targetX = LP_CENTER;
        targetZ = LP_CENTER;
      }
    }

    let dx = targetX - e.x, dz = targetZ - e.z;
    let d = mag2(dx, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * 1.5, 0.04);
      e.vz = lerp(e.vz || 0, (dz / d) * 1.5, 0.04);
    }

    e.x += e.vx; e.z += e.vz;
    // Snap to ground surface
    const gyS = terrain.getAltitude(e.x, e.z);
    e.y = gyS - 20;

    // Infect tiles below — triggers launchpad alarm when relevant
    if (random() < 0.025) {
      if (!aboveSea(gyS)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k)) {
          if (isLaunchpad(e.x, e.z)) {
            maybePlayLaunchpadAlarm();
          }
          terrain.addPulse(e.x, e.z, 1.0);
        }
      }
    }

    // Fire upward bullet at nearby players every 150 frames
    e.fireTimer = (e.fireTimer || 0) + 1;
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    if (target) {
      let pd = mag2(target.x - e.x, target.z - e.z);
      if (pd < 1200 && e.fireTimer > 150) {
        e.fireTimer = 0;
        // scorpion shot - keep alive for extended travel
        particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy: -10, vz: 0, life: 1000 });
        if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('crab', e.x, e.y - 10, e.z);
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
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    // Slow, deliberate movement toward the player
    let dx = tShip.x - e.x, dz = tShip.z - e.z;
    let d = mag2(dx, dz);
    let speed = 1.2;  // Slower than most enemies — weight of a giant
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.025);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.025);
    }
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
      if (!aboveSea(gyCo)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k)) {
          if (isLaunchpad(e.x, e.z)) {
            maybePlayLaunchpadAlarm();
          }
          terrain.addPulse(e.x, e.z, 1.0);
        }
        // Infect a few neighbouring tiles as well for a wide footprint
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (random() < 0.25) {
              let nk = tileKey(tx + di, tz + dj);
              if (!infection.has(nk)) {
                let nx = (tx + di) * TILE, nz = (tz + dj) * TILE;
                if (!aboveSea(terrain.getAltitude(nx, nz)))
                  infection.add(nk);
              }
            }
          }
        }
      }
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
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dy = tShip.y - e.y, dz = tShip.z - e.z;
    let d = mag3(dx, dy, dz);
    let speed = 3.5;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
    }

    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 150) e.vy -= 1.0;

    // Squirt animation timer: short body squeeze during ink release.
    if (e.inkSqueeze && e.inkSqueeze > 0) e.inkSqueeze--;

    // Ink squirt decision: single large cloud with cooldown.
    if (e.inkCooldown === undefined) e.inkCooldown = floor(random(140, 240));
    e.inkCooldown--;
    if (e.inkCooldown <= 0) {
      let shouldSquirt = (d < 1500 && random() < 0.32) || random() < 0.02;
      if (shouldSquirt) {
        let vm = Math.max(mag3(e.vx || 0, e.vy || 0, e.vz || 0), 0.001);
        let bx = -(e.vx || 0) / vm, by = -(e.vy || 0) / vm, bz = -(e.vz || 0) / vm;
        particleSystem.addFogParticle({
          x: e.x + bx * 34,
          y: e.y + by * 20,
          z: e.z + bz * 34,
          vx: bx * 1.2 + random(-0.25, 0.25),
          vy: by * 0.8 + random(-0.2, 0.2),
          vz: bz * 1.2 + random(-0.25, 0.25),
          life: 320,
          decay: 0.95,
          size: random(780, 980),
          color: [1, 1, 2],
          isInkBurst: true
        });
        e.inkSqueeze = 12;
        // Recoil forward after squirting for a darting squid-like motion.
        e.vx += (e.vx || 0) * 0.22;
        e.vy += (e.vy || 0) * 0.22;
        e.vz += (e.vz || 0) * 0.22;
      }
      e.inkCooldown = floor(random(220, 360));
    }

    e.x += e.vx; e.y += e.vy; e.z += e.vz;
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
    let v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    let nx = v1[1] * v2[2] - v1[2] * v2[1];
    let ny = v1[2] * v2[0] - v1[0] * v2[2];
    let nz = v1[0] * v2[1] - v1[1] * v2[0];
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
    fill(ccR, ccG, ccB);
    if (isYellow) {
      // Luminous glow for yellow crab
      let glow = sin(frameCount * 0.1) * 30 + 30;
      fill(Math.min(255, ccR + glow), Math.min(255, ccG + glow), ccB);
    }
    push(); box(36, 16, 30); pop();
    push(); translate(0, -8, 0); box(24, 8, 20); pop();
    push();
    fill(12, 12, 12);
    translate(-8, -10, 15); box(4, 8, 4);
    translate(16, 0, 0); box(4, 8, 4);
    pop();
    fill(ccDR, ccDG, ccDB);
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
    fill(ccR, ccG, ccB);
    if (isYellow) {
      let glow = sin(frameCount * 0.1) * 30 + 30;
      fill(Math.min(255, ccR + glow), Math.min(255, ccG + glow), ccB);
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
    fill(30, 30, 35);
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
    fill(scR, scG, scB);
    push(); box(30, 10, 26); pop();
    fill(scDR, scDG, scDB);
    push(); translate(0, -5, 2); box(24, 2, 20); pop();
    push(); translate(0, -4, -8); box(20, 2, 10); pop();

    // Head/Front
    fill(scR, scG, scB);
    push(); translate(0, -1, 14); box(18, 6, 12); pop();
    fill(80, 255, 80); // Eyes
    push(); translate(-6, -5, 18); box(3, 3, 3); pop();
    push(); translate(6, -5, 18); box(3, 3, 3); pop();

    // Articulated pincers
    fill(scR, scG, scB);
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
    fill(scDR, scDG, scDB);
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
    fill(scR, scG, scB);
    push(); translate(0, -5, -15);
    for (let i = 0; i < 6; i++) {
      let wave = sin(frameCount * 0.1 + e.id + i * 0.5) * 0.1;
      rotateX(-0.35 + wave);
      translate(0, -7, -4);
      box(14 - i * 2, 8 - i, 8 - i);
    }
    fill(scGR, scGG, scGB);
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
      fill(fcR, fcG, fcB);
      rotateX(thighSwing);
      push(); translate(0, 60, 0); box(50, 120, 50); pop();
      translate(0, 120, 0);
      rotateX(-shinBend);
      push(); translate(0, 60, 0); box(40, 120, 40); pop();
      fill(dkR, dkG, dkB);
      translate(0, 120, 0);
      push(); translate(0, 12, side * -6); box(60, 24, 75); pop();
      pop();
    }
    fill(dkR, dkG, dkB);
    push(); translate(0, -45, 0); box(130, 36, 90); pop();
    fill(fcR, fcG, fcB);
    push(); translate(0, -160, 0); box(160, 200, 110); pop();
    fill(dkR, dkG, dkB);
    push(); translate(-105, -210, 0); box(50, 50, 65); pop();
    push(); translate(105, -210, 0); box(50, 50, 65); pop();
    for (let side = -1; side <= 1; side += 2) {
      let armSwing = sin(walkCycle * side + PI) * 0.15;
      push();
      translate(side * 105, -210, 0);
      rotateX(armSwing);
      fill(fcR, fcG, fcB);
      push(); translate(0, 65, 0); box(45, 120, 45); pop();
      fill(dkR, dkG, dkB);
      push(); translate(0, 125, 0); box(40, 30, 40); pop();
      fill(fcR, fcG, fcB);
      push(); translate(0, 185, 0); box(36, 100, 36); pop();
      fill(acR, acG, acB);
      push(); translate(0, 245, 0); box(55, 55, 55); pop();
      pop();
    }
    fill(dkR, dkG, dkB);
    push(); translate(0, -270, 0); box(65, 40, 60); pop();
    fill(fcR, fcG, fcB);
    push(); translate(0, -320, 0); box(100, 90, 100); pop();
    fill(glR, glG, glB);
    push(); translate(-25, -330, 51); box(25, 18, 8); pop();
    push(); translate(25, -330, 51); box(25, 18, 8); pop();
    fill(dkR, dkG, dkB);
    push(); translate(0, -348, 51); box(104, 15, 8); pop();
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

  /** @private Renders a bomber enemy (rotating bipyramid). */
  _drawBomber(e) {
    rotateY(frameCount * 0.05);
    noStroke();
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

  /** @private Renders a seeder enemy (rotating double-diamond + vertical antenna). */
  _drawSeeder(e) {
    rotateY(frameCount * 0.15); noStroke();
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
  }

  /**
   * Renders all enemies visible from the given ship's position.
   * Each enemy type has a distinct 3D mesh.  All meshes cast a ground shadow.
   *
   * Two rendering passes are required because p5.js box()/cylinder() primitives
   * need the default shader to respect fill() colours, while vertex-based enemies
   * use the terrain shader for fog and rim-lighting effects.
   *
   * @param {{x,y,z,yaw}} s  Ship state used as the view origin for culling.
   */
  draw(s) {
    let cullSq = CULL_DIST * CULL_DIST;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PASS 1: Box/cylinder-based enemies — p5 default shader so fill() colors work.
    // p5.js box() and cylinder() do NOT pass the current fill() as aVertexColor
    // when a custom shader is active; the vertex color buffer retains its baked-in
    // default (often black/white), making the entity appear black. These enemies
    // are therefore drawn BEFORE applying the terrain shader.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    setSceneLighting();

    for (let e of this.enemies) {
      let localCullSq = cullSq;
      if (e.type === 'colossus') {
        const colScale = e.colossusScale || 1;
        localCullSq = (CULL_DIST * (1.5 + (colScale - 1) * 0.4)) ** 2;
      }
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > localCullSq) continue;

      push();
      translate(e.x, e.y, e.z);
      if (e.type === 'crab' || e.type === 'yellowCrab') translate(0, -10, 0);
      if (e.type === 'colossus') scale(ENEMY_DRAW_SCALE * (e.colossusScale || 1));
      else scale(ENEMY_DRAW_SCALE);

      if (e.type === 'crab' || e.type === 'yellowCrab') this._drawCrab(e);
      else if (e.type === 'squid') this._drawSquid(e);
      else if (e.type === 'scorpion') this._drawScorpion(e);
      else if (e.type === 'colossus') this._drawColossus(e);

      pop();
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // PASS 2: Vertex-based enemies — terrain shader for fog, lighting & rim effects.
    // These use beginShape(TRIANGLES) with explicit vertex calls, which correctly
    // populate aVertexColor with the current fill() colour.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    terrain.applyShader();

    for (let e of this.enemies) {
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > cullSq) continue;
      const isVertexEnemy = (e.type === 'fighter' || e.type === 'bomber' ||
        e.type === 'hunter' || e.type === 'seeder');
      if (!isVertexEnemy) continue;

      push(); translate(e.x, e.y, e.z); scale(ENEMY_DRAW_SCALE);
      if (e.type === 'fighter') this._drawFighter(e);
      else if (e.type === 'bomber') this._drawBomber(e);
      else if (e.type === 'hunter') this._drawHunter(e);
      else this._drawSeeder(e);
      pop();
    }

    resetShader();
    setSceneLighting();

    // Shadow pass
    for (let e of this.enemies) {
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > cullSq) continue;
      const gy = terrain.getAltitude(e.x, e.z);
      const casterH = max(24, gy - e.y);
      let sw = 80, sh = 50;
      if (e.type === 'colossus') {
        const colScale = e.colossusScale || 1;
        sw = 320 * colScale;
        sh = 230 * colScale;
      }
      else if (e.type === 'bomber') { sw = 150; sh = 85; }
      else if (e.type === 'fighter') { sw = 64; sh = 60; }
      else if (e.type === 'hunter') { sw = 80; sh = 48; }
      else if (e.type === 'squid') { sw = 110; sh = 72; }
      else if (e.type === 'seeder') { sw = 68; sh = 50; }
      if (e.type !== 'crab' && e.type !== 'scorpion' && e.type !== 'yellowCrab') {
        drawShadow(e.x, gy, e.z, sw, sh, casterH);
      }
    }
  }
}

// Singleton instance used by all other modules
const enemyManager = new EnemyManager();
