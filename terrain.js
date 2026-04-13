// =============================================================================
// terrain.js — Core terrain generation, rendering, and shader management
//
// @exports   Terrain             — class definition
// @exports   terrain             — singleton
// =============================================================================


import { p } from './p5Context.js';
import {
  VIEW_FAR, TILE, CHUNK_SIZE, infection, getVironProfiler,
  chunkKey, tileKey
} from './constants.js';
import {
  TERRAIN_PALETTE_FLAT, TERRAIN_VERT, TERRAIN_FRAG,
  FILL_COLOR_FRAG, SHADOW_FRAG
} from './terrainShaders.js';
import { TerrainMath } from './terrainMath.js';
import { TerrainGeometry } from './terrainGeometry.js';
import { TerrainRender } from './terrainRender.js';
import { TerrainShadows } from './terrainShadows.js';
import { TerrainTrees } from './terrainTrees.js';
import { TerrainBuildings } from './terrainBuildings.js';
import { gameState } from './gameState.js';

/**
 * Enables stencil before drawing one shadow polygon.
 */
export function _beginShadowStencil() {
  const gl = p.drawingContext;
  gl.enable(gl.STENCIL_TEST);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-2.0, -5.0);
  gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  gl.stencilMask(0xFF);
}

/**
 * Disables the stencil test after drawing one shadow polygon.
 */
export function _endShadowStencil() {
  const gl = p.drawingContext;
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.disable(gl.STENCIL_TEST);
}

export const TREE_BATCH_SIZE = 4;
export const BUILDING_BATCH_SIZE = 2;
export const BAKE_BUDGET_MS = 4.0;

export class Terrain {
  constructor() {
    this.altCache = new Map();
    this.chunkCache = new Map();
    this.shader = null;
    this.shadowShader = null;
    this.activePulses = [];
    this.sentinelGlows = [];

    this._pulseArr = new Float32Array(20);
    this._glowArr = new Float32Array(64);
    this._uFogDistArr = new Float32Array(2);
    this._uFogColorArr = new Float32Array(3);
    this._uSunDirArr = new Float32Array(3);
    this._uSunColorArr = new Float32Array(3);
    this._uAmbLowArr = new Float32Array(3);
    this._uAmbHighArr = new Float32Array(3);
    this._uFillColorArr = new Float32Array(3);

    this._fogFarWorldSmoothed = VIEW_FAR * TILE;
    this._fogFrameStamp = -1;
    this._procTreeChunkCache = new Map();

    this._sunShadowBasis = { x: 0, y: 1, z: 0 };
    this._sunShadowFrame = -Infinity;

    this._renderPassId = 0;
    this._uniformUploadedPassId = [-1, -1];

    this._overlayCaches = new Map();
    this._treeBakeState = new Map();
    this._treeShadowChunkCache = new Map();
    this._buildingBakeState = new Map();
    this._buildingShadowChunkCache = new Map();
    this._bakedShadowSun = { x: 0, y: 1, z: 0 };
    this._buildingBucketsCount = 0;
    this._isBuildingShadow = false;
    this._treeBakeFrame = -1;
    this._treeChunksBakedThisFrame = new Set();
    this._treeBakeBudgetUsedMs = 0;
    this._buildingBakeFrame = -1;
    this._buildingChunksBakedThisFrame = new Set();
    this._buildingBakeBudgetUsedMs = 0;

    infection.onInvalidate = (tx, tz) => {
      this._invalidateOverlay(0, tx, tz);
      this._invalidateChunkProps(tx, tz);
    };
  }

  // --- Delegation Methods ---

  getGridAltitude(tx, tz) { return TerrainMath.getGridAltitude(this, tx, tz); }
  getAltitude(x, z) { return TerrainMath.getAltitude(this, x, z); }
  getCameraParams(s, fp) { return TerrainMath.getCameraParams(s, fp); }
  resolveViewSource(s, fp) { return TerrainMath.resolveViewSource(this, s, fp); }
  inFrustum(cam, tx, tz) { return TerrainMath.inFrustum(cam, tx, tz); }
  _isChunkVisible(cam, cx, cz, ch) { return TerrainMath.isChunkVisible(cam, cx, cz, ch); }
  getFogFarWorld() { return TerrainMath.getFogFarWorld(this); }

