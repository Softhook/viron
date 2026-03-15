// =============================================================================
// gameRenderer.js — All visual rendering (camera, 3D scene, HUD, UI)
//
// Consolidates all rendering logic: 3D scene composition per-viewport, lighting,
// particle effects, overlay rendering, and performance-adaptive quality scaling.
// Pure render-side logic with no physics or state mutations.
// =============================================================================

const POST_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
varying vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

const POST_FRAG = `
precision highp float;
varying vec2 vTexCoord;
uniform sampler2D uTex;
uniform bool uIsMobile;

// ACES tonemapping
vec3 ACESFilm(vec3 x) {
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}

void main() {
  vec2 uv = vTexCoord;
  if (uIsMobile) {
      uv.y = 1.0 - uv.y;
  }

  // 1. Read Base Texture
  vec3 col = texture2D(uTex, uv).rgb;
  
  // 5. Mild contrast boost to prevent bleaching
  col = mix(col, col * col * (3.0 - 2.0 * clamp(col, 0.0, 1.0)), 0.2);
  
  // 6. ACES Filmic Tone Mapping (lower exposure to recover highlights)
  col = ACESFilm(col * 0.95);

  gl_FragColor = vec4(col, 1.0);
}
`;

class GameRenderer {
  constructor() {
    this.sceneFBO = null;
    this.shakeAmount = 0;
  }

