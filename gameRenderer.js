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
uniform float uTime;
uniform vec2 uResolution;
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
  
  // 8. Subtle holographic scanlines (Simplified without length())
  // float scanline = sin(uv.y * uResolution.y * 2.0) * 0.03;
  // col -= scanline; // Fixed subtractive blend

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
   * Dispatches one 3D render pass per player and draws shared 2D overlay.
   */
  renderAllPlayers(gl) {
    // Decay camera shake
    this.shakeAmount *= 0.88;
    if (this.shakeAmount < 0.1) this.shakeAmount = 0;

    const h = height, pxDensity = pixelDensity();

    if (!this.masterFBO) {
      this.masterFBO = createFramebuffer();
      this.postShader = createShader(POST_VERT, POST_FRAG);
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
    // mobile y-flip treatment (POST_FRAG uv.y inversion) as the 3D scene.
    // Game-over overlay is included here specifically to fix the mirror-reversed
    // text seen on mobile when the overlay was drawn outside the FBO pipeline.
    this.setup2DViewport();
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
    this.masterFBO.end();

    // Post-processing pass to screen
    this.setup2DViewport();
    gl.disable(gl.DEPTH_TEST);
    shader(this.postShader);
    this.postShader.setUniform('uTex', this.masterFBO);
    this.postShader.setUniform('uTime', millis() / 1000.0);
    this.postShader.setUniform('uResolution', [width, height]);
    this.postShader.setUniform('uIsMobile', gameState.isMobile);
    
    noStroke();
    rectMode(CENTER);
    rect(0, 0, width, height);
    
    resetShader();
    gl.enable(gl.DEPTH_TEST);
    pop();
  }

  /**
   * Returns platform-tuned performance scaling thresholds.
   * @private
   */
  _getPerfProfile() {
    if (gameState.isMobile) {
      return {
        reduceRatio: 1.40,
        restoreRatio: 1.15,
        limits: MOBILE_VIEW_LIMITS
      };
    }
    return {
      reduceRatio: 1.55,
      restoreRatio: 1.08,
      limits: DESKTOP_VIEW_LIMITS
    };
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
    VIEW_FAR = min(profile.limits.far, VIEW_FAR + 1);
    CULL_DIST = min(profile.limits.cull, CULL_DIST + 150);
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
      if (!gameState.isMobile) perf.budgetMs = Math.max(perf.budgetMs, 1000 / 60);
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
   * @private
   */
  _canAnyPlayerHearPulse(x, y, z, hearDist) {
    for (let p of gameState.players) {
      if (!p.dead && dist(p.ship.x, p.ship.y, p.ship.z, x, y, z) < hearDist) {
        return true;
      }
    }
    return false;
  }

  /**
   * Handles infected sentinel interval tick.
   * @private
   */
  _handleInfectedSentinelPulse(building) {
    building.pulseTimer = 0;
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
    terrain.sentinelGlows.push({ x: building.x, z: building.z, radius: building.w * 1.5 });
    if (building.pulseTimer >= SENTINEL_PULSE_INTERVAL) building.pulseTimer = 0;
  }

  /**
   * Updates sentinel glow/pulse data for terrain shaders.
   * Regenerated every frame to reflect infection state.
   */
  updateSentinelGlows() {
    terrain.sentinelGlows = [];
    for (let building of gameState.buildings) {
      if (building.type !== 4) continue;
      building.pulseTimer = (building.pulseTimer || 0) + 1;

      if (this._isSentinelInfected(building)) {
        if (building.pulseTimer >= SENTINEL_PULSE_INTERVAL) {
          this._handleInfectedSentinelPulse(building);
        }
      } else {
        this._handleCleanSentinel(building);
      }
    }
  }

  /**
   * Draws vertical light beams from the sky connecting to each enemy.
   * @private
   */
  _drawEnemyBeams(s) {
    if (typeof enemyManager === 'undefined' || !enemyManager.enemies) return;
    
    // Increased height significantly to simulate an 'infinite' beam. 
    // 25,000 is far beyond the typical flight ceiling.
    const beamHeight = 25000;
    const beamRadius = 14;
    const time = millis() / 1000.0;
    
    push();
    noStroke();
    // Use ADD blend for glowing volumetric effect
    blendMode(ADD);
    
    for (let e of enemyManager.enemies) {
      // Distance culling
      let dSq = (s.x - e.x) ** 2 + (s.z - e.z) ** 2;
      if (dSq > 6000 * 6000) continue;
      
      let col = enemyManager.getColor(e.type);
      let flicker = 0.8 + 0.2 * sin(time * 25.0 + e.id * 10.0);
      
      push();
      translate(e.x, e.y, e.z);
      
      // --- Energetic Ground Splash (Rings at base) ---
      for (let i = 0; i < 2; i++) {
        let expand = ((time * 1.5 + i * 0.5) % 1.0);
        let ringAlpha = (1.0 - expand) * 120 * flicker;
        push();
        rotateX(HALF_PI);
        fill(col[0], col[1], col[2], ringAlpha);
        torus(beamRadius * (2.0 + expand * 8.0), 2.0, 16, 4);
        pop();
      }
      
      // --- The Main Volumetric Beam (Starts at enemy, goes WAY up) ---
      push();
      translate(0, -beamHeight / 2 - 10, 0); 
      
      // Outer aura
      fill(col[0], col[1], col[2], 25 * flicker);
      cylinder(beamRadius * 6.0, beamHeight, 6, 1, false, false);
      
      // Mid energy column
      fill(col[0], col[1], col[2], 70 * flicker);
      cylinder(beamRadius * 2.2, beamHeight, 6, 1, false, false);
      
      // Intelligent Core
      fill(255, 255, 255, 200 * flicker);
      cylinder(beamRadius * 0.5, beamHeight, 6, 1, false, false);
      pop();
      
      // --- High-Speed Energy Ripples (Moving down from sky) ---
      // We limit ripples to the lower 8000 units so they are dense around the player
      const rippleRange = 8000;
      for (let i = 0; i < 3; i++) {
        let pOffset = (time * 2500.0 + e.id * 1000.0 + i * 2200.0) % rippleRange;
        let pY = -rippleRange + pOffset;
        
        // Fade ripples as they get higher to simulate them emerging from the sky
        let fadeEdge = 1500;
        let rippleAlphaMult = 1.0;
        if (pY < -rippleRange + fadeEdge) rippleAlphaMult = (pY + rippleRange) / fadeEdge;
        
        push();
        translate(0, pY, 0);
        fill(255, 255, 255, 130 * flicker * rippleAlphaMult);
        cylinder(beamRadius * 4.5, 120, 6, 1, false, false);
        fill(col[0], col[1], col[2], 90 * flicker * rippleAlphaMult);
        cylinder(beamRadius * 9.0, 30, 8, 1, false, false);
        pop();
      }
      
      pop();
    }
    
    blendMode(BLEND);
    pop();
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
