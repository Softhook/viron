// =============================================================================
// buildingGeometry.js — Per-building-type geometry and shadow footprint helpers
//
// Extracted from terrain.js so each building variant lives in one focused file.
// Functions here are called from Terrain._getBuildingGeom(),
// Terrain._getPowerupGeom(), and Terrain._ensureBuildingShadowBaked().
//
// All drawing functions are designed to be called inside a _safeBuildGeometry()
// callback so they have access to p5's global drawing functions (fill, push,
// pop, translate, box, cylinder, cone, sphere, rotateX, rotateY, torus).
//
// Building type catalogue:
//   0 — Pyramid-Roofed House
//   1 — Cylindrical Observatory
//   2 — Pagoda
//   3 — Floating UFO / Powerup  (see buildPowerupGeometry)
//   4 — Wizard Tower
//   5 — Chinese Hut (two variants selected by world position)
// =============================================================================

// ---------------------------------------------------------------------------
// Shared colour helper
// ---------------------------------------------------------------------------

/**
 * Reserved R channel values that trigger specific GLSL material branches in
 * the terrain fragment shader (mat = int(vColor.r * 255 + 0.5)):
 *   1-2   → computeLandscapeColor
 *   10-11 → computeVironColor
 *   14-15 → computeYellowVironColor
 *   20-21 → computeBarrierColor
 *   30    → computeSeaColor
 *   60    → computeWoodColor (normal)
 *   61    → computeWoodColor (infected)
 *   250   → launchpad blue
 * Building fill() calls must never use these values as a literal red colour
 * channel. The only exception is when intentionally selecting a terrain-shader
 * material ID (e.g. fill(60,0,0) to select computeWoodColor in the GLSL).
 */
const _BLDG_RESERVED_R = new Set([1, 2, 10, 11, 14, 15, 20, 21, 30, 60, 61, 250]);

/**
 * Returns r incremented past any reserved terrain-shader palette index so
 * that fill() R values for buildings never accidentally trigger the wrong
 * GLSL material branch inside the terrain fragment shader.
 * Loops until it finds a value not in _BLDG_RESERVED_R to handle consecutive
 * reserved pairs (e.g. 1→2→3, 10→11→12, 14→15→16, 20→21→22).
 * @param {number} r  Red channel value (0–255 integer).
 * @returns {number}
 */
function _bldgSafeR(r) {
  while (_BLDG_RESERVED_R.has(r)) r++;
  return r;
}

// ---------------------------------------------------------------------------
// Per-type geometry builders
// Each function emits p5 drawing calls that will be captured by buildGeometry().
// ---------------------------------------------------------------------------

