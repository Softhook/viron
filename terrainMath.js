// =============================================================================
// terrainMath.js — Pure math and altitude lookup procedures for Terrain
// =============================================================================

const TerrainMath = {

    /**
     * Returns the altitude at a grid-corner position.
     * @param {Terrain} ctx Terrain instance for cache access.
     * @param {number} tx Tile-grid X index.
     * @param {number} tz Tile-grid Z index.
     */
    getGridAltitude(ctx, tx, tz) {
        let key = tileKey(tx, tz);
        let cached = ctx.altCache.get(key);
        if (cached !== undefined) return cached;

        let x = tx * TILE, z = tz * TILE;
        let alt;
        if (isLaunchpad(x, z)) {
            alt = LAUNCH_ALT;
        } else {
            let xs = x * 0.0008, zs = z * 0.0008;
            let elevation = noise(xs, zs) +
                0.5 * noise(xs * 2.5 + 31.7, zs * 2.5 + 83.3) +
                0.25 * noise(xs * 5 + 67.1, zs * 5 + 124.9);
            alt = 300 - Math.pow(elevation / 1.75, 2.0) * 550;

            for (let peak of MOUNTAIN_PEAKS) {
                let dx = x - peak.x, dz = z - peak.z;
                let dSq = dx * dx + dz * dz;
                if (dSq > peak._skipDistSq) continue;
                alt -= peak.strength * Math.exp(-dSq / peak._s2);
            }
        }

        ctx.altCache.set(key, alt);
        return alt;
    },

    /**
     * Bilinear interpolation for sub-tile altitude lookups.
     */
    getAltitude(ctx, x, z) {
        if (isLaunchpad(x, z)) return LAUNCH_ALT;

        let tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
        let fx = (x - tx * TILE) / TILE, fz = (z - tz * TILE) / TILE;

        if (fx === 0 && fz === 0) return this.getGridAltitude(ctx, tx, tz);

        let y00 = this.getGridAltitude(ctx, tx, tz);
        let y10 = this.getGridAltitude(ctx, tx + 1, tz);
        let y01 = this.getGridAltitude(ctx, tx, tz + 1);
        let y11 = this.getGridAltitude(ctx, tx + 1, tz + 1);

        if (fx + fz <= 1) return y00 + (y10 - y00) * fx + (y01 - y00) * fz;
        return y11 + (y01 - y11) * (1 - fx) + (y10 - y11) * (1 - fz);
    },

    /**
     * Provides a smoothed fog distance value.
     */
    getFogFarWorld(ctx) {
        let frame = (typeof frameCount === 'number') ? frameCount : -1;
        if (frame === ctx._fogFrameStamp) return ctx._fogFarWorldSmoothed;

        ctx._fogFrameStamp = frame;
        const target = VIEW_FAR * TILE;
        const dtMs = (typeof deltaTime === 'number' && Number.isFinite(deltaTime))
            ? Math.max(0, Math.min(deltaTime, 100))
            : 16.67;
        const alpha = 1.0 - Math.exp(-dtMs / 320.0);
        ctx._fogFarWorldSmoothed += (target - ctx._fogFarWorldSmoothed) * alpha;
        return ctx._fogFarWorldSmoothed;
    },

    getCameraParams(s, firstPerson = false) {
        let fwdX = -sin(s.yaw), fwdZ = -cos(s.yaw);
        return firstPerson
            ? { x: s.x, z: s.z, fwdX, fwdZ, pitch: s.pitch }
            : { x: s.x - fwdX * 550, z: s.z - fwdZ * 550, fwdX, fwdZ, pitch: s.pitch };
    },

    inFrustum(cam, tx, tz) {
        if (cam.skipFrustum) return true;
        let dx = tx - cam.x, dz = tz - cam.z;
        let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
        if (fwdDist < -TILE * 5) return false;
        let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
        let halfWidth = (fwdDist > 0 ? fwdDist : 0) * cam.fovSlope + TILE * 6;
        return Math.abs(rightDist) <= halfWidth;
    },

    isChunkVisible(cam, cx, cz, chunkHalf) {
        if (cam.skipFrustum) return true;
        const chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
        const chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;
        const dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
        const fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
        if (fwdDist < -chunkHalf) return false;
        const rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
        const halfWidth = (fwdDist > 0 ? fwdDist : 0) * cam.fovSlope + chunkHalf;
        return Math.abs(rightDist) <= halfWidth;
    }
};
