// =============================================================================
// wizards.js — WizardManager class
//
// Spawns a single wizard figure from each uninfected wizard tower
// (building type 0 — two-tiered jade tower with cinnabar eaves). Wizards are
// more powerful than villagers: they actively hunt infection across a wider
// radius, cast spells that clear a 2×2 block of virus tiles in one go, and
// are slightly taller in appearance.
//
// Eastern-magic aesthetic: each wizard wears deep-crimson robes with a gold
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
const WIZARD_CULL_DIST_SQ    = CULL_DIST * CULL_DIST;
const WIZARD_MAX_HEALTH      = 150;          // Sturdier than villager (100)
const WIZARD_INFECTION_DAM   = 1.2;          // Health loss per tick on infected tile
const WIZARD_HEAL_RATE       = 0.5;          // Health recovery per tick when safe
const WIZARD_SPELL_DURATION  = 28;           // Ticks for a spell blob to reach its target
const WIZARD_DRAW_SCALE      = 2.5;          // Slightly taller than a villager (2.0)

class WizardManager {
  constructor() {
    /** @type {Array<object>} Active wizard objects. */
    this.wizards = [];

    // Reused across draw() to avoid per-frame allocation.
    this._visible = [];

    /** @type {Array<object>} Cached reference to all wizard tower buildings (type 0). */
    this.towers = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Resets wizard state. Called at every level start. */
  clear() {
    if (gameState.level === 1) {
      this.wizards.length = 0;
    }

    // Refresh tower list from current world buildings.
    this.towers = gameState.buildings.filter(b => b.type === 0);

    if (gameState.level === 1) {
      for (const b of this.towers) {
        b._wizardSpawned = false;
        b._wizardTimer   = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update  (called from the fixed-timestep physics loop)
  // ---------------------------------------------------------------------------

  update() {
    if (typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagers) return;

    // Try to spawn one wizard per clean, un-occupied tower.
    this._trySpawn();

    // Update every active wizard.
    for (let i = this.wizards.length - 1; i >= 0; i--) {
      const w = this.wizards[i];

      // Health: take damage when standing on infected tile.
      const tk = tileKey(toTile(w.x), toTile(w.z));
      if (infection.has(tk)) {
        w.health -= WIZARD_INFECTION_DAM;
        if (w.health <= 0) {
          this._killWizard(w, i);
          continue;
        }
      } else if (w.health < WIZARD_MAX_HEALTH) {
        w.health = Math.min(WIZARD_MAX_HEALTH, w.health + WIZARD_HEAL_RATE);
      }

      // Advance in-flight spell blobs first so they can clear tiles this tick.
      this._updateSpells(w);

      // Steer toward nearest infection cluster.
      this._steerTowardInfection(w);

      // Integrate movement.
      w.x += w.vx;
      w.z += w.vz;

      // Snap to ground.
      const gy = terrain.getAltitude(w.x, w.z);
      w.y = gy;

      // Kill if wizard walked into the sea.
      if (aboveSea(gy)) {
        this._killWizard(w, i);
        continue;
      }

      // Advance walk animation phase.
      w.walkPhase += 0.12;

      // Advance cast animation phase.
      if (w.isCasting) {
        w.castPhase = (w.castPhase + 0.18) % (Math.PI * 2);
      }
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
          for (let p = 0; p < 18; p++) {
            particleSystem.particles.push({
              x: ix, y: iy - 8, z: iz,
              vx: random(-3.5, 3.5), vy: random(-6, -1), vz: random(-3.5, 3.5),
              life: 220, decay: 7, size: random(4, 10),
              color: p % 3 === 0 ? [255, 240, 140] : [255, 200, 55]
            });
          }
          if (typeof gameSFX !== 'undefined') {
            gameSFX.playVillagerCure(ix, iy, iz);
          }
        }

        // Remove spent spell; let the wizard retarget.
        swapRemove(w.spells, i);
        w.isCasting  = false;
        w.targetTx   = null;
        w.targetTz   = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /** @private Attempts to spawn a wizard from each eligible sentinel tower. */
  _trySpawn() {
    for (const b of this.towers) {
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
      const angle = random(TWO_PI);
      const dist  = random(40, 100);
      const sx    = b.x + cos(angle) * dist;
      const sz    = b.z + sin(angle) * dist;
      const sy    = terrain.getAltitude(sx, sz);

      if (aboveSea(sy)) continue; // Underwater spawn point — retry next tick.

      b._wizardSpawned = true;
      b._wizardTimer   = 0;

      this.wizards.push({
        x: sx, y: sy, z: sz,
        vx: 0, vz: 0,
        targetTx: null, targetTz: null,
        walkPhase: random(TWO_PI),
        id: random(),
        towerX: b.x,
        towerZ: b.z,
        towerRef: b,         // Back-reference so death can clear _wizardSpawned.
        health: WIZARD_MAX_HEALTH,
        isCasting: false,
        castPhase: 0,
        facingAngle: 0,
        spells: []
      });
    }
  }

  // ---------------------------------------------------------------------------
  // AI
  // ---------------------------------------------------------------------------

  /** @private Steers a wizard toward infection; casts a spell when in range. */
  _steerTowardInfection(w) {
    // Enforce max wander distance — return toward tower if exceeded.
    const dxH = w.x - w.towerX;
    const dzH = w.z - w.towerZ;
    if (dxH * dxH + dzH * dzH > WIZARD_MAX_WANDER_DIST_SQ) {
      w.targetTx = null;
      w.targetTz = null;
      const d = Math.hypot(dxH, dzH);
      if (d > 0) {
        w.vx = (-dxH / d) * WIZARD_SPEED;
        w.vz = (-dzH / d) * WIZARD_SPEED;
      }
      return;
    }

    // Retarget periodically or when the tile is no longer infected.
    w._retargetTimer = (w._retargetTimer || 0) + 1;
    const needsRetarget =
      w.targetTx === null ||
      w._retargetTimer > 60 ||
      !infection.has(tileKey(w.targetTx, w.targetTz));

    if (needsRetarget) {
      w._retargetTimer = 0;
      this._findNearestInfection(w);
    }

    if (w.targetTx !== null) {
      const targetWx = w.targetTx * TILE + TILE * 0.5;
      const targetWz = w.targetTz * TILE + TILE * 0.5;
      const dx = targetWx - w.x;
      const dz = targetWz - w.z;
      const d  = Math.hypot(dx, dz);

      if (d > WIZARD_STOP_DIST) {
        // Walk toward target.
        w.vx = (dx / d) * WIZARD_SPEED;
        w.vz = (dz / d) * WIZARD_SPEED;
        w.isCasting = false;
      } else {
        // In casting range — stop and face target.
        w.vx = 0;
        w.vz = 0;
        w.facingAngle = atan2(dx, dz);

        // Cast only when no spell is already in flight.
        if (w.spells.length === 0) {
          if (random() < WIZARD_CAST_PROB) {
            this._castSpell(w);
          } else {
            w.isCasting = false;
          }
        }
      }
    } else {
      // No target — wander slowly back toward the tower.
      w.isCasting = false;
      if (random() < 0.02) {
        const angle = random(TWO_PI);
        w.vx = cos(angle) * WIZARD_SPEED * 0.4;
        w.vz = sin(angle) * WIZARD_SPEED * 0.4;
      }
    }
  }

  /** @private Scans for nearest infected tile within WIZARD_SEARCH_RADIUS. */
  _findNearestInfection(w) {
    const wtx = toTile(w.x), wtz = toTile(w.z);
    let bestDist = Infinity;
    let bestTx = null, bestTz = null;
    const r = WIZARD_SEARCH_RADIUS;

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = wtx + dx, tz = wtz + dz;
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

    w.targetTx = bestTx;
    w.targetTz = bestTz;
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

  // ---------------------------------------------------------------------------
  // Death
  // ---------------------------------------------------------------------------

  /** @private Removes a wizard, plays a crimson death burst, and frees the tower slot. */
  _killWizard(w, idx) {
    for (let p = 0; p < 16; p++) {
      particleSystem.particles.push({
        x: w.x, y: w.y - 8, z: w.z,
        vx: random(-3, 3), vy: random(-5, -1), vz: random(-3, 3),
        life: 220, decay: 9, size: random(3, 7),
        color: p % 2 === 0 ? [200, 50, 40] : [255, 195, 50]
      });
    }

    if (typeof gameSFX !== 'undefined') {
      gameSFX.playVillagerDeath(w.x, w.y, w.z);
    }

    // Allow the home tower to spawn a replacement wizard.
    if (w.towerRef) w.towerRef._wizardSpawned = false;

    swapRemove(this.wizards, idx);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Draws all in-range wizards and their in-flight spell blobs.
   *
   * Each wizard wears deep-crimson robes with a gold sash, a wide bamboo
   * conical hat, a flowing white beard, and carries a bamboo staff topped with
   * a jade ring and glowing jade orb.  Spell orbs travel as glowing amber
   * spheres along a parabolic arc.
   *
   * @param {{x,y,z}} s  Ship state used for distance culling.
   */
  draw(s) {
    if (this.wizards.length === 0) return;

    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    const sx = s.x, sz = s.z;
    const vis = this._visible;
    vis.length = 0;

    for (let i = 0; i < this.wizards.length; i++) {
      const w = this.wizards[i];
      if ((w.x - sx) ** 2 + (w.z - sz) ** 2 > WIZARD_CULL_DIST_SQ) continue;
      vis.push(w);
    }

    if (vis.length === 0) {
      if (profiler) profiler.recordWizards(0, performance.now() - start);
      return;
    }

    if (terrain.fillShader) {
      terrain.applyFillColorShader();
      terrain.setScanlineWeight(0.0);
    } else {
      setSceneLighting();
    }

    noStroke();

    for (let i = 0; i < vis.length; i++) {
      const w = vis[i];
      const walkSpeed = Math.hypot(w.vx || 0, w.vz || 0);
      const isWalking = walkSpeed > 0.1;
      const phase     = w.walkPhase;

      push();
      translate(w.x, w.y, w.z);

      if (isWalking) {
        rotateY(atan2(w.vx || 0, w.vz || 0));
      } else if (w.facingAngle !== undefined) {
        rotateY(w.facingAngle);
      }

      scale(WIZARD_DRAW_SCALE);

      // --- Head ---
      this._setColor(220, 185, 150);  // Skin tone
      push(); translate(0, -22, 0); box(5, 5, 5); pop();

      // --- White beard (below chin, slightly forward) ---
      this._setColor(235, 235, 230);
      push(); translate(0, -19, 2.5); box(3, 4, 2); pop();

      // --- Bamboo conical hat (wide flat brim + tapering crown) ---
      this._setColor(90, 140, 60);   // bamboo green brim
      push(); translate(0, -26, 0); cylinder(8, 1.5, 8, 1); pop();
      push(); translate(0, -30, 0); rotateX(PI); cone(5, 7, 8, 1); pop();  // conical crown, point up
      this._setColor(220, 185, 50);  // gold hat band
      push(); translate(0, -26.8, 0); cylinder(8.1, 0.6, 8, 1); pop();

      // --- Body — deep crimson robe ---
      this._setColor(175, 40, 50);
      push(); translate(0, -16, 0); box(7, 8, 4); pop();

      // --- Golden sash across waist ---
      this._setColor(220, 185, 50);
      push(); translate(0, -12.5, 0); box(8, 1.8, 5); pop();

      // --- Lower robe hem (wider, suggests flowing robe) ---
      this._setColor(175, 40, 50);
      push(); translate(0, -9, 0); box(8, 5, 5); pop();

      // --- Legs (barely visible beneath robe hem) ---
      this._setColor(130, 30, 35);
      const legSwing = isWalking ? sin(phase) * 0.6 : 0;
      push(); translate(-1.5, -6.5, 0); rotateX(legSwing);  translate(0, 3, 0); box(2.5, 4, 2.5); pop();
      push(); translate( 1.5, -6.5, 0); rotateX(-legSwing); translate(0, 3, 0); box(2.5, 4, 2.5); pop();

      // --- Left sleeve (crimson) ---
      this._setColor(175, 40, 50);
      const leftArmSwing = isWalking ? sin(phase + PI) * 0.5 : (w.isCasting ? sin(w.castPhase * 3) * 0.3 : 0);
      push(); translate(-4.5, -17, 0); rotateX(leftArmSwing); translate(0, 3, 0); box(2.5, 5, 2.5); pop();

      // --- Right sleeve: holds bamboo staff — raises while casting ---
      const staffArm = w.isCasting
        ? -Math.PI * 0.6 + Math.sin(w.castPhase) * 0.15
        : (isWalking ? sin(phase) * 0.5 : -0.15);

      this._setColor(175, 40, 50);
      push();
      translate(4.5, -17, 0);
      rotateX(staffArm);
      translate(0, 3, 0);
      box(2.5, 5, 2.5);     // Sleeve

      // Bamboo staff shaft
      this._setColor(90, 140, 60);
      push(); translate(0, -13, 0); cylinder(0.8, 18, 5, 1); pop();

      // Gold ring ornament near staff top
      this._setColor(220, 185, 50);
      push(); translate(0, -22.5, 0); rotateX(PI / 2); torus(2.5, 0.5, 8, 4); pop();

      // Jade orb at staff tip — brightens when casting
      this._setColor(w.isCasting ? 55 : 40, w.isCasting ? 225 : 200, w.isCasting ? 145 : 120);
      push(); translate(0, -25, 0); sphere(2.0, 6, 4); pop();
      pop();  // end right arm/staff

      pop(); // End of wizard transform

      // Draw in-flight spell blobs in world space (fill shader still active).
      this._drawSpells(w);
    }

    resetShader();
    setSceneLighting();

    if (profiler) profiler.recordWizards(vis.length, performance.now() - start);
  }

  /**
   * Draws the spell blobs belonging to one wizard.
   * Called in world-space after the wizard's local push/pop has been closed.
   * @private
   */
  _drawSpells(w) {
    for (const sp of w.spells) {
      const t = sp.progress;

      // World-space position of the target tile centre.
      const targetWx = sp.targetTx * TILE + TILE * 0.5;
      const targetWz = sp.targetTz * TILE + TILE * 0.5;
      const targetWy = terrain.getAltitude(targetWx, targetWz);

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
      push(); translate(bx, by, bz); sphere(blobR, 6, 4); pop();

      // Lighter amber halo.
      this._setColor(255, 240, 145);
      push(); translate(bx, by, bz); sphere(blobR * 0.55, 5, 3); pop();

      // Trailing sparkle particles (occasional, cheap).
      if (random() < 0.45) {
        particleSystem.particles.push({
          x: bx, y: by, z: bz,
          vx: random(-0.8, 0.8), vy: random(-0.6, 0.6), vz: random(-0.8, 0.8),
          life: 28, decay: 3, size: random(2, 5),
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
    fill(r, g, b);
    terrain.setFillColor(r, g, b);
  }
}

// Singleton instance
const wizardManager = new WizardManager();
