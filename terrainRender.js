// =============================================================================
// terrainRender.js — Shader application and landscape drawing for Terrain
// =============================================================================

const TerrainRender = {

    drawLandscape(ctx, s, viewAspect, firstPerson = false) {
        const gx = toTile(s.x), gz = toTile(s.z);
        noStroke();

        ctx._renderPassId++;
        const cam = ctx.getCameraParams(s, firstPerson);
        cam.fovSlope = 0.57735 * viewAspect + 0.3;
        cam.skipFrustum = firstPerson && Math.abs(cam.pitch) > Math.PI / 4;
        ctx._cam = cam;

        noLights();
        const profiler = getVironProfiler();
        const shaderStart = profiler ? performance.now() : 0;
        this.applyShader(ctx);
        if (profiler) profiler.record('shader', performance.now() - shaderStart);

        const terrainStart = profiler ? performance.now() : 0;
        const minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
        const maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
        const minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
        const maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

        this._drawTerrainChunks(ctx, cam, minCx, maxCx, minCz, maxCz);

        if (infection.count > 0) {
            TerrainGeometry.drawTileOverlays(
                ctx, infection, { normal: [10, 11], yellow: [14, 15] },
                -0.5, cam, cam.fovSlope, 'infection',
                minCx, maxCx, minCz, maxCz
            );
        }

        if (gameState.barrierTiles && gameState.barrierTiles.size > 0) {
            TerrainGeometry.drawTileOverlays(
                ctx, gameState.barrierTiles, { default: [20, 21] },
                -0.3, cam, cam.fovSlope, 'barrier',
                minCx, maxCx, minCz, maxCz
            );
        }

        this._drawSeaPlane(ctx, s);
        if (profiler) profiler.record('terrain', performance.now() - terrainStart);

        resetShader();
        setSceneLighting();

        this._drawLaunchpadMissiles(ctx, cam);
    },

    _drawTerrainChunks(ctx, cam, minCx, maxCx, minCz, maxCz) {
        const chunkHalf = CHUNK_SIZE * TILE;
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cx = minCx; cx <= maxCx; cx++) {
                if (!ctx._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
                const geom = ctx.getChunkGeometry(cx, cz);
                if (geom) model(geom);
            }
        }
    },

    _drawSeaPlane(ctx, s) {
        const seaSize = VIEW_FAR * TILE * 1.5;
        const seaCx = toTile(s.x) * TILE, seaCz = toTile(s.z) * TILE;
        const sx0 = seaCx - seaSize, sx1 = seaCx + seaSize;
        const sz0 = seaCz - seaSize, sz1 = seaCz + seaSize;
        const gl = drawingContext;
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1.0, -4.0);
        fill(30, 45, 150);
        beginShape(TRIANGLES);
        normal(0, -1, 0);
        vertex(sx0, SEA, sz0); vertex(sx1, SEA, sz0); vertex(sx0, SEA, sz1);
        vertex(sx1, SEA, sz0); vertex(sx1, SEA, sz1); vertex(sx0, SEA, sz1);
        endShape();
        gl.disable(gl.POLYGON_OFFSET_FILL);
    },

    _drawLaunchpadMissiles(ctx, cam) {
        push();
        const mX = LAUNCH_MAX - 100;
        for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
            const fogF = ctx.getFogFactor((mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ);
            push();
            translate(mX, LAUNCH_ALT, mZ);
            fill(lerp(60, SKY_R, fogF), lerp(60, SKY_G, fogF), lerp(60, SKY_B, fogF));
            push(); translate(0, -10, 0); box(30, 20, 30); pop();
            fill(lerp(255, SKY_R, fogF), lerp(140, SKY_G, fogF), lerp(20, SKY_B, fogF));
            push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();
            pop();
        }
        pop();
    },

    applyShader(ctx) {
        shader(ctx.shader);
        const needsTerrainUpload = (ctx._uniformUploadedPassId[0] !== ctx._renderPassId);
        this._uploadSharedUniforms(ctx, ctx.shader);
        if (!needsTerrainUpload) return;
        ctx.shader.setUniform('uTileSize', TILE);
        ctx.shader.setUniform('uPalette', TERRAIN_PALETTE_FLAT);
        this._uploadSentinelGlows(ctx);
    },

    _uploadSentinelGlows(ctx) {
        const glowArr = ctx._glowArr;
        for (let i = 0; i < 16; i++) {
            const base = i * 4;
            if (i < ctx.sentinelGlows.length) {
                const g = ctx.sentinelGlows[i];
                glowArr[base] = g.x; glowArr[base + 1] = g.z; glowArr[base + 2] = g.radius; glowArr[base + 3] = 1.0;
            } else {
                glowArr[base] = 0.0; glowArr[base + 1] = 0.0; glowArr[base + 2] = 0.0; glowArr[base + 3] = 0.0;
            }
        }
        ctx.shader.setUniform('uSentinelGlows', glowArr);
    },

    applyFillColorShader(ctx) {
        if (!ctx.fillShader) return;
        shader(ctx.fillShader);
        this._uploadSharedUniforms(ctx, ctx.fillShader);
        ctx._uFillColorArr[0] = 1.0; ctx._uFillColorArr[1] = 1.0; ctx._uFillColorArr[2] = 1.0;
        ctx.fillShader.setUniform('uFillColor', ctx._uFillColorArr);
        ctx.fillShader.setUniform('uScanlineWeight', 1.0);
    },

    setFillColor(ctx, r, g, b) {
        ctx._uFillColorArr[0] = r / 255.0;
        ctx._uFillColorArr[1] = g / 255.0;
        ctx._uFillColorArr[2] = b / 255.0;
        if (ctx.fillShader) ctx.fillShader.setUniform('uFillColor', ctx._uFillColorArr);
    },

    applyShadowShader(ctx) {
        if (!ctx.shadowShader) return;
        shader(ctx.shadowShader);
        ctx.shadowShader.setUniform('uFogDist', ctx._uFogDistArr);
    },

    _uploadSharedUniforms(ctx, sh) {
        const shIdx = (sh === ctx.shader) ? 0 : 1;
        if (ctx._uniformUploadedPassId[shIdx] === ctx._renderPassId) return;
        ctx._uniformUploadedPassId[shIdx] = ctx._renderPassId;

        const fogFar = ctx.getFogFarWorld();
        ctx._uFogDistArr[0] = fogFar - 1500; ctx._uFogDistArr[1] = fogFar;
        ctx._uFogColorArr[0] = SKY_R / 255.0; ctx._uFogColorArr[1] = SKY_G / 255.0; ctx._uFogColorArr[2] = SKY_B / 255.0;
        ctx._uSunDirArr[0] = SUN_DIR_NX; ctx._uSunDirArr[1] = SUN_DIR_NY; ctx._uSunDirArr[2] = SUN_DIR_NZ;
        ctx._uSunColorArr[0] = SHADER_SUN_R; ctx._uSunColorArr[1] = SHADER_SUN_G; ctx._uSunColorArr[2] = SHADER_SUN_B;
        ctx._uAmbLowArr[0] = SHADER_AMB_L_R; ctx._uAmbLowArr[1] = SHADER_AMB_L_G; ctx._uAmbLowArr[2] = SHADER_AMB_L_B;
        ctx._uAmbHighArr[0] = SHADER_AMB_H_R; ctx._uAmbHighArr[1] = SHADER_AMB_H_G; ctx._uAmbHighArr[2] = SHADER_AMB_H_B;

        const r = _renderer;
        if (r && r.uViewMatrix) {
            if (!ctx._invViewMat) ctx._invViewMat = new p5.Matrix();
            ctx._invViewMat.set(r.uViewMatrix);
            ctx._invViewMat.invert(ctx._invViewMat);
            sh.setUniform('uInvViewMatrix', ctx._invViewMat.mat4);
        }

        sh.setUniform('uTime', millis() / 1000.0);
        sh.setUniform('uFogDist', ctx._uFogDistArr);
        sh.setUniform('uFogColor', ctx._uFogColorArr);
        sh.setUniform('uSunDir', ctx._uSunDirArr);
        sh.setUniform('uSunColor', ctx._uSunColorArr);
        sh.setUniform('uAmbientLow', ctx._uAmbLowArr);
        sh.setUniform('uAmbientHigh', ctx._uAmbHighArr);

        const pulseArr = ctx._pulseArr;
        for (let i = 0; i < 5; i++) {
            const base = i * 4;
            if (i < ctx.activePulses.length) {
                const p = ctx.activePulses[i];
                pulseArr[base] = p.x; pulseArr[base + 1] = p.z; pulseArr[base + 2] = p.start; pulseArr[base + 3] = p.type || 0.0;
            } else {
                pulseArr[base] = 0.0; pulseArr[base + 1] = 0.0; pulseArr[base + 2] = -9999.0; pulseArr[base + 3] = 0.0;
            }
        }
        sh.setUniform('uPulses', pulseArr);
    }
};
