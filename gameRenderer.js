// =============================================================================
// gameRenderer.js — All visual rendering (camera, 3D scene, HUD, UI)
//
// Consolidates all rendering logic: 3D scene composition per-viewport, lighting,
// particle effects, overlay rendering, and performance-adaptive quality scaling.
// Pure render-side logic with no physics or state mutations.
//
// @exports   GameRenderer     — class definition
// @exports   gameRenderer     — singleton
// @exports   setSceneLighting  — compat shim (delegates to gameRenderer)
// @exports   setup2DViewport   — compat shim (delegates to gameRenderer)
// @exports   drawBackgroundLandscape
// =============================================================================

import { p } from './p5Context.js';
import {
  AMBIENT_R, AMBIENT_G, AMBIENT_B,
  SUN_KEY_R, SUN_KEY_G, SUN_KEY_B,
  SUN_DIR_NX, SUN_DIR_NY, SUN_DIR_NZ,
  VIEW_NEAR, VIEW_FAR, TILE, CULL_DIST,
  MOBILE_VIEW_LIMITS, DESKTOP_VIEW_LIMITS,
  SKY_R, SKY_G, SKY_B,
  setViewDistances, getVironProfiler,
  SENTINEL_PULSE_INTERVAL, infection, tileKey, toTile
} from './constants.js';
import { gameState } from './gameState.js';
import { terrain } from './terrain.js';
import { enemyManager } from './enemies.js';
import { particleSystem, ParticleSystem } from './particles.js';
import { villagerManager } from './villagers.js';
import { wizardManager } from './wizards.js';
import { drawPlayerHUD } from './hudComponents.js';
import { shipDisplay } from './player.js';
import { renderInFlightBarriers, renderProjectiles } from './projectiles.js';
import { HUD_Manager } from './hudCore.js';
import { aimAssist } from './aimAssist.js';
import { mobileController } from './mobileControls.js';
import { gameSFX } from './sfx.js';

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
void main() {
  // Final desktop resolve pass: copy the composed masterFBO to screen.
  // Tonemapping is intentionally not applied in this shader.
  gl_FragColor = texture2D(uTex, vTexCoord);
}
`;

function _drawGameOverContent() {
  p.drawingContext.clear(p.drawingContext.DEPTH_BUFFER_BIT);

  if (gameState.gameFont) p.textFont(gameState.gameFont);
  p.fill(255, 60, 60);
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(80);
  p.text('GAME OVER', 0, -50);

  p.textSize(24);
  p.fill(180, 200, 180);
  p.text(gameState.gameOverReason || 'INFECTION REACHED CRITICAL MASS', 0, 40);

  p.textSize(18);
  p.fill(180, 200, 180, 160);
  p.text(gameState.isMobile ? 'TAP TO CONTINUE' : 'PRESS ENTER TO CONTINUE', 0, p.height * 0.35);

  if (p.millis() - gameState.levelEndTime > 5000) {
    gameState.mode = 'menu';
  }
}

export class GameRenderer {
  constructor() {
    this.sceneFBO = null;
    this.masterFBO = null;
    this.postShader = null;
    this.shakeAmount = 0;
  }

  setShake(amt) {
    this.shakeAmount = Math.max(this.shakeAmount, amt);
  }

  initialize(isMobile) {
    if (!isMobile) {
      ParticleSystem.init();
    }
    this.sceneFBO = null;
    GameRenderer._PERF_PROFILE_MOBILE.limits = MOBILE_VIEW_LIMITS;
    GameRenderer._PERF_PROFILE_DESKTOP.limits = DESKTOP_VIEW_LIMITS;
  }

  setSceneLighting() {
    p.noLights();
    p.specularColor(0, 0, 0);
    p.specularMaterial(0);
    p.shininess(0);
    p.ambientLight(AMBIENT_R, AMBIENT_G, AMBIENT_B);
    p.directionalLight(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, SUN_DIR_NX, SUN_DIR_NY, SUN_DIR_NZ);
  }

  drawSunInWorld(cx, cy, cz, viewFarWorld, intensity = 1.0) {
    const toSunX = -SUN_DIR_NX;
    const toSunY = -SUN_DIR_NY;
    const toSunZ = -SUN_DIR_NZ;
    const sunDist = viewFarWorld * 1.4;
    const sunPosX = cx + toSunX * sunDist;
    const sunHeight = cy + toSunY * sunDist;
    const sunPosZ = cz + toSunZ * sunDist;

    p.push();
    p.noStroke();
    p.blendMode(p.ADD);
    p.push();
    p.translate(sunPosX, sunHeight, sunPosZ);
    p.emissiveMaterial(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B);
    if (gameState.isMobile) {
      p.sphere(viewFarWorld * 0.038, 8, 6);
    } else {
      const sunDetailLongitude = 16;
      const sunDetailLatitude = 12;
      p.sphere(viewFarWorld * 0.038, sunDetailLongitude, sunDetailLatitude);
      p.fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 80 * intensity);
      p.sphere(viewFarWorld * 0.057, sunDetailLongitude, sunDetailLatitude);
      p.fill(SUN_KEY_R, SUN_KEY_G, SUN_KEY_B, 40 * intensity);
      p.sphere(viewFarWorld * 0.083, sunDetailLongitude, sunDetailLatitude);
    }
    p.pop();
    p.blendMode(p.BLEND);
    p.pop();
  }

  setup2DViewport() {
    const pxD = p.pixelDensity();
    p.drawingContext.viewport(0, 0, p.width * pxD, p.height * pxD);
    p.push();
    p.ortho(-p.width / 2, p.width / 2, -p.height / 2, p.height / 2, 0, 1000);
    p.resetMatrix();
  }

  _computeCamera(ship) {
    const camNear = gameState.firstPersonView ? 5 : 50;
    const camFar = VIEW_FAR * TILE * 1.5;
    let cx;
    let cy;
    let cz;
    let lx;
    let ly;
    let lz;

    if (gameState.firstPersonView) {
      const cosPitch = Math.cos(ship.pitch);
      const sinPitch = Math.sin(ship.pitch);
      cx = ship.x;
      cy = ship.y - 25;
      cz = ship.z;
      lx = ship.x + (-Math.sin(ship.yaw) * cosPitch) * 500;
      ly = (ship.y - 25) + sinPitch * 500;
      lz = ship.z + (-Math.cos(ship.yaw) * cosPitch) * 500;
    } else {
      cy = Math.min(ship.y - 120, 140);
      cx = ship.x + 300 * Math.sin(ship.yaw);
      cz = ship.z + 300 * Math.cos(ship.yaw);

      const terrainY = terrain.getAltitude(cx, cz);
      cy = Math.min(cy, terrainY - 60);

      lx = ship.x;
      ly = ship.y;
      lz = ship.z;
    }

    if (this.shakeAmount > 0.1) {
      const sx = (p.random() - 0.5) * this.shakeAmount;
      const sy = (p.random() - 0.5) * this.shakeAmount;
      const sz = (p.random() - 0.5) * this.shakeAmount;
      cx += sx;
      cy += sy;
      cz += sz;
      lx += sx;
      ly += sy;
      lz += sz;
    }

    return { camNear, camFar, cx, cy, cz, lx, ly, lz };
  }

  _applyViewportScissor(gl, vx, vw, vh) {
    gl.viewport(vx, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, 0, vw, vh);
  }

  _setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    p.perspective(Math.PI / 3, viewW / viewH, camNear, camFar);
    p.camera(cx, cy, cz, lx, ly, lz, 0, 1, 0);
  }

  _drawSharedWorld(s, player, viewAspect, drawAimAssist) {
    this.setSceneLighting();
    terrain.drawLandscape(s, viewAspect, gameState.firstPersonView);
    terrain.drawTrees(s);
    terrain.drawBuildings(s);
    enemyManager.draw(s);
    villagerManager?.draw(s);
    wizardManager?.draw(s);
    this._drawEnemyBeams(s);
    for (const plyr of gameState.players) {
      if (!plyr.dead && (plyr !== player || !gameState.firstPersonView)) shipDisplay(plyr.ship, plyr.labelColor);
      renderProjectiles(plyr, s.x, s.z);
    }
    renderInFlightBarriers(s.x, s.z);
    if (drawAimAssist && aimAssist) aimAssist.drawDebug3D(s);
  }

  renderPlayerView(gl, player, playerIdx, viewX, viewW, viewH, pxDensity) {
    const s = player.ship;
    const vx = viewX * pxDensity;
    const vw = viewW * pxDensity;
    const vh = viewH * pxDensity;
    const { camNear, camFar, cx, cy, cz, lx, ly, lz } = this._computeCamera(s);

    gameSFX?.updateListener(cx, cy, cz, lx, ly, lz, 0, 1, 0);

    if (this.sceneFBO) {
      this._renderWithFBO(gl, s, player, viewX, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    } else {
      this._renderSinglePass(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    }
    gl.clear(gl.DEPTH_BUFFER_BIT);
    drawPlayerHUD(player, playerIdx, viewW, viewH);
    if ((gameState.isMobile || mobileController?.debug) && gameState.numPlayers === 1 && mobileController) {
      mobileController.draw(p.width, p.height);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  _renderWithFBO(gl, s, player, viewX, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    this.sceneFBO.begin();
    this._applyViewportScissor(gl, vx, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    p.push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this._drawSharedWorld(s, player, viewW / viewH, true);

    const profiler = getVironProfiler();
    let pStart = profiler ? performance.now() : 0;
    particleSystem.renderHardParticles(cx, cy, cz, s.x, s.z);
    if (profiler) profiler.record('particles', performance.now() - pStart);
    p.pop();
    this.sceneFBO.end();

    this._applyViewportScissor(gl, vx, vw, vh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    p.push();
    p.ortho(-viewW / 2, viewW / 2, -viewH / 2, viewH / 2, -1, 1);
    p.resetMatrix();
    p.imageMode(p.CORNER);
    gl.disable(gl.DEPTH_TEST);
    p.image(this.sceneFBO, -viewW / 2, -viewH / 2, viewW, viewH, viewX, 0, viewW, viewH);
    gl.enable(gl.DEPTH_TEST);
    p.pop();

    this._applyViewportScissor(gl, vx, vw, vh);
    p.push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    pStart = profiler ? performance.now() : 0;
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, this.sceneFBO);
    if (profiler) profiler.record('particles', performance.now() - pStart);
    p.pop();
  }

  _renderSinglePass(gl, s, player, vx, vw, vh, viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz) {
    this._applyViewportScissor(gl, vx, vw, vh);
    gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    p.push();
    this._setupSceneCamera(viewW, viewH, camNear, camFar, cx, cy, cz, lx, ly, lz);
    this.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 1.0);
    this._drawSharedWorld(s, player, viewW / viewH, false);

    const profiler = getVironProfiler();
    const pStart = profiler ? performance.now() : 0;
    particleSystem.render(s.x, s.z, cx, cy, cz, camNear, camFar, null);
    if (profiler) profiler.record('particles', performance.now() - pStart);
    if (aimAssist) aimAssist.drawDebug3D(s);
    p.pop();
  }

  _drawShared2DOverlay() {
    this.setup2DViewport();

    HUD_Manager?.drawDimOverlay();

    if (gameState.numPlayers === 2) {
      p.stroke(0, 255, 0, 180);
      p.strokeWeight(2);
      p.line(0, -p.height / 2, 0, p.height / 2);
    }
    if (gameState.levelComplete) {
      p.noStroke();
      p.fill(0, 255, 0);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(40);
      p.text('LEVEL ' + gameState.level + ' COMPLETE', 0, 0);
    }
    if (gameState.mode === 'gameover') {
      _drawGameOverContent();
    }
    p.pop();
  }

  renderAllPlayers(gl) {
    this.shakeAmount *= 0.88;
    if (this.shakeAmount < 0.1) this.shakeAmount = 0;

    const h = p.height;
    const pxDensity = p.pixelDensity();

    if (gameState.isMobile) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      if (gameState.numPlayers === 1) {
        this.renderPlayerView(gl, gameState.players[0], 0, 0, p.width, h, pxDensity);
      } else {
        const hw = Math.floor(p.width / 2);
        for (let pi = 0; pi < 2; pi++) {
          this.renderPlayerView(gl, gameState.players[pi], pi, pi * hw, hw, h, pxDensity);
        }
      }

      this._drawShared2DOverlay();
      return;
    }

    if (!this.masterFBO) {
      this.masterFBO = p.createFramebuffer();
      this.postShader = p.createShader(POST_VERT, POST_FRAG);
    }
    if (this.masterFBO.width !== p.width || this.masterFBO.height !== h) {
      this.masterFBO.resize(p.width, h);
    }

    this.masterFBO.begin();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (gameState.numPlayers === 1) {
      this.renderPlayerView(gl, gameState.players[0], 0, 0, p.width, h, pxDensity);
    } else {
      const hw = Math.floor(p.width / 2);
      for (let pi = 0; pi < 2; pi++) {
        this.renderPlayerView(gl, gameState.players[pi], pi, pi * hw, hw, h, pxDensity);
      }
    }

    this._drawShared2DOverlay();
    this.masterFBO.end();

    this.setup2DViewport();
    gl.disable(gl.DEPTH_TEST);
    p.shader(this.postShader);
    this.postShader.setUniform('uTex', this.masterFBO);

    p.noStroke();
    p.rectMode(p.CENTER);
    p.rect(0, 0, p.width, p.height);

    p.resetShader();
    gl.enable(gl.DEPTH_TEST);
    p.pop();
  }

  _getPerfProfile() {
    return gameState.isMobile
      ? GameRenderer._PERF_PROFILE_MOBILE
      : GameRenderer._PERF_PROFILE_DESKTOP;
  }

  _resetPerfCounters(perf) {
    perf.overBudgetEvals = 0;
    perf.underBudgetEvals = 0;
  }

  _applyPerfReduction(perf, now, profile) {
    const nextNear = Math.max(profile.limits.near / 2, VIEW_NEAR - 1);
    const nextFar = Math.max(profile.limits.far / 2, VIEW_FAR - 1);
    const nextCull = Math.max(profile.limits.cull / 2, CULL_DIST - 250);
    setViewDistances(nextNear, nextFar, nextCull);
    perf.cooldown = now + 6000;
    this._resetPerfCounters(perf);
  }

  _applyPerfRestore(perf, now, profile) {
    const nextNear = Math.min(profile.limits.near, VIEW_NEAR + 1);
    const nextFar = Math.min(profile.limits.far, VIEW_FAR + 2);
    const nextCull = Math.min(profile.limits.cull, CULL_DIST + 250);
    setViewDistances(nextNear, nextFar, nextCull);
    perf.cooldown = now + 4000;
    this._resetPerfCounters(perf);
  }

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

    perf.buf[perf.idx] = Math.min(p.deltaTime, 100);
    perf.idx = (perf.idx + 1) % 60;
    if (perf.idx === 0) perf.full = true;

    if (!perf.budgetSet && perf.full) {
      perf.sortedBuf.set(perf.buf);
      perf.sortedBuf.sort();
      const medMs = (perf.sortedBuf[29] + perf.sortedBuf[30]) / 2;
      const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
      perf.budgetMs = tierMs.reduce((b, c) => (Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b));
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

  _isSentinelInfected(building) {
    return infection.has(tileKey(toTile(building.x), toTile(building.z)));
  }

  _canAnyPlayerHearPulse(x, y, z, hearDist) {
    const hearDistSq = hearDist * hearDist;
    for (const plyr of gameState.players) {
      if (!plyr.dead) {
        const dx = plyr.ship.x - x;
        const dy = plyr.ship.y - y;
        const dz = plyr.ship.z - z;
        if (dx * dx + dy * dy + dz * dz < hearDistSq) return true;
      }
    }
    return false;
  }

  _handleInfectedSentinelPulse(building) {
    building._lastPulseMs = p.millis();
    terrain.addPulse(building.x, building.z, 1.0);

    if (!gameSFX) return;
    if (this._canAnyPlayerHearPulse(building.x, building.y, building.z, 2000)) {
      gameSFX.playInfectionPulse(building.x, building.y, building.z);
    }
  }

  _handleCleanSentinel(building) {
    if (!building._cachedGlow) {
      building._cachedGlow = { x: building.x, z: building.z, radius: building.w * 1.5 };
    }
    terrain.sentinelGlows.push(building._cachedGlow);
  }

  updateSentinelGlows() {
    terrain.sentinelGlows.length = 0;
    const now = p.millis();
    for (const building of gameState.buildings) {
      if (building.type !== 4) continue;

      if (building._lastPulseMs === undefined) {
        building._lastPulseMs = now - (building.pulseTimer || 0);
      }

      if (this._isSentinelInfected(building)) {
        if (now - building._lastPulseMs >= SENTINEL_PULSE_INTERVAL) {
          this._handleInfectedSentinelPulse(building);
        }
      } else {
        while (now - building._lastPulseMs >= SENTINEL_PULSE_INTERVAL) {
          building._lastPulseMs += SENTINEL_PULSE_INTERVAL;
        }
        this._handleCleanSentinel(building);
      }
    }
  }

  _drawEnemyBeams(s) {
    if (!enemyManager?.enemies) return;
    if (gameState.isMobile) return;

    const beamHeight = 25000;
    const beamRadius = 14;
    const time = p.millis() / 1000.0;

    p.push();
    p.noStroke();
    p.blendMode(p.ADD);

    for (const e of enemyManager.enemies) {
      const dSq = (s.x - e.x) ** 2 + (s.z - e.z) ** 2;
      if (dSq > 6000 * 6000) continue;

      const col = enemyManager.getColor(e.type);
      const flicker = 0.8 + 0.2 * Math.sin(time * 25.0 + e.id * 10.0);

      p.push();
      p.translate(e.x, e.y, e.z);

      const expand = (time * 1.5) % 1.0;
      const ringAlpha = (1.0 - expand) * 120 * flicker;
      p.push();
      p.rotateX(p.HALF_PI);
      p.fill(col[0], col[1], col[2], ringAlpha);
      p.torus(beamRadius * (2.0 + expand * 8.0), 2.0, 8, 4);
      p.pop();

      p.push();
      p.translate(0, -beamHeight / 2 - 10, 0);
      p.fill(col[0], col[1], col[2], 70 * flicker);
      p.cylinder(beamRadius * 2.2, beamHeight, 6, 1, false, false);
      p.fill(255, 255, 255, 200 * flicker);
      p.cylinder(beamRadius * 0.5, beamHeight, 6, 1, false, false);
      p.pop();

      const rippleRange = 8000;
      for (let i = 0; i < 2; i++) {
        const pOffset = (time * 2500.0 + e.id * 1000.0 + i * 2200.0) % rippleRange;
        const pY = -rippleRange + pOffset;
        const fadeEdge = 1500;
        let rippleAlphaMult = 1.0;
        if (pY < -rippleRange + fadeEdge) rippleAlphaMult = (pY + rippleRange) / fadeEdge;
        p.push();
        p.translate(0, pY, 0);
        p.fill(255, 255, 255, 130 * flicker * rippleAlphaMult);
        p.cylinder(beamRadius * 4.5, 120, 6, 1, false, false);
        p.fill(col[0], col[1], col[2], 90 * flicker * rippleAlphaMult);
        p.cylinder(beamRadius * 9.0, 30, 6, 1, false, false);
        p.pop();
      }

      p.pop();
    }

    p.blendMode(p.BLEND);
    p.pop();
  }
}

export function drawBackgroundLandscape() {
  const gl = p.drawingContext;
  gl.clearColor(SKY_R / 255, SKY_G / 255, SKY_B / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

  const t = p.millis() * 0.00008;
  const orbit = 1800;
  const cx = Math.cos(t) * orbit;
  const cz = Math.sin(t) * orbit;
  const cy = -380;
  const ly = terrain.getAltitude(0, 0) - 120;
  const cam = {
    x: cx,
    z: cz,
    fwdX: -cx / orbit,
    fwdZ: -cz / orbit,
    pitch: 0
  };

  p.push();
  p.perspective(Math.PI / 3, p.width / p.height, 30, VIEW_FAR * TILE * 1.8);
  p.camera(cx, cy, cz, 0, ly, 0, 0, 1, 0);
  gameRenderer.setSceneLighting();
  gameRenderer.drawSunInWorld(cx, cy, cz, VIEW_FAR * TILE, 0.8);
  terrain.drawLandscape(cam, p.width / p.height, false);
  terrain.drawTrees(cam);
  terrain.drawBuildings(cam);
  p.pop();
}

GameRenderer._PERF_PROFILE_MOBILE = {
  reduceRatio: 1.40,
  restoreRatio: 1.15,
  limits: null
};
GameRenderer._PERF_PROFILE_DESKTOP = {
  reduceRatio: 1.55,
  restoreRatio: 1.08,
  limits: null
};

export const gameRenderer = new GameRenderer();

export function setSceneLighting() {
  return gameRenderer.setSceneLighting();
}

export function setup2DViewport() {
  return gameRenderer.setup2DViewport();
}
