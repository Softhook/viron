// =============================================================================
// terrainTrees.js — Procedural tree generation and rendering
// Extracted from terrain.js
// =============================================================================

Object.assign(Terrain.prototype, {


  /** Deterministic 0..1 hash from integer tile coordinates. */
  _treeHash01(tx, tz, salt = 0) {
    return Math.abs(Math.sin((tx + salt * 17.0) * 12.9898 + (tz - salt * 13.0) * 78.233) * 43758.5453) % 1;
  },


  /** Returns spawn density [0..1] for a procedural tree sample point. */
  _getProceduralTreeDensity(tx, tz) {
    // Coarse spacing keeps total draw count low while still covering the world.
    if ((tx & 1) !== 0 || (tz & 1) !== 0) return 0;

    // Forest mask creates broad biomes; grove noise forms dense clustered woods.
    const forest = noise(tx * 0.014 + 180.0, tz * 0.014 - 260.0);
    if (forest < 0.36) return 0;

    const grove = noise(tx * 0.052 - 90.0, tz * 0.052 + 140.0);
    const patch = noise(tx * 0.120 + 22.0, tz * 0.120 - 38.0);

    const r = this._treeHash01(tx, tz, 1.0);
    let density = map(forest, 0.36, 1.0, 0.10, 0.52, true);

    // Strong dense-core clustering with clear glades between forests.
    if (grove < 0.28) density *= 0.08;
    else if (grove > 0.62) density *= 1.85;

    // Fine patch variation so forests feel organic, not uniform carpets.
    if (patch < 0.30) density *= 0.55;
    else if (patch > 0.70) density *= 1.30;

    return constrain(density, 0.0, 0.78);
  },


  /**
   * Returns true when a procedural tree should exist at this tile sample point.
   * Uses low-frequency noise as a "forest mask" and hash noise for local variation.
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
      variant: floor(this._treeHash01(tx, tz, 4.0) * 3),
      trunkH: 26 + this._treeHash01(tx, tz, 5.0) * 24,
      canopyScale: 1.0 + this._treeHash01(tx, tz, 6.0) * 0.8
    };
  },


  /** Returns deterministic procedural tree instance for tile sample, or null. */
  tryGetProceduralTree(tx, tz) {
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
   * Lazily builds deterministic procedural trees for a chunk and caps per-chunk
   * tree count to keep draw cost bounded while preserving clustered structure.
   */
  getProceduralTreesForChunk(cx, cz) {
    const key = `${cx},${cz}`;
    const cached = this._procTreeChunkCache.get(key);
    if (cached) return cached;

    const out = [];
    const tx0 = cx * CHUNK_SIZE;
    const tz0 = cz * CHUNK_SIZE;

    for (let tz = tz0; tz < tz0 + CHUNK_SIZE; tz += 2) {
      for (let tx = tx0; tx < tx0 + CHUNK_SIZE; tx += 2) {
        const t = this.tryGetProceduralTree(tx, tz);
        if (t) out.push(t);
      }
    }

    const maxTreesPerChunk = (typeof gameState !== 'undefined' && gameState.isMobile) ? 9 : 13;
    if (out.length > maxTreesPerChunk) {
      out.sort((a, b) => b._score - a._score);
      out.length = maxTreesPerChunk;
    }

    // Static world: cache expensive lookups once per tree instance.
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      t.k = tileKey(t.tx, t.tz);
      t.y = this.getAltitude(t.x, t.z);
    }

    this._procTreeChunkCache.set(key, out);
    return out;
  },


  drawTrees(s) {
    const currentFrame = (typeof frameCount === 'number') ? frameCount : 0;
    if (this._bakeFrame !== currentFrame) {
      this._bakeFrame = currentFrame;
      this._chunksBakedThisFrame.clear();
      this._bakeBudgetUsedMs = 0;
    }
    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    let cam = this._cam || this.getCameraParams(s);
    let gx = toTile(s.x), gz = toTile(s.z);
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    noStroke();
    this.applyShader();

    const chunkHalf = CHUNK_SIZE * TILE;
    const sun = this._getSunShadowBasis();
    const visibleChunks = [];

    // We purposefully DO NOT globally clear shadow caches here anymore when sun changes.
    // Chunk caching handles stale retries internally so we don't drop 50 chunks at once.
    if (sun.x !== this._bakedShadowSun.x || sun.y !== this._bakedShadowSun.y || sun.z !== this._bakedShadowSun.z) {
      this._bakedShadowSun = { x: sun.x, y: sun.y, z: sun.z };
    }

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!this._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        
        visibleChunks.push({ cx, cz });
        const treeState = this._advanceChunkTreeBatch(cx, cz);
        if (treeState) {
          // Draw all completed batches.
          for (const geom of treeState.batches) model(geom);
          // Draw remaining un-baked trees individually this frame.
          for (let i = treeState.nextIdx; i < treeState.trees.length; i++) {
            const t = treeState.trees[i];
            push(); translate(t.x, t.y, t.z);
            this._drawTreeImmediate(t, infection.has(t.k));
            pop();
          }
        }
        // null means no renderable trees — nothing to draw.
      }
    }

    resetShader();
    setSceneLighting();

    noLights(); noStroke();
    this.applyShadowShader();
    _beginShadowStencil();
    for (const c of visibleChunks) {
      const shadowMesh = this._getChunkTreeShadow(c.cx, c.cz, sun);
      if (shadowMesh) {
        model(shadowMesh);
      } else if (!this._treeShadowChunkCache.has(`${c.cx},${c.cz}`)) {
        // Fallback: draw individually if chunk shadow timed out
        if (gameState.mode === 'menu') continue;
        // This chunk already baked this frame (shadow will fire next available frame)
        // or the frame budget is exhausted — skip individual draws for now.
        if (this._chunksBakedThisFrame.has(`${c.cx},${c.cz}`) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS) continue;
        const trees = this.getProceduralTreesForChunk(c.cx, c.cz);
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          if (!t._shadowHull) {
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
              const a = (i / 16) * TWO_PI;
              footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
            }
            t._footprint = footprint;
            t._shadowCasterH = h + (vi === 2 ? 24 : 18) * sc;
            t._shadowHull = true;
          }
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          // isBaking=true because the caller (drawTrees) has already applied the shadow shader and stencil setup
          this._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      }
    }
    _endShadowStencil();
    resetShader();
    setSceneLighting();

    if (profiler) profiler.record('trees', performance.now() - start);
  },



  _drawTreeImmediate(t, inf) {
    const { trunkH: h, canopyScale: sc, variant: vi } = t;
    let tv = TREE_VARIANTS[vi];

    // Ensure R values avoid terrain palette indices (1,2, 10,11, 20,21)
    const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;

    fill(safeR(inf ? 80 : 100), inf ? 40 : 65, inf ? 20 : 25);
    push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

    let c1 = inf ? tv.infected : tv.healthy;
    fill(safeR(c1[0]), c1[1], c1[2]);

    if (vi === 2) {
      push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
    } else {
      let cn = tv.cones[0];
      push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();
      if (tv.cones2) {
        let c2 = inf ? tv.infected2 : tv.healthy2;
        fill(safeR(c2[0]), c2[1], c2[2]);
        let cn2 = tv.cones2[0];
        push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
      }
    }
  },




  /**
   * Draws all trees within rendering range, applying fog colour blending and
   * infection tinting using the terrain shader and single coherent meshes.
   * Ground shadows are projected from component silhouettes (trunk + canopy tiers).
   * @param {{x,y,z,yaw}} s  Ship state (used as the view origin for culling).
   */

  /**
   * Returns the progressive bake state for a tree chunk, advancing one batch
   * (TREE_BATCH_SIZE trees) if the per-frame budget has not yet been exhausted.
   *
   * State shape: null (no renderable trees) | { batches: p5.Geometry[],
   *   nextIdx: number, trees: Object[] }
   * where trees is the filtered renderable list for this chunk.
   * nextIdx === trees.length means the chunk is fully baked.
   * Un-baked trees (indices nextIdx..trees.length-1) must be drawn individually
   * by the caller on the same frame.
   */
  _advanceChunkTreeBatch(cx, cz) {
    const key = `${cx},${cz}`;
    const existing = this._treeBakeState.get(key);

    if (existing === null) return null; // Confirmed: no renderable trees.

    let state = existing; // undefined = first visit; object = in-progress / done.

    if (state === undefined) {
      const allTrees = this.getProceduralTreesForChunk(cx, cz);
      const trees = allTrees.filter(t => !aboveSea(t.y) && !isLaunchpad(t.x, t.z));
      if (trees.length === 0) {
        this._treeBakeState.set(key, null);
        return null;
      }
      state = { batches: [], nextIdx: 0, trees };
    }

    // Fully baked — just cache and return.
    if (state.nextIdx >= state.trees.length) {
      if (existing === undefined) this._treeBakeState.set(key, state);
      return state;
    }

    // This chunk already baked something this frame, the global time budget is
    // exhausted, or another bake is in progress — defer to the next frame.
    if (this._chunksBakedThisFrame.has(key) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS || this._isBuildingShadow) {
      if (existing === undefined) this._treeBakeState.set(key, state);
      return state;
    }

    // Bake the next TREE_BATCH_SIZE trees.
    const end = Math.min(state.nextIdx + TREE_BATCH_SIZE, state.trees.length);
    this._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (let i = state.nextIdx; i < end; i++) {
          const t = state.trees[i];
          push(); translate(t.x, t.y, t.z);
          this._drawTreeImmediate(t, infection.has(t.k));
          pop();
        }
      });
    } catch (err) {
      console.error('[Viron] Tree batch bake failed:', err);
    } finally {
      this._isBuildingShadow = false;
    }
    this._bakeBudgetUsedMs += performance.now() - t0;
    this._chunksBakedThisFrame.add(key);

    if (geom) state.batches.push(geom);
    // Always advance past this batch (even on failure) so a permanently failing
    // buildGeometry call does not cause an infinite retry loop.  In practice
    // _safeBuildGeometry only returns null on catastrophic errors; those 4 trees
    // will be absent until the chunk is evicted and re-baked.
    state.nextIdx = end;
    this._treeBakeState.set(key, state);
    return state;
  },


  _getChunkTreeShadow(cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = this._treeShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (this._chunksBakedThisFrame.has(key) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS || this._isBuildingShadow) {
      // This chunk already baked, budget exhausted, or mutex busy; return stale
      // geometry so shadows are never worse than one sun-step behind.
      if (cached && cached.geom) return cached.geom;
      return null;
    }

    const trees = this.getProceduralTreesForChunk(cx, cz);
    let hasRenderable = false;
    for (const t of trees) {
        if (!aboveSea(t.y) && !isLaunchpad(t.x, t.z)) {
            hasRenderable = true;
            break;
        }
    }
    if (!hasRenderable) {
      this._treeShadowChunkCache.set(key, { geom: null, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
      return null;
    }

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          if (!t._shadowHull) {
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
              const a = (i / 16) * TWO_PI;
              footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
            }
            t._footprint = footprint;
            t._shadowCasterH = h + (vi === 2 ? 24 : 18) * sc;
            t._shadowHull = true;
          }
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          this._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      });
    } catch (err) {
      console.error("[Viron] Chunk tree shadow geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }
    this._bakeBudgetUsedMs += performance.now() - t0;
    this._chunksBakedThisFrame.add(key);

    this._treeShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  },

});
