// =============================================================================
// wizards.js — WizardManager class
//
// Spawns a single wizard figure from each uninfected wizard tower
// (building type 0 — two-tiered jade tower with cinnabar eaves). Wizards are
// more powerful than villagers: they actively hunt infection across a wider
// radius, cast spells that clear a 2×2 block of virus tiles in one go, and
// are slightly taller in appearance.
//
// Eastern-magic aesthetic: each wizard wears deep-blue robes with a gold
//
// @exports   WizardManager    — class definition
// @exports   wizardManager    — singleton
// =============================================================================
// sash, a wide bamboo conical hat, a flowing white beard, and carries a
// bamboo staff topped with a jade ring ornament and glowing jade orb.
//
// Spell animation: a golden amber orb travels along a parabolic arc from the
// wizard's staff to the target, then detonates and clears up to 4 tiles.
//
// Rules:
//   • One wizard per tower at any time.
//   • If the tower becomes infected, no new wizard spawns from it.
//   • When a wizard dies its tower can spawn a replacement (once tower is clean).
// =============================================================================

import { p } from './p5Context.js';
import { TILE, CULL_DIST, infection, swapRemove, tileKey, toTile, aboveSea } from './constants.js';
import { AgentManager, ENEMY_CONFRONT_OFFSET, STEERING_LERP_FACTOR } from './agentManager.js';
import { _bldgSafeR } from './buildingGeometry.js';
import { particleSystem } from './particles.js';
import { terrain } from './terrain.js';
import { gameState } from './gameState.js';
import { enemyManager } from './enemies.js';
import { gameSFX } from './sfx.js';
import { setSceneLighting } from './gameRenderer.js';

// --- Wizard tuning constants ---

const WIZARD_MAX_PER_TOWER   = 1;            // One wizard per sentinel tower
const WIZARD_SPAWN_DELAY     = 180;          // Ticks before first spawn (~3 s at 60 Hz)
const WIZARD_SPEED           = 1.0;          // World units per physics tick
const WIZARD_SEARCH_RADIUS   = 10;           // Tile radius to scan for infection (villager = 4)
const WIZARD_CAST_RANGE_TILES = 3;           // Max tile distance at which a spell can be cast
const WIZARD_STOP_DIST       = WIZARD_CAST_RANGE_TILES * TILE; // World units — stop here to cast
const WIZARD_CAST_PROB       = 0.015;        // Per-tick probability of casting when in range
// Spell clears a 2×2 block (4 tiles) — matching the issue spec "remove a block of four virus".
const WIZARD_CLEAR_SIZE      = 2;            // Side length of the 2×2 clearing square
const WIZARD_MAX_WANDER_DIST_SQ = 2400 * 2400; // 20-tile max wander radius squared
const getWizardCullDistSq = () => CULL_DIST * CULL_DIST;
const WIZARD_MAX_HEALTH      = 150;          // Sturdier than villager (100)
const WIZARD_INFECTION_DAM   = 1.2;          // Health loss per tick on infected tile
const WIZARD_HEAL_RATE       = 0.5;          // Health recovery per tick when safe
const WIZARD_SPELL_DURATION  = 28;           // Ticks for a spell blob to reach its target
const WIZARD_DRAW_SCALE      = 2.5;          // Slightly taller than a villager (2.0)
// Retarget hysteresis: only switch to a new infection target if it is this many
// tiles² closer than the current one (prevents oscillation between equal targets).
const WIZARD_TARGET_HYSTERESIS_SQ = 4;       // ≈ 2 tiles
// --- Ground-enemy confrontation constants ---
const WIZARD_FIGHT_RADIUS = 8;               // Tile radius to detect nearby ground enemies
const WIZARD_FIGHT_RANGE = 350;              // World units: cast range for ground enemy spells
const WIZARD_GROUND_KILL_PROB = 0.05;        // Per-cast probability of killing a ground enemy