  getChunkGeometry(cx, cz) { return TerrainGeometry.getChunkGeometry(this, cx, cz); }
  _safeBuildGeometry(cb) { return TerrainGeometry._safeBuildGeometry(cb); }
  _drawTileOverlays(m, tc, yo, cam, fs, tag, minCx, maxCx, minCz, maxCz) {
    return TerrainGeometry.drawTileOverlays(this, m, tc, yo, cam, fs, tag, minCx, maxCx, minCz, maxCz);
  }

  drawLandscape(s, va, fp) { return TerrainRender.drawLandscape(this, s, va, fp); }
  applyShader() { return TerrainRender.applyShader(this); }
  applyFillColorShader() { return TerrainRender.applyFillColorShader(this); }
  applyShadowShader() { return TerrainRender.applyShadowShader(this); }
  getFogFactor(d) {
    const fogFar = this.getFogFarWorld();
    return p.constrain(p.map(d, fogFar - 800, fogFar + 400, 0, 1), 0, 1);
  }

  // Trees / Buildings delegation
  getProceduralTreesForChunk(cx, cz) { return TerrainTrees.getProceduralTreesForChunk(this, cx, cz); }
  tryGetProceduralTree(tx, tz) { return TerrainTrees.tryGetProceduralTree(this, tx, tz); }
  drawTrees(s) { return TerrainTrees.drawTrees(this, s); }
  _getBuildingsForChunk(cx, cz) { return TerrainBuildings._getBuildingsForChunk(this, cx, cz); }
  drawBuildings(s) { return TerrainBuildings.drawBuildings(this, s); }

  // Shadow delegation
  _getSunShadowBasis() { return TerrainShadows.getSunShadowBasis(this); }
  _drawProjectedFootprintShadow(wx, wz, gy, ch, fp, a, s, float, bake) {
    return TerrainShadows.drawProjectedFootprintShadow(this, wx, wz, gy, ch, fp, a, s, float, bake);
  }
  _drawProjectedEllipseShadow(wx, wz, gy, ch, rx, rz, a, s, f) {
    return TerrainShadows.drawProjectedEllipseShadow(this, wx, wz, gy, ch, rx, rz, a, s, f);
  }

  // --- Core State Management (Kept in Terrain) ---

  init() {
    this.shader = p.createShader(TERRAIN_VERT, TERRAIN_FRAG);
    this.fillShader = p.createShader(TERRAIN_VERT, FILL_COLOR_FRAG);
    this.shadowShader = p.createShader(TERRAIN_VERT, SHADOW_FRAG);
  }

  addPulse(x, z, type = 0.0) {
    this.activePulses.unshift({ x, z, start: p.millis() / 1000.0, type });
    if (this.activePulses.length > 5) this.activePulses.length = 5;
  }

