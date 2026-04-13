// =============================================================================
// terrainShadows.js — Shared shadow projection logic
// Now as a stateless service to improve LLM-readability.
// =============================================================================


import { p } from './p5Context.js';
import {
  SUN_DIR_MIN_Y, SUN_DIR_NX, SUN_DIR_NY, SUN_DIR_NZ,
  shadowOpacityFactor, shadowShift, TILE,
  AMBIENT_R, AMBIENT_G, AMBIENT_B,
  SUN_KEY_R, SUN_KEY_G, SUN_KEY_B
} from './constants.js';
import { _beginShadowStencil, _endShadowStencil } from './terrain.js';
import { gameState } from './gameState.js';

function _restoreSceneLighting() {
  p.noLights();
  p.specularColor(0, 0, 0);
  p.specularMaterial(0);
  p.shininess(0);
  p.ambientLight(AMBIENT_R, AMBIENT_G, AMBIENT_B);
  p.directionalLight(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, SUN_DIR_NX, SUN_DIR_NY, SUN_DIR_NZ);
}

export const TerrainShadows = {

  /**
   * Computes normalized sun projection data reused by all ground shadow draws.
   */
  getSunShadowBasis(ctx) {
    const frame = typeof p.frameCount === 'number' ? p.frameCount : 0;
    if (frame !== ctx._sunShadowFrame) {
      const clampedSunNY = Math.max(SUN_DIR_MIN_Y, SUN_DIR_NY);
      ctx._sunShadowBasis = {
        x: SUN_DIR_NX,
        y: clampedSunNY,
        z: SUN_DIR_NZ
      };
      ctx._sunShadowFrame = frame;
    }
    return ctx._sunShadowBasis;
  },

  shadowOpacityFactor(casterH) {
    return shadowOpacityFactor(casterH);
  },

  shadowShift(casterH, sun) {
    return shadowShift(casterH, sun);
  },

  /**
   * 2D convex hull in XZ plane for projected shadow polygons.
   */
  _shadowHullXZ(points) {
    if (points.length <= 2) return points.slice();
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
   */
  drawProjectedFootprintShadow(ctx, wx, wz, groundY, casterH, footprint, alpha, sun, isFloating = false, isBaking = false) {
    if (typeof window !== 'undefined' && window.BENCHMARK && typeof window.BENCHMARK === 'object' && window.BENCHMARK.disableShadows) return;
    const shift = this.shadowShift(casterH, sun);
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

    let cx = 0, cz = 0;
    const numPts = hullFlat.length / 2;
    for (let i = 0; i < hullFlat.length; i += 2) {
      cx += hullFlat[i];
      cz += hullFlat[i + 1];
    }
    cx /= numPts;
    cz /= numPts;

    const threshold = TILE * TILE * 0.4;
    const liftY = -3.5;
    const maxDepth = isBaking ? 1 : (gameState.isMobile ? 4 : 5);
    const MAX_SHADOW_TRIS = 5000;
    let triCount = 0;

    p.noStroke();
    const shadowAlpha = alpha * this.shadowOpacityFactor(casterH);
    p.fill(0, 0, 0, shadowAlpha);

    if (!isBaking) {
      p.noLights();
      ctx.applyShadowShader();
      _beginShadowStencil();
    }

    p.beginShape(p.TRIANGLES);
    p.normal(0, 1, 0);

    const emitTri = (x1, z1, x2, z2, x3, z3, depth) => {
      if (triCount >= MAX_SHADOW_TRIS) return;
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
        p.vertex(x1, ctx.getAltitude(x1, z1) + liftY, z1);
        p.vertex(x2, ctx.getAltitude(x2, z2) + liftY, z2);
        p.vertex(x3, ctx.getAltitude(x3, z3) + liftY, z3);
      }
    };

    for (let i = 0; i < numPts; i++) {
      let idx1 = i * 2;
      let idx2 = ((i + 1) % numPts) * 2;
      emitTri(cx, cz, hullFlat[idx1], hullFlat[idx1 + 1], hullFlat[idx2], hullFlat[idx2 + 1], 0);
    }

    p.endShape();
    if (!isBaking) {
      _endShadowStencil();
      p.resetShader();
      _restoreSceneLighting();
    }
  },

  drawProjectedEllipseShadow(ctx, wx, wz, groundY, casterH, rx, rz, alpha, sun, isFloating = false) {
    const pts = [];
    const steps = 16;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * (2 * Math.PI);
      pts.push({ x: Math.cos(a) * rx * 0.5, z: Math.sin(a) * rz * 0.5 });
    }
    this.drawProjectedFootprintShadow(ctx, wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  },

  drawProjectedRectShadow(ctx, wx, wz, groundY, casterH, w, d, alpha, sun, isFloating = false) {
    const hw = w * 0.5, hd = d * 0.5;
    const pts = [{ x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd }];
    this.drawProjectedFootprintShadow(ctx, wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  }
};