export class WizardManager extends AgentManager {
  constructor() {
    super(0, {
      maxHealth: WIZARD_MAX_HEALTH,
      infectionDam: WIZARD_INFECTION_DAM,
      healRate: WIZARD_HEAL_RATE,
      speed: WIZARD_SPEED,
      searchRadius: WIZARD_SEARCH_RADIUS,
      targetHysteresisSq: WIZARD_TARGET_HYSTERESIS_SQ,
      stopDist: WIZARD_STOP_DIST,
      maxWanderDistSq: WIZARD_MAX_WANDER_DIST_SQ,
      wanderSpeedMult: 0.4
    }); // Tower building type
    // Aliases to seamlessly patch rendering and old logic references seamlessly 
    this.wizards = this.agents;
    this.towers = this.hubs;
  }

  onWanderExceeded(w) { w.isCasting = false; }
  onWalkToTarget(w) { w.isCasting = false; }
  onReachTarget(w) {
    if (w.spells.length === 0) {
      if (p.random() < WIZARD_CAST_PROB) {
        this._castSpell(w);
      } else {
        w.isCasting = false;
      }
    }
  }
  onNoTarget(w) { w.isCasting = false; }

  onAgentDeath(w) {
    for (let i = 0; i < 16; i++) {
      particleSystem.particles.push({
        x: w.x, y: w.y - 8, z: w.z,
        vx: p.random(-3, 3), vy: p.random(-5, -1), vz: p.random(-3, 3),
        life: 220, decay: 9, size: p.random(3, 7),
        color: i % 2 === 0 ? [200, 50, 40] : [255, 195, 50]
      });
    }

    gameSFX?.playVillagerDeath(w.x, w.y, w.z);

    // Allow the home tower to spawn a replacement wizard.
    if (w.towerRef) w.towerRef._wizardSpawned = false;
  }

  // ---------------------------------------------------------------------------
  // Geometry Baking
  // ---------------------------------------------------------------------------

