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
const VILLAGER_CURE_RADIUS = 1;       // Must be within 1 tile to attempt a cure (matches 100 unit stop dist)
const VILLAGER_CULL_DIST_SQ = CULL_DIST * CULL_DIST;
const VILLAGER_MAX_HEALTH = 100;
const VILLAGER_INFECTION_DAM = 1.2;    // Health loss per tick on infected tile
const VILLAGER_HEAL_RATE = 0.5;    // Health recovery per tick when safe
const VILLAGER_STOP_DIST = 100;     // Target distance to start curing (units)
// Retarget hysteresis: only switch to a new infection target if it is this many
// tiles² closer than the current one (prevents oscillation between equal targets).
const VILLAGER_TARGET_HYSTERESIS_SQ = 4; // ≈ 2 tiles
// --- Idle planting constants ---
const VILLAGER_PLANT_DURATION = 240;   // Ticks to animate planting at one spot (~4 s at 60 Hz)
const VILLAGER_PLANT_RADIUS = 3;       // Base tile radius from pagoda when picking a crop plot (actual range ~0.5–2× this value)
// --- Ground-enemy confrontation constants ---
const VILLAGER_FIGHT_RADIUS = 8;       // Tile radius to detect nearby ground enemies
const VILLAGER_PUNCH_GAP = 20;         // World units gap from enemy body edge where villager stops and punches

class VillagerManager extends AgentManager {
  constructor() {
    super(2, {
      maxHealth: VILLAGER_MAX_HEALTH,
      infectionDam: VILLAGER_INFECTION_DAM,
      healRate: VILLAGER_HEAL_RATE,
      speed: VILLAGER_SPEED,
      searchRadius: VILLAGER_SEARCH_RADIUS,
      targetHysteresisSq: VILLAGER_TARGET_HYSTERESIS_SQ,
      stopDist: VILLAGER_STOP_DIST,
      maxWanderDistSq: VILLAGER_MAX_WANDER_DIST_SQ,
      wanderSpeedMult: 0.3
    }); // Pagoda building type
    // Aliases to seamlessly patch rendering and old logic references seamlessly 
    this.villagers = this.agents;
    this.villages = this.hubs;
  }

  /**
   * Clears all transient planting state so the villager can pick a new activity.
   * Called whenever the villager starts moving to a target, is leashed home, or
   * confronts an enemy — any event that interrupts an in-progress planting cycle.
   * @param {object} v Villager agent object.
   * @private
   */
  _clearPlantingState(v) {
    v.isPlanting = false;
    v.plantTargetX = null;
    v.plantTargetZ = null;
  }

  onWanderExceeded(v) { v.isCuring = false; this._clearPlantingState(v); }
  onWalkToTarget(v) { v.isCuring = false; this._clearPlantingState(v); }
  onReachTarget(v) { v.isCuring = true; v.isPlanting = false; }
  onNoTarget(v) { v.isCuring = false; }

