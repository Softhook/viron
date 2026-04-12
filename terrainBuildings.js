// =============================================================================
// terrainBuildings.js — Building rendering and shadows
// Now as a stateless service to improve LLM-readability.
// =============================================================================

const TerrainBuildings = {

  _getBuildingsForChunk(ctx, cx, cz) {
    if (typeof gameState === 'undefined' || !gameState.buildings) return [];
    if (!ctx._buildingBuckets || ctx._buildingBucketsCount !== gameState.buildings.length) {
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

      if (ctx._buildingBucketsCount !== 0 && ctx._buildingBuckets) {
        for (const [bk, oldArr] of ctx._buildingBuckets.entries()) {
           const newArr = newBuckets.get(bk) || [];
           if (oldArr.length !== newArr.length || oldArr.some((b, i) => b !== newArr[i])) {
              ctx._buildingBakeState.delete(bk);
              ctx._buildingShadowChunkCache.delete(bk);
           }
        }
        for (const bk of newBuckets.keys()) {
           if (!ctx._buildingBuckets.has(bk)) {
              ctx._buildingBakeState.delete(bk);
              ctx._buildingShadowChunkCache.delete(bk);
           }
        }
      } else {
        ctx._buildingBakeState.clear();
        ctx._buildingShadowChunkCache.clear();
      }

      ctx._buildingBuckets = newBuckets;
      ctx._buildingBucketsCount = newCount;
    }
    return ctx._buildingBuckets.get(`${cx},${cz}`) || [];
  },

  _drawBuildingShadow(ctx, b, groundY, sun) {
    const bw = b.w, bh = b.h;
    const floatY = groundY - bh - 100 - sin(millis() * 0.0012 + b.x) * 50;
    const casterH = Math.max(35, groundY - floatY);
    ctx._drawProjectedEllipseShadow(b.x, b.z, groundY, casterH, bw * 2.2, bw * 1.4, 70, sun, true);
  },

  drawBuildings(ctx, s) {
    const currentFrame = (typeof frameCount === 'number') ? frameCount : 0;
    if (ctx._bakeFrame !== currentFrame) {
      ctx._bakeFrame = currentFrame;
      ctx._chunksBakedThisFrame.clear();
      ctx._bakeBudgetUsedMs = 0;
    }
    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    let cam = ctx._cam || ctx.getCameraParams(s);
    const sun = ctx._getSunShadowBasis();
    
    let gx = toTile(s.x), gz = toTile(s.z);
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    const chunkHalf = CHUNK_SIZE * TILE;

    ctx.applyShader();

    const visibleBldgs = [];
    const visibleChunks = [];

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!ctx._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        
        visibleChunks.push({ cx, cz });
        const bldgState = this._advanceChunkBuildingBatch(ctx, cx, cz);
        if (bldgState) {
          for (const geom of bldgState.batches) model(geom);
          for (let i = bldgState.nextIdx; i < bldgState.buildings.length; i++) {
            const b = bldgState.buildings[i];
            push(); translate(b.x, b.y, b.z);
            this._drawBuildingImmediate(ctx, b, infection.has(b._tileKey));
            pop();
          }
        }

        const bldgs = this._getBuildingsForChunk(ctx, cx, cz);
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
        let geom = this._getPowerupGeom(ctx, b, inf);
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
    ctx.applyShadowShader();
    _beginShadowStencil();
    
    for (const c of visibleChunks) {
      const geom = this._getChunkBuildingShadow(ctx, c.cx, c.cz, sun);
      if (geom) {
        model(geom);
      } else if (!ctx._buildingShadowChunkCache.has(`${c.cx},${c.cz}`)) {
        if (gameState.mode === 'menu') continue;
        if (ctx._chunksBakedThisFrame.has(`${c.cx},${c.cz}`) || ctx._bakeBudgetUsedMs >= BAKE_BUDGET_MS) continue;
        const chunkBldgs = this._getBuildingsForChunk(ctx, c.cx, c.cz);
        for (const b of chunkBldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          this._ensureBuildingShadowHull(b);
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? 65 : (b.type === 0 ? 85 : 80);
          ctx._drawProjectedFootprintShadow(b.x, b.z, b.y, casterH, b._footprint, baseAlpha, sun, false, true);
        }
      }
    }
    _endShadowStencil();

    for (const v of visibleBldgs) {
      const b = v.b;
      if (b.type === 3 && v.dSq < 2250000 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        this._drawBuildingShadow(ctx, b, b.y, sun);
      }
    }

    resetShader();
    setSceneLighting();

    if (profiler) profiler.record('buildings', performance.now() - start);
  },

  _ensureBuildingShadowHull(b) {
    if (b._shadowHull) return;
    const { footprint, casterH } = getBuildingFootprint(b);
    b._footprint = footprint;
    b._shadowCasterH = casterH;
    b._shadowHull = true;
  },

  _drawBuildingImmediate(ctx, b, inf) {
    if      (b.type === 0) buildType0Geometry(b, inf);
    else if (b.type === 1) buildType1Geometry(b, inf);
    else if (b.type === 2) buildType2Geometry(b, inf);
    else if (b.type === 4) buildType4Geometry(b, inf);
    else if (b.type === 5) buildType5Geometry(b, inf);
  },

  _advanceChunkBuildingBatch(ctx, cx, cz) {
    const key = `${cx},${cz}`;
    const existing = ctx._buildingBakeState.get(key);
    if (existing === null) return null;

    let state = existing;
    if (state === undefined) {
      const allBldgs = this._getBuildingsForChunk(ctx, cx, cz);
      const buildings = allBldgs.filter(b => b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z));
      for (const b of buildings) {
        if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      }
      if (buildings.length === 0) {
        ctx._buildingBakeState.set(key, null);
        return null;
      }
      state = { batches: [], nextIdx: 0, buildings };
    }

    if (state.nextIdx >= state.buildings.length) {
      if (existing === undefined) ctx._buildingBakeState.set(key, state);
      return state;
    }

    if (ctx._chunksBakedThisFrame.has(key) || ctx._bakeBudgetUsedMs >= BAKE_BUDGET_MS || ctx._isBuildingShadow) {
      if (existing === undefined) ctx._buildingBakeState.set(key, state);
      return state;
    }

    const end = Math.min(state.nextIdx + BUILDING_BATCH_SIZE, state.buildings.length);
    ctx._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = ctx._safeBuildGeometry(() => {
        for (let i = state.nextIdx; i < end; i++) {
          const b = state.buildings[i];
          push(); translate(b.x, b.y, b.z);
          this._drawBuildingImmediate(ctx, b, infection.has(b._tileKey));
          pop();
        }
      });
    } catch (err) { console.error('[Viron] Building batch bake failed:', err); } finally { ctx._isBuildingShadow = false; }
    ctx._bakeBudgetUsedMs += performance.now() - t0;
    ctx._chunksBakedThisFrame.add(key);

    if (geom) state.batches.push(geom);
    state.nextIdx = end;
    ctx._buildingBakeState.set(key, state);
    return state;
  },

  _getChunkBuildingShadow(ctx, cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = ctx._buildingShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (ctx._chunksBakedThisFrame.has(key) || ctx._bakeBudgetUsedMs >= BAKE_BUDGET_MS || ctx._isBuildingShadow) {
      if (cached && cached.geom) return cached.geom;
      return null;
    }

    const bldgs = this._getBuildingsForChunk(ctx, cx, cz);
    let hasStatic = false;
    for (const b of bldgs) {
      if (b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        hasStatic = true; break;
      }
    }

    if (!hasStatic) {
      ctx._buildingShadowChunkCache.set(key, { geom: null, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
      return null;
    }

    if (ctx._isBuildingShadow) return null;
    ctx._isBuildingShadow = true;
    const t0 = performance.now();
    let geom = null;
    try {
      geom = ctx._safeBuildGeometry(() => {
        for (const b of bldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          this._ensureBuildingShadowHull(b);
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? 65 : (b.type === 0 ? 85 : 80);
          ctx._drawProjectedFootprintShadow(b.x, b.z, b.y, casterH, b._footprint, baseAlpha, sun, false, true);
        }
      });
    } catch (err) { console.error(err); } finally { ctx._isBuildingShadow = false; }
    ctx._bakeBudgetUsedMs += performance.now() - t0;
    ctx._chunksBakedThisFrame.add(key);
    
    ctx._buildingShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  },

  _getPowerupGeom(ctx, b, inf) {
    if (!b._geomKeyPair) {
      const base = `pu_${b.w.toFixed(1)}_${b.h.toFixed(1)}_`;
      b._geomKeyPair = [base + 'false', base + 'true'];
    }
    const key = b._geomKeyPair[inf ? 1 : 0];
    if (!ctx._geoms) ctx._geoms = new Map();
    if (ctx._geoms.has(key)) return ctx._geoms.get(key);

    if (ctx._isBuildingShadow) return null;
    ctx._isBuildingShadow = true;
    let geom = null;
    try {
      geom = ctx._safeBuildGeometry(() => buildPowerupGeometry(b, inf));
    } catch (err) {
      console.error("[Viron] Powerup geometry build failed:", err);
    } finally {
      ctx._isBuildingShadow = false;
    }

    ctx._geoms.set(key, geom);
    return geom;
  }
};