/**
 * Draws a Pyramid-Roofed House (building type 0).
 * @param {{w:number, h:number, d:number}} b   Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildType0Geometry(b, inf) {
  fill(inf ? 41 : 40, inf ? 50 : 220, inf ? 50 : 220);
  push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();
  fill(_bldgSafeR(inf ? 150 : 220), inf ? 30 : 50, inf ? 30 : 50);
  let rh = b.w / 1.5;
  push(); translate(0, -b.h - rh / 2, 0); rotateX(PI); rotateY(PI / 4); cone(b.w * 0.8, rh, 4, 1); pop();
}

/**
 * Draws a Cylindrical Observatory (building type 1).
 * @param {{w:number, h:number, d:number}} b   Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildType1Geometry(b, inf) {
  fill(inf ? 43 : 42, inf ? 50 : 160, inf ? 50 : 170);
  push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();
  fill(_bldgSafeR(inf ? 150 : 80), inf ? 30 : 180, inf ? 30 : 220);
  push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();
}

/**
 * Draws a Pagoda (building type 2) — three stacked tiers with swept roofs.
 * @param {{w:number, h:number, d:number}} b   Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildType2Geometry(b, inf) {
  let roofR = _bldgSafeR(inf ? 220 : 160), roofG = inf ? 20 : 40,  roofB = inf ? 20 : 35;  // Red
  let wallR = _bldgSafeR(inf ? 200 : 200), wallG = inf ? 30 : 180, wallB = inf ? 30 : 140; // Cream / infected red
  let beamR = _bldgSafeR(inf ? 180 : 80),  beamG = inf ? 20 : 50,  beamB = inf ? 20 : 40;  // Wood / infected red

  let bw = b.w, bh = b.h, bd = b.d;
  fill(beamR, beamG, beamB);
  push(); translate(0, -bh * 0.05, 0); box(bw * 1.2, bh * 0.1, bd * 1.2); pop();

  for (let i = 0; i < 3; i++) {
    let ty = -bh * (0.1 + i * 0.3);
    let tw = bw * (1.0 - i * 0.2);
    let td = bd * (1.0 - i * 0.2);
    let th = bh * 0.25;
    let rh = th * 0.6;

    fill(wallR, wallG, wallB);
    push(); translate(0, ty - th / 2, 0); box(tw * 0.8, th, td * 0.8); pop();

    // Roof: rotateX(PI) flips it so point is UP in Y-up system
    fill(roofR, roofG, roofB);
    push();
    translate(0, ty - th - rh / 2, 0);
    rotateX(PI);
    rotateY(PI / 4);
    cone(tw * 1.4, rh, 4, 1);
    pop();
  }
  fill(beamR, beamG, beamB);
  push(); translate(0, -bh * 1.0, 0); cylinder(bw * 0.05, bh * 0.2, 6, 1); pop();
  fill(roofR, roofG, roofB);
  push(); translate(0, -bh * 1.15, 0); sphere(bw * 0.1, 6, 4); pop();
}

/**
 * Draws a Wizard Tower (building type 4) — a stone cylindrical tower with a
 * pointed turret cap, glowing magic crystal, and decorative battlements.
 * A rotating torus crown is drawn separately in drawBuildings() each frame.
 * @param {{w:number, h:number, d:number}} b   Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildType4Geometry(b, inf) {
  // Stone walls: medium grey (healthy) or sickly olive-red (infected).
  let stoneR  = _bldgSafeR(inf ? 130 : 95),  stoneG  = inf ? 38 : 90,  stoneB  = inf ? 38 : 95;
  // Darker mortar courses.
  let mortarR = _bldgSafeR(inf ? 100 : 65),  mortarG = inf ? 25 : 65,  mortarB = inf ? 25 : 70;
  // Magical accent / window glow: purple-blue (healthy) or toxic orange (infected).
  let accentR = _bldgSafeR(inf ? 220 : 60),  accentG = inf ? 60 : 100, accentB = inf ? 22 : 220;
  // Crystal orb atop the spire: cyan-white (healthy) or deep red (infected).
  let crystalR = _bldgSafeR(inf ? 255 : 100), crystalG = inf ? 80 : 220, crystalB = inf ? 30 : 255;
  // Pointed spire cone: dark indigo (healthy) or charred black-red (infected).
  let spireR  = _bldgSafeR(inf ? 180 : 50),  spireG  = inf ? 40 : 30,  spireB  = inf ? 22 : 110;

  let bw = b.w, bh = b.h;
  let rh = bh * 0.28; // Height of the pointed spire cone.

  // Base plinth — wide flat cylinder.
  fill(mortarR, mortarG, mortarB);
  push(); translate(0, -bh * 0.04, 0); cylinder(bw * 1.15, bh * 0.08, 6, 1); pop();

  // Lower tower body — broad stone cylinder.
  fill(stoneR, stoneG, stoneB);
  push(); translate(0, -bh * 0.24, 0); cylinder(bw * 0.78, bh * 0.32, 8, 1); pop();

  // First mortar course band.
  fill(mortarR, mortarG, mortarB);
  push(); translate(0, -bh * 0.38, 0); cylinder(bw * 0.81, bh * 0.016, 8, 1); pop();

  // Mid tower body — slightly narrower.
  fill(stoneR, stoneG, stoneB);
  push(); translate(0, -bh * 0.54, 0); cylinder(bw * 0.58, bh * 0.28, 8, 1); pop();

  // Second mortar course band.
  fill(mortarR, mortarG, mortarB);
  push(); translate(0, -bh * 0.67, 0); cylinder(bw * 0.61, bh * 0.016, 8, 1); pop();

  // Magic crystal orb (central glow — the tower's power source).
  fill(crystalR, crystalG, crystalB);
  push(); translate(0, -bh * 0.42, 0); sphere(bw * 0.28, 8, 6); pop();

  // Accent ring around crystal window.
  fill(accentR, accentG, accentB);
  push(); translate(0, -bh * 0.42, 0); cylinder(bw * 0.35, bh * 0.012, 8, 1); pop();

  // Upper tower body — narrow neck.
  fill(stoneR, stoneG, stoneB);
  push(); translate(0, -bh * 0.78, 0); cylinder(bw * 0.34, bh * 0.20, 8, 1); pop();

  // Battlement ledge just below the spire.
  fill(mortarR, mortarG, mortarB);
  push(); translate(0, -bh * 0.86, 0); cylinder(bw * 0.38, bh * 0.016, 8, 1); pop();

  // Pointed turret spire.
  fill(spireR, spireG, spireB);
  push(); translate(0, -bh * 0.95 - rh / 2, 0); rotateX(PI); cone(bw * 0.22, rh, 6, 1); pop();

  // Small crystal sphere at the very tip.
  fill(crystalR, crystalG, crystalB);
  push(); translate(0, -bh * 0.95 - rh - bw * 0.08, 0); sphere(bw * 0.09, 6, 4); pop();
}

/**
 * Draws a Chinese Hut (building type 5).
 * Randomly selects Variant A (square hut) or Variant B (long hut) based on
 * world position so different huts at the same scale look distinct.
 * @param {{w:number, h:number, d:number, x:number, z:number}} b  Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildType5Geometry(b, inf) {
  let roofR = _bldgSafeR(inf ? 210 : 75), roofG = inf ? 20 : 58, roofB = inf ? 20 : 32;  // Dark thatch / infected red
  // Walls: wood-grain shader when healthy; direct red fill when infected (to show fully red).
  let wallR = inf ? _bldgSafeR(200) : 60, wallG = inf ? 25 : 0, wallB = inf ? 25 : 0;

  let bw = b.w, bh = b.h, bd = b.d;
  let seed = Math.abs(Math.sin(b.x * 0.0123 + b.z * 0.0456));

  if (seed < 0.5) {
    // Variant A: Square Hut
    let rh = bh * 0.7;
    fill(wallR, wallG, wallB);
    push(); translate(0, -bh * 0.4, 0); box(bw, bh * 0.8, bd); pop();
    fill(roofR, roofG, roofB);
    push(); translate(0, -bh * 0.8 - rh / 2, 0); rotateX(PI); rotateY(PI / 4); cone(bw * 1.5, rh, 4, 1); pop();
  } else {
    // Variant B: Long Hut
    let rh = bh * 0.6;
    fill(wallR, wallG, wallB);
    push(); translate(0, -bh * 0.3, 0); box(bw * 1.6, bh * 0.6, bd * 1.1); pop();
    fill(roofR, roofG, roofB);
    push(); translate(0, -bh * 0.6 - rh / 2, 0); rotateX(PI); rotateY(PI / 2); cone(bw * 2.1, rh, 4, 1); pop();
  }
}

/**
 * Draws the Floating UFO / Powerup geometry (building type 3).
 * A double-cone diamond shape; colour changes with infection state.
 * @param {{w:number, h:number}} b   Building descriptor.
 * @param {boolean} inf  Whether the tile is currently infected.
 */
