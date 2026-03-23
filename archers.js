// =============================================================================
// archers.js — ArcherManager class
//
// Spawns a single archer figure from each uninfected Cylindrical Observatory
// (building type 1 — cylinder body with a sphere cap). Archers are ranged
// allied units that seek out nearby enemy units, move to a comfortable
// standoff distance, and fire arrows at them.
//
// Unlike villagers (who clear infection) and wizards (who cast spells on
// infection tiles), archers target living enemy units from enemyManager.
//
// Bow animation: three-phase shooting sequence —
//   1. Raise bow   (ARCHER_RAISE_DURATION ticks)
//   2. Aim / pause (ARCHER_AIM_DURATION ticks)
//   3. Fire — arrow flies a parabolic arc toward the target position
//   4. Cooldown    (ARCHER_COOLDOWN ticks) before next shot
//
// Rules:
//   • One archer per observatory at any time.
//   • If the observatory becomes infected, no new archer spawns from it.
//   • When an archer dies its observatory can spawn a replacement.
// =============================================================================

// --- Archer tuning constants ---
const ARCHER_MAX_PER_TOWER     = 1;     // One archer per observatory
const ARCHER_SPAWN_DELAY       = 150;   // Ticks before first spawn (~2.5 s at 60 Hz)
const ARCHER_SPEED             = 0.9;   // World units per physics tick
const ARCHER_SEARCH_RADIUS     = 1800;  // World-unit radius to scan for enemies
const ARCHER_STANDOFF_DIST     = 380;   // Ideal attack distance from enemy (world units)
const ARCHER_MIN_DIST          = 220;   // Retreat if closer than this to an enemy
const ARCHER_MAX_ENGAGE_DIST   = 900;   // Ignore enemies beyond this distance
const ARCHER_CULL_DIST_SQ      = CULL_DIST * CULL_DIST;
const ARCHER_MAX_HEALTH        = 80;    // Slightly more fragile than a villager (100)
const ARCHER_INFECTION_DAM     = 1.5;   // Infection hurts archers a bit more
const ARCHER_HEAL_RATE         = 0.4;
const ARCHER_MAX_WANDER_DIST_SQ = 2000 * 2000; // 16-tile max wander radius²
const ARCHER_DRAW_SCALE        = 2.0;   // Same size as a villager

// Shooting animation phases (in ticks)
const ARCHER_RAISE_DURATION    = 22;    // Ticks to raise the bow
const ARCHER_AIM_DURATION      = 16;    // Ticks spent aiming before firing
const ARCHER_COOLDOWN          = 100;   // Ticks between shots

// Arrow projectile
const ARCHER_ARROW_DURATION    = 38;    // Ticks for arrow to reach target
const ARCHER_HIT_PROB          = 0.35;  // Per-shot probability of hitting the target

// Number of raise-animation frames baked
const ARCHER_RAISE_FRAMES      = 16;
// Local Y offset from archer origin to bow tip (used to position arrow start).
// Derived from rendered geometry: left arm base -17 + arm pivot +3 + bow stave -11.5 = -25.5
const ARCHER_BOW_TIP_Y_OFFSET  = 25.5;

class ArcherManager extends AgentManager {
  constructor() {
    super(1, {  // Building type 1 = Cylindrical Observatory
      maxHealth:          ARCHER_MAX_HEALTH,
      infectionDam:       ARCHER_INFECTION_DAM,
      healRate:           ARCHER_HEAL_RATE,
      speed:              ARCHER_SPEED,
      searchRadius:       0,   // Not used — archers target enemies, not infection
      targetHysteresisSq: 0,
      stopDist:           ARCHER_STANDOFF_DIST,
      maxWanderDistSq:    ARCHER_MAX_WANDER_DIST_SQ,
      wanderSpeedMult:    0.35
    });
    // Convenience aliases
    this.archers        = this.agents;
    this.observatories  = this.hubs;
  }

  // ---------------------------------------------------------------------------
  // Geometry Baking
  // ---------------------------------------------------------------------------