  clearCaches() {
    if (this.altCache.size > 100000) this.altCache.clear();
    if (this.chunkCache.size > 500) {
      const keys = this.chunkCache.keys();
      for (let i = 0; i < 250; i++) this.chunkCache.delete(keys.next().value);
    }
    if (this._procTreeChunkCache.size > 1200) {
      const keys = this._procTreeChunkCache.keys();
      for (let i = 0; i < 600; i++) this._procTreeChunkCache.delete(keys.next().value);
    }
    if (this._overlayCaches.size > 600) {
      const keys = this._overlayCaches.keys();
      for (let i = 0, n = this._overlayCaches.size >> 1; i < n; i++) this._overlayCaches.delete(keys.next().value);
    }
    if (this._treeBakeState.size > 600) {
      const keys = this._treeBakeState.keys();
      for (let i = 0, n = this._treeBakeState.size >> 1; i < n; i++) this._treeBakeState.delete(keys.next().value);
    }
    if (this._treeShadowChunkCache.size > 600) {
      const keys = this._treeShadowChunkCache.keys();
      for (let i = 0, n = this._treeShadowChunkCache.size >> 1; i < n; i++) this._treeShadowChunkCache.delete(keys.next().value);
    }
    if (this._buildingBakeState.size > 600) {
      const keys = this._buildingBakeState.keys();
      for (let i = 0, n = this._buildingBakeState.size >> 1; i < n; i++) this._buildingBakeState.delete(keys.next().value);
    }
    if (this._buildingShadowChunkCache.size > 600) {
      const keys = this._buildingShadowChunkCache.keys();
      for (let i = 0, n = this._buildingShadowChunkCache.size >> 1; i < n; i++) this._buildingShadowChunkCache.delete(keys.next().value);
    }
    if (this._geoms && this._geoms.size > 3000) {
      const keys = this._geoms.keys();
      for (let i = 0, n = this._geoms.size >> 1; i < n; i++) this._geoms.delete(keys.next().value);
    }
  }

  reset(seed) {
    if (seed !== undefined && seed === this._seed) {
      this.activePulses = [];
      return;
    }
    this._seed = seed;
    this.altCache.clear();
    this.chunkCache.clear();
    this._procTreeChunkCache.clear();
    this._overlayCaches.clear();
    if (this._overlayDirtyQueue) this._overlayDirtyQueue.clear();
    this._treeBakeState.clear();
    this._treeShadowChunkCache.clear();
    this._buildingBakeState.clear();
    this._buildingShadowChunkCache.clear();
    this._treeBakeFrame = -1;
    this._treeChunksBakedThisFrame.clear();
    this._treeBakeBudgetUsedMs = 0;
    this._buildingBakeFrame = -1;
    this._buildingChunksBakedThisFrame.clear();
    this._buildingBakeBudgetUsedMs = 0;
    this._buildingBucketsCount = 0;
    if (this._buildingBuckets) this._buildingBuckets.clear();
    if (this._geoms) this._geoms.clear();
    this._fogFrameStamp = -1;
  }

  _invalidateOverlay(managerId, tx, tz) {
    const bk = chunkKey(tx >> 4, tz >> 4);
    if (!this._overlayDirtyQueue) this._overlayDirtyQueue = new Set();
    this._overlayDirtyQueue.add(`${managerId}_${bk}`);
  }

  _invalidateChunkProps(tx, tz) {
    const cx = tx >> 4, cz = tz >> 4;
    const bk = `${cx},${cz}`;
    const k = tileKey(tx, tz);

    let treeHit = false;
    const trees = this.getProceduralTreesForChunk(cx, cz);
    for (let i = 0; i < trees.length; i++) {
        if (trees[i].k === k) { treeHit = true; break; }
    }
    if (treeHit) this._treeBakeState.delete(bk);

    let bldgHit = false;
    const bldgs = this._getBuildingsForChunk(cx, cz);
    for (let i = 0; i < bldgs.length; i++) {
        if (bldgs[i]._tileKey === k) { bldgHit = true; break; }
    }
    if (bldgHit) this._buildingBakeState.delete(bk);
  }

  setFillColor(r, g, b) { return TerrainRender.setFillColor(this, r, g, b); }
  setScanlineWeight(w) { if (this.fillShader) this.fillShader.setUniform('uScanlineWeight', w);  }
}

// ---------------------------------------------------------------------------
// Global Compatibility Aliases
// ---------------------------------------------------------------------------
// These provide backward compatibility for legacy rendering code (Enemies, 
// Villagers, Wizards) that expects these functions in the global scope.
export const _safeBuildGeometry = (cb) => TerrainGeometry._safeBuildGeometry(cb);
export const getFogFarWorld = () => TerrainMath.getFogFarWorld(terrain);

// Singleton instance
export const terrain = new Terrain();