  onAgentDeath(v) {
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
    gameSFX?.playVillagerDeath(v.x, v.y, v.z);

    // Release budget slot
    if (v.villageRef) {
      v.villageRef._activeVillagers = Math.max(0, (v.villageRef._activeVillagers || 0) - 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Geometry Baking
  // ---------------------------------------------------------------------------

  /**
   * Pre-bakes 64 frames of villager walking animation into cached p5.Geometry
   * objects. Baking vertex colours directly into the mesh eliminates the need
   * for expensive per-part fill() and terrain.setFillColor() calls in the loop.
   *
   * Uses _bldgSafeR() for all colours to ensure we don't accidentally trigger
   * special terrain-shader material logic (like wood textures or viron glows).
   * @private
   */
  _ensureGeoms() {
    if (VillagerManager._geoms) return;
    VillagerManager._geoms = [];

    // Base palette
    const skinR = _bldgSafeR(220), skinG = 185, skinB = 150;
    const tunicR = _bldgSafeR(60), tunicG = 120, tunicB = 200;
    const legR = _bldgSafeR(80), legG = 60, legB = 40;

    for (let f = 0; f < 64; f++) {
      const phase = (f / 64) * TWO_PI;
      const legSwing = sin(phase) * 0.6;
      const armSwing = sin(phase + PI) * 0.5;

      VillagerManager._geoms[f] = _safeBuildGeometry(() => {
        noStroke();
        translate(0, 5, 0); // Anchor feet precisely to Y=0

        // --- Head ---
        fill(skinR, skinG, skinB);
        push(); translate(0, -22, 0); box(5, 5, 5); pop();

        // --- Body ---
        fill(tunicR, tunicG, tunicB);
        push(); translate(0, -16, 0); box(6, 8, 4); pop();

        // --- Legs ---
        fill(legR, legG, legB);
        // Left
        push(); translate(-1.5, -11, 0); rotateX(legSwing); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
        // Right
        push(); translate(1.5, -11, 0); rotateX(-legSwing); translate(0, 3, 0); box(2.5, 6, 2.5); pop();

        // --- Arms ---
        fill(skinR, skinG, skinB);
        // Left
        push(); translate(-4.5, -17, 0); rotateX(armSwing); translate(0, 3, 0); box(2, 5, 2); pop();
        // Right
        push(); translate(4.5, -17, 0); rotateX(-armSwing); translate(0, 3, 0); box(2, 5, 2); pop();
      });
    }

    // Static frame for standing still
    VillagerManager._staticGeom = _safeBuildGeometry(() => {
      noStroke();
      translate(0, 5, 0); // Anchor feet precisely to Y=0

      fill(skinR, skinG, skinB); push(); translate(0, -22, 0); box(5, 5, 5); pop();
      fill(tunicR, tunicG, tunicB); push(); translate(0, -16, 0); box(6, 8, 4); pop();
      fill(legR, legG, legB);
      push(); translate(-1.5, -11, 0); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
      push(); translate(1.5, -11, 0); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
      fill(skinR, skinG, skinB);
      push(); translate(-4.5, -17, 0); translate(0, 3, 0); box(2, 5, 2); pop();
      push(); translate(4.5, -17, 0); translate(0, 3, 0); box(2, 5, 2); pop();
    });

    // Special "curing" frame with waving arms
    VillagerManager._curingGeoms = [];
    for (let f = 0; f < 64; f++) {
      const phase = (f / 64) * TWO_PI;
      const wave = sin(phase * 3) * 0.8; // Match original procedural wave speed (phase * 3)
      VillagerManager._curingGeoms[f] = _safeBuildGeometry(() => {
        noStroke();
        translate(0, 5, 0); // Anchor feet precisely to Y=0

        fill(skinR, skinG, skinB); push(); translate(0, -22, 0); box(5, 5, 5); pop();
        fill(tunicR, tunicG, tunicB); push(); translate(0, -16, 0); box(6, 8, 4); pop();
        fill(legR, legG, legB);
        push(); translate(-1.5, -11, 0); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
        push(); translate(1.5, -11, 0); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
        fill(skinR, skinG, skinB);
        push(); translate(-4.5, -17, 0); rotateX(wave); translate(0, 3, 0); box(2, 5, 2); pop();
        push(); translate(4.5, -17, 0); rotateX(-wave); translate(0, 3, 0); box(2, 5, 2); pop();
      });
    }

    // Idle planting frames: body bent forward at waist, arms alternating down toward ground.
    // 64 pre-baked frames keep the hot-path draw() loop allocation-free.
    VillagerManager._plantingGeoms = [];
    for (let f = 0; f < 64; f++) {
      const phase = (f / 64) * TWO_PI;
      // Subtle body-sway while bending (±10°)
      // Negative angle bends the top of the body toward +Z (forward in model space).
      const bendAngle = -(0.75 + sin(phase * 2) * 0.1);
      // Alternating arm plunge toward the ground: positive rotateX tips the arm tip
      // toward +Z (forward / ground-ward) in the already-forward-tilted torso frame.
      const leftArmDip = 0.9 + sin(phase * 2) * 0.55;
      const rightArmDip = 0.9 + sin(phase * 2 + PI) * 0.55;

      VillagerManager._plantingGeoms[f] = _safeBuildGeometry(() => {
        noStroke();
        translate(0, 5, 0); // feet at Y=0

        // Legs — slightly bent at knees for a crouching posture
        fill(legR, legG, legB);
        push(); translate(-1.5, -11, 0); rotateX(-0.2); translate(0, 3, 0); box(2.5, 6, 2.5); pop();
        push(); translate(1.5, -11, 0); rotateX(-0.2); translate(0, 3, 0); box(2.5, 6, 2.5); pop();

        // Upper body: pivot at hip (~y=-13), rotate forward to simulate waist-bend
        push();
        translate(0, -13, 0); // hip pivot
        rotateX(bendAngle);   // bend forward (negative = top toward +Z)

        // Torso
        fill(tunicR, tunicG, tunicB);
        push(); translate(0, -4, 0); box(6, 8, 4); pop();

        // Head (follows torso bend)
        fill(skinR, skinG, skinB);
        push(); translate(0, -10, 0); box(5, 5, 5); pop();

        // Left arm — plunges down to plant, then lifts back
        push(); translate(-4.5, -5, 0); rotateX(leftArmDip); translate(0, 3, 0); box(2, 5, 2); pop();
        // Right arm — opposite phase for natural alternating motion
        push(); translate(4.5, -5, 0); rotateX(rightArmDip); translate(0, 3, 0); box(2, 5, 2); pop();

        pop(); // end upper-body pivot
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets all villager state. Called at level start. */
  clear() {
    super.clear();
    // Only reset budgets on Level 1. On higher levels, the budget from the 
    // previous level carries over (and will continue to regenerate over time).
    if (gameState.level === 1) {
      for (const b of this.hubs) {
        b._villagerBudget = VILLAGER_MAX_PER_VILLAGE;
        b._villagerTimer = 0;
        b._villagerRegenTimer = 0;
        b._villagerSpawned = 0;
        b._activeVillagers = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update (called from the fixed-timestep physics loop)
  // ---------------------------------------------------------------------------

  update() {
    if (typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagers) return;

    super.update();

    const targets = this.getTargetHubs();

    // 1. Regenerate villager budgets over time
    this._regenerateBudgets(targets);

    // 2. Try to spawn new villagers from uninfected active pagodas
    this._trySpawn(targets);

    // 2. Update each active villager
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const v = this.agents[i];

      // --- AI: find nearest infected tile and walk toward it ---
      // Always run the infection scan so a newly infected tile aborts planting.
      // When in planting mode and no infection is found, restore vx/vz afterwards
      // to prevent the no-target random-wander branch from causing jerky rotation.
      const inPlanting = v.isPlanting || v.plantTargetX !== null;
      const savedVx = inPlanting ? v.vx : 0;
      const savedVz = inPlanting ? v.vz : 0;
      this._steerTowardInfection(v, v.villageX, v.villageZ);
      if (inPlanting && v.targetTx === null) { v.vx = savedVx; v.vz = savedVz; }

      // --- Confront nearby ground enemies (overrides infection steering when close) ---
      this._confrontNearbyEnemy(v);

      // --- Idle planting when no infection is nearby and not confronting ---
      if (v.targetTx === null && !v.isConfronting) {
        this._updateIdlePlanting(v);
      }

      // --- Health & Physics Integration ---
      if (!this._applyHealthAndPhysics(v)) {
        this.killAgent(v, i);
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
              terrain.addPulse(v.targetTx * TILE, v.targetTz * TILE, 3.0);
              gameSFX?.playVillagerCure(v.x, v.y, v.z);
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

      this._smoothRotation(v);
    }
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  _regenerateBudgets(villagesArray) {
    for (const b of villagesArray) {
      // Initialize on first encounter if not set
      if (b._villagerBudget === undefined) {
        b._villagerBudget = VILLAGER_MAX_PER_VILLAGE;
        b._villagerTimer = 0;
        b._villagerRegenTimer = 0;
        b._villagerSpawned = 0;
        b._activeVillagers = 0;
      }

      // Only regenerate if the total population (active + available budget) is below the cap
      if (b._villagerBudget + (b._activeVillagers || 0) < VILLAGER_MAX_PER_VILLAGE) {
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
      b._activeVillagers = (b._activeVillagers || 0) + 1;

      // Spawn position: near the pagoda, slightly offset
      const angle = random(TWO_PI);
      const dist = random(40, 120);
      const sx = b.x + cos(angle) * dist;
      const sz = b.z + sin(angle) * dist;
      const sy = terrain.getAltitude(sx, sz);

      if (aboveSea(sy)) {
        // Refund if we couldn't spawn
        b._villagerBudget++;
        b._activeVillagers--;
        continue;
      }

      this.villagers.push({
        x: sx, y: sy, z: sz,
        vx: 0, vz: 0,
        targetTx: null, targetTz: null,
        walkPhase: random(TWO_PI),
        id: random(),              // Unique seed for animation offsets
        villageX: b.x,             // Home pagoda position (for reference)
        villageZ: b.z,
        villageRef: b,             // Pointer to home village for budget tracking
        health: VILLAGER_MAX_HEALTH,
        isCuring: false,
        isPlanting: false,         // True while performing idle crop-planting animation
        plantTimer: 0,             // Ticks spent at current plant spot
        plantTargetX: null,        // World X of chosen crop plot
        plantTargetZ: null,        // World Z of chosen crop plot
        isConfronting: false,      // True when moving toward or punching a ground enemy
        facingAngle: angle,        // Start facing outward from spawn
        _retargetTimer: Math.floor(random(60)) // Stagger CPU spikes
      });
    }
  }

  /**
   * Handles idle crop-planting behaviour when a villager is not actively pursuing
   * an infection target.
   * State machine:
   *   1. No plot chosen → pick a random spot near the home pagoda (~2% chance / tick).
   *   2. Walking to plot → steer toward it at reduced speed.
   *   3. At plot → play planting animation for VILLAGER_PLANT_DURATION ticks, then reset.
   *
   * Infection steering always runs before this method; if a target is found the
   * onWalkToTarget callback clears isPlanting/plantTargetX so this method is
   * effectively bypassed for that tick.
   * @private
   */
  _updateIdlePlanting(v) {
    if (v.isPlanting) {
      // Freeze movement; increment timer until the planting duration elapses.
      v.vx = 0;
      v.vz = 0;
      v.plantTimer = (v.plantTimer || 0) + 1;
      if (v.plantTimer >= VILLAGER_PLANT_DURATION) {
        v.plantTimer = 0;
        this._clearPlantingState(v);
      }
      return;
    }

    if (v.plantTargetX !== null) {
      // Walk toward the chosen crop plot at a slow, deliberate pace.
      const dx = v.plantTargetX - v.x;
      const dz = v.plantTargetZ - v.z;
      const distSq = dx * dx + dz * dz;
      const arrivalSq = (TILE * 0.5) * (TILE * 0.5);

      if (distSq < arrivalSq) {
        // Arrived — begin planting animation.
        v.vx = 0;
        v.vz = 0;
        v.isPlanting = true;
        v.plantTimer = 0;
        v.plantTargetX = null;
        v.plantTargetZ = null;
      } else {
        const d = Math.sqrt(distSq);
        const spd = VILLAGER_SPEED * 0.4;
        v.vx = lerp(v.vx || 0, (dx / d) * spd, STEERING_LERP_FACTOR);
        v.vz = lerp(v.vz || 0, (dz / d) * spd, STEERING_LERP_FACTOR);
      }
      return;
    }

    // Pick a new crop-plot position near the home pagoda (~2 % chance per tick
    // so villagers don't all rush to a new spot on the same frame).
    if (random() < 0.02) {
      const angle = random(Math.PI * 2);
      const dist = (0.5 + random(1.5)) * TILE * VILLAGER_PLANT_RADIUS;
      const tx = v.villageX + Math.cos(angle) * dist;
      const tz = v.villageZ + Math.sin(angle) * dist;
      // Keep within the max wander leash
      const dhx = tx - v.villageX;
      const dhz = tz - v.villageZ;
      if (dhx * dhx + dhz * dhz <= VILLAGER_MAX_WANDER_DIST_SQ) {
        v.plantTargetX = tx;
        v.plantTargetZ = tz;
      }
    }
  }

  /**
   * Checks for nearby ground enemies and steers the villager toward them.
   * Villagers attempt to punch but never actually harm the enemy.
   * Overrides infection-steering velocity when an enemy is within fight radius.
   * Stops at the near edge of the enemy body (ENEMY_CONFRONT_OFFSET from centre
   * plus a small punch gap), so the villager confronts at the body surface
   * rather than trying to walk to the enemy's origin point.
   * @private
   */
  _confrontNearbyEnemy(v) {
    const enemy = this._findNearestGroundEnemy(v, VILLAGER_FIGHT_RADIUS);
    if (!enemy) {
      v.isConfronting = false;
      return;
    }

    const dx = enemy.x - v.x;
    const dz = enemy.z - v.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Stop once the villager has closed to within VILLAGER_PUNCH_GAP of the
    // enemy's near body surface (ENEMY_CONFRONT_OFFSET from the centre).
    const stopDist = ENEMY_CONFRONT_OFFSET + VILLAGER_PUNCH_GAP;

    if (dist > stopDist) {
      // Move toward enemy — direction toward body edge and centre are collinear,
      // so (dx/dist, dz/dist) naturally leads to the body surface.
      v.vx = lerp(v.vx || 0, (dx / dist) * VILLAGER_SPEED, STEERING_LERP_FACTOR);
      v.vz = lerp(v.vz || 0, (dz / dist) * VILLAGER_SPEED, STEERING_LERP_FACTOR);
      v.isConfronting = true;
      this._clearPlantingState(v);
    } else {
      // At body edge — stop and punch (never harms the enemy)
      v.vx = 0;
      v.vz = 0;
      v.isConfronting = true;
      this._clearPlantingState(v);
      v.targetAngle = Math.atan2(dx, dz);
    }
  }

  killVillagerAtIndex(idx) {
    const v = this.agents[idx];
    if (v) this.killAgent(v, idx);
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
    if (this.agents.length === 0) return;

    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    const vis = this._cullVisible(s, VILLAGER_CULL_DIST_SQ);

    if (vis.length === 0) {
      if (profiler) profiler.recordVillagers(0, performance.now() - start);
      return;
    }

    // Use the standard terrain shader for villagers. This supports vertex-baked
    // colours and shared lighting uniforms, ensuring they match the world lighting.
    terrain.applyShader();


    this._ensureGeoms();
    noStroke();

    for (let i = 0; i < vis.length; i++) {
      const v = vis[i];
      const vx = v.vx || 0;
      const vz = v.vz || 0;
      const isWalking = (vx * vx + vz * vz) > 0.01;

      push();
      translate(v.x, v.y, v.z);

      // Face current smoothed angle
      rotateY(v.facingAngle);

      // Scale down — villagers are small
      scale(2);

      // Selection of the pre-baked geometry frame based on animation state
      let geom;
      if (isWalking) {
        const fIdx = Math.floor(((v.walkPhase % TWO_PI + TWO_PI) % TWO_PI) / TWO_PI * 64);
        geom = VillagerManager._geoms[fIdx];
      } else if (v.isCuring || v.isConfronting) {
        // Curing animation doubles as a punch attempt when confronting enemies
        // (visual only — villagers never actually damage ground enemies)
        const fIdx = Math.floor(((v.walkPhase % TWO_PI + TWO_PI) % TWO_PI) / TWO_PI * 64);
        geom = VillagerManager._curingGeoms[fIdx];
      } else if (v.isPlanting) {
        const fIdx = Math.floor(((v.walkPhase % TWO_PI + TWO_PI) % TWO_PI) / TWO_PI * 64);
        geom = VillagerManager._plantingGeoms[fIdx];
      } else {
        geom = VillagerManager._staticGeom;
      }

      if (geom) model(geom);

      pop(); // End of villager transform
    }

    resetShader();
    setSceneLighting();

    if (profiler) profiler.recordVillagers(vis.length, performance.now() - start);
  }
}

// Singleton instance
const villagerManager = new VillagerManager();
