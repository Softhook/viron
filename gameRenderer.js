// =============================================================================
// gameRenderer.js — All visual rendering (camera, 3D scene, HUD, UI)
//
// Consolidates all rendering logic: 3D scene composition per-viewport, lighting,
// particle effects, overlay rendering, and performance-adaptive quality scaling.
// Pure render-side logic with no physics or state mutations.
// =============================================================================

class GameRenderer {
  constructor() {
    this.sceneFBO = null;
    this._perfScalingState = null;
  }

  /**
   * Initializes rendering subsystems depending on platform.
   * Desktop: initializes particle billboard shader.
   * Mobile: skips FBO/billboard path due to tile-flush stall cost.
   */
  initialize(isMobile) {
    if (!isMobile) {
      ParticleSystem.init();
    }
    this.sceneFBO = null;
  }

  /**
   * Applies directional + ambient lighting for the 3D scene.
   * Calls noLights() first to reset p5's internal light accumulation.
   */
  setSceneLighting() {
    noLights();
    specularColor(0, 0, 0);
    specularMaterial(0);
    shininess(0);
    ambientLight(AMBIENT_R, AMBIENT_G, AMBIENT_B);
    directionalLight(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, SUN_DIR_NX, SUN_DIR_NY, SUN_DIR_NZ);
  }