  /**
   * Triggers or increases camera shake intensity.
   * @param {number} amt Shake intensity (pixels of offset).
   */
  setShake(amt) {
    this.shakeAmount = Math.max(this.shakeAmount, amt);
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
    // Patch limits into the static perf profiles now that constants are defined.
    GameRenderer._PERF_PROFILE_MOBILE.limits = MOBILE_VIEW_LIMITS;
    GameRenderer._PERF_PROFILE_DESKTOP.limits = DESKTOP_VIEW_LIMITS;
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
    // Mobile: low-detail disc only (no glow halo spheres).
    // Desktop: reduced from 40×32 to 16×12 — p5 generates 2*detailX*detailY
    // triangles per sphere, so 40×32 = 2,560 → 16×12 = 384 triangles each.
    // The sun is always a small distant disc, so the extra polygons buy nothing visually.
    if (gameState.isMobile) {
      sphere(viewFarWorld * 0.038, 8, 6);
    } else {
      const sunDetailLongitude = 16, sunDetailLatitude = 12;
      sphere(viewFarWorld * 0.038, sunDetailLongitude, sunDetailLatitude);
      fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 80 * intensity);
      sphere(viewFarWorld * 0.057, sunDetailLongitude, sunDetailLatitude);
      fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 40 * intensity);
      sphere(viewFarWorld * 0.083, sunDetailLongitude, sunDetailLatitude);
    }
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
   * Computes camera eye/look vectors for a player's ship.
   * @private
   */
  _computeCamera(ship) {
    let camNear = gameState.firstPersonView ? 5 : 50;
    let camFar = VIEW_FAR * TILE * 1.5;
    let cx, cy, cz, lx, ly, lz;

    if (gameState.firstPersonView) {
      let cosPitch = cos(ship.pitch), sinPitch = sin(ship.pitch);
      cx = ship.x;
      cy = ship.y - 25;
      cz = ship.z;
      lx = ship.x + (-sin(ship.yaw) * cosPitch) * 500;
      ly = (ship.y - 25) + sinPitch * 500;
      lz = ship.z + (-cos(ship.yaw) * cosPitch) * 500;
    } else {
      cy = min(ship.y - 120, 140);
      cx = ship.x + 300 * sin(ship.yaw);
      cz = ship.z + 300 * cos(ship.yaw);

      // Constrain altitude to be above terrain and sea level
      let terrainY = terrain.getAltitude(cx, cz);
      cy = min(cy, terrainY - 60); // Maintain safety margin above surface

      lx = ship.x;
      ly = ship.y;
      lz = ship.z;
    }

    if (this.shakeAmount > 0.1) {
      let sx = (random() - 0.5) * this.shakeAmount;
      let sy = (random() - 0.5) * this.shakeAmount;
      let sz = (random() - 0.5) * this.shakeAmount;
      cx += sx; cy += sy; cz += sz;
      lx += sx; ly += sy; lz += sz;
    }

    return { camNear, camFar, cx, cy, cz, lx, ly, lz };
  }

  /**
   * Applies viewport + scissor for one split-screen region.
   * @private
   */
  _applyViewportScissor(gl, vx, vw, vh) {
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
  }

  /**
   * Sets perspective and camera transform for 3D scene draw.
   * @private
   */
  _setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    perspective(PI / 3, viewW / viewH, camNear, camFar);
    camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
  }

  /**
   * Draws shared opaque world/actor content.
   * @private
   */
  _drawSharedWorld(s, player, viewAspect, drawAimAssist) {
    this.setSceneLighting();
    terrain.drawLandscape(s, viewAspect, gameState.firstPersonView);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    this._drawEnemyBeams(s);
    for (let p of gameState.players) {
      if (!p.dead && (p !== player || !gameState.firstPersonView)) shipDisplay(p.ship, p.labelColor);
      renderProjectiles(p, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    if (drawAimAssist && typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
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
    let { camNear, camFar, cx, cy, cz, lx, ly, lz } = this._computeCamera(s);

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
    this._applyViewportScissor(gl, vx, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this._drawSharedWorld(s, player, viewW / viewH, true);
    particleSystem.renderHardParticles(cx, cy, cz, s.x, s.z);
    pop();
    this.sceneFBO.end();

    // Pass 2: Blit FBO to main canvas
    this._applyViewportScissor(gl, vx, vw, vh);
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
    this._applyViewportScissor(gl, vx, vw, vh);
    push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, this.sceneFBO);
    pop();
  }

  /**
   * Single-pass rendering (WebGL1 / no-FBO fallback).
   * @private
   */
  _renderSinglePass(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    this._applyViewportScissor(gl, vx, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this._drawSharedWorld(s, player, viewW / viewH, false);
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, null);
    if (typeof aimAssist !== 'undefined') aimAssist.drawDebug3D(s);
    pop();
  }

  /**
   * Draws shared 2D overlays: split-screen divider, level-complete banner,
   * and game-over screen.  Called from renderAllPlayers() in both the mobile
   * (direct-to-canvas) and desktop (masterFBO) branches so the code is not
   * duplicated between the two paths.
   * @private
   */
  _drawShared2DOverlay() {
    this.setup2DViewport();
    
    // Smooth transitions for gameplay dimming (e.g. resuming from pause)
    if (typeof HUD_Manager !== 'undefined') HUD_Manager.drawDimOverlay();

    if (gameState.numPlayers === 2) {

      stroke(0, 255, 0, 180); strokeWeight(2);
      line(0, -height / 2, 0, height / 2);
    }
    if (gameState.levelComplete) {
      noStroke(); fill(0, 255, 0); textAlign(CENTER, CENTER); textSize(40);
      text('LEVEL ' + gameState.level + ' COMPLETE', 0, 0);
    }
    if (gameState.mode === 'gameover') {
      _drawGameOverContent();
    }
    pop();
  }

  /**
   * Dispatches one 3D render pass per player and draws shared 2D overlay.
   */
  renderAllPlayers(gl) {
    // Decay camera shake
    this.shakeAmount *= 0.88;
    if (this.shakeAmount < 0.1) this.shakeAmount = 0;

    const h = height, pxDensity = pixelDensity();

    if (gameState.isMobile) {
      // Mobile: render directly to the canvas without an intermediate masterFBO.
      // Bypassing the FBO eliminates the expensive tile-flush stall that
      // Apple Silicon tile-based GPUs incur on every FBO begin()/end() pair, and
      // saves the full-screen post-processing resolve pass.  ACES tonemapping and
      // the contrast boost are cosmetic extras; correctness is not affected.
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      if (gameState.numPlayers === 1) {
        this.renderPlayerView(gl, gameState.players[0], 0, 0, width, h, pxDensity);
      } else {
        let hw = floor(width / 2);
        for (let pi = 0; pi < 2; pi++) {
          this.renderPlayerView(gl, gameState.players[pi], pi, pi * hw, hw, h, pxDensity);
        }
      }

      this._drawShared2DOverlay();
      return;
    }

    // Desktop: full masterFBO + post-processing (ACES tonemapping, contrast boost).
    if (!this.masterFBO) {
      this.masterFBO = createFramebuffer();
      this.postShader = createShader(POST_VERT, POST_FRAG);
      this._postShaderReady = false;
    }
    if (this.masterFBO.width !== width || this.masterFBO.height !== h) {
      this.masterFBO.resize(width, h);
    }

    this.masterFBO.begin();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (gameState.numPlayers === 1) {
      this.renderPlayerView(gl, gameState.players[0], 0, 0, width, h, pxDensity);
    } else {
      let hw = floor(width / 2);
      for (let pi = 0; pi < 2; pi++) {
        this.renderPlayerView(gl, gameState.players[pi], pi, pi * hw, hw, h, pxDensity);
      }
    }

    // Shared 2D overlay — drawn into masterFBO so it receives the same
    // ACES tonemapping and contrast post-processing as the 3D scene.
    this._drawShared2DOverlay();
    this.masterFBO.end();

    // Post-processing pass to screen — only uTex changes each frame.
    // uIsMobile is false on desktop and never changes; set it once after the
    // shader is first bound (shader() triggers lazy compilation in p5).
    this.setup2DViewport();
    gl.disable(gl.DEPTH_TEST);
    shader(this.postShader);
    if (!this._postShaderReady) {
      // Desktop-only path; no y-flip needed — set once after shader compiles.
      this.postShader.setUniform('uIsMobile', false);
      this._postShaderReady = true;
    }
    this.postShader.setUniform('uTex', this.masterFBO);

    noStroke();
    rectMode(CENTER);
    rect(0, 0, width, height);

    resetShader();
    gl.enable(gl.DEPTH_TEST);
    pop();
  }

  /**
   * Returns platform-tuned performance scaling thresholds.
   * Returns a reference to one of two pre-built static objects so that
   * updatePerformanceScaling() (called every frame) does not allocate.
   * @private
   */
  _getPerfProfile() {
    return gameState.isMobile
      ? GameRenderer._PERF_PROFILE_MOBILE
      : GameRenderer._PERF_PROFILE_DESKTOP;
  }

  /**
   * Clears streak counters used to trigger scale adjustments.
   * @private
   */
  _resetPerfCounters(perf) {
    perf.overBudgetEvals = 0;
    perf.underBudgetEvals = 0;
  }

  /**
   * Applies one quality-level reduction step.
   * @private
   */
  _applyPerfReduction(perf, now, profile) {
    VIEW_NEAR = max(profile.limits.near / 2, VIEW_NEAR - 1);
    VIEW_FAR = max(profile.limits.far / 2, VIEW_FAR - 1);
    CULL_DIST = max(profile.limits.cull / 2, CULL_DIST - 250);
    perf.cooldown = now + 6000;
    this._resetPerfCounters(perf);
  }

  /**
   * Applies one quality-level restoration step.
   * @private
   */
  _applyPerfRestore(perf, now, profile) {
    VIEW_NEAR = min(profile.limits.near, VIEW_NEAR + 1);
    VIEW_FAR = min(profile.limits.far, VIEW_FAR + 2);
    CULL_DIST = min(profile.limits.cull, CULL_DIST + 250);
    perf.cooldown = now + 4000;
    this._resetPerfCounters(perf);
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
        sortedBuf: new Float32Array(60),
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
    const perf = window._perf;
    const profile = this._getPerfProfile();

    perf.buf[perf.idx] = Math.min(deltaTime, 100);
    perf.idx = (perf.idx + 1) % 60;
    if (perf.idx === 0) perf.full = true;

    if (!perf.budgetSet && perf.full) {
      perf.sortedBuf.set(perf.buf);
      perf.sortedBuf.sort();
      const medMs = (perf.sortedBuf[29] + perf.sortedBuf[30]) / 2;
      const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
      perf.budgetMs = tierMs.reduce((b, c) => Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b);
      perf.budgetMs = Math.max(perf.budgetMs, 1000 / 60);
      perf.budgetSet = true;
    }

    const now = performance.now();
    if (!perf.full || now < perf.nextEval) return;
    perf.nextEval = now + 2000;

    perf.sortedBuf.set(perf.buf);
    perf.sortedBuf.sort();
    const p90ms = perf.sortedBuf[53];
    const canRestore = now >= perf.cooldown;

    if (p90ms > perf.budgetMs * profile.reduceRatio) {
      perf.overBudgetEvals++;
      perf.underBudgetEvals = 0;
    } else if (p90ms < perf.budgetMs * profile.restoreRatio && canRestore) {
      perf.underBudgetEvals++;
      perf.overBudgetEvals = 0;
    } else {
      this._resetPerfCounters(perf);
    }

    if (perf.overBudgetEvals >= 2) {
      this._applyPerfReduction(perf, now, profile);
    } else if (perf.underBudgetEvals >= 3) {
      this._applyPerfRestore(perf, now, profile);
    }
  }

  /**
   * Checks whether a sentinel building is on an infected tile.
   * @private
   */
  _isSentinelInfected(building) {
    return infection.has(tileKey(toTile(building.x), toTile(building.z)));
  }

  /**
   * True when any living player is close enough to hear a pulse.
   * Uses squared distance to avoid a sqrt per player per pulse.
   * @private
   */
  _canAnyPlayerHearPulse(x, y, z, hearDist) {
    const hearDistSq = hearDist * hearDist;
    for (let p of gameState.players) {
      if (!p.dead) {
        let dx = p.ship.x - x, dy = p.ship.y - y, dz = p.ship.z - z;
        if (dx * dx + dy * dy + dz * dz < hearDistSq) return true;
      }
    }
    return false;
  }

  /**
   * Handles infected sentinel interval tick.
   * @private
   */
  _handleInfectedSentinelPulse(building) {
    building._lastPulseMs = millis();
    terrain.addPulse(building.x, building.z, 1.0);

    if (typeof gameSFX === 'undefined') return;
    if (this._canAnyPlayerHearPulse(building.x, building.y, building.z, 2000)) {
      gameSFX.playInfectionPulse(building.x, building.y, building.z);
    }
  }

  /**
   * Handles non-infected sentinel visual state.
   * @private
   */
  _handleCleanSentinel(building) {
    // Cache the glow descriptor on the building object the first time we see it
    // so we never allocate a { x, z, radius } literal inside this per-frame hot path.
    // Assumes sentinel positions and sizes are static after world creation —
    // valid for all current sentinel types (spawned once, never moved or resized).
    if (!building._cachedGlow) {
      building._cachedGlow = { x: building.x, z: building.z, radius: building.w * 1.5 };
    }
    terrain.sentinelGlows.push(building._cachedGlow);
  }

  /**
   * Updates sentinel glow/pulse data for terrain shaders.
   * Regenerated every frame to reflect infection state.
   * Pulse interval is millisecond-based so it fires at the same wall-clock
   * rate regardless of display refresh rate.
   */
  updateSentinelGlows() {
    terrain.sentinelGlows.length = 0;  // reuse array — avoid per-frame GC allocation
    const now = millis();
    for (let building of gameState.buildings) {
      if (building.type !== 4) continue;

      // Initialize _lastPulseMs on first visit.  building.pulseTimer was set
      // in setup() as a ms-based stagger offset (floor(i*SENTINEL_PULSE_INTERVAL/n)):
      // the sentinel has already "run" that many ms of its first cycle, so the
      // first pulse fires after (SENTINEL_PULSE_INTERVAL - pulseTimer) ms from
      // game start.  The pulseTimer field is a one-time read; _lastPulseMs owns
      // the timing from this point on.
      if (building._lastPulseMs === undefined) {
        building._lastPulseMs = now - (building.pulseTimer || 0);
      }

      if (this._isSentinelInfected(building)) {
        if (now - building._lastPulseMs >= SENTINEL_PULSE_INTERVAL) {
          this._handleInfectedSentinelPulse(building);
        }
      } else {
        // Advance _lastPulseMs through whole intervals even while clean so that
        // a newly-infected sentinel fires on the next scheduled boundary instead
        // of immediately (which would happen if _lastPulseMs had stalled).
        while (now - building._lastPulseMs >= SENTINEL_PULSE_INTERVAL) {
          building._lastPulseMs += SENTINEL_PULSE_INTERVAL;
        }
        this._handleCleanSentinel(building);
      }
    }
  }

  /**
   * Draws vertical light beams from the sky connecting to each enemy.
   *
   * Mobile: skipped entirely — blendMode(ADD) over multiple overlapping
   * transparent cylinders is expensive on tile-based GPUs (Apple Silicon iPads)
   * and the effect is purely cosmetic.
   *
   * Desktop: reduced from 11 to 7 draw calls per in-range enemy by:
   *   • Dropping the near-invisible outer-aura cylinder (alpha 25)
   *   • Reducing torus rings from 2 to 1
   *   • Reducing ripple passes from 3 to 2
   *   • Lowering torus radial segments from 16 to 8
   * @private
   */
  _drawEnemyBeams(s) {
    if (typeof enemyManager === 'undefined' || !enemyManager.enemies) return;

    // Skip on mobile: blendMode(ADD) with overlapping transparent geometry
    // causes severe tile-flush stalls on Apple Silicon tile-based GPUs.
    if (gameState.isMobile) return;

    const beamHeight = 25000;
    const beamRadius = 14;
    const time = millis() / 1000.0;

    push();
    noStroke();
    blendMode(ADD);

    for (let e of enemyManager.enemies) {
      // Distance culling
      let dSq = (s.x - e.x) ** 2 + (s.z - e.z) ** 2;
      if (dSq > 6000 * 6000) continue;

      let col = enemyManager.getColor(e.type);
      let flicker = 0.8 + 0.2 * sin(time * 25.0 + e.id * 10.0);

      push();
      translate(e.x, e.y, e.z);

      // --- Energetic Ground Splash (single ring; was 2) ---
      let expand = (time * 1.5) % 1.0;
      let ringAlpha = (1.0 - expand) * 120 * flicker;
      push();
      rotateX(HALF_PI);
      fill(col[0], col[1], col[2], ringAlpha);
      torus(beamRadius * (2.0 + expand * 8.0), 2.0, 8, 4); // 16 → 8 segments
      pop();

      // --- Main Volumetric Beam (outer aura dropped; mid + core remain) ---
      push();
      translate(0, -beamHeight / 2 - 10, 0);
      fill(col[0], col[1], col[2], 70 * flicker);
      cylinder(beamRadius * 2.2, beamHeight, 6, 1, false, false);
      fill(255, 255, 255, 200 * flicker);
      cylinder(beamRadius * 0.5, beamHeight, 6, 1, false, false);
      pop();

      // --- High-Speed Energy Ripples (2 passes; was 3) ---
      const rippleRange = 8000;
      for (let i = 0; i < 2; i++) {
        let pOffset = (time * 2500.0 + e.id * 1000.0 + i * 2200.0) % rippleRange;
        let pY = -rippleRange + pOffset;
        let fadeEdge = 1500;
        let rippleAlphaMult = 1.0;
        // Fade ripples as they emerge from the sky so they don't pop in abruptly.
        if (pY < -rippleRange + fadeEdge) rippleAlphaMult = (pY + rippleRange) / fadeEdge;
        push();
        translate(0, pY, 0);
        fill(255, 255, 255, 130 * flicker * rippleAlphaMult);
        cylinder(beamRadius * 4.5, 120, 6, 1, false, false);
        fill(col[0], col[1], col[2], 90 * flicker * rippleAlphaMult);
        cylinder(beamRadius * 9.0, 30, 6, 1, false, false); // 8 → 6 segments
        pop();
      }

      pop();
    }

    blendMode(BLEND);
    pop();
  }
}

// Static performance profiles — referenced by _getPerfProfile() so that method
// never allocates an object.  MOBILE_VIEW_LIMITS and DESKTOP_VIEW_LIMITS are
// defined in constants.js before this file loads.
GameRenderer._PERF_PROFILE_MOBILE = {
  reduceRatio: 1.40,
  restoreRatio: 1.15,
  limits: null  // patched to MOBILE_VIEW_LIMITS in initialize() once constants are ready
};
GameRenderer._PERF_PROFILE_DESKTOP = {
  reduceRatio: 1.55,
  restoreRatio: 1.08,
  limits: null  // patched to DESKTOP_VIEW_LIMITS in initialize()
};

// Single global renderer instance
const gameRenderer = new GameRenderer();

// Backward-compatibility shims for pre-refactor global helper calls.
function setSceneLighting() {
  return gameRenderer.setSceneLighting();
}

function setup2DViewport() {
  return gameRenderer.setup2DViewport();
}
