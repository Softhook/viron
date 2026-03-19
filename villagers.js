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
const VILLAGER_SPAWN_INTERVAL  = 300;     // Frames between spawn attempts (~5 seconds at 60 Hz)
const VILLAGER_RESPAWN_INTERVAL= 1200;    // Frames to regenerate one villager budget (~20 seconds)
const VILLAGER_MAX_WANDER_DIST_SQ = 1440 * 1440; // Max distance squared (12 tiles) from home pagoda
const VILLAGER_SPEED           = 0.8;     // World units per physics tick
const VILLAGER_CURE_PROB       = 0.004;   // Per-tick probability of curing a nearby virus tile
const VILLAGER_SEARCH_RADIUS   = 12;      // Tile radius to search for infected tiles
const VILLAGER_CURE_RADIUS     = 1;       // Must be within 1 tile to attempt a cure
const VILLAGER_CULL_DIST_SQ    = CULL_DIST * CULL_DIST;

class VillagerManager {
  constructor() {
    /** @type {Array<object>} Active villager objects. */
    this.villagers = [];

    // Reusable array for the draw pass — avoids per-frame allocation.
    this._visible = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets all villager state. Called at level start. */
  clear() {
    this.villagers.length = 0;
    // Reset spawn budgets on all pagodas
    for (const b of gameState.buildings) {
      if (b.type === 2) {
        b._villagerBudget = VILLAGER_MAX_PER_VILLAGE;
        b._villagerTimer = 0;
        b._villagerRegenTimer = 0;
        b._villagerSpawned = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update (called from the fixed-timestep physics loop)
  // ---------------------------------------------------------------------------

  update() {
    // 1. Regenerate villager budgets over time
    this._regenerateBudgets();

    // 2. Try to spawn new villagers from uninfected pagodas
    this._trySpawn();

    // 2. Update each active villager
    for (let i = this.villagers.length - 1; i >= 0; i--) {
      const v = this.villagers[i];

      // --- Check death: tile became infected ---
      const tk = tileKey(toTile(v.x), toTile(v.z));
      if (infection.has(tk)) {
        this._killVillager(v, i);
        continue;
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

  /** @private */
  _regenerateBudgets() {
    for (const b of gameState.buildings) {
      if (b.type !== 2) continue;
      
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
  _trySpawn() {
    for (const b of gameState.buildings) {
      if (b.type !== 2) continue;  // Only pagodas spawn villagers

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
        villageZ: b.z
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
      if (d > 10) {
        v.vx = (dx / d) * VILLAGER_SPEED;
        v.vz = (dz / d) * VILLAGER_SPEED;
      } else {
        v.vx = 0;
        v.vz = 0;
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

      // Face movement direction
      if (isWalking) {
        rotateY(atan2(v.vx || 0, v.vz || 0));
      }

      // Scale down — villagers are small
      scale(2.5);

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
      const armSwing = isWalking ? sin(phase + PI) * 0.5 : 0;
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