  /**
   * Draws a sunrise sun-disc and glow in world space.
   * Anchored relative to camera so it maintains fixed parallax distance.
   */
  drawSunInWorld(cx, cy, cz, viewFarWorld, intensity = 1.0) {
    const toSunX = -SUN_DIR_NX, toSunY = -SUN_DIR_NY, toSunZ = -SUN_DIR_NZ;
    const sunDist = viewFarWorld * 1.4;
    const sunPosX = cx + toSunX * sunDist;
    const sunHeight = cy + toSunY * sunDist;
    const sunPosZ = cz + toSunZ * sunDist;

    push();
    noStroke();
    blendMode(ADD);
    push();
    translate(sunPosX, sunHeight, sunPosZ);
    emissiveMaterial(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B);
    const sunDetailLongitude = 40, sunDetailLatitude = 32;
    sphere(viewFarWorld * 0.038, sunDetailLongitude, sunDetailLatitude);
    fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 80 * intensity);
    sphere(viewFarWorld * 0.057, sunDetailLongitude, sunDetailLatitude);
    fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 40 * intensity);
    sphere(viewFarWorld * 0.083, sunDetailLongitude, sunDetailLatitude);
    pop();
    blendMode(BLEND);
    pop();
  }

  /**
   * Switches to 2D orthographic projection covering full canvas.
   * Sets WebGL viewport and ortho camera. Caller MUST call pop() when finished.
   */
  setup2DViewport() {
    let pxD = pixelDensity();
    drawingContext.viewport(0, 0, width * pxD, height * pxD);
    push();
    ortho(-width / 2, width / 2, -height / 2, height / 2, 0, 1000);
    resetMatrix();
  }

  /**
   * Renders the complete 3D scene for one player using scissor testing.
   * Handles camera positioning, lighting, terrain, enemies, particles, and HUD.
   *
   * @param {WebGLRenderingContext} gl       Raw WebGL context.
   * @param {object}                player   Player state object.
   * @param {number}                playerIdx Player index (0 or 1).
   * @param {number}                viewX    Left pixel of viewport.
   * @param {number}                viewW    Width of viewport in CSS pixels.
   * @param {number}                viewH    Height of viewport in CSS pixels.
   * @param {number}                pxDensity Device pixel ratio from p5's pixelDensity().
   */
  renderPlayerView(gl, player, playerIdx, viewX, viewW, viewH, pxDensity) {
    let s = player.ship;
    let vx = viewX * pxDensity, vw = viewW * pxDensity, vh = viewH * pxDensity;

    // Pre-compute camera parameters
    let camNear = gameState.firstPersonView ? 5 : 50;
    let camFar = VIEW_FAR * TILE * 1.5;
    let cx, cy, cz, lx, ly, lz;

    if (gameState.firstPersonView) {
      let cosPitch = cos(s.pitch), sinPitch = sin(s.pitch);
      cx = s.x; cy = s.y - 25; cz = s.z;
      lx = s.x + (-sin(s.yaw) * cosPitch) * 500;
      ly = (s.y - 25) + sinPitch * 500;
      lz = s.z + (-cos(s.yaw) * cosPitch) * 500;
    } else {
      cy = min(s.y - 120, 140);
      cx = s.x + 300 * sin(s.yaw);
      cz = s.z + 300 * cos(s.yaw);
      lx = s.x; ly = s.y; lz = s.z;
    }

    // Update spatial audio listener once per viewport
    if (typeof gameSFX !== 'undefined') {
      gameSFX.updateListener(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    }

    if (this.sceneFBO) {
      this._renderWithFBO(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    } else {
      this._renderSinglePass(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    }

    // HUD overlay (2D)
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawPlayerHUD(player, playerIdx, viewW, viewH);
    if ((gameState.isMobile || (typeof mobileController !== 'undefined' && mobileController.debug)) && gameState.numPlayers === 1 && typeof mobileController !== 'undefined') {
      mobileController.draw(width, height);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /**
   * Multi-pass rendering with FBO for soft particles at depth intersections.
   * @private
   */
  _renderWithFBO(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    // Pass 1: Render opaque scene to FBO
    this.sceneFBO.begin();
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this.setSceneLighting();
    terrain.drawLandscape(s, viewW / viewH, gameState.firstPersonView);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    for (let p of gameState.players) {
      if (!p.dead && (p !== player || !gameState.firstPersonView)) shipDisplay(p.ship, p.labelColor);
      renderProjectiles(p, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
    particleSystem.renderHardParticles(cx, cy, cz, s.x, s.z);
    pop();
    this.sceneFBO.end();

    // Pass 2: Blit FBO to main canvas
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    push();
    ortho(-viewW / 2, viewW / 2, -viewH / 2, viewH / 2, -1, 1);
    resetMatrix();
    imageMode(CORNER);
    gl.disable(gl.DEPTH_TEST);
    image(this.sceneFBO, -viewW / 2, -viewH / 2, viewW, viewH, viewX, 0, viewW, viewH);
    gl.enable(gl.DEPTH_TEST);
    pop();

    // Pass 3: Render soft billboard particles
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, this.sceneFBO);
    pop();
  }

  /**
   * Single-pass rendering (WebGL1 / no-FBO fallback).
   * @private
   */
  _renderSinglePass(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    push();
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this.setSceneLighting();
    terrain.drawLandscape(s, viewW / viewH, gameState.firstPersonView);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    for (let p of gameState.players) {
      if (!p.dead && (p !== player || !gameState.firstPersonView)) shipDisplay(p.ship, p.labelColor);
      renderProjectiles(p, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, null);
    if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
    pop();
  }

  /**
   * Dispatches one 3D render pass per player and draws shared 2D overlay.
   */
  renderAllPlayers(gl) {
    const h = height, pxDensity = pixelDensity();

    if (gameState.numPlayers === 1) {
      this.renderPlayerView(gl, gameState.players[0], 0, 0, width, h, pxDensity);
    } else {
      let hw = floor(width / 2);
      for (let pi = 0; pi < 2; pi++) {
        this.renderPlayerView(gl, gameState.players[pi], pi, pi * hw, hw, h, pxDensity);
      }
    }

    // Shared 2D overlay
    this.setup2DViewport();
    if (gameState.numPlayers === 2) {
      stroke(0, 255, 0, 180); strokeWeight(2);
      line(0, -height / 2, 0, height / 2);
    }
    if (gameState.levelComplete) {
      noStroke(); fill(0, 255, 0); textAlign(CENTER, CENTER); textSize(40);
      text('LEVEL ' + gameState.level + ' COMPLETE', 0, 0);
    }
    pop();
  }

  /**
   * Runs adaptive performance quality scaling based on frame-time percentiles.
   * Uses 60-sample circular buffer to detect thermal throttling and adjust
   * VIEW_NEAR/FAR and CULL_DIST accordingly with 6-second cooldown.
   */
  updatePerformanceScaling() {
    if (!window._perf) {
      window._perf = {
        buf: new Float32Array(60),
        idx: 0,
        full: false,
        budgetMs: 1000 / 60,
        budgetSet: false,
        nextEval: 0,
        cooldown: 0,
        overBudgetEvals: 0,
        underBudgetEvals: 0,
      };
    }
    const _p = window._perf;

    _p.buf[_p.idx] = Math.min(deltaTime, 100);
    _p.idx = (_p.idx + 1) % 60;
    if (_p.idx === 0) _p.full = true;

    if (!_p.budgetSet && _p.full) {
      const sorted = _p.buf.slice().sort();
      const medMs = (sorted[29] + sorted[30]) / 2;
      const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
      _p.budgetMs = tierMs.reduce((b, c) => Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b);
      if (!gameState.isMobile) _p.budgetMs = Math.max(_p.budgetMs, 1000 / 60);
      _p.budgetSet = true;
    }

    const _now = performance.now();
    if (!_p.full || _now < _p.nextEval) return;
    _p.nextEval = _now + 2000;

    const sorted = _p.buf.slice().sort();
    const p90ms = sorted[53];
    const reduceRatio = gameState.isMobile ? 1.40 : 1.55;
    const restoreRatio = gameState.isMobile ? 1.15 : 1.08;
    const canRestore = _now >= _p.cooldown;

    if (p90ms > _p.budgetMs * reduceRatio) {
      _p.overBudgetEvals++;
      _p.underBudgetEvals = 0;
    } else if (p90ms < _p.budgetMs * restoreRatio && canRestore) {
      _p.underBudgetEvals++;
      _p.overBudgetEvals = 0;
    } else {
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
    }

    const minNear = gameState.isMobile ? 15 : 24;
    const minFar = gameState.isMobile ? 20 : 34;
    const minCull = gameState.isMobile ? 2000 : 4200;

    if (_p.overBudgetEvals >= 2) {
      VIEW_NEAR = max(minNear, VIEW_NEAR - 1);
      VIEW_FAR = max(minFar, VIEW_FAR - 1);
      CULL_DIST = max(minCull, CULL_DIST - 250);
      _p.cooldown = _now + 6000;
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
    } else if (_p.underBudgetEvals >= 3) {
      VIEW_NEAR = min(35, VIEW_NEAR + 1);
      VIEW_FAR = min(50, VIEW_FAR + 1);
      CULL_DIST = min(6000, CULL_DIST + 150);
      _p.cooldown = _now + 4000;
      _p.overBudgetEvals = 0;
      _p.underBudgetEvals = 0;
    }
  }

  /**
   * Updates sentinel glow/pulse data for terrain shaders.
   * Regenerated every frame to reflect infection state.
   */
  updateSentinelGlows() {
    terrain.sentinelGlows = [];
    for (let b of gameState.buildings) {
      if (b.type !== 4) continue;
      b.pulseTimer = (b.pulseTimer || 0) + 1;
      let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));
      if (inf) {
        if (b.pulseTimer >= SENTINEL_PULSE_INTERVAL) {
          b.pulseTimer = 0;
          terrain.addPulse(b.x, b.z, 1.0);
          if (typeof gameSFX !== 'undefined') {
            let hearDist = 2000;
            for (let p of gameState.players) {
              if (!p.dead && dist(p.ship.x, p.ship.y, p.ship.z, b.x, b.y, b.z) < hearDist) {
                gameSFX.playInfectionPulse(b.x, b.y, b.z);
                break;
              }
            }
          }
        }
      } else {
        terrain.sentinelGlows.push({ x: b.x, z: b.z, radius: b.w * 1.5 });
        if (b.pulseTimer >= SENTINEL_PULSE_INTERVAL) b.pulseTimer = 0;
      }
    }
  }
}

// Single global renderer instance
const gameRenderer = new GameRenderer();

// Backward-compatibility shims for pre-refactor global helper calls.
function setSceneLighting() {
  return gameRenderer.setSceneLighting();
}

function setup2DViewport() {
  return gameRenderer.setup2DViewport();
}
