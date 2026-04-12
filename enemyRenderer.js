// =============================================================================
// enemyRenderer.js — Enemy rendering subsystem
//
// Owns all visual rendering of enemy entities: per-type 3D meshes, shadow
// casting, and the two-pass draw pipeline (fill-colour shader for box/cylinder
// enemies, vertex shader for triangle-mesh enemies).
//
// Separated from EnemyManager (enemies.js) so AI logic and rendering can
// evolve independently.  The renderer reads only positional and animation
// state from enemy objects — it never mutates them.
// =============================================================================

// Pre-allocated edge vectors for _drawTri() — eliminates 2 array literal
// allocations per call.  Safe: _drawTri() is non-re-entrant (single-threaded JS).
const _triV1 = [0, 0, 0];
const _triV2 = [0, 0, 0];

class EnemyRenderer {
  constructor() {
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
    // Reusable visible-enemy list — reset with .length=0 each frame to avoid
    // allocating a fresh array every draw() call (called at display refresh rate).
    this._visibleEnemies = [];
  }

  // ---------------------------------------------------------------------------
  // Colour helpers
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Geometry primitives
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

  // ---------------------------------------------------------------------------
  // Per-type draw methods (fill-colour pass — box/cylinder primitives)
  // ---------------------------------------------------------------------------

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
    this._setColor(darkR, darkG, darkB);
    push(); rotateX(PI / 2); cylinder(82, 26, 10, 1); pop();

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
    const phase   = frameCount * 0.02 + (e.id || 0) * 0.15;
    const SEG_LEN = 28;

    // 6 main tentacles (8 segments each)
    const NUM_MAIN  = 6;
    const MAIN_SEGS = 8;
    for (let i = 0; i < NUM_MAIN; i++) {
      const a      = (i / NUM_MAIN) * TWO_PI;
      const tPhase = phase + i * (TWO_PI / NUM_MAIN);
      push();
      rotateY(a);
      translate(74, 5, 0);
      rotateX(0.82);
      for (let seg = 0; seg < MAIN_SEGS; seg++) {
        const t  = seg / (MAIN_SEGS - 1);
        const sw = sin(tPhase + seg * 0.5) * 0.22;
        const cr = lerp(tb0, tt0, t), cg = lerp(tb1, tt1, t), cb = lerp(tb2, tt2, t);
        this._setColor(cr, cg, cb);
        rotateZ(sw);
        rotateX(sin(tPhase * 0.6 + seg * 0.4) * 0.08 - 0.07);
        translate(0, 0, SEG_LEN);
        const w = lerp(21, 3, t);
        box(w, w * 0.7, SEG_LEN + 4);
      }
      pop();
    }

    // 2 long "reach" tentacles (10 segments each)
    const NUM_LONG  = 2;
    const LONG_SEGS = 10;
    const LONG_LEN  = 30;
    for (let i = 0; i < NUM_LONG; i++) {
      const a      = (i / NUM_LONG) * TWO_PI + PI / 6;
      const tPhase = phase + i * PI + 1.8;
      push();
      rotateY(a);
      translate(62, 4, 0);
      rotateX(1.08);
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

  // ---------------------------------------------------------------------------
  // Per-type draw methods (vertex pass — triangle-mesh primitives)
  // ---------------------------------------------------------------------------

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
   * thereafter, replacing 8 _drawTri() calls per enemy per frame with a single
   * model() draw call.
   */
  _drawBomber(e) {
    rotateY(frameCount * 0.05);
    noStroke();
    if (!EnemyRenderer._bomberGeom) {
      EnemyRenderer._bomberGeom = terrain._safeBuildGeometry(() => {
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
    if (EnemyRenderer._bomberGeom) model(EnemyRenderer._bomberGeom);
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
   * The mesh is baked once into a cached p5.Geometry on first draw.
   */
  _drawSeeder(e) {
    rotateY(frameCount * 0.15); noStroke();
    if (!EnemyRenderer._seederGeom) {
      EnemyRenderer._seederGeom = terrain._safeBuildGeometry(() => {
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
    if (EnemyRenderer._seederGeom) model(EnemyRenderer._seederGeom);
  }

  // ---------------------------------------------------------------------------
  // Main draw orchestration
  // ---------------------------------------------------------------------------

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
   * @param {object[]} enemies  The live enemy array.
   * @param {{x,y,z,yaw}} s    Ship state used as the view origin for culling.
   */
  draw(enemies, s) {
    if (enemies.length === 0) return;

    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    const cullSq = CULL_DIST * CULL_DIST;
    const sx = s.x, sz = s.z;

    // Single culling pass — build list of enemies visible this frame.
    const vis = this._visibleEnemies;
    vis.length = 0;
    const cam = terrain._cam;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
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
        sh = dims ? dims[1] : 80;
      }
      drawShadow(e.x, gy, e.z, sw, sh, casterH);
    }

    if (profiler) profiler.record('enemies', performance.now() - start);
  }
}

// Static geometry caches shared across all EnemyRenderer instances.
// Populated on first draw() call once the WebGL canvas exists.
// null = not yet built; p5.Geometry = cached mesh for that enemy type.
/** @type {p5.Geometry|null} */ EnemyRenderer._bomberGeom = null;
/** @type {p5.Geometry|null} */ EnemyRenderer._seederGeom = null;

// Singleton instance
const enemyRenderer = new EnemyRenderer();
