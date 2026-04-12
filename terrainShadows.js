// =============================================================================
// terrainShadows.js — Shared shadow projection logic
// Extracted from terrain.js
// =============================================================================

Object.assign(Terrain.prototype, {




  /**
   * Computes normalized sun projection data reused by all ground shadow draws.
   * @returns {{x:number,y:number,z:number}}
   */
  _getSunShadowBasis() {
    const frame = typeof frameCount === 'number' ? frameCount : 0;
    if (frame !== this._sunShadowFrame) {
      const clampedSunNY = Math.max(SUN_DIR_MIN_Y, SUN_DIR_NY);
      this._sunShadowBasis = {
        x: SUN_DIR_NX,
        y: clampedSunNY,
        z: SUN_DIR_NZ
      };
      this._sunShadowFrame = frame;
    }
    return this._sunShadowBasis;
  },


  _shadowOpacityFactor(casterH) {
    return shadowOpacityFactor(casterH);
  },


  _shadowShift(casterH, sun) {
    return shadowShift(casterH, sun);
  },


  /**
   * 2D convex hull in XZ plane for projected shadow polygons.
   */
  _shadowHullXZ(points) {
    if (points.length <= 2) return points.slice();
    // points is already {x, z} objects (the concat result is always a fresh temp array).
    // Sort in-place — the redundant .map(p => ({x, z})) only existed to copy objects
    // before sorting, but that copy is unnecessary since the input is already {x, z}.
    const pts = points.sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));

    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  },


  /**
   * Draws a cast shadow polygon from a base footprint and caster height.
   * Small shadows are drawn as simpler polygons; large shadows (like from
   * tall sentinel buildings) are recursively subdivided to conform to
   * terrain bumps and avoid "bright chunks" caused by clipping.
   */
  _drawProjectedFootprintShadow(wx, wz, groundY, casterH, footprint, alpha, sun, isFloating = false, isBaking = false) {
    const shift = this._shadowShift(casterH, sun);
    let rawHull;
    if (isFloating) {
      const top = footprint.map(p => ({ x: wx + p.x + sun.x * shift, z: wz + p.z + sun.z * shift }));
      rawHull = this._shadowHullXZ(top);
    } else {
      const base = footprint.map(p => ({ x: wx + p.x, z: wz + p.z }));
      const top = base.map(p => ({ x: p.x + sun.x * shift, z: p.z + sun.z * shift }));
      rawHull = this._shadowHullXZ(base.concat(top));
    }
    if (rawHull.length < 3) return;

    // 1. Subdivide the hull boundary into a flat array [x, z, x, z, ...] to avoid objects
    const hullFlat = [];
    const edgeRes = TILE * 0.75;
    const edgeResSq = edgeRes * edgeRes;
    for (let i = 0; i < rawHull.length; i++) {
      let p1 = rawHull[i], p2 = rawHull[(i + 1) % rawHull.length];
      hullFlat.push(p1.x, p1.z);
      let dx = p2.x - p1.x;
      let dz = p2.z - p1.z;
      let dSq = dx * dx + dz * dz;
      if (dSq > edgeResSq) {
        let steps = Math.ceil(Math.sqrt(dSq) / edgeRes);
        let stepScale = 1.0 / steps;
        for (let s = 1; s < steps; s++) {
          let f = s * stepScale;
          hullFlat.push(p1.x + dx * f, p1.z + dz * f);
        }
      }
    }

    // --- Triangle Fan from center with per-vertex conformal lift ---
    let cx = 0, cz = 0;
    const numPts = hullFlat.length / 2;
    for (let i = 0; i < hullFlat.length; i += 2) {
      cx += hullFlat[i];
      cz += hullFlat[i + 1];
    }
    cx /= numPts;
    cz /= numPts;

    // Threshold tuned for robust terrain coverage; depth 5 allows precise "draping"
    const threshold = TILE * TILE * 0.4; // Tighter threshold for better geometry tracking 
    const liftY = -3.5; // Aggressive lift to stay above terrain triangles quad-splits
    // When baking geometry for the cache, cap at depth 1.  At low sun angles (Sunset/Dusk/Dawn,
    // sun.y ≈ 0.12) the shadow polygon spans ~333 world units.  The recursive threshold allows
    // depth 2 to trigger, generating 11 520 tris/chunk and 34 560 getAltitude() calls (~10 ms).
    // Depth 1 limits each chunk to 2 880 tris and 8 640 calls (~2.5 ms) while still conforming
    // to terrain at ~0.7–1.4 tile granularity — imperceptible in practice for a multi-frame
    // cache.  Real-time individual-draw paths keep the full depth 4/5 for maximum fidelity.
    const maxDepth = isBaking ? 1 : (gameState.isMobile ? 4 : 5);

    // Hard cap on emitted triangles to prevent push.apply overflowing V8's
    // call-stack argument limit (~65 536).  p5's addGeometry uses
    //   push.apply(dest, _toConsumableArray(array))
    // which passes every element as a C-stack argument.  The largest array is
    // vertexColors at 4 values per vertex, so the safe ceiling is:
    //   MAX_SHADOW_TRIS * 3 vertices * 4 color-values < 65 536
    //   → MAX_SHADOW_TRIS < 5 461
    // Using 5 000 gives 15 000 vertices / 60 000 vertexColors — comfortably safe.
    // triCount is a closure variable intentionally shared across all recursive
    // emitTri calls — this is the standard single-threaded JS accumulator pattern.
    const MAX_SHADOW_TRIS = 5000;
    let triCount = 0;

    const lightsWereOn = (typeof SUN_KEY_R !== 'undefined');

    noStroke();
    const shadowAlpha = alpha * this._shadowOpacityFactor(casterH);
    // Bake the precise shadow color/alpha into the vertex colors
    fill(0, 0, 0, shadowAlpha);

    if (!isBaking) {
      if (lightsWereOn) noLights();
      this.applyShadowShader();
      _beginShadowStencil();
    }

    beginShape(TRIANGLES);
    normal(0, 1, 0); // Always set normals so the mesh is complete and valid for WebGL shaders

    // Zero-allocation inner subdivision loop
    const emitTri = (x1, z1, x2, z2, x3, z3, depth) => {
      if (triCount >= MAX_SHADOW_TRIS) {
        // Cap reached: shadow is partially drawn but safe. This only occurs for
        // extreme configurations (very tall building + very low sun angle) and
        // is far preferable to a RangeError crashing all geometry caching.
        return;
      }
      let dx12 = x1 - x2, dz12 = z1 - z2;
      let dx23 = x2 - x3, dz23 = z2 - z3;
      let dx31 = x3 - x1, dz31 = z3 - z1;

      let d1 = dx12 * dx12 + dz12 * dz12;
      let d2 = dx23 * dx23 + dz23 * dz23;
      let d3 = dx31 * dx31 + dz31 * dz31;

      if (depth < maxDepth && (d1 > threshold || d2 > threshold || d3 > threshold)) {
        let m12x = (x1 + x2) * 0.5, m12z = (z1 + z2) * 0.5;
        let m23x = (x2 + x3) * 0.5, m23z = (z2 + z3) * 0.5;
        let m31x = (x3 + x1) * 0.5, m31z = (z3 + z1) * 0.5;
        emitTri(x1, z1, m12x, m12z, m31x, m31z, depth + 1);
        emitTri(x2, z2, m23x, m23z, m12x, m12z, depth + 1);
        emitTri(x3, z3, m31x, m31z, m23x, m23z, depth + 1);
        emitTri(m12x, m12z, m23x, m23z, m31x, m31z, depth + 1);
      } else {
        triCount++;
        vertex(x1, this.getAltitude(x1, z1) + liftY, z1);
        vertex(x2, this.getAltitude(x2, z2) + liftY, z2);
        vertex(x3, this.getAltitude(x3, z3) + liftY, z3);
      }
    };

    for (let i = 0; i < numPts; i++) {
      let idx1 = i * 2;
      let idx2 = ((i + 1) % numPts) * 2;
      emitTri(cx, cz, hullFlat[idx1], hullFlat[idx1 + 1], hullFlat[idx2], hullFlat[idx2 + 1], 0);
    }

    endShape();
    if (!isBaking) {
      _endShadowStencil();
      resetShader();
      if (lightsWereOn && typeof setSceneLighting === 'function') setSceneLighting();
    }
  },


  /**
   * Draws one projected ellipse footprint for a caster at height casterH.
   */
  _drawProjectedEllipseShadow(wx, wz, groundY, casterH, rx, rz, alpha, sun, isFloating = false) {
    const pts = [];
    const steps = 16; // Higher step count: smoother ellipse silhouette at close range
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TWO_PI;
      pts.push({ x: Math.cos(a) * rx * 0.5, z: Math.sin(a) * rz * 0.5 });
    }
    this._drawProjectedFootprintShadow(wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  },


  /**
   * Draws one projected rectangular footprint for a caster at height casterH.
   */
  _drawProjectedRectShadow(wx, wz, groundY, casterH, w, d, alpha, sun, isFloating = false) {
    const hw = w * 0.5, hd = d * 0.5;
    const pts = [
      { x: -hw, z: -hd },
      { x: hw, z: -hd },
      { x: hw, z: hd },
      { x: -hw, z: hd }
    ];
    this._drawProjectedFootprintShadow(wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  }

});
