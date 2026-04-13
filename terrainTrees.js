// =============================================================================
// terrainTrees.js — Procedural tree generation and rendering
// Now as a stateless service to improve LLM-readability.
// =============================================================================


import { p } from './p5Context.js';
import {
  TILE, CHUNK_SIZE, TREE_VARIANTS, infection, tileKey, toTile,
  aboveSea, isLaunchpad, getVironProfiler,
  TREE_DEFAULT_TRUNK_HEIGHT, TREE_SHADOW_BASE_ALPHA, VIEW_FAR
} from './constants.js';
import { TerrainShadows } from './terrainShadows.js';
import { gameState } from './gameState.js';
import { setSceneLighting } from './gameRenderer.js';
import { _beginShadowStencil, _endShadowStencil, BAKE_BUDGET_MS, TREE_BATCH_SIZE } from './terrain.js';

export const TerrainTrees = {

  /** Deterministic 0..1 hash from integer tile coordinates. */
  _treeHash01(tx, tz, salt = 0) {
    return Math.abs(Math.sin((tx + salt * 17.0) * 12.9898 + (tz - salt * 13.0) * 78.233) * 43758.5453) % 1;
  },

  /** Returns spawn density [0..1] for a procedural tree sample point. */
  _getProceduralTreeDensity(tx, tz) {
    if ((tx & 1) !== 0 || (tz & 1) !== 0) return 0;

    const forest = p.noise(tx * 0.014 + 180.0, tz * 0.014 - 260.0);
    if (forest < 0.36) return 0;

    const grove = p.noise(tx * 0.052 - 90.0, tz * 0.052 + 140.0);
    const patch = p.noise(tx * 0.120 + 22.0, tz * 0.120 - 38.0);

    let density = p.map(forest, 0.36, 1.0, 0.10, 0.52, true);

    if (grove < 0.28) density *= 0.08;
    else if (grove > 0.62) density *= 1.85;

    if (patch < 0.30) density *= 0.55;
    else if (patch > 0.70) density *= 1.30;

    return p.constrain(density, 0.0, 0.78);
  },

  /**
   * Returns true when a procedural tree should exist at this tile sample point.
   */
  hasProceduralTree(tx, tz) {
    const density = this._getProceduralTreeDensity(tx, tz);
    if (density <= 0) return false;
    const r = this._treeHash01(tx, tz, 1.0);
    return r < density;
  },

  /** Builds deterministic tree instance data for a tile sample point. */
  getProceduralTree(tx, tz) {
    const jx = (this._treeHash01(tx, tz, 2.0) - 0.5) * TILE * 0.70;
    const jz = (this._treeHash01(tx, tz, 3.0) - 0.5) * TILE * 0.70;
    return {
      x: tx * TILE + TILE * 0.5 + jx,
      z: tz * TILE + TILE * 0.5 + jz,
      variant: Math.floor(this._treeHash01(tx, tz, 4.0) * 3),
      trunkH: 26 + this._treeHash01(tx, tz, 5.0) * 24,
      canopyScale: 1.0 + this._treeHash01(tx, tz, 6.0) * 0.8
    };
  },

  /** Returns deterministic procedural tree instance for tile sample, or null. */
  tryGetProceduralTree(ctx, tx, tz) {
    const density = this._getProceduralTreeDensity(tx, tz);
    if (density <= 0) return null;
    const r = this._treeHash01(tx, tz, 1.0);
    if (r >= density) return null;
    const t = this.getProceduralTree(tx, tz);
    t.tx = tx;
    t.tz = tz;
    t._score = density + this._treeHash01(tx, tz, 8.0) * 0.15;
    return t;
  },

  /**
   * Lazily builds deterministic procedural trees for a chunk.
   */
  getProceduralTreesForChunk(ctx, cx, cz) {
    const key = `${cx},${cz}`;
    const cached = ctx._procTreeChunkCache.get(key);
    if (cached) return cached;

    const out = [];
    const tx0 = cx * CHUNK_SIZE;
    const tz0 = cz * CHUNK_SIZE;

    for (let tz = tz0; tz < tz0 + CHUNK_SIZE; tz += 2) {
      for (let tx = tx0; tx < tx0 + CHUNK_SIZE; tx += 2) {
        const t = this.tryGetProceduralTree(ctx, tx, tz);
        if (t) out.push(t);
      }
    }

    const maxTreesPerChunk = gameState.isMobile ? 9 : 13;
    if (out.length > maxTreesPerChunk) {
      out.sort((a, b) => b._score - a._score);
      out.length = maxTreesPerChunk;
    }

    for (let i = 0; i < out.length; i++) {
        const t = out[i];
        t.k = tileKey(t.tx, t.tz);
        t.y = ctx.getAltitude(t.x, t.z);
    }

    ctx._procTreeChunkCache.set(key, out);
    return out;
  },

  drawTrees(ctx, s) {
    const currentFrame = (typeof p.frameCount === 'number') ? p.frameCount : 0;
    if (ctx._treeBakeFrame !== currentFrame) {
      ctx._treeBakeFrame = currentFrame;
      ctx._treeChunksBakedThisFrame.clear();
      ctx._treeBakeBudgetUsedMs = 0;
    }
    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    let { gx, gz, cam } = ctx.resolveViewSource(s, false);
    cam = ctx._cam || cam;
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    p.noStroke();
    ctx.applyShader();

    const chunkHalf = CHUNK_SIZE * TILE;
    const sun = ctx._getSunShadowBasis();
    const visibleChunks = [];

    if (sun.x !== ctx._bakedShadowSun.x || sun.y !== ctx._bakedShadowSun.y || sun.z !== ctx._bakedShadowSun.z) {
      ctx._bakedShadowSun = { x: sun.x, y: sun.y, z: sun.z };
    }

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!ctx._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        
        visibleChunks.push({ cx, cz });
        const treeState = this._advanceChunkTreeBatch(ctx, cx, cz);
        if (treeState) {
          for (const geom of treeState.batches) p.model(geom);
          for (let i = treeState.nextIdx; i < treeState.trees.length; i++) {
            const t = treeState.trees[i];
            p.push(); p.translate(t.x, t.y, t.z);
            this._drawTreeImmediate(ctx, t, infection.has(t.k));
            p.pop();
          }
        }
      }
    }

    p.resetShader();

    p.noLights(); p.noStroke();
    ctx.applyShadowShader();
    _beginShadowStencil();
    for (const c of visibleChunks) {
      const shadowMesh = this._getChunkTreeShadow(ctx, c.cx, c.cz, sun);
      if (shadowMesh) {
        p.model(shadowMesh);
      } else if (!ctx._treeShadowChunkCache.has(`${c.cx},${c.cz}`)) {
        if (gameState.mode === 'menu') continue;
        if (ctx._treeChunksBakedThisFrame.has(`${c.cx},${c.cz}`) || ctx._treeBakeBudgetUsedMs >= BAKE_BUDGET_MS) continue;
        
        const trees = this.getProceduralTreesForChunk(ctx, c.cx, c.cz);
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          this._ensureTreeShadowHull(t);
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          ctx._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      }
    }
    _endShadowStencil();
    p.resetShader();
    setSceneLighting();

    if (profiler) profiler.record('trees', performance.now() - start);
  },

  _ensureTreeShadowHull(t) {
    if (t._shadowHull) return;
    const { trunkH: h, canopyScale: sc, variant: vi } = t;
    const hrx = (vi === 2) ? 20 * sc : 17 * sc;
    const hrz = (vi === 2) ? 14 * sc : 12 * sc;
    const trunkHalf = 2.5;
    const footprint = [];
    footprint.push(
      { x: -trunkHalf, z: -trunkHalf }, { x: trunkHalf, z: -trunkHalf },
      { x: trunkHalf, z: trunkHalf }, { x: -trunkHalf, z: trunkHalf }
    );
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * (2 * Math.PI);
      footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
    }
    t._footprint = footprint;
    t._shadowCasterH = h + (vi === 2 ? 24 : 18) * sc;
    t._shadowHull = true;
  },

  _drawTreeImmediate(ctx, t, inf) {
    const { trunkH: h, canopyScale: sc, variant: vi } = t;
    let tv = TREE_VARIANTS[vi];
    const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;

    p.fill(safeR(inf ? 80 : 100), inf ? 40 : 65, inf ? 20 : 25);
    p.push(); p.translate(0, -h / 2, 0); p.box(5, h, 5); p.pop();

    let c1 = inf ? tv.infected : tv.healthy;
    p.fill(safeR(c1[0]), c1[1], c1[2]);

    if (vi === 2) {
      p.push(); p.translate(0, -h, 0); p.cone(35 * sc, 15 * sc, 6, 1); p.pop();
    } else {
      let cn = tv.cones[0];
      p.push(); p.translate(0, -h - cn[2] * sc, 0); p.cone(cn[0] * sc, cn[1] * sc, 4, 1); p.pop();
      if (tv.cones2) {
        let c2 = inf ? tv.infected2 : tv.healthy2;
        p.fill(safeR(c2[0]), c2[1], c2[2]);
        let cn2 = tv.cones2[0];
        p.push(); p.translate(0, -h - cn2[2] * sc, 0); p.cone(cn2[0] * sc, cn2[1] * sc, 4, 1); p.pop();
      }
    }
  },

  _advanceChunkTreeBatch(ctx, cx, cz) {
    const key = `${cx},${cz}`;
    const existing = ctx._treeBakeState.get(key);
    if (existing === null) return null;

    let state = existing;
    if (state === undefined) {
      const allTrees = this.getProceduralTreesForChunk(ctx, cx, cz);
      const trees = allTrees.filter(t => !aboveSea(t.y) && !isLaunchpad(t.x, t.z));
      if (trees.length === 0) {
        ctx._treeBakeState.set(key, null);
        return null;
      }
      state = { batches: [], nextIdx: 0, trees };
    }

    if (state.nextIdx >= state.trees.length) {
      if (existing === undefined) ctx._treeBakeState.set(key, state);
      return state;
    }

    if (ctx._treeChunksBakedThisFrame.has(key) || ctx._treeBakeBudgetUsedMs >= BAKE_BUDGET_MS || ctx._isBuildingShadow) {
      if (existing === undefined) ctx._treeBakeState.set(key, state);
      return state;
    }

    const end = Math.min(state.nextIdx + TREE_BATCH_SIZE, state.trees.length);
    ctx._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = ctx._safeBuildGeometry(() => {
        for (let i = state.nextIdx; i < end; i++) {
          const t = state.trees[i];
          p.push(); p.translate(t.x, t.y, t.z);
          this._drawTreeImmediate(ctx, t, infection.has(t.k));
          p.pop();
        }
      });
    } catch (err) {
      console.error('[Viron] Tree batch bake failed:', err);
    } finally {
      ctx._isBuildingShadow = false;
    }
    ctx._treeBakeBudgetUsedMs += performance.now() - t0;
    ctx._treeChunksBakedThisFrame.add(key);

    if (geom) state.batches.push(geom);
    state.nextIdx = end;
    ctx._treeBakeState.set(key, state);
    return state;
  },

  _getChunkTreeShadow(ctx, cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = ctx._treeShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (ctx._treeChunksBakedThisFrame.has(key) || ctx._treeBakeBudgetUsedMs >= BAKE_BUDGET_MS || ctx._isBuildingShadow) {
      if (cached && cached.geom) return cached.geom;
      return null;
    }

    const trees = this.getProceduralTreesForChunk(ctx, cx, cz);
    let hasRenderable = false;
    for (const t of trees) {
        if (!aboveSea(t.y) && !isLaunchpad(t.x, t.z)) {
            hasRenderable = true;
            break;
        }
    }
    if (!hasRenderable) {
      ctx._treeShadowChunkCache.set(key, { geom: null, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
      return null;
    }

    if (ctx._isBuildingShadow) return null;
    ctx._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = ctx._safeBuildGeometry(() => {
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          this._ensureTreeShadowHull(t);
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          ctx._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      });
    } catch (err) {
      console.error("[Viron] Chunk tree shadow geometry build failed:", err);
    } finally {
      ctx._isBuildingShadow = false;
    }
    ctx._treeBakeBudgetUsedMs += performance.now() - t0;
    ctx._treeChunksBakedThisFrame.add(key);

    ctx._treeShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  }
};