function buildPowerupGeometry(b, inf) {
  fill(inf ? 251 : 250, inf ? 50 : 180, inf ? 50 : 240);
  push();
  cone(b.w, b.h / 2, 4, 1);
  pop();
  push();
  rotateX(PI);
  cone(b.w, b.h / 2, 4, 1);
  pop();
}

// ---------------------------------------------------------------------------
// Shadow footprint helper
// ---------------------------------------------------------------------------

/**
 * Returns the shadow footprint (XZ polygon) and the effective caster height
 * for a static building (types 0, 1, 2, 4, 5).  Type 3 (animated UFO) uses
 * an ellipse shadow computed in real-time and does not use this function.
 *
 * The returned footprint is an array of {x, z} objects in building-local
 * coordinates (centred at origin).  It is stored on the building descriptor
 * after the first call so this function is only invoked once per building.
 *
 * Type 5 huts have two variants (A: square hut, B: long hut) selected by
 * world-position seed — the same seed used in buildType5Geometry so the
 * footprint always matches the rendered geometry.
 *
 * @param {{type:number, w:number, h:number, d:number, x:number, z:number}} b
 * @returns {{footprint: Array<{x:number, z:number}>, casterH: number}}
 */
function getBuildingFootprint(b) {
  const bw = b.w, bh = b.h, bd = b.d;
  let footprint, casterH;

  if (b.type === 0) {
    const hw = bw * 0.5, hd = bd * 0.5;
    footprint = [
      { x: -hw, z: -hd }, { x: hw, z: -hd },
      { x:  hw, z:  hd }, { x: -hw, z:  hd }
    ];
    casterH = bh + bw * 0.35;
  } else if (b.type === 1) {
    footprint = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TWO_PI;
      footprint.push({ x: Math.cos(a) * bw * 0.5, z: Math.sin(a) * bw * 0.425 });
    }
    casterH = bh + bw * 0.5;
  } else if (b.type === 2) {
    const hw = bw * 0.75, hd = bd * 0.75;
    footprint = [
      { x: -hw, z: -hd }, { x: hw, z: -hd },
      { x:  hw, z:  hd }, { x: -hw, z:  hd }
    ];
    casterH = bh;
  } else if (b.type === 5) {
    // Variant selected by world-position seed, matching buildType5Geometry.
    const seed = Math.abs(Math.sin(b.x * 0.0123 + b.z * 0.0456));
    if (seed < 0.5) {
      // Variant A: Square Hut — base wall bw × bd, total height bh * 1.5.
      const hw = bw * 0.5, hd = bd * 0.5;
      footprint = [
        { x: -hw, z: -hd }, { x: hw, z: -hd },
        { x:  hw, z:  hd }, { x: -hw, z:  hd }
      ];
      casterH = bh * 1.5;
    } else {
      // Variant B: Long Hut — base wall bw*1.6 × bd*1.1, total height bh * 1.2.
      const hw = bw * 0.8, hd = bd * 0.55;
      footprint = [
        { x: -hw, z: -hd }, { x: hw, z: -hd },
        { x:  hw, z:  hd }, { x: -hw, z:  hd }
      ];
      casterH = bh * 1.2;
    }
  } else {
    // Type 4 — Sentinel Tower (also default for any future unhandled types).
    footprint = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TWO_PI;
      footprint.push({ x: Math.cos(a) * bw * 1.1, z: Math.sin(a) * bw * 0.92 });
    }
    casterH = bh;
  }

  return { footprint, casterH };
}
