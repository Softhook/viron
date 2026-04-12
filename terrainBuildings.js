// =============================================================================
// terrainBuildings.js — Building rendering and shadows
// Extracted from terrain.js
// =============================================================================

Object.assign(Terrain.prototype, {




  /**
   * Draws all buildings using single coherent meshes and the terrain shader.
   */

  _getBuildingsForChunk(cx, cz) {
    if (typeof gameState === 'undefined' || !gameState.buildings) return [];
    if (!this._buildingBuckets || this._buildingBucketsCount !== gameState.buildings.length) {
      const newBuckets = new Map();
      const newCount = gameState.buildings.length;
      for (const b of gameState.buildings) {
        if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
        const tX = toTile(b.x);
        const tZ = toTile(b.z);
        const bcx = tX >> 4;
        const bcz = tZ >> 4;
        const bk = `${bcx},${bcz}`;
        let arr = newBuckets.get(bk);
        if (!arr) { arr = []; newBuckets.set(bk, arr); }
        arr.push(b);
      }

      if (this._buildingBucketsCount !== 0 && this._buildingBuckets) {
        // Only invalidate chunks where the building arrangement actually changed
        for (const [bk, oldArr] of this._buildingBuckets.entries()) {
           const newArr = newBuckets.get(bk) || [];
           if (oldArr.length !== newArr.length || oldArr.some((b, i) => b !== newArr[i])) {
              this._buildingBakeState.delete(bk);
              this._buildingShadowChunkCache.delete(bk);
           }
        }
        for (const bk of newBuckets.keys()) {
           if (!this._buildingBuckets.has(bk)) {
              this._buildingBakeState.delete(bk);
              this._buildingShadowChunkCache.delete(bk);
           }
        }
      } else {
        // Initial setup or full reset
        this._buildingBakeState.clear();
        this._buildingShadowChunkCache.clear();
      }

      this._buildingBuckets = newBuckets;
      this._buildingBucketsCount = newCount;
    }
    return this._buildingBuckets.get(`${cx},${cz}`) || [];
  },


  /**
   * Ensures the shadow geometry for a tree is baked and cached.
   * Handles sun-change invalidation, hull initialisation, and geometry baking.
   * Called once per shadow-queue entry before the batched render pass.
   * @param {{}} t    Tree descriptor from getProceduralTreesForChunk.
   * @param {{}} sun  Sun shadow basis from _getSunShadowBasis().
   */
  _drawBuildingShadow(b, groundY, sun) {
    // Caller guarantees b.type === 3.
    const bw = b.w, bh = b.h;
    const floatY = groundY - bh - 100 - sin(millis() * 0.0012 + b.x) * 50;
    const casterH = max(35, groundY - floatY);
    this._drawProjectedEllipseShadow(b.x, b.z, groundY, casterH, bw * 2.2, bw * 1.4, 70, sun, true);
  },


  drawBuildings(s) {
    const currentFrame = (typeof frameCount === 'number') ? frameCount : 0;
    if (this._bakeFrame !== currentFrame) {
      this._bakeFrame = currentFrame;
      this._chunksBakedThisFrame.clear();
      this._bakeBudgetUsedMs = 0;
    }
    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    let cam = this._cam || this.getCameraParams(s);
    const sun = this._getSunShadowBasis();
    
    let gx = toTile(s.x), gz = toTile(s.z);
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    const chunkHalf = CHUNK_SIZE * TILE;

    this.applyShader();

    const visibleBldgs = [];
    const visibleChunks = [];

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!this._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        
        visibleChunks.push({ cx, cz });
        const bldgState = this._advanceChunkBuildingBatch(cx, cz);
        if (bldgState) {
          // Draw completed batches.
          for (const geom of bldgState.batches) model(geom);
          // Draw remaining un-baked buildings individually this frame.
          for (let i = bldgState.nextIdx; i < bldgState.buildings.length; i++) {
            const b = bldgState.buildings[i];
            push(); translate(b.x, b.y, b.z);
            this._drawBuildingImmediate(b, infection.has(b._tileKey));
            pop();
          }
        }
        // null means no static buildings — nothing to draw.

        const bldgs = this._getBuildingsForChunk(cx, cz);
        for (const b of bldgs) {
           let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
           if (dSq >= cullSq) continue;
           visibleBldgs.push({ b, dSq });
        }
      }
    }

    noStroke();
    for (const v of visibleBldgs) {
      const b = v.b;
      const y = b.y;
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;
      
      const inf = infection.has(b._tileKey);

      if (b.type === 3) {
        push(); translate(b.x, y, b.z);
        let floatY = y - b.h - 100 - sin(millis() * 0.0012 + b.x) * 50;
        translate(0, floatY - y, 0);
        rotateY(millis() * 0.0006 + b.x);
        rotateZ(millis() * 0.0009 + b.z);
        let geom = this._getPowerupGeom(b, inf);
        if (geom) model(geom);
        pop();
      } else if (b.type === 4) {
        push(); translate(b.x, y, b.z);
        const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;
        fill(safeR(inf ? 220 : 20), inf ? 60 : 230, inf ? 20 : 210);
        translate(0, -b.h * 0.87, 0);
        rotateY(millis() * 0.00192 + b.x * 0.001);
        torus(b.w * 0.32, b.w * 0.07, 14, 6);
        pop();
      }
    }

    resetShader();
    setSceneLighting();

    noLights(); noStroke();
    this.applyShadowShader();
    _beginShadowStencil();
    
    for (const c of visibleChunks) {
      const geom = this._getChunkBuildingShadow(c.cx, c.cz, sun);
      if (geom) {
        model(geom);
      } else if (!this._buildingShadowChunkCache.has(`${c.cx},${c.cz}`)) {
        // Fallback: draw individually if chunk building shadow timed out
        if (gameState.mode === 'menu') continue;
        // This chunk already baked this frame (shadow will fire next available frame)
        // or the frame budget is exhausted — skip individual draws for now.
        if (this._chunksBakedThisFrame.has(`${c.cx},${c.cz}`) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS) continue;
        const chunkBldgs = this._getBuildingsForChunk(c.cx, c.cz);
        for (const b of chunkBldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          if (!b._shadowHull) {
            const { footprint, casterH } = getBuildingFootprint(b);
            b._footprint = footprint;
            b._shadowCasterH = casterH;
            b._shadowHull = true;
          }
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? 65 : (b.type === 0 ? 85 : 80);
          // isBaking=true because the caller (drawBuildings) has already applied the shadow shader and stencil setup
          this._drawProjectedFootprintShadow(b.x, b.z, b.y, casterH, b._footprint, baseAlpha, sun, false, true);
        }
      }
    }
    _endShadowStencil();

    for (const v of visibleBldgs) {
      const b = v.b;
      if (b.type === 3 && v.dSq < 2250000 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        this._drawBuildingShadow(b, b.y, sun);
      }
    }

    resetShader();
    setSceneLighting();

    if (profiler) profiler.record('buildings', performance.now() - start);
  },




  _drawBuildingImmediate(b, inf) {
    if      (b.type === 0) buildType0Geometry(b, inf);
    else if (b.type === 1) buildType1Geometry(b, inf);
    else if (b.type === 2) buildType2Geometry(b, inf);
    else if (b.type === 4) buildType4Geometry(b, inf);
    else if (b.type === 5) buildType5Geometry(b, inf);
  },


  /**
   * Returns the progressive bake state for a building chunk, advancing one
   * batch (BUILDING_BATCH_SIZE static buildings) per call when budget allows.
   *
   * State shape: null (no static buildings) | { batches: p5.Geometry[],
   *   nextIdx: number, buildings: Object[] }
   * Buildings in indices nextIdx..buildings.length-1 must be drawn individually
   * by the caller on the same frame.
   */
  _advanceChunkBuildingBatch(cx, cz) {
    const key = `${cx},${cz}`;
    const existing = this._buildingBakeState.get(key);

    if (existing === null) return null; // Confirmed: no static buildings.

    let state = existing;

    if (state === undefined) {
      const allBldgs = this._getBuildingsForChunk(cx, cz);
      const buildings = allBldgs.filter(b => b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z));
      // Pre-compute _tileKey for all buildings up front.  Trees already have
      // t.k set by getProceduralTreesForChunk() via tileKey(); buildings are
      // mutable world objects whose _tileKey is initialised lazily here instead.
      for (const b of buildings) {
        if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      }
      if (buildings.length === 0) {
        this._buildingBakeState.set(key, null);
        return null;
      }
      state = { batches: [], nextIdx: 0, buildings };
    }

    if (state.nextIdx >= state.buildings.length) {
      if (existing === undefined) this._buildingBakeState.set(key, state);
      return state;
    }

    // This chunk already baked something this frame, the global time budget is
    // exhausted, or another bake is in progress — defer to the next frame.
    if (this._chunksBakedThisFrame.has(key) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS || this._isBuildingShadow) {
      if (existing === undefined) this._buildingBakeState.set(key, state);
      return state;
    }

    const end = Math.min(state.nextIdx + BUILDING_BATCH_SIZE, state.buildings.length);
    this._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (let i = state.nextIdx; i < end; i++) {
          const b = state.buildings[i];
          push(); translate(b.x, b.y, b.z);
          this._drawBuildingImmediate(b, infection.has(b._tileKey));
          pop();
        }
      });
    } catch (err) { console.error('[Viron] Building batch bake failed:', err); } finally { this._isBuildingShadow = false; }
    this._bakeBudgetUsedMs += performance.now() - t0;
    this._chunksBakedThisFrame.add(key);

    if (geom) state.batches.push(geom);
    state.nextIdx = end;
    this._buildingBakeState.set(key, state);
    return state;
  },


  _getChunkBuildingShadow(cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = this._buildingShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (this._chunksBakedThisFrame.has(key) || this._bakeBudgetUsedMs >= BAKE_BUDGET_MS || this._isBuildingShadow) {
      // This chunk already baked, budget exhausted, or mutex busy; return stale
      // geometry so shadows are never worse than one sun-step behind.
      if (cached && cached.geom) return cached.geom;
      return null;
    }

    const bldgs = this._getBuildingsForChunk(cx, cz);
    let hasStatic = false;
    for (const b of bldgs) {
      if (b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        hasStatic = true; break;
      }
    }

    if (!hasStatic) {
      this._buildingShadowChunkCache.set(key, { geom: null, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
      return null;
    }

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const b of bldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          
          if (!b._shadowHull) {
            const { footprint, casterH } = getBuildingFootprint(b);
            b._footprint = footprint;
            b._shadowCasterH = casterH;
            b._shadowHull = true;
          }
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? 65 : (b.type === 0 ? 85 : 80);
          
          this._drawProjectedFootprintShadow(b.x, b.z, b.y, casterH, b._footprint, baseAlpha, sun, false, true);
        }
      });
    } catch (err) { console.error(err); } finally { this._isBuildingShadow = false; }
    this._bakeBudgetUsedMs += performance.now() - t0;
    this._chunksBakedThisFrame.add(key);
    
    this._buildingShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  },


  _getPowerupGeom(b, inf) {
    // Cache both key variants on the powerup object so toFixed() is paid only once.
    // b._geomKeyPair[0] = clean key, b._geomKeyPair[1] = infected key.
    if (!b._geomKeyPair) {
      const base = `pu_${b.w.toFixed(1)}_${b.h.toFixed(1)}_`;
      b._geomKeyPair = [base + 'false', base + 'true'];
    }
    const key = b._geomKeyPair[inf ? 1 : 0];
    if (!this._geoms) this._geoms = new Map();
    if (this._geoms.has(key)) return this._geoms.get(key);

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => buildPowerupGeometry(b, inf));
    } catch (err) {
      console.error("[Viron] Powerup geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    this._geoms.set(key, geom);
    return geom;
  }

});

// Singleton instance used by all other modules
const terrain = new Terrain();
