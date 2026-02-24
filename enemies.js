// =============================================================================
// enemies.js — EnemyManager class
//
// Owns the active enemy list and all AI update + rendering logic.
//
// Seven enemy types are implemented:
//   seeder   — slow drifter; randomly drops normal infection bombs below itself
//   bomber   — fast drifter; drops large 'mega' bombs every 600 frames (~10 s)
//   crab     — ground-hugging unit that tracks the nearest player and infects tiles
//   hunter   — fast aggressive airborne pursuer; no weapons, kills by collision
//   fighter  — switching between aggressive pursuit and wandering; shoots + drops bombs
//   squid    — medium-speed pursuer; emits a dark ink-cloud smoke trail
//   scorpion — ground-hugging; targets sentinel buildings to infect them, then launchpad
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
      scorpion: [20, 180, 120]
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
   *   fighter 25%  |  bomber 15%  |  crab 15%  |  hunter 10%  |  squid 10%  |  scorpion 15%  |  seeder 10%
   *
   * @param {boolean} [forceSeeder=false]  If true, always spawns a seeder regardless of level.
   */
  spawn(forceSeeder = false) {
    let type = 'seeder';
    if (!forceSeeder && level > 0) {
      let r = random();
      if (r < 0.25) type = 'fighter';
      else if (r < 0.40) type = 'bomber';
      else if (r < 0.55) type = 'crab';
      else if (r < 0.65) type = 'hunter';
      else if (r < 0.75) type = 'squid';
      else if (r < 0.90) type = 'scorpion';
    }

    let ex = random(-4000, 4000);
    let ez = random(-4000, 4000);
    let ey = random(-300, -800);
    if (type === 'crab' || type === 'scorpion') {
      // Ground-hugging enemies spawn ON the ground surface rather than at altitude
      ey = terrain.getAltitude(ex, ez) - 10;
    }

    this.enemies.push({
      x: ex, y: ey, z: ez,
      vx: random(-2, 2), vz: random(-2, 2),
      id: random(),        // Unique random seed used for per-enemy animation phase offsets
      type,
      fireTimer: 0,        // Counts frames since last bullet fired
      bombTimer: 0         // Counts frames since last bomb dropped (bomber/fighter/scorpion)
    });
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
      else if (e.type === 'scorpion') this.updateScorpion(e, refShip);
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
        if (!infectedTiles[k]) {
          infectedTiles[k] = { tick: frameCount };
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
          if (!infectedTiles[k]) {
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
        if (!infectedTiles[k]) {
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
   * @param {object} e        Enemy state.
   * @param {object} refShip  Fallback target for boundary checks.
   */
  updateScorpion(e, refShip) {
    // Locate the nearest healthy (uninfected) sentinel building
    let targetX = null, targetZ = null;
    let bestDist = Infinity;
    for (let b of buildings) {
      if (b.type !== 4) continue;
      let sk = tileKey(toTile(b.x), toTile(b.z));
      if (infectedTiles[sk]) continue;  // Already infected — skip
      let distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
      if (distSq < bestDist) { bestDist = distSq; targetX = b.x; targetZ = b.z; }
    }

    // Fall back to the launchpad centre if no healthy sentinel is reachable
    const LP_CENTER = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420
    if (targetX === null) {
      targetX = LP_CENTER;
      targetZ = LP_CENTER;
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

    // Infect tiles below — higher rate near launchpad, moderate elsewhere
    if (random() < 0.025) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (!infectedTiles[k]) {
          infectedTiles[k] = { tick: frameCount };
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
    let alivePlayers = players.filter(p => !p.dead).map(p => p.ship);
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
   * Squid AI: medium-speed 3D pursuer that emits a dark fog-particle ink trail.
   * The trail provides visual cover and makes the squid harder to track.
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

    e.x += e.vx; e.y += e.vy; e.z += e.vz;

    // Emit dark ink-cloud particles every 5 frames
    if (frameCount % 5 === 0) {
      particleSystem.particles.push({
        x: e.x + random(-10, 10),
        y: e.y + random(-10, 10),
        z: e.z + random(-10, 10),
        isFog: true,
        vx: e.vx * 0.2 + random(-0.5, 0.5),
        vy: e.vy * 0.2 + random(-0.5, 0.5),
        vz: e.vz * 0.2 + random(-0.5, 0.5),
        life: 255,
        decay: 3,
        size: random(30, 80),
        color: [10, 10, 12]
      });
    }
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
    let cam = terrain.getCameraParams(s);
    let cullSq = CULL_DIST * CULL_DIST;

    for (let e of this.enemies) {
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > cullSq) continue;

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
      let sSize = e.type === 'bomber' ? 60 : (e.type === 'fighter' || e.type === 'hunter' ? 25 : 40);
      if (e.type !== 'crab' && e.type !== 'scorpion') {  // Ground-huggers already touch the surface
        drawShadow(e.x, terrain.getAltitude(e.x, e.z), e.z, sSize * 2, sSize * 2);
      }
    }
  }
}

// Singleton instance used by all other modules
const enemyManager = new EnemyManager();