  /**
   * Pre-bakes 64 frames of wizard animations into cached p5.Geometry objects.
   * Eliminates expensive per-part draw calls and fill state changes.
   * @private
   */
  _ensureGeoms() {
    if (WizardManager._geoms) return;
    WizardManager._geoms = [];
    WizardManager._castingGeoms = [];

    const buildWiz = (isCasting, phase, castPhase, isSitting = false) => {
      return terrain._safeBuildGeometry(() => {
        p.noStroke();
        
        if (isSitting) {
          p.translate(0, 5, 0); // lower to the ground
        }

        // Head
        p.fill(_bldgSafeR(220), 185, 150);
        p.push(); p.translate(0, -22, 0); p.box(5, 5, 5); p.pop();

        // Beard
        p.fill(_bldgSafeR(235), 235, 230);
        p.push(); p.translate(0, -19, 2.5); p.box(3, 4, 2); p.pop();

        // Hat
        p.fill(_bldgSafeR(90), 140, 60);
        p.push(); p.translate(0, -26, 0); p.cylinder(8, 1.5, 8, 1); p.pop();
        p.push(); p.translate(0, -30, 0); p.rotateX(Math.PI); p.cone(5, 7, 8, 1); p.pop();
        p.fill(_bldgSafeR(220), 185, 50);
        p.push(); p.translate(0, -26.8, 0); p.cylinder(8.1, 0.6, 8, 1); p.pop();

        // Robe
        p.fill(_bldgSafeR(70), 100, 185);
        p.push(); p.translate(0, -16, 0); p.box(7, 8, 4); p.pop();
        p.fill(_bldgSafeR(220), 185, 50);
        p.push(); p.translate(0, -12.5, 0); p.box(8, 1.8, 5); p.pop();
        p.fill(_bldgSafeR(70), 100, 185);
        p.push(); p.translate(0, -9, 0); p.box(8, 5, 5); p.pop();

        // Legs
        p.fill(_bldgSafeR(48), 65, 140);
        let legSwing = 0;
        if (isSitting) {
          p.push(); p.translate(-1.5, -6.5, 0); p.rotateX(Math.PI * 0.4); p.translate(0, 3, 0); p.box(2.5, 4, 2.5); p.pop();
          p.push(); p.translate( 1.5, -6.5, 0); p.rotateX(Math.PI * 0.4); p.translate(0, 3, 0); p.box(2.5, 4, 2.5); p.pop();
        } else {
          legSwing = isCasting ? 0 : Math.sin(phase) * 0.6;
          p.push(); p.translate(-1.5, -6.5, 0); p.rotateX(legSwing);  p.translate(0, 3, 0); p.box(2.5, 4, 2.5); p.pop();
          p.push(); p.translate( 1.5, -6.5, 0); p.rotateX(-legSwing); p.translate(0, 3, 0); p.box(2.5, 4, 2.5); p.pop();
        }

        // Left Arm
        p.fill(_bldgSafeR(70), 100, 185);
        const leftArmSwing = isSitting ? 0.3 : (isCasting ? Math.sin(castPhase * 3) * 0.3 : Math.sin(phase + Math.PI) * 0.5);
        p.push(); p.translate(-4.5, -17, 0); p.rotateX(leftArmSwing); p.translate(0, 3, 0); p.box(2.5, 5, 2.5); p.pop();

        // Right Arm (Staff)
        const staffArm = isSitting 
          ? 0.3 
          : (isCasting
            ? -Math.PI * 0.6 + Math.sin(castPhase) * 0.15
            : (legSwing !== 0 ? Math.sin(phase) * 0.5 : -0.15)); // Stand idle: -0.15
        
        p.fill(_bldgSafeR(70), 100, 185);
        p.push(); p.translate(4.5, -17, 0); p.rotateX(staffArm); p.translate(0, 3, 0); p.box(2.5, 5, 2.5);
        
        // Staff & Orb
        p.fill(_bldgSafeR(90), 140, 60);
        p.push(); p.translate(0, -13, 0); p.cylinder(0.8, 18, 5, 1); p.pop();
        p.fill(_bldgSafeR(220), 185, 50);
        p.push(); p.translate(0, -22.5, 0); p.rotateX(Math.PI / 2); p.torus(2.5, 0.5, 8, 4); p.pop();
        p.fill(_bldgSafeR(isCasting ? 55 : 40), isCasting ? 225 : 200, isCasting ? 145 : 120);
        p.push(); p.translate(0, -25, 0); p.sphere(2.0, 6, 4); p.pop();
        p.pop(); // right arm group
      });
    };

    for (let f = 0; f < 64; f++) {
      const phase = (f / 64) * Math.PI * 2;
      WizardManager._geoms[f] = buildWiz(false, phase, 0, false);
      WizardManager._castingGeoms[f] = buildWiz(true, 0, phase, false);
    }
    WizardManager._staticGeom = buildWiz(false, 0, 0, false);
    WizardManager._sittingGeom = buildWiz(false, 0, 0, true);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets wizard state. Called at every level start. */
  clear() {
    super.clear();
    if (gameState.level === 1) {
      for (const b of this.hubs) {
        b._wizardSpawned = false;
        b._wizardTimer   = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update  (called from the fixed-timestep physics loop)
  // ---------------------------------------------------------------------------

  update() {
    if (typeof window !== 'undefined' && window.BENCHMARK && typeof window.BENCHMARK === 'object' && window.BENCHMARK.disableVillagers) return;

    super.update();
    const targets = this.getTargetHubs();

    // Try to spawn one wizard per clean, un-occupied tower.
    this._trySpawn(targets);

    // Update every active wizard.
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const w = this.agents[i];

      // Advance in-flight spell blobs first so they can clear tiles this tick.
      this._updateSpells(w);

      // Steer toward nearest infection cluster.
      this._steerTowardInfection(w, w.towerX, w.towerZ);

      // Confront nearby ground enemies when idle (no infection target).
      this._confrontNearbyGroundEnemy(w);

      // Interpret idle state
      // Only sit if we are not actively being leashed back home or confronting an enemy.
      const distFromTowerSq = (w.x - w.towerX) * (w.x - w.towerX) + (w.z - w.towerZ) * (w.z - w.towerZ);
      if (w.targetTx === null && !w.isConfronting && distFromTowerSq <= WIZARD_MAX_WANDER_DIST_SQ) {
        w.isSitting = true;
        w.vx = 0;
        w.vz = 0;
      } else {
        w.isSitting = false;
      }

      // --- Health & Physics Integration ---
      if (!this._applyHealthAndPhysics(w)) {
        this.killAgent(w, i);
        continue;
      }

      // Advance walk animation phase.
      w.walkPhase += 0.12;

      // Advance cast animation phase.
      if (w.isCasting) {
        w.castPhase = (w.castPhase + 0.18) % (Math.PI * 2);
      }

      this._smoothRotation(w);
    }
  }

  // ---------------------------------------------------------------------------
  // Spell projectile simulation
  // ---------------------------------------------------------------------------

  /** @private Advances in-flight spell blobs for one tick and handles arrival. */
  _updateSpells(w) {
    for (let i = w.spells.length - 1; i >= 0; i--) {
      const sp = w.spells[i];
      sp.progress += 1 / WIZARD_SPELL_DURATION;

      if (sp.progress >= 1.0) {
        if (sp.isEnemySpell) {
          // Arrived at ground enemy — attempt to kill with low probability.
          const eIdx = sp.targetEnemy ? enemyManager.enemies.indexOf(sp.targetEnemy) : -1;
          if (eIdx >= 0) {
            const e = enemyManager.enemies[eIdx];
            if (p.random() < WIZARD_GROUND_KILL_PROB) {
              particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
              swapRemove(enemyManager.enemies, eIdx);
            }
          }
          // Impact burst regardless of kill (shows the spell tried)
          const ix = sp.targetWx, iy = sp.targetWy, iz = sp.targetWz;
          for (let i = 0; i < 12; i++) {
            particleSystem.particles.push({
              x: ix, y: iy - 8, z: iz,
              vx: p.random(-3.0, 3.0), vy: p.random(-5, -1), vz: p.random(-3.0, 3.0),
              life: 180, decay: 8, size: p.random(3, 8),
              color: i % 3 === 0 ? [255, 240, 140] : [255, 200, 55]
            });
          }
          swapRemove(w.spells, i);
          w.isCasting = false;
          w.isConfronting = false;
        } else {
          // Arrived — clear a 2×2 block of tiles (4 tiles) centred on the target.
          const htx = sp.targetTx, htz = sp.targetTz;
          let cleared = 0;
          for (let ddx = 0; ddx < WIZARD_CLEAR_SIZE; ddx++) {
            for (let ddz = 0; ddz < WIZARD_CLEAR_SIZE; ddz++) {
              const ck = tileKey(htx + ddx, htz + ddz);
              if (infection.remove(ck)) {
                cleared++;
                terrain.addPulse((htx + ddx) * TILE, (htz + ddz) * TILE, 1.0);
              }
            }
          }

          if (cleared > 0) {
            // Amber/gold impact burst particles.
            const ix = htx * TILE + TILE * 0.5;
            const iz = htz * TILE + TILE * 0.5;
            const iy = terrain.getAltitude(ix, iz);
            for (let i = 0; i < 18; i++) {
              particleSystem.particles.push({
                x: ix, y: iy - 8, z: iz,
                vx: p.random(-3.5, 3.5), vy: p.random(-6, -1), vz: p.random(-3.5, 3.5),
                life: 220, decay: 7, size: p.random(4, 10),
                color: i % 3 === 0 ? [255, 240, 140] : [255, 200, 55]
              });
            }
            gameSFX?.playVillagerCure(ix, iy, iz);
          }

          // Remove spent spell; let the wizard retarget.
          swapRemove(w.spells, i);
          w.isCasting  = false;
          w.targetTx   = null;
          w.targetTz   = null;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /** @private Attempts to spawn a wizard from each eligible sentinel tower. */
  _trySpawn(towersArray) {
    for (const b of towersArray) {
      // One wizard per tower.
      if (b._wizardSpawned) continue;

      // Don't spawn from an infected tower.
      if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      if (infection.has(b._tileKey)) continue;

      // Require some infection to fight.
      if (infection.count === 0) continue;

      // Brief delay before the first wizard emerges.
      b._wizardTimer = (b._wizardTimer || 0) + 1;
      if (b._wizardTimer < WIZARD_SPAWN_DELAY) continue;

      // Spawn position: close to the tower.
      const angle = p.random(Math.PI * 2);
      const dist  = p.random(40, 100);
      const sx    = b.x + Math.cos(angle) * dist;
      const sz    = b.z + Math.sin(angle) * dist;
      const sy    = terrain.getAltitude(sx, sz);

      if (aboveSea(sy)) continue; // Underwater spawn point — retry next tick.

      b._wizardSpawned = true;
      b._wizardTimer   = 0;

      this.agents.push({
        x: sx, y: sy, z: sz,
        vx: 0, vz: 0,
        targetTx: null, targetTz: null,
        walkPhase: p.random(Math.PI * 2),
        id: p.random(),
        towerX: b.x,
        towerZ: b.z,
        towerRef: b,         // Back-reference so death can clear _wizardSpawned.
        health: WIZARD_MAX_HEALTH,
        isCasting: false,
        isSitting: false,
        isConfronting: false, // True when moving toward or casting at a ground enemy
        castPhase: 0,
        facingAngle: angle,
        spells: [],
        _retargetTimer: Math.floor(p.random(60)) // Stagger CPU spikes
      });
    }
  }

  /** @private Launches a spell blob toward the wizard's current target tile. */
  _castSpell(w) {
    if (w.targetTx === null) return;
    w.isCasting = true;
    w.castPhase = 0;

    // Staff tip position in world space, derived from the rendered model's local geometry:
    //   arm base: translate(4.5, -17, 0) → hand: translate(0, 3, 0) → orb: translate(0, -25, 0)
    //   net pre-scale local Y = -17 + 3 - 25 = -39  →  world offset = WIZARD_DRAW_SCALE * 39
    //   net pre-scale local X = 4.5 (right side of wizard)
    const staffTipY = w.y - WIZARD_DRAW_SCALE * 39;
    // Horizontal offset: staff is on the right-hand side, perpendicular to facing direction.
    const fa = w.facingAngle;
    const staffOffX = Math.sin(fa + Math.PI * 0.5) * WIZARD_DRAW_SCALE * 4.5;
    const staffOffZ = Math.cos(fa + Math.PI * 0.5) * WIZARD_DRAW_SCALE * 4.5;

    w.spells.push({
      startX:   w.x   + staffOffX,
      startY:   staffTipY,
      startZ:   w.z   + staffOffZ,
      targetTx: w.targetTx,
      targetTz: w.targetTz,
      progress: 0
    });
  }

  /**
   * Checks for nearby ground enemies and steers the wizard toward them.
   * Runs only when the wizard has no infection to pursue, so infection-clearing
   * remains the higher priority.  On arrival, casts a spell at the enemy with
   * a very low chance of actually killing it.
   * @private
   */
  _confrontNearbyGroundEnemy(w) {
    // Don't interrupt active infection-clearing spells.
    if (w.spells.some(sp => !sp.isEnemySpell)) return;

    // Only confront when idle (no infection target).
    if (w.targetTx !== null) {
      w.isConfronting = false;
      return;
    }

    const enemy = this._findNearestGroundEnemy(w, WIZARD_FIGHT_RADIUS);
    if (!enemy) {
      w.isConfronting = false;
      return;
    }

    const dx = enemy.x - w.x;
    const dz = enemy.z - w.z;
    const distSq = dx * dx + dz * dz;
    const dist = Math.sqrt(distSq);
    const rangeSq = WIZARD_FIGHT_RANGE * WIZARD_FIGHT_RANGE;

    if (distSq > rangeSq) {
      // Steer toward the near body edge (ENEMY_CONFRONT_OFFSET from centre),
      // keeping the wizard at casting range from the body surface.
      w.vx = p.lerp(w.vx || 0, (dx / dist) * WIZARD_SPEED, STEERING_LERP_FACTOR);
      w.vz = p.lerp(w.vz || 0, (dz / dist) * WIZARD_SPEED, STEERING_LERP_FACTOR);
      w.isConfronting = true;
      w.isCasting = false;
      w.isSitting = false;
    } else {
      // In cast range: stop and attempt a spell
      w.vx = 0;
      w.vz = 0;
      w.isConfronting = true;
      w.isSitting = false;
      w.targetAngle = Math.atan2(dx, dz);

      // Only fire if no enemy spell already in flight
      if (!w.spells.some(sp => sp.isEnemySpell) && p.random() < WIZARD_CAST_PROB) {
        this._castSpellAtEnemy(w, enemy);
      }
    }
  }

  /**
   * Launches a spell blob aimed at a ground enemy's current position.
   * The spell travels identically to an infection spell but targets a
   * world-space coordinate and optionally kills the enemy on arrival.
   * @private
   */
  _castSpellAtEnemy(w, enemy) {
    w.isCasting = true;
    w.castPhase = 0;

    const fa = w.facingAngle;
    const staffOffX = Math.sin(fa + Math.PI * 0.5) * WIZARD_DRAW_SCALE * 4.5;
    const staffOffZ = Math.cos(fa + Math.PI * 0.5) * WIZARD_DRAW_SCALE * 4.5;
    const staffTipY = w.y - WIZARD_DRAW_SCALE * 39;

    w.spells.push({
      startX:      w.x + staffOffX,
      startY:      staffTipY,
      startZ:      w.z + staffOffZ,
      targetTx:    null,  // Not targeting a tile
      targetTz:    null,
      targetWx:    enemy.x,
      targetWy:    enemy.y - 10,  // Aim at enemy body centre
      targetWz:    enemy.z,
      targetEnemy: enemy,         // Reference to test for kill on arrival
      isEnemySpell: true,
      progress:    0
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws all in-range wizards and their in-flight spell blobs.
   *
   * Each wizard wears deep-blue robes with a gold sash, a wide bamboo
   * conical hat, a flowing white beard, and carries a bamboo staff topped with
   * a jade ring and glowing jade orb.  Spell orbs travel as glowing amber
   * spheres along a parabolic arc.
   *
   * @param {{x,y,z}} s  Ship state used for distance culling.
   */
  draw(s) {
    if (this.agents.length === 0) return;

    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    const vis = this._cullVisible(s, getWizardCullDistSq());

    if (vis.length === 0) {
      if (profiler) profiler.recordWizards(0, performance.now() - start);
      return;
    }

    this._ensureGeoms();
    p.noStroke();

    // 1. Draw wizards with vertex-baked geometries using the standard terrain shader
    terrain.applyShader();

    for (let i = 0; i < vis.length; i++) {
      const w = vis[i];
      const vx = w.vx || 0;
      const vz = w.vz || 0;
      const isWalking = (vx * vx + vz * vz) > 0.01;

      p.push();
      p.translate(w.x, w.y, w.z);
      p.rotateY(w.facingAngle);
      p.scale(WIZARD_DRAW_SCALE);

      let geom;
      if (isWalking) {
        const TWO_PI_MATH = Math.PI * 2;
        const fIdx = Math.floor(((w.walkPhase % TWO_PI_MATH + TWO_PI_MATH) % TWO_PI_MATH) / TWO_PI_MATH * 64);
        geom = WizardManager._geoms[fIdx];
      } else if (w.isCasting) {
        const TWO_PI_MATH = Math.PI * 2;
        const fIdx = Math.floor(((w.castPhase % TWO_PI_MATH + TWO_PI_MATH) % TWO_PI_MATH) / TWO_PI_MATH * 64);
        geom = WizardManager._castingGeoms[fIdx];
      } else if (w.isSitting) {
        geom = WizardManager._sittingGeom;
      } else {
        geom = WizardManager._staticGeom;
      }

      if (geom) p.model(geom);

      p.pop(); // End of wizard transform
    }

    // 2. Draw in-flight spell blobs in world space using fill shader (no scanlines)
    if (terrain.fillShader) {
      terrain.applyFillColorShader();
      terrain.setScanlineWeight(0.0);
    } else {
      setSceneLighting();
    }

    for (let i = 0; i < vis.length; i++) {
      this._drawSpells(vis[i]);
    }

    p.resetShader();
    setSceneLighting();

    if (profiler) profiler.recordWizards(vis.length, performance.now() - start);
  }

  /**
   * Draws the spell blobs belonging to one wizard.
   * Called in world-space after the wizard's local push/pop has been closed.
   * Handles both infection-clearing spells (targeting a tile) and ground-enemy
   * spells (targeting a world-space position).
   * @private
   */
  _drawSpells(w) {
    for (const sp of w.spells) {
      const t = sp.progress;

      // Resolve world-space target: enemy spells use pre-stored coordinates;
      // infection spells derive from the target tile index.
      let targetWx, targetWz, targetWy;
      if (sp.isEnemySpell) {
        targetWx = sp.targetWx;
        targetWz = sp.targetWz;
        targetWy = sp.targetWy;
      } else {
        targetWx = sp.targetTx * TILE + TILE * 0.5;
        targetWz = sp.targetTz * TILE + TILE * 0.5;
        targetWy = terrain.getAltitude(targetWx, targetWz);
      }

      // Lerp position along the path.
      const bx = sp.startX + (targetWx - sp.startX) * t;
      const bz = sp.startZ + (targetWz - sp.startZ) * t;

      // Parabolic arc: rises in the middle, hits the ground at the target.
      const arcHeight  = 90 * Math.sin(t * Math.PI);
      const by         = sp.startY + (targetWy - sp.startY) * t - arcHeight;

      // Blob pulses in size as it travels.
      const blobR = 4 + t * 6 + Math.sin(t * Math.PI * 8) * 1.5;

      // Amber/gold core.
      this._setColor(255, 200, 55);
      p.push(); p.translate(bx, by, bz); p.sphere(blobR, 6, 4); p.pop();

      // Lighter amber halo.
      this._setColor(255, 240, 145);
      p.push(); p.translate(bx, by, bz); p.sphere(blobR * 0.55, 5, 3); p.pop();

      // Trailing sparkle particles (occasional, cheap).
      if (p.random() < 0.45) {
        particleSystem.particles.push({
          x: bx, y: by, z: bz,
          vx: p.random(-0.8, 0.8), vy: p.random(-0.6, 0.6), vz: p.random(-0.8, 0.8),
          life: 28, decay: 3, size: p.random(2, 5),
          color: [255, 200, 50]
        });
      }
    }
  }

  /**
   * Sets both the p5 fill colour and the terrain-shader fill uniform.
   * Mirrors VillagerManager._setColor().
   * @private
   */
  _setColor(r, g, b) {
    p.fill(r, g, b);
    terrain.setFillColor(r, g, b);
  }
}

// Singleton instance
export const wizardManager = new WizardManager();