  /**
   * Pre-bakes archer animation frames into cached p5.Geometry objects.
   *
   * Frames baked:
   *   _geoms[64]           — walk cycle (left/right leg swing)
   *   _staticGeom          — standing idle (no bow held)
   *   _raisingGeoms[16]    — bow-raise animation (arm sweeps up from rest to draw)
   *   _aimingGeom          — bow fully drawn, ready to fire
   * @private
   */
  _ensureGeoms() {
    if (ArcherManager._geoms) return;
    ArcherManager._geoms        = [];
    ArcherManager._raisingGeoms = [];

    // Colour palette — ranger aesthetic
    const skinR  = _bldgSafeR(220), skinG  = 185, skinB  = 150;
    const tunicR = _bldgSafeR(55),  tunicG = 105, tunicB = 55;   // Forest green
    const pantR  = _bldgSafeR(80),  pantG  = 55,  pantB  = 30;   // Brown leather
    const bowR   = _bldgSafeR(85),  bowG   = 50,  bowB   = 25;   // Dark wood

    /**
     * Emits the archer body given leg swing and bow-arm angles.
     * bowArmAngle: 0 = arm at side (idle), -PI*0.7 = fully raised for draw.
     * drawPull: 0-1, how far back the string arm is pulled (0 = no pull).
     */
    const buildArcher = (legSwing, bowArmAngle, drawPull) => {
      return _safeBuildGeometry(() => {
        noStroke();
        translate(0, 5, 0); // Anchor feet to Y=0

        // Head
        fill(skinR, skinG, skinB);
        push(); translate(0, -22, 0); box(5, 5, 5); pop();

        // Body / tunic
        fill(tunicR, tunicG, tunicB);
        push(); translate(0, -16, 0); box(6, 8, 4); pop();

        // Legs
        fill(pantR, pantG, pantB);
        push(); translate(-1.5, -10.5, 0); rotateX( legSwing); translate(0, 3.5, 0); box(2.5, 7, 2.5); pop();
        push(); translate( 1.5, -10.5, 0); rotateX(-legSwing); translate(0, 3.5, 0); box(2.5, 7, 2.5); pop();

        // Left arm — holds the bow out in front when shooting
        fill(skinR, skinG, skinB);
        push();
        translate(-4.5, -17, 0);
        rotateX(bowArmAngle);
        translate(0, 3, 0);
        box(2, 5, 2);

        // Bow held in left hand (only drawn when arm is raised enough)
        if (bowArmAngle < -0.3) {
          fill(bowR, bowG, bowB);
          // Vertical bow stave along the arm axis
          push(); translate(0, -5, 0); cylinder(0.6, 14, 5, 1); pop();
          // Bow tips curve away
          push(); translate(0, -11.5, 0); sphere(1.0, 4, 3); pop();
          push(); translate(0,  1.5, 0); sphere(1.0, 4, 3); pop();
        }
        pop(); // left arm

        // Right arm — string-draw arm, pulled back when shooting
        const stringPull = drawPull * 0.7; // rotateX angle for pull-back
        fill(skinR, skinG, skinB);
        push();
        translate(4.5, -17, 0);
        rotateX(bowArmAngle * 0.6 - stringPull); // follows bow arm, plus pull
        translate(0, 3, 0);
        box(2, 5, 2);
        pop();
      });
    };

    // 64-frame walk cycle
    for (let f = 0; f < 64; f++) {
      const phase    = (f / 64) * Math.PI * 2;
      const legSwing = Math.sin(phase) * 0.6;
      ArcherManager._geoms[f] = buildArcher(legSwing, 0, 0);
    }

    // Standing idle
    ArcherManager._staticGeom = buildArcher(0, 0, 0);

    // 16-frame raise animation: bow arm sweeps from 0 to -PI*0.7
    for (let f = 0; f < ARCHER_RAISE_FRAMES; f++) {
      const t = f / (ARCHER_RAISE_FRAMES - 1);
      const bowAngle = -Math.PI * 0.7 * t;
      ArcherManager._raisingGeoms[f] = buildArcher(0, bowAngle, 0);
    }

    // Aiming — bow fully raised, string arm pulled back
    ArcherManager._aimingGeom = buildArcher(0, -Math.PI * 0.7, 1);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets archer state. Called at every level start. */
  clear() {
    super.clear();
    if (gameState.level === 1) {
      for (const b of this.hubs) {
        b._archerSpawned = false;
        b._archerTimer   = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  update() {
    if (typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagers) return;

    super.update();
    const targets = this.getTargetHubs();

    this._trySpawn(targets);

    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];

      // Advance in-flight arrows first so they can resolve this tick.
      this._updateArrows(a);

      // Steer toward nearest enemy (or wander if none).
      this._steerTowardEnemy(a);

      // Health & physics integration
      if (!this._applyHealthAndPhysics(a)) {
        this.killAgent(a, i);
        continue;
      }

      // Advance walk animation phase
      a.walkPhase += 0.12;

      // Advance shoot state machine
      this._tickShootState(a);

      this._smoothRotation(a);
    }
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /** @private Attempts to spawn an archer from each eligible observatory. */
  _trySpawn(towersArray) {
    for (const b of towersArray) {
      if (b._archerSpawned) continue;

      if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      if (infection.has(b._tileKey)) continue;

      b._archerTimer = (b._archerTimer || 0) + 1;
      if (b._archerTimer < ARCHER_SPAWN_DELAY) continue;

      // Spawn close to the observatory
      const angle = random(TWO_PI);
      const dist  = random(40, 100);
      const sx    = b.x + cos(angle) * dist;
      const sz    = b.z + sin(angle) * dist;
      const sy    = terrain.getAltitude(sx, sz);

      if (aboveSea(sy)) continue;

      b._archerSpawned = true;
      b._archerTimer   = 0;

      this.agents.push({
        x: sx, y: sy, z: sz,
        vx: 0, vz: 0,
        walkPhase:    random(TWO_PI),
        id:           random(),
        towerX:       b.x,
        towerZ:       b.z,
        towerRef:     b,
        health:       ARCHER_MAX_HEALTH,
        // Shoot-state machine
        shootState:   'idle',    // 'idle' | 'raising' | 'aiming' | 'cooldown'
        shootTimer:   0,
        raiseFrame:   0,
        // Enemy target
        targetEnemyId: null,
        targetX:       null,    // World-space X of locked target position (at fire time)
        targetZ:       null,
        facingAngle:   angle,
        arrows:        [],
        _retargetTimer: Math.floor(random(60))
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Enemy steering
  // ---------------------------------------------------------------------------

  /**
   * Finds the nearest enemy within ARCHER_MAX_ENGAGE_DIST, steers to standoff
   * distance, and initiates the shooting sequence when in range.
   * Falls back to wandering when no enemy is found.
   * @private
   */
  _steerTowardEnemy(a) {
    const dxHome = a.x - a.towerX;
    const dzHome = a.z - a.towerZ;
    const distFromHomeSq = dxHome * dxHome + dzHome * dzHome;

    // Enforce max wander radius — leash back to tower.
    if (distFromHomeSq > ARCHER_MAX_WANDER_DIST_SQ) {
      this._cancelShooting(a);
      const d = Math.sqrt(distFromHomeSq);
      a.vx = lerp(a.vx || 0, (-dxHome / d) * ARCHER_SPEED, 0.15);
      a.vz = lerp(a.vz || 0, (-dzHome / d) * ARCHER_SPEED, 0.15);
      return;
    }

    // Periodically refresh enemy target.
    a._retargetTimer = (a._retargetTimer || 0) + 1;
    if (a._retargetTimer >= 45 || !this._isTargetValid(a)) {
      a._retargetTimer = 0;
      this._acquireTarget(a);
    }

    const enemy = this._resolveTarget(a);
    if (!enemy) {
      // No target — wander slowly (patrol).
      if (a.shootState !== 'idle') this._cancelShooting(a);
      if (random() < 0.02) {
        const angle = random(Math.PI * 2);
        a.vx = Math.cos(angle) * ARCHER_SPEED * 0.35;
        a.vz = Math.sin(angle) * ARCHER_SPEED * 0.35;
      }
      return;
    }

    const dx = enemy.x - a.x;
    const dz = enemy.z - a.z;
    const d  = Math.sqrt(dx * dx + dz * dz);

    if (d > ARCHER_STANDOFF_DIST + 30) {
      // Too far — move closer.
      if (a.shootState !== 'idle') this._cancelShooting(a);
      a.vx = lerp(a.vx || 0, (dx / d) * ARCHER_SPEED, 0.15);
      a.vz = lerp(a.vz || 0, (dz / d) * ARCHER_SPEED, 0.15);
    } else if (d < ARCHER_MIN_DIST) {
      // Too close — retreat.
      if (a.shootState !== 'idle') this._cancelShooting(a);
      a.vx = lerp(a.vx || 0, (-dx / d) * ARCHER_SPEED * 0.7, 0.15);
      a.vz = lerp(a.vz || 0, (-dz / d) * ARCHER_SPEED * 0.7, 0.15);
    } else {
      // In the sweet spot — stand still and shoot.
      a.vx = 0;
      a.vz = 0;
      a.targetAngle = Math.atan2(dx, dz);
      // Begin raising bow if idle and no arrow in flight.
      if (a.shootState === 'idle' && a.arrows.length === 0) {
        a.shootState  = 'raising';
        a.shootTimer  = 0;
        a.raiseFrame  = 0;
        // Lock the fire-target position (enemy's current world position).
        a.targetX = enemy.x;
        a.targetZ = enemy.z;
      }
    }
  }

  /** @private Returns the enemy object this archer is targeting, or null. */
  _resolveTarget(a) {
    if (a.targetEnemyId === null) return null;
    if (typeof enemyManager === 'undefined') return null;
    for (const e of enemyManager.enemies) {
      if (e.id === a.targetEnemyId) return e;
    }
    return null;
  }

  /** @private True if the archer's current target is still alive. */
  _isTargetValid(a) {
    if (a.targetEnemyId === null) return false;
    return this._resolveTarget(a) !== null;
  }

  /** @private Scans for the nearest enemy within ARCHER_MAX_ENGAGE_DIST. */
  _acquireTarget(a) {
    if (typeof enemyManager === 'undefined') { a.targetEnemyId = null; return; }
    let best = null, bestDSq = ARCHER_MAX_ENGAGE_DIST * ARCHER_MAX_ENGAGE_DIST;
    for (const e of enemyManager.enemies) {
      const dx = e.x - a.x, dz = e.z - a.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDSq) { bestDSq = dSq; best = e; }
    }
    a.targetEnemyId = best ? best.id : null;
  }

  /** @private Cancels any in-progress shooting sequence. */
  _cancelShooting(a) {
    a.shootState = 'idle';
    a.shootTimer = 0;
    a.raiseFrame = 0;
  }

  // ---------------------------------------------------------------------------
  // Shoot state machine
  // ---------------------------------------------------------------------------

  /**
   * Advances the shooting animation state machine one tick.
   * States: idle → raising → aiming → (fire arrow) → cooldown → idle
   * @private
   */
  _tickShootState(a) {
    a.shootTimer++;

    switch (a.shootState) {
      case 'raising':
        // Advance raise frame proportionally to timer.
        a.raiseFrame = Math.floor((a.shootTimer / ARCHER_RAISE_DURATION) * (ARCHER_RAISE_FRAMES - 1));
        if (a.shootTimer >= ARCHER_RAISE_DURATION) {
          a.shootState = 'aiming';
          a.shootTimer = 0;
        }
        break;

      case 'aiming':
        if (a.shootTimer >= ARCHER_AIM_DURATION) {
          // Fire the arrow
          this._fireArrow(a);
          a.shootState = 'cooldown';
          a.shootTimer = 0;
        }
        break;

      case 'cooldown':
        if (a.shootTimer >= ARCHER_COOLDOWN) {
          a.shootState = 'idle';
          a.shootTimer = 0;
          a.raiseFrame = 0;
        }
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Arrow projectile
  // ---------------------------------------------------------------------------

  /**
   * Launches an arrow from the archer's bow tip toward the locked target position.
   * @private
   */
  _fireArrow(a) {
    if (a.targetX === null) return;

    // Approximate bow-tip world position from the rendered geometry:
    // left arm base: translate(-4.5, -17, 0) + arm segment + bow stave offset
    // Net local Y = -17 + 3 - 11.5 = -25.5 → world offset = ARCHER_DRAW_SCALE * ARCHER_BOW_TIP_Y_OFFSET
    const bowTipY  = a.y - ARCHER_DRAW_SCALE * ARCHER_BOW_TIP_Y_OFFSET;
    const fa       = a.facingAngle;
    // Bow is on the left side of the archer (negative X in local space)
    const bowOffX  = Math.sin(fa - Math.PI * 0.5) * ARCHER_DRAW_SCALE * 4.5;
    const bowOffZ  = Math.cos(fa - Math.PI * 0.5) * ARCHER_DRAW_SCALE * 4.5;

    const startX = a.x + bowOffX;
    const startZ = a.z + bowOffZ;

    a.arrows.push({
      startX,
      startY: bowTipY,
      startZ,
      targetX: a.targetX,
      targetZ: a.targetZ,
      // Record enemy ID for hit detection — arrow resolves at arrival
      targetEnemyId: a.targetEnemyId,
      progress: 0
    });
  }

  /**
   * Advances all in-flight arrows for one archer.
   * On arrival, rolls the hit probability and removes/damages the enemy if hit.
   * @private
   */
  _updateArrows(a) {
    for (let i = a.arrows.length - 1; i >= 0; i--) {
      const ar = a.arrows[i];
      ar.progress += 1 / ARCHER_ARROW_DURATION;

      if (ar.progress >= 1.0) {
        // Arrow arrived — attempt to hit
        this._resolveArrowHit(ar);
        swapRemove(a.arrows, i);
      }
    }
  }

  /**
   * Determines whether an arrow hit its target and applies consequences.
   * @private
   */
  _resolveArrowHit(ar) {
    if (typeof enemyManager === 'undefined') return;

    // Low hit probability per spec
    if (random() > ARCHER_HIT_PROB) return;

    // Find the target enemy by id (if it's still alive)
    for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
      const e = enemyManager.enemies[j];
      if (e.id !== ar.targetEnemyId) continue;

      // Hit! Apply damage to bosses, remove normal enemies outright.
      const isBoss = e.type === 'colossus' || e.type === 'kraken';
      if (isBoss) {
        e.hp  = (e.hp || 0) - 5;
        e.hitFlash = 8;
        if (e.hp <= 0) {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          swapRemove(enemyManager.enemies, j);
        }
      } else {
        // Arrow impact burst
        const ix = ar.targetX, iz = ar.targetZ;
        const iy = terrain.getAltitude(ix, iz);
        for (let p = 0; p < 8; p++) {
          particleSystem.particles.push({
            x: ix, y: iy - 6, z: iz,
            vx: random(-2, 2), vy: random(-4, -1), vz: random(-2, 2),
            life: 160, decay: 10, size: random(2, 5),
            color: [220, 180, 60]
          });
        }
        particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
        swapRemove(enemyManager.enemies, j);
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Death callback
  // ---------------------------------------------------------------------------

  onAgentDeath(a) {
    // Small dust/blood burst
    for (let p = 0; p < 10; p++) {
      particleSystem.particles.push({
        x: a.x, y: a.y - 8, z: a.z,
        vx: random(-2.5, 2.5), vy: random(-4, -1), vz: random(-2.5, 2.5),
        life: 180, decay: 10, size: random(2, 5),
        color: p % 2 === 0 ? [180, 50, 30] : [220, 180, 60]
      });
    }

    if (typeof gameSFX !== 'undefined') {
      gameSFX.playVillagerDeath(a.x, a.y, a.z);
    }

    // Allow the home observatory to spawn a replacement.
    if (a.towerRef) a.towerRef._archerSpawned = false;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws all in-range archers and their in-flight arrows.
   * @param {{x,y,z}} s  Ship state used for distance culling.
   */
  draw(s) {
    if (this.agents.length === 0) return;

    const vis = this._cullVisible(s, ARCHER_CULL_DIST_SQ);
    if (vis.length === 0) return;

    this._ensureGeoms();
    noStroke();

    // 1. Archer bodies — rendered with the terrain shader for lighting consistency
    terrain.applyShader();

    for (let i = 0; i < vis.length; i++) {
      const a    = vis[i];
      const vx   = a.vx || 0;
      const vz   = a.vz || 0;
      const isWalking = (vx * vx + vz * vz) > 0.01;

      push();
      translate(a.x, a.y, a.z);
      rotateY(a.facingAngle);
      scale(ARCHER_DRAW_SCALE);

      let geom;
      if (isWalking) {
        const TWO_PI_MATH = Math.PI * 2;
        const fIdx = Math.floor(
          ((a.walkPhase % TWO_PI_MATH + TWO_PI_MATH) % TWO_PI_MATH) / TWO_PI_MATH * 64
        );
        geom = ArcherManager._geoms[fIdx];
      } else if (a.shootState === 'raising') {
        geom = ArcherManager._raisingGeoms[
          Math.min(Math.max(a.raiseFrame, 0), ARCHER_RAISE_FRAMES - 1)
        ];
      } else if (a.shootState === 'aiming' || a.shootState === 'cooldown') {
        geom = ArcherManager._aimingGeom;
      } else {
        geom = ArcherManager._staticGeom;
      }

      if (geom) model(geom);
      pop();
    }

    // 2. In-flight arrows — rendered with fill-colour shader (no scanlines)
    if (terrain.fillShader) {
      terrain.applyFillColorShader();
      terrain.setScanlineWeight(0.0);
    } else {
      setSceneLighting();
    }

    for (let i = 0; i < vis.length; i++) {
      this._drawArrows(vis[i]);
    }

    resetShader();
    setSceneLighting();
  }

  /**
   * Draws in-flight arrows for one archer.
   * Each arrow is rendered as a thin cylinder oriented along its flight
   * direction, following a parabolic arc from bow tip to target.
   * @private
   */
  _drawArrows(a) {
    for (const ar of a.arrows) {
      const t = ar.progress;

      const targetWy = terrain.getAltitude(ar.targetX, ar.targetZ);

      // Interpolate position along the arc
      const bx = ar.startX + (ar.targetX - ar.startX) * t;
      const bz = ar.startZ + (ar.targetZ - ar.startZ) * t;

      // Parabolic vertical arc
      const arcHeight = 55 * Math.sin(t * Math.PI);
      const by        = ar.startY + (targetWy - ar.startY) * t - arcHeight;

      // Velocity direction (tangent to arc) for arrow orientation
      const dt        = 0.02;
      const t2        = Math.min(t + dt, 1.0);
      const bx2       = ar.startX + (ar.targetX - ar.startX) * t2;
      const bz2       = ar.startZ + (ar.targetZ - ar.startZ) * t2;
      const arcH2     = 55 * Math.sin(t2 * Math.PI);
      const by2       = ar.startY + (targetWy - ar.startY) * t2 - arcH2;

      const dirX = bx2 - bx, dirY = by2 - by, dirZ = bz2 - bz;
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;

      push();
      translate(bx, by, bz);

      // Rotate arrow cylinder to point along flight direction
      // p5 cylinders are oriented along Y; we need to align Y-axis with dir.
      // Use rotateX then rotateY approximation.
      const yaw   = Math.atan2(dirX, dirZ);
      const pitch = -Math.asin(dirY / dirLen);
      rotateY(yaw);
      rotateX(pitch);

      // Arrow shaft (light wood)
      this._setColor(150, 120, 55);
      cylinder(0.7, 14, 4, 1);

      // Arrowhead (grey steel tip — translated along +Y which is now the flight axis)
      this._setColor(160, 160, 170);
      push(); translate(0, -8, 0); cone(1.5, 4, 4, 1); pop();

      // Fletching (white feathers at tail)
      this._setColor(230, 230, 220);
      push(); translate(0, 7, 0); box(0.8, 3, 3.5); pop();

      pop();

      // Occasional trail particle
      if (random() < 0.3) {
        particleSystem.particles.push({
          x: bx, y: by, z: bz,
          vx: random(-0.4, 0.4), vy: random(-0.3, 0.3), vz: random(-0.4, 0.4),
          life: 18, decay: 4, size: random(1, 3),
          color: [200, 170, 80]
        });
      }
    }
  }

  /**
   * Sets both the p5 fill colour and the terrain-shader fill uniform.
   * @private
   */
  _setColor(r, g, b) {
    fill(r, g, b);
    terrain.setFillColor(r, g, b);
  }
}

// Singleton instance
const archerManager = new ArcherManager();
