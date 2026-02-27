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
    this.enemies = [];
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
      colossus: [255, 60, 20]
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
    } else if (!forceSeeder && level > 0) {
      let r = random();
      if (r < 0.35) type = 'seeder';
      else if (r < 0.57) type = 'fighter';
      else if (r < 0.72) type = 'bomber';
      else if (r < 0.84) type = 'crab';
      else if (r < 0.90) type = 'hunter';
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
      if (type === 'crab' || type === 'scorpion') {
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

    // Colossus gets a large HP pool — it takes many hits
    if (type === 'colossus') {
      entry.hp = 80;   // 80 hits to kill
      entry.maxHp = 80;
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
    let alivePlayers = players.filter(p => !p.dead).map(p => p.ship);
    let refShip = alivePlayers[0] || players[0].ship;  // Fallback to P1 even if dead

    for (let e of this.enemies) {
      if (e.type === 'fighter') this.updateFighter(e, alivePlayers, refShip);
      else if (e.type === 'bomber') this.updateBomber(e, refShip);
      else if (e.type === 'crab') this.updateCrab(e, alivePlayers, refShip);
      else if (e.type === 'hunter') this.updateHunter(e, alivePlayers, refShip);
      else if (e.type === 'squid') this.updateSquid(e, alivePlayers, refShip);
      else if (e.type === 'scorpion') this.updateScorpion(e, alivePlayers, refShip);
      else if (e.type === 'colossus') this.updateColossus(e, alivePlayers, refShip);
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
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dz = tShip.z - e.z;
    let d = Math.hypot(dx, dz);
    if (d > 0) {
      // Slow lerped steering gives the crab a clumsy, deliberate gait
      e.vx = lerp(e.vx || 0, (dx / d) * 1.2, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * 1.2, 0.05);
    }

    e.x += e.vx; e.z += e.vz;

    // Snap Y to the ground surface minus a small offset so the crab appears to crawl
    e.y = terrain.getAltitude(e.x, e.z) - 10;

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      // Shoot a fast upward projectile toward the player
      particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy: -12, vz: 0, life: 100 });
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('crab', e.x, e.y - 10, e.z);
    }

    // Random ground infection
    if (random() < 0.02) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k)) {
          if (isLaunchpad(e.x, e.z)) {
            if (millis() - lastAlarmTime > 1000) {
              if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
              lastAlarmTime = millis();
            }
          }
          terrain.addPulse(e.x, e.z, 1.0);  // Blue crab-type pulse ring
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
    let d = Math.hypot(dx, dy, dz);
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
    let d = Math.hypot(dx, dy, dz);

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
      let pd = Math.hypot(pvx, pvy, pvz);
      particleSystem.enemyBullets.push({
        x: e.x, y: e.y, z: e.z,
        vx: (pvx / pd) * 10, vy: (pvy / pd) * 10, vz: (pvz / pd) * 10,
        life: 120
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
          if (!infection.tiles[k]) {
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
        if (!infection.tiles[k]) {
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
      for (let b of buildings) {
        if (b.type !== 4) continue;
        let sk = tileKey(toTile(b.x), toTile(b.z));
        if (infection.tiles[sk]) continue;  // Already infected — skip
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
    let d = Math.hypot(dx, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * 1.5, 0.04);
      e.vz = lerp(e.vz || 0, (dz / d) * 1.5, 0.04);
    }

    e.x += e.vx; e.z += e.vz;
    // Snap to ground surface
    e.y = terrain.getAltitude(e.x, e.z) - 10;

    // Infect tiles below — triggers launchpad alarm when relevant
    if (random() < 0.025) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k)) {
          if (isLaunchpad(e.x, e.z)) {
            if (millis() - lastAlarmTime > 1000) {
              if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
              lastAlarmTime = millis();
            }
          }
          terrain.addPulse(e.x, e.z, 1.0);
        }
      }
    }

    // Fire upward bullet at nearby players every 150 frames
    e.fireTimer = (e.fireTimer || 0) + 1;
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    if (target) {
      let pd = Math.hypot(target.x - e.x, target.z - e.z);
      if (pd < 1200 && e.fireTimer > 150) {
        e.fireTimer = 0;
        particleSystem.enemyBullets.push({ x: e.x, y: e.y - 10, z: e.z, vx: 0, vy: -10, vz: 0, life: 120 });
        if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('crab', e.x, e.y - 10, e.z);
      }
    }
  }

  /**
   * Colossus BOSS AI: A massive ground-walking block-humanoid.
   * - Walks slowly but relentlessly toward the nearest player on two legs.
   * - Fires burst salvos of 3 aimed bullets every 120 frames when in range.
   * - Leaves virus infection in its footsteps as it marches.
   * - Has 40 HP; bullets/missiles reduce .hp rather than destroying it outright.
   * @param {object}   e            Enemy state (carries hp, maxHp, hitFlash).
   * @param {object[]} alivePlayers Alive ship states.
   * @param {object}   refShip      Fallback target.
   */
  updateColossus(e, alivePlayers, refShip) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    // Slow, deliberate movement toward the player
    let dx = tShip.x - e.x, dz = tShip.z - e.z;
    let d = Math.hypot(dx, dz);
    let speed = 1.2;  // Slower than most enemies — weight of a giant
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.025);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.025);
    }
    e.x += e.vx; e.z += e.vz;

    // Snap to ground surface — the Colossus always walks on land
    e.y = terrain.getAltitude(e.x, e.z);

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
        let bdx = tShip.x - e.x, bdy = tShip.y - (e.y - 240), bdz = tShip.z - e.z;
        let bd = Math.hypot(bdx, bdy, bdz);
        if (bd > 0) {
          let spread = 0.12;
          particleSystem.enemyBullets.push({
            x: e.x, y: e.y - 240, z: e.z,
            vx: (bdx / bd) * 14 + random(-spread, spread) * 14,
            vy: (bdy / bd) * 14,
            vz: (bdz / bd) * 14 + random(-spread, spread) * 14,
            life: 160
          });
          if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, e.y - 240, e.z);
        }
      }
    }

    // --- Virus trail: infect tiles below the Colossus as it lumbers along ---
    if (random() < 0.06) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (infection.add(k)) {
          if (isLaunchpad(e.x, e.z)) {
            if (millis() - lastAlarmTime > 1000) {
              if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
              lastAlarmTime = millis();
            }
          }
          terrain.addPulse(e.x, e.z, 1.0);
        }
        // Infect a few neighbouring tiles as well for a wide footprint
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (random() < 0.25) {
              let nk = tileKey(tx + di, tz + dj);
              if (!infection.tiles[nk]) {
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
    let d = Math.hypot(dx, dy, dz);
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
        let vm = Math.max(Math.hypot(e.vx || 0, e.vy || 0, e.vz || 0), 0.001);
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
   * Renders all enemies visible from the given ship's position.
   * Each enemy type has a distinct 3D mesh.  All meshes apply fog-colour blending
   * via terrain.getFogColor() and cast a ground shadow.
   *
   * Enemy mesh summaries:
   *   fighter — arrowhead (TRIANGLES, yaw/pitch aligned to velocity)
   *   bomber  — spinning bipyramid (double diamond, Y-rotation)
   *   crab    — detailed articulated body with animated legs and pincers
   *   hunter  — small teardrop arrowhead (yaw/pitch aligned to velocity)
   *   squid   — cylinder body + 8 animated tentacles
   *   seeder  — rotating double diamond + vertical antenna
   *
   * @param {{x,y,z,yaw}} s  Ship state used as the view origin for depth and culling.
   */
  draw(s) {
    // Reuse the camera params already computed in terrain.drawLandscape this frame.
    let cam = terrain._cam || terrain.getCameraParams(s);
    // Colossus is massive — always render it even near the edge of cull distance
    let cullSq = CULL_DIST * CULL_DIST;

    for (let e of this.enemies) {
      // Colossus gets an extra-generous cull distance so it's always visible
      let localCullSq = (e.type === 'colossus') ? (CULL_DIST * 1.5) ** 2 : cullSq;
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > localCullSq) continue;

      let depth = (e.x - cam.x) * cam.fwdX + (e.z - cam.z) * cam.fwdZ;

      push(); translate(e.x, e.y, e.z);

      // Crabs are drawn 10 units lower so their body appears to rest on the ground
      if (e.type === 'crab') translate(0, -10, 0);

      scale(2);

      if (e.type === 'fighter') {
        // Align mesh to velocity direction
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
        noStroke();
        let ec = terrain.getFogColor([255, 150, 0], depth);
        fill(ec[0], ec[1], ec[2]);
        beginShape(TRIANGLES);
        // Nose → left rear, nose → right rear (top and bottom faces)
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(15, 0, -15);
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, -10, 0);
        vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, -10, 0);
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, 10, 0);
        vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, 10, 0);
        endShape();

      } else if (e.type === 'bomber') {
        rotateY(frameCount * 0.05);
        noStroke();
        let bc = terrain.getFogColor([180, 20, 180], depth);
        fill(bc[0], bc[1], bc[2]);
        beginShape(TRIANGLES);
        // Two mirrored pyramids sharing a square equator — upper and lower halves
        vertex(0, -40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
        vertex(0, -40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
        vertex(0, -40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
        vertex(0, -40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
        vertex(0, 40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
        vertex(0, 40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
        vertex(0, 40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
        vertex(0, 40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
        endShape();

      } else if (e.type === 'crab') {
        // ---- Detailed articulated crab body ----
        let yaw = atan2(e.vx || 0, e.vz || 0);
        rotateY(yaw);
        noStroke();
        let cc = terrain.getFogColor([200, 80, 20], depth);
        let ccDark = terrain.getFogColor([150, 40, 10], depth);

        // Main shell and raised carapace
        fill(cc[0], cc[1], cc[2]);
        push(); box(36, 16, 30); pop();
        push(); translate(0, -8, 0); box(24, 8, 20); pop();

        // Eye stalks
        push();
        fill(10, 10, 10);
        translate(-8, -10, 15); box(4, 8, 4);
        translate(16, 0, 0); box(4, 8, 4);
        pop();

        // Animated walking legs (3 per side, alternating stride)
        fill(ccDark[0], ccDark[1], ccDark[2]);
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
            translate(side * 10, -3, 0); box(20, 6, 6);  // Upper segment
            translate(side * 8, 0, 0);
            rotateZ(side * 0.8);
            translate(side * 10, 0, 0); box(22, 4, 4);  // Lower segment
            pop();
          }
        }

        // Pincers with opening/closing nip animation
        fill(cc[0], cc[1], cc[2]);
        for (let side = -1; side <= 1; side += 2) {
          let pincerLift = sin(frameCount * 0.1 + e.id) * 0.1;
          push();
          translate(side * 16, 0, 14);
          rotateY(side * -0.6);
          rotateZ(side * (-0.3 + pincerLift));
          translate(side * 10, 0, 0); box(20, 6, 8);   // Arm segment
          translate(side * 10, 0, 0);
          rotateY(side * -1.2);
          translate(side * 8, 0, 0); box(16, 8, 10);  // Claw body
          translate(side * 10, 0, 0); box(12, 10, 12); // Claw tip

          // Upper and lower nippers rotating apart
          let nip = abs(sin(frameCount * 0.2 + e.id * 3)) * 0.5;
          push(); translate(side * 6, 0, -4); rotateY(side * -nip); translate(side * 8, 0, 0); box(16, 5, 4); pop();
          push(); translate(side * 6, 0, 4); rotateY(side * nip); translate(side * 8, 0, 0); box(16, 5, 4); pop();
          pop();
        }

      } else if (e.type === 'hunter') {
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
        noStroke();
        let hc = terrain.getFogColor([40, 255, 40], depth);
        fill(hc[0], hc[1], hc[2]);
        // Smaller arrowhead than fighter — faster and more agile
        beginShape(TRIANGLES);
        vertex(0, 0, 30); vertex(-8, 0, -20); vertex(8, 0, -20);
        vertex(0, 0, 30); vertex(-8, 0, -20); vertex(0, -10, 0);
        vertex(0, 0, 30); vertex(8, 0, -20); vertex(0, -10, 0);
        endShape();

      } else if (e.type === 'squid') {
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) { rotateY(atan2(fvX, fvZ)); rotateX(-asin(fvY / d)); }
        noStroke();
        let sqc = terrain.getFogColor([30, 30, 35], depth);
        fill(sqc[0], sqc[1], sqc[2]);

        push();
        // Brief squeeze animation when releasing ink.
        let squeeze = (e.inkSqueeze || 0) / 12;
        scale(1.0 + squeeze * 0.20, 1.0 - squeeze * 0.25, 1.0 + squeeze * 0.20);
        rotateX(PI / 2);
        cylinder(12, 40, 8, 1);  // Mantle body

        // 8 animated tentacles arranged in a circle around the base
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

      } else if (e.type === 'scorpion') {
        // ---- Scorpion: armoured ground-crawler with raised segmented tail ----
        let yaw = atan2(e.vx || 0, e.vz || 0);
        rotateY(yaw);
        noStroke();

        let sc = terrain.getFogColor([20, 180, 120], depth);  // Main teal-green
        let scD = terrain.getFogColor([5, 100, 60], depth);  // Dark underside
        let scG = terrain.getFogColor([80, 255, 160], depth);  // Bright sting glow

        // Main carapace — low flattened body
        fill(sc[0], sc[1], sc[2]);
        push(); box(30, 8, 26); pop();                   // Central hull
        push(); translate(0, -2, -18); box(18, 6, 12); pop();  // Rear abdomen
        push(); translate(0, -1, 14); box(14, 5, 10); pop();  // Forward head plate

        // Eye nubs
        fill(80, 255, 80);
        push(); translate(-6, -5, 18); box(3, 3, 3); pop();
        push(); translate(6, -5, 18); box(3, 3, 3); pop();

        // Animated scuttling legs (3 per side)
        fill(scD[0], scD[1], scD[2]);
        let walkPhase = frameCount * 0.35 + e.id;
        for (let side = -1; side <= 1; side += 2) {
          for (let i = -1; i <= 1; i++) {
            let lp = walkPhase + i * PI / 3 * side;
            let lift = max(0, sin(lp)) * 0.5;
            let stride = cos(lp);
            push();
            translate(side * 15, 2, i * 8);
            rotateZ(side * (-0.15 - lift * 0.35));
            rotateY(stride * 0.25);
            translate(side * 8, 0, 0); box(16, 4, 4);
            pop();
          }
        }

        // Segmented raised tail (4 segments curving up and over the body)
        fill(sc[0], sc[1], sc[2]);
        push();
        translate(0, -5, -20);
        for (let i = 0; i < 4; i++) {
          let wave = sin(frameCount * 0.08 + e.id + i * 0.6) * 0.06;
          rotateX(-0.45 + wave);
          translate(0, -7, -3);
          box(10 - i * 1.5, 7 - i, 6 - i);
        }
        // Sting tip — bright glowing point
        fill(scG[0], scG[1], scG[2]);
        translate(0, -5, -3);
        box(4, 10, 4);
        pop();

      } else if (e.type === 'colossus') {
        // ---- COLOSSUS BOSS: towering humanoid built from imposing blocks ----
        let yaw = atan2(e.vx || 0, e.vz || 0);
        rotateY(yaw);
        noStroke();

        // Colour scheme: dark charcoal body with lava-orange accents, flashes white when hit
        let hitT = e.hitFlash > 0 ? min(1, e.hitFlash / 8) : 0;
        let bodyBase = [40, 40, 55];
        let bodyHit = [255, 255, 255];
        let accentBase = [255, 60, 20];
        let accentHit = [255, 255, 0];

        let bodyR = lerp(bodyBase[0], bodyHit[0], hitT);
        let bodyG = lerp(bodyBase[1], bodyHit[1], hitT);
        let bodyB = lerp(bodyBase[2], bodyHit[2], hitT);

        let accR = lerp(accentBase[0], accentHit[0], hitT);
        let accG = lerp(accentBase[1], accentHit[1], hitT);
        let accB = lerp(accentBase[2], accentHit[2], hitT);


        let fc = terrain.getFogColor([bodyR, bodyG, bodyB], depth);
        let ac = terrain.getFogColor([accR, accG, accB], depth);
        let darkC = terrain.getFogColor([20, 20, 30], depth);
        let glowC = terrain.getFogColor([255, 120, 0], depth);

        // ---- LEGS (animated — alternating stride) ----
        let walkSpeed = Math.hypot(e.vx || 0, e.vz || 0);
        let walkCycle = frameCount * 0.08 * (walkSpeed > 0.1 ? 1 : 0) + (e.id || 0);
        for (let side = -1; side <= 1; side += 2) {
          let legPhase = walkCycle * side;
          let thighSwing = sin(legPhase) * 0.4;
          let shinBend = max(0, -cos(legPhase)) * 0.5;
          let footLift = max(0, sin(legPhase)) * 40;

          push();
          // Hip attachment point — shifted up for longer legs
          translate(side * 50, -40, 0);

          // Thigh — lengthened to 120
          fill(fc[0], fc[1], fc[2]);
          rotateX(thighSwing);
          push(); translate(0, 60, 0); box(50, 120, 50); pop();

          // Shin — lengthened to 120
          translate(0, 120, 0);
          rotateX(-shinBend);
          push(); translate(0, 60, 0); box(40, 120, 40); pop();

          // Foot — wide flat block
          fill(darkC[0], darkC[1], darkC[2]);
          translate(0, 120, 0);
          push(); translate(0, 12, side * -6); box(60, 24, 75); pop();
          pop();
        }

        // ---- PELVIS / WAIST ----
        fill(darkC[0], darkC[1], darkC[2]);
        push(); translate(0, -45, 0); box(130, 36, 90); pop();

        // ---- TORSO — massive imposing chest block ----
        fill(fc[0], fc[1], fc[2]);
        push(); translate(0, -160, 0); box(160, 200, 110); pop();

        // ---- SHOULDERS ----
        fill(darkC[0], darkC[1], darkC[2]);
        push(); translate(-105, -210, 0); box(50, 50, 65); pop();
        push(); translate(105, -210, 0); box(50, 50, 65); pop();

        // ---- ARMS — large swinging limbs ----
        for (let side = -1; side <= 1; side += 2) {
          let armSwing = sin(walkCycle * side + PI) * 0.15;
          push();
          translate(side * 105, -210, 0);
          rotateX(armSwing);

          // Upper arm
          fill(fc[0], fc[1], fc[2]);
          push(); translate(0, 65, 0); box(45, 120, 45); pop();

          // Elbow joint
          fill(darkC[0], darkC[1], darkC[2]);
          push(); translate(0, 125, 0); box(40, 30, 40); pop();

          // Forearm
          fill(fc[0], fc[1], fc[2]);
          push(); translate(0, 185, 0); box(40, 100, 40); pop();

          // Fist — massive brutality
          fill(ac[0], ac[1], ac[2]);
          push(); translate(0, 245, 0); box(55, 55, 55); pop();
          pop();
        }

        // ---- NECK ----
        fill(darkC[0], darkC[1], darkC[2]);
        push(); translate(0, -270, 0); box(65, 40, 60); pop();

        // ---- HEAD — massive boxy skull ----
        fill(fc[0], fc[1], fc[2]);
        push(); translate(0, -320, 0); box(100, 90, 100); pop();

        // Eye slots — glowing orange
        fill(glowC[0], glowC[1], glowC[2]);
        push(); translate(-25, -330, 51); box(25, 18, 8); pop();
        push(); translate(25, -330, 51); box(25, 18, 8); pop();

        // Head armour brow ridge
        fill(darkC[0], darkC[1], darkC[2]);
        push(); translate(0, -348, 51); box(104, 15, 8); pop();



      } else {
        // ---- Seeder: rotating double diamond with central antenna ----
        rotateY(frameCount * 0.15); noStroke();
        for (let [yOff, col] of [[-10, [220, 30, 30]], [6, [170, 15, 15]]]) {
          let oc = terrain.getFogColor(col, depth);
          fill(oc[0], oc[1], oc[2]);
          beginShape(TRIANGLES);
          vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
          vertex(0, yOff, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
          vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(0, yOff, 25);
          vertex(0, yOff, -25); vertex(22, 0, 0); vertex(0, yOff, 25);
          endShape();
        }
        let cc = terrain.getFogColor([255, 60, 60], depth);
        fill(cc[0], cc[1], cc[2]);
        push(); translate(0, -14, 0); box(3, 14, 3); pop();  // Antenna
      }
      pop();

      // Ground shadow — size varies by enemy type
      let sSize = e.type === 'colossus' ? 200
        : e.type === 'bomber' ? 60
          : (e.type === 'fighter' || e.type === 'hunter') ? 25 : 40;
      if (e.type !== 'crab' && e.type !== 'scorpion') {  // Ground-huggers already touch the surface
        drawShadow(e.x, terrain.getAltitude(e.x, e.z), e.z, sSize * 2, sSize * 2);
      }
    }
  }
}

// Singleton instance used by all other modules
const enemyManager = new EnemyManager();
