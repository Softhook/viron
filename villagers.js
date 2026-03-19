// =============================================================================
// villagers.js — VillagerManager class
//
// Spawns small villager figures from uninfected villages. Villagers walk
// toward nearby infected tiles and have a low probability of removing one.
// They are destroyed if the tile they stand on becomes infected.
//
// Villages are identified by Pagoda buildings (type 2) from gameState.buildings.
// Each pagoda tracks its own spawn budget and cooldown timer.
// =============================================================================

// --- Villager tuning constants ---
const VILLAGER_MAX_PER_VILLAGE = 5;       // Maximum villagers a single village can spawn
const VILLAGER_SPAWN_INTERVAL = 300;     // Frames between spawn attempts (~5 seconds at 60 Hz)
const VILLAGER_RESPAWN_INTERVAL = 1200;    // Frames to regenerate one villager budget (~20 seconds)
const VILLAGER_MAX_WANDER_DIST_SQ = 1440 * 1440; // Max distance squared (12 tiles) from home pagoda
const VILLAGER_SPEED = 0.8;     // World units per physics tick
const VILLAGER_CURE_PROB = 0.004;   // Per-tick probability of curing a nearby virus tile
const VILLAGER_SEARCH_RADIUS = 4;      // Tile radius to search for infected tiles
const VILLAGER_CURE_RADIUS = 1;       // Must be within 1 tile to attempt a cure
const VILLAGER_CULL_DIST_SQ = CULL_DIST * CULL_DIST;
const VILLAGER_MAX_HEALTH = 100;
const VILLAGER_INFECTION_DAM = 1.2;    // Health loss per tick on infected tile
const VILLAGER_HEAL_RATE = 0.5;    // Health recovery per tick when safe
const VILLAGER_STOP_DIST = 100;     // Target distance to start curing (units)

