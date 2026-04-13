// =============================================================================
// terrainGeometry.js — Geometry building for terrain chunks and overlays
// =============================================================================


import { p } from './p5Context.js';
import { CHUNK_SIZE, TILE, aboveSea, SEA, infection, chunkKey, getVironProfiler } from './constants.js';
import { gameState } from './gameState.js';

export const TerrainGeometry = {

    /**
     * Builds or retrieves the cached p5 geometry mesh for one terrain chunk.
     */
    getChunkGeometry(ctx, cx, cz) {
        let key = cx + ',' + cz;
        let cached = ctx.chunkCache.get(key);
        if (cached !== undefined) return cached;

        if (ctx._isBuildingShadow) return null;

        let startX = cx * CHUNK_SIZE;
        let startZ = cz * CHUNK_SIZE;

        let hasRenderableTile = false;
        scanRows: for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
            for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
                let minY = Math.min(
                    ctx.getGridAltitude(tx, tz),
                    ctx.getGridAltitude(tx + 1, tz),
                    ctx.getGridAltitude(tx, tz + 1),
                    ctx.getGridAltitude(tx + 1, tz + 1)
                );
                if (!aboveSea(minY)) { hasRenderableTile = true; break scanRows; }
            }
        }

        if (!hasRenderableTile) {
            ctx.chunkCache.set(key, null);
            return null;
        }

        ctx._isBuildingShadow = true;
        let geom = null;
        try {
            geom = this._safeBuildGeometry(() => {
                p.beginShape(p.TRIANGLES);
                p.fill(34, 139, 34);

                for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
                    for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
                        let xP = tx * TILE, zP = tz * TILE;
                        let xP1 = xP + TILE, zP1 = zP + TILE;
                        let y00 = ctx.getGridAltitude(tx, tz);
                        let y10 = ctx.getGridAltitude(tx + 1, tz);
                        let y01 = ctx.getGridAltitude(tx, tz + 1);
                        let y11 = ctx.getGridAltitude(tx + 1, tz + 1);
                        let minY = Math.min(y00, y10, y01, y11);
                        if (aboveSea(minY)) continue;

                        let avgY = (y00 + y10 + y01 + y11) * 0.25;
                        let isShore = (avgY > SEA - 15);
                        let noiseVal = p.noise(tx * 0.15, tz * 0.15);
                        let randVal = Math.abs(Math.sin(tx * 12.9898 + tz * 78.233)) * 43758.5453 % 1;
                        let parity = ((tx + tz) % 2 === 0) ? 1.0 : 0.85;

                        p.fill(isShore ? 2 : 1, noiseVal * 255, randVal * 255, parity * 255);

                        let e1x = xP1 - xP, e1y = y10 - y00, e1z = 0;
                        let e2x = 0, e2y = y01 - y00, e2z = zP1 - zP;
                        let n1x = e1y * e2z - e1z * e2y;
                        let n1y = e1z * e2x - e1x * e2z;
                        let n1z = e1x * e2y - e1y * e2x;
                        p.normal(n1x, n1y, n1z);
                        p.vertex(xP, y00, zP); p.vertex(xP1, y10, zP); p.vertex(xP, y01, zP1);

                        e1x = xP1 - xP1; e1y = y11 - y10; e1z = zP1 - zP;
                        e2x = xP - xP1; e2y = y01 - y10; e2z = zP1 - zP;
                        let n2x = e1y * e2z - e1z * e2y;
                        let n2y = e1z * e2x - e1x * e2z;
                        let n2z = e1x * e2y - e1y * e2x;
                        p.normal(n2x, n2y, n2z);
                        p.vertex(xP1, y10, zP); p.vertex(xP1, y11, zP1); p.vertex(xP, y01, zP1);
                    }
                }
                p.endShape();
            });
        } catch (err) {
            console.error("[Viron] Chunk geometry build failed:", err);
        } finally {
            ctx._isBuildingShadow = false;
        }

        ctx.chunkCache.set(key, geom);
        return geom;
    },

    /**
     * Internal helper to build geometry quads for infection or barrier overlays.
     */
    drawTileOverlays(ctx, manager, typeConfigs, yOffset, cam, fovSlope, tag, minCx, maxCx, minCz, maxCz) {
        const profiler = getVironProfiler();
        const overlayStart = profiler ? performance.now() : 0;
        const managerId = (manager === infection) ? 0 : 1;

        if (!manager.onInvalidate) {
            manager.onInvalidate = (tx, tz) => ctx._invalidateOverlay(managerId, tx, tz);
        }

        if (ctx._overlayDirtyQueue && ctx._overlayDirtyQueue.size > 0) {
            for (const dirtyPrefix of ctx._overlayDirtyQueue) {
                const searchPrefix = `${dirtyPrefix}_`;
                for (const k of ctx._overlayCaches.keys()) {
                    if (k.startsWith(searchPrefix)) ctx._overlayCaches.delete(k);
                }
            }
            ctx._overlayDirtyQueue.clear();
        }

        let totalTiles = 0;
        const chunkHalf = CHUNK_SIZE * TILE;
        const _gl = (typeof p.drawingContext !== 'undefined') ? p.drawingContext : null;
        if (_gl) {
            _gl.enable(_gl.POLYGON_OFFSET_FILL);
            _gl.polygonOffset(-1.0, -2.0);
        }

        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                const bk = chunkKey(cx, cz);
                const tileList = manager.buckets ? manager.buckets.get(bk) : null;
                if (!tileList || tileList.length === 0) continue;

                if (!ctx._isChunkVisible(cam, cx, cz, chunkHalf)) continue;

                const matIdSet = new Set();
                for (let i = 0; i < tileList.length; i++) {
                    const t = tileList[i];
                    const type = t.type || 'default';
                    const parity = (t.tx + t.tz) % 2 === 0 ? 0 : 1;
                    const config = typeConfigs[type] || typeConfigs['default'];
                    if (config) matIdSet.add(config[parity]);
                }

                let allCached = true;
                for (const matId of matIdSet) {
                    if (ctx._overlayCaches.get(`${managerId}_${bk}_${matId}`) === undefined) {
                        allCached = false;
                        break;
                    }
                }

                if (allCached) {
                    for (const matId of matIdSet) {
                        const geom = ctx._overlayCaches.get(`${managerId}_${bk}_${matId}`);
                        if (geom) {
                            p.model(geom);
                            totalTiles += tileList.length;
                        }
                    }
                    continue;
                }

                const matBuckets = {};
                for (let i = 0; i < tileList.length; i++) {
                    const t = tileList[i];
                    const type = t.type || 'default';
                    const parity = (t.tx + t.tz) % 2 === 0 ? 0 : 1;
                    const config = typeConfigs[type] || typeConfigs['default'];
                    if (!config) continue;
                    const matId = config[parity];
                    if (!matBuckets[matId]) matBuckets[matId] = [];
                    matBuckets[matId].push(t);
                }

                for (const matId in matBuckets) {
                    const cacheKey = `${managerId}_${bk}_${matId}`;
                    let geom = ctx._overlayCaches.get(cacheKey);

                    if (geom === undefined) {
                        const mList = matBuckets[matId];
                        geom = this._safeBuildGeometry(() => {
                            p.beginShape(p.TRIANGLES);
                            p.normal(0, 1, 0);
                            p.fill(parseInt(matId), 0, 0, 255);
                            for (let i = 0; i < mList.length; i++) {
                                const t = mList[i];
                                if (!t.verts) {
                                    const xP = t.tx * TILE, zP = t.tz * TILE, xP1 = xP + TILE, zP1 = zP + TILE;
                                    const y00 = ctx.getGridAltitude(t.tx, t.tz) + yOffset;
                                    const y10 = ctx.getGridAltitude(t.tx + 1, t.tz) + yOffset;
                                    const y01 = ctx.getGridAltitude(t.tx, t.tz + 1) + yOffset;
                                    const y11 = ctx.getGridAltitude(t.tx + 1, t.tz + 1) + yOffset;
                                    t.verts = new Float32Array([
                                        xP, y00, zP, xP1, y10, zP, xP, y01, zP1,
                                        xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1
                                    ]);
                                }
                                const v = t.verts;
                                for (let j = 0; j < 18; j += 3) p.vertex(v[j], v[j + 1], v[j + 2]);
                            }
                            p.endShape();
                        });
                        ctx._overlayCaches.set(cacheKey, geom);
                    }

                    if (geom) {
                        p.model(geom);
                        totalTiles += matBuckets[matId].length;
                    }
                }
            }
        }

        if (_gl) _gl.disable(_gl.POLYGON_OFFSET_FILL);
        if (profiler && tag) profiler.recordOverlay(tag, totalTiles, performance.now() - overlayStart);
    },

    _safeBuildGeometry(callback) {
        try {
            return p.buildGeometry(callback);
        } catch (err) {
            let cleared = false;
            try { p.endGeometry(); cleared = true; } catch (_ignored) {}
            if (!cleared) {
                try {
                    if (p._renderer && p._renderer.geometryBuilder) {
                        p._renderer.geometryBuilder = undefined;
                        try { p.pop(); } catch (_e) {}
                    }
                } catch (_ignored2) {}
            }
            throw err;
        }
    }
};