class VillagerManager {
  constructor() {
    /** @type {Array<object>} Active villager objects. */
    this.villagers = [];

    // Reusable array for the draw pass — avoids per-frame allocation.
    this._visible = [];

    /** @type {Array<object>} Cached reference to all village buildings (pagodas). */
    this.villages = [];
    /** @type {Array<object>} Villages currently within simulation range. */
    this.activeVillages = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets all villager state. Called at level start. */
  clear() {
    // Only completely clear the active list on Level 1.
    // On subsequent levels, the villagers persist as requested.
    if (gameState.level === 1) {
      this.villagers.length = 0;
    }

    // Always refresh the village cache based on the current world buildings
    this.villages = gameState.buildings.filter(b => b.type === 2);
    this.activeVillages = [];

    // Only reset budgets on Level 1. On higher levels, the budget from the 
    // previous level carries over (and will continue to regenerate over time).
    if (gameState.level === 1) {
      for (const b of this.villages) {
        b._villagerBudget = VILLAGER_MAX_PER_VILLAGE;
        b._villagerTimer = 0;
        b._villagerRegenTimer = 0;
        b._villagerSpawned = 0;
      }
    }

    this._updateActiveVillages();
    this._frameCounter = 0;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update (called from the fixed-timestep physics loop)
  // ---------------------------------------------------------------------------

  update() {
    if (typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagers) return;

    let targetVillages = this.villages;

    if (!(typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagerCulling)) {
      // 0. Determine which villages are close enough to simulate (update every 30 frames)
      this._frameCounter = (this._frameCounter || 0) + 1;
      if (this._frameCounter >= 30) {
        this._frameCounter = 0;
        this._updateActiveVillages();
      }
      targetVillages = this.activeVillages;
    }

    // 1. Regenerate villager budgets over time
    this._regenerateBudgets(targetVillages);

    // 2. Try to spawn new villagers from uninfected active pagodas
    this._trySpawn(targetVillages);

    // 2. Update each active villager
    for (let i = this.villagers.length - 1; i >= 0; i--) {
      const v = this.villagers[i];

      // --- Health management: damage from infection ---
      const tk = tileKey(toTile(v.x), toTile(v.z));
      if (infection.has(tk)) {
        v.health -= VILLAGER_INFECTION_DAM;
        if (v.health <= 0) {
          this._killVillager(v, i);
          continue;
        }
      } else if (v.health < VILLAGER_MAX_HEALTH) {
        v.health = Math.min(VILLAGER_MAX_HEALTH, v.health + VILLAGER_HEAL_RATE);
      }

      // --- AI: find nearest infected tile and walk toward it ---
      this._steerTowardInfection(v);

      // --- Movement integration ---
      v.x += v.vx;
      v.z += v.vz;

      // Snap to ground
      const gy = terrain.getAltitude(v.x, v.z);
      v.y = gy;

      // Kill if walked into the sea
      if (aboveSea(gy)) {
        this._killVillager(v, i);
        continue;
      }

      // --- Try to cure nearby infection ---
      if (v.targetTx !== null && v.targetTz !== null) {
        const dx = Math.abs(toTile(v.x) - v.targetTx);
        const dz = Math.abs(toTile(v.z) - v.targetTz);
        if (dx <= VILLAGER_CURE_RADIUS && dz <= VILLAGER_CURE_RADIUS) {
          if (random() < VILLAGER_CURE_PROB) {
            const cureKey = tileKey(v.targetTx, v.targetTz);
            if (infection.has(cureKey)) {
              infection.remove(cureKey);
              // Visual + audio feedback
              terrain.addPulse(v.targetTx * TILE, v.targetTz * TILE, 1.0);
              if (typeof gameSFX !== 'undefined') {
                gameSFX.playVillagerCure(v.x, v.y, v.z);
              }
              // Small particle burst
              for (let p = 0; p < 8; p++) {
                particleSystem.particles.push({
                  x: v.x, y: v.y - 10, z: v.z,
                  vx: random(-2, 2), vy: random(-3, -1), vz: random(-2, 2),
                  life: 180, decay: 8, size: random(3, 6),
                  color: [60, 220, 120]
                });
              }
              // Clear target so villager seeks a new one
              v.targetTx = null;
              v.targetTz = null;
            }
          }
        }
      }

      // Walk animation phase
      v.walkPhase += 0.15;
    }
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /** @private Filters villages based on distance to active players to reduce CPU load. */
  _updateActiveVillages() {
    this.activeVillages.length = 0;
    const SIMULATION_DIST = CULL_DIST + 1000;
    const SIMULATION_DIST_SQ = SIMULATION_DIST * SIMULATION_DIST;

    if (!gameState.players || gameState.players.length === 0) return;

    for (const b of this.villages) {
      let isActive = false;
      for (const p of gameState.players) {
        if (!p.dead && p.ship) {
          const dx = b.x - p.ship.x;
          const dz = b.z - p.ship.z;
          if (dx * dx + dz * dz <= SIMULATION_DIST_SQ) {
            isActive = true;
            break;
          }
        }
      }
      if (isActive) {
        this.activeVillages.push(b);
      }
    }
  }

  /** @private */
  _regenerateBudgets(villagesArray) {
    for (const b of villagesArray) {
      // Initialize on first encounter if not set
      if (b._villagerBudget === undefined) {
        b._villagerBudget = VILLAGER_MAX_PER_VILLAGE;
        b._villagerTimer = 0;
        b._villagerRegenTimer = 0;
        b._villagerSpawned = 0;
      }

      if (b._villagerBudget < VILLAGER_MAX_PER_VILLAGE) {
        b._villagerRegenTimer = (b._villagerRegenTimer || 0) + 1;
        if (b._villagerRegenTimer > VILLAGER_RESPAWN_INTERVAL) {
          b._villagerRegenTimer = 0;
          b._villagerBudget++;
        }
      }
    }
  }

  /** @private */
  _trySpawn(villagesArray) {
    for (const b of villagesArray) {
      // Setup handled by _regenerateBudgets

      // Don't spawn if village is infected
      if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      if (infection.has(b._tileKey)) continue;

      // Budget exhausted
      if (b._villagerBudget <= 0) continue;

      // Cooldown
      b._villagerTimer++;
      if (b._villagerTimer < VILLAGER_SPAWN_INTERVAL) continue;

      // Only spawn if there's infection in the world to fight
      if (infection.count === 0) continue;

      b._villagerTimer = 0;
      b._villagerBudget--;
      b._villagerSpawned++;

      // Spawn position: near the pagoda, slightly offset
      const angle = random(TWO_PI);
      const dist = random(40, 120);
      const sx = b.x + cos(angle) * dist;
      const sz = b.z + sin(angle) * dist;
      const sy = terrain.getAltitude(sx, sz);

      if (aboveSea(sy)) continue;  // Skip if spawn point is underwater

      this.villagers.push({
        x: sx, y: sy, z: sz,
        vx: 0, vz: 0,
        targetTx: null, targetTz: null,
        walkPhase: random(TWO_PI),
        id: random(),              // Unique seed for animation offsets
        villageX: b.x,             // Home pagoda position (for reference)
        villageZ: b.z,
        health: VILLAGER_MAX_HEALTH,
        isCuring: false
      });
    }
  }

  // ---------------------------------------------------------------------------
  // AI
  // ---------------------------------------------------------------------------

  /** @private Steers villager toward nearest infected tile within search radius. */
  _steerTowardInfection(v) {
    // Ensure we don't wander too far from home.
    const dxFromHome = v.x - v.villageX;
    const dzFromHome = v.z - v.villageZ;
    if (dxFromHome * dxFromHome + dzFromHome * dzFromHome > VILLAGER_MAX_WANDER_DIST_SQ) {
      v.targetTx = null;
      v.targetTz = null;
      const d = Math.hypot(dxFromHome, dzFromHome);
      if (d > 0) {
        v.vx = (-dxFromHome / d) * VILLAGER_SPEED;
        v.vz = (-dzFromHome / d) * VILLAGER_SPEED;
      }
      return;
    }

    // Retarget periodically or when target is missing
    v._retargetTimer = (v._retargetTimer || 0) + 1;
    const needsRetarget = v.targetTx === null ||
      v._retargetTimer > 60 ||
      (v.targetTx !== null && !infection.has(tileKey(v.targetTx, v.targetTz)));

    if (needsRetarget) {
      v._retargetTimer = 0;
      this._findNearestInfection(v);
    }

    if (v.targetTx !== null) {
      const targetWx = v.targetTx * TILE + TILE * 0.5;
      const targetWz = v.targetTz * TILE + TILE * 0.5;
      const dx = targetWx - v.x;
      const dz = targetWz - v.z;
      const d = Math.hypot(dx, dz);
      if (d > VILLAGER_STOP_DIST) {
        v.vx = (dx / d) * VILLAGER_SPEED;
        v.vz = (dz / d) * VILLAGER_SPEED;
        v.isCuring = false;
      } else {
        // Within range — stop and face target
        v.vx = 0;
        v.vz = 0;
        v.isCuring = true;
        // Turn to face the exact tile center
        v.facingAngle = atan2(dx, dz);
      }
    } else {
      // No target — wander slowly
      if (random() < 0.02) {
        const angle = random(TWO_PI);
        v.vx = cos(angle) * VILLAGER_SPEED * 0.3;
        v.vz = sin(angle) * VILLAGER_SPEED * 0.3;
      }
    }
  }

  /** @private Scans for nearest infected tile within VILLAGER_SEARCH_RADIUS. */
  _findNearestInfection(v) {
    const vtx = toTile(v.x), vtz = toTile(v.z);
    let bestDist = Infinity;
    let bestTx = null, bestTz = null;
    const r = VILLAGER_SEARCH_RADIUS;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = vtx + dx, tz = vtz + dz;
        if (infection.has(tileKey(tx, tz))) {
          const distSq = dx * dx + dz * dz;
          if (distSq < bestDist) {
            bestDist = distSq;
            bestTx = tx;
            bestTz = tz;
          }
        }
      }
    }

    v.targetTx = bestTx;
    v.targetTz = bestTz;
  }

  // ---------------------------------------------------------------------------
  // Death
  // ---------------------------------------------------------------------------

  /** @private Removes villager and plays death effect. */
  _killVillager(v, idx) {
    // Death particles
    for (let p = 0; p < 12; p++) {
      particleSystem.particles.push({
        x: v.x, y: v.y - 8, z: v.z,
        vx: random(-3, 3), vy: random(-4, -1), vz: random(-3, 3),
        life: 200, decay: 10, size: random(2, 5),
        color: [200, 60, 40]
      });
    }

    // Audio
    if (typeof gameSFX !== 'undefined') {
      gameSFX.playVillagerDeath(v.x, v.y, v.z);
    }

    // Remove using swap-remove for O(1)
    swapRemove(this.villagers, idx);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws all villagers visible from the given ship position.
   * Villagers are small stick-figure-like characters with animated walking.
   *
   * @param {{x,y,z}} s  Ship state for culling.
   */
  draw(s) {
    if (this.villagers.length === 0) return;

    const sx = s.x, sz = s.z;
    const vis = this._visible;
    vis.length = 0;

    // Cull to visible range
    for (let i = 0; i < this.villagers.length; i++) {
      const v = this.villagers[i];
      if ((v.x - sx) ** 2 + (v.z - sz) ** 2 > VILLAGER_CULL_DIST_SQ) continue;
      vis.push(v);
    }

    if (vis.length === 0) return;

    // Use fill-color shader for box/cylinder primitives
    if (terrain.fillShader) {
      terrain.applyFillColorShader();
      terrain.setScanlineWeight(0.0); // Remove stripey texture for small villagers
    } else {
      setSceneLighting();
    }

    noStroke();

    for (let i = 0; i < vis.length; i++) {
      const v = vis[i];
      const walkSpeed = Math.hypot(v.vx || 0, v.vz || 0);
      const isWalking = walkSpeed > 0.1;
      const phase = v.walkPhase;

      push();
      translate(v.x, v.y, v.z);

      // Face movement direction or target
      if (isWalking) {
        rotateY(atan2(v.vx || 0, v.vz || 0));
      } else if (v.isCuring && v.facingAngle !== undefined) {
        rotateY(v.facingAngle);
      }

      // Scale down — villagers are small
      scale(2);

      // --- Head (sphere-like box) ---
      this._setColor(220, 185, 150);  // Skin tone
      push();
      translate(0, -22, 0);
      box(5, 5, 5);
      pop();

      // --- Body ---
      this._setColor(60, 120, 200);  // Blue tunic
      push();
      translate(0, -16, 0);
      box(6, 8, 4);
      pop();

      // --- Legs (animated) ---
      this._setColor(80, 60, 40);  // Brown
      const legSwing = isWalking ? sin(phase) * 0.6 : 0;
      // Left leg
      push();
      translate(-1.5, -11, 0);
      rotateX(legSwing);
      translate(0, 3, 0);
      box(2.5, 6, 2.5);
      pop();
      // Right leg
      push();
      translate(1.5, -11, 0);
      rotateX(-legSwing);
      translate(0, 3, 0);
      box(2.5, 6, 2.5);
      pop();

      // --- Arms (animated) ---
      this._setColor(220, 185, 150);

      // Swing arms while walking or wave them while curing
      const armSwing = isWalking ? sin(phase + PI) * 0.5 : (v.isCuring ? sin(phase * 3) * 0.8 : 0);

      // Left arm
      push();
      translate(-4.5, -17, 0);
      rotateX(armSwing);
      translate(0, 3, 0);
      box(2, 5, 2);
      pop();
      // Right arm
      push();
      translate(4.5, -17, 0);
      rotateX(-armSwing);
      translate(0, 3, 0);
      box(2, 5, 2);
      pop();

      pop(); // End of villager transform
    }

    resetShader();
    setSceneLighting();
  }

  /**
   * Sets both the p5 fill colour and the terrain shader uniform.
   * Mirrors EnemyManager._setColor().
   * @private
   */
  _setColor(r, g, b) {
    fill(r, g, b);
    terrain.setFillColor(r, g, b);
  }
}

// Singleton instance
const villagerManager = new VillagerManager();
