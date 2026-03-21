// =============================================================================
// terrain.js — Core terrain generation, rendering, and shader management
//
// Palette data and GLSL shader sources live in terrainShaders.js.
// Building geometry and shadow footprint helpers live in buildingGeometry.js.
// Both files are loaded before this one in index.html.
// =============================================================================


// =============================================================================
// Shadow stencil helpers
// Shadow polygons use a NOTEQUAL/REPLACE stencil so each screen pixel is
// darkened at most once per viewport frame, regardless of how many shadow
// polygons overlap it.  gl.clear(STENCIL_BUFFER_BIT) is called once at the
// start of each viewport render (with scissor active) to reset the mask.
// =============================================================================

/**
 * Enables stencil before drawing one shadow polygon.
 * First shadow polygon covering a pixel writes stencil=1 and colours it;
 * any subsequent polygon covering the same pixel is discarded by the test.
 */
function _beginShadowStencil() {
  const gl = drawingContext;
  gl.enable(gl.STENCIL_TEST);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-2.0, -5.0);
  gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF);
  gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  gl.stencilMask(0xFF);
}

/**
 * Disables the stencil test after drawing one shadow polygon.
 * Stencil values are preserved so subsequent shadow draws in the same
 * viewport frame continue adding to the accumulated shadow mask.
 */
function _endShadowStencil() {
  const gl = drawingContext;
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.disable(gl.STENCIL_TEST);
}

// =============================================================================
// Safe buildGeometry wrapper
// =============================================================================
/**
 * Wraps p5's buildGeometry() with proper error recovery.
 *
 * p5's buildGeometry() calls beginGeometry() before the callback and
 * endGeometry() after it.  If the callback throws, endGeometry() is never
 * called, so p5's internal geometryBuilder reference stays set.  Every
 * subsequent call to buildGeometry() then fails immediately with:
 *   "beginGeometry() is being called while another p5.Geometry is already
 *    being built."
 * …poisoning all geometry caching for the rest of the session.
 *
 * This wrapper catches that situation, calls endGeometry() to flush the
 * stale geometryBuilder, and re-throws the original error so callers can
 * decide whether to retry or give up.
 *
 * If endGeometry() itself throws (e.g. finish()/pop() fails for any reason),
 * we fall back to directly resetting _renderer.geometryBuilder so the state
 * is always clean regardless of what went wrong.
 *
 * Performance: zero per-frame overhead. Every call site is behind a cache
 * check (chunkCache, _geoms, _shadowGeom), so _safeBuildGeometry only runs
 * once per unique geometry, after which the cache is returned directly.
 */
function _safeBuildGeometry(callback) {
  try {
    return buildGeometry(callback);
  } catch (err) {
    // Primary recovery: call endGeometry() to flush the stale geometryBuilder.
    let cleared = false;
    try { endGeometry(); cleared = true; } catch (_ignored) { /* already cleared or never set */ }

    // Belt-and-suspenders: if endGeometry() threw before it could set
    // geometryBuilder = undefined (e.g. finish()/pop() failed), force-clear
    // it directly so future buildGeometry() calls are never poisoned.
    if (!cleared) {
      try {
        if (typeof _renderer !== 'undefined' && _renderer && _renderer.geometryBuilder) {
          _renderer.geometryBuilder = undefined;
          // Balance the push() that GeometryBuilder constructor called.
          try { pop(); } catch (_e) { }
        }
      } catch (_ignored2) { }
    }
    throw err;
  }
}

// =============================================================================
// Terrain class
// =============================================================================
class Terrain {
  constructor() {
    /** @type {Map<string,number>} Memoised grid-point altitudes, keyed by "tx,tz". */
    this.altCache = new Map();

    /** @type {Map<string,p5.Geometry>} Pre-built chunk meshes, keyed by "cx,cz". */
    this.chunkCache = new Map();

    /** @type {p5.Shader|null} Compiled GLSL shader; null until init() is called. */
    this.shader = null;

    /** @type {p5.Shader|null} Shadow fog shader; null until init() is called. */
    this.shadowShader = null;

    /** @type {Array<{x,z,start,type}>} Up to 5 active shockwave pulses. */
    this.activePulses = [];

    /**
     * Positions of healthy (uninfected) sentinels for the steady glow shader.
     * Each entry: {x, z, radius}.  Uploaded each frame by sketch.js.
     * @type {Array<{x:number,z:number,radius:number}>}
     */
    this.sentinelGlows = [];

    // Pre-allocated uniform upload buffers — reused every frame to avoid GC churn.
    // pulseArr  : 5 pulses × 4 floats  (x, z, startTime, type)
    // glowArr   : 16 sentinels × 4 floats (x, z, radius, active)
    this._pulseArr = new Float32Array(20);
    this._glowArr = new Float32Array(64);

    // Pre-allocated scalar-uniform buffers — each would otherwise allocate a new JS
    // array literal every frame inside applyShader().
    this._uFogDistArr = new Float32Array(2);
    this._uFogColorArr = new Float32Array(3);
    this._uSunDirArr = new Float32Array(3);
    this._uSunColorArr = new Float32Array(3);
    this._uAmbLowArr = new Float32Array(3);
    this._uAmbHighArr = new Float32Array(3);
    // Fill-colour uniform for the box/cylinder enemy shader path.
    this._uFillColorArr = new Float32Array(3);

    // Pre-allocated overlay buffers for batching viron/barrier quads.
    // Fixed size based on MAX_INF (2000) with a 2x safety margin.
    // Each tile = 6 vertices × 3 floats = 18 floats.
    this._overlayBuffer0 = new Float32Array(5000 * 18);
    this._overlayBuffer1 = new Float32Array(5000 * 18);

    // Smoothed fog boundary to avoid visible popping when VIEW_FAR changes.
    this._fogFarWorldSmoothed = VIEW_FAR * TILE;
    this._fogFrameStamp = -1;

    // Procedural tree chunk cache (static by world position, lazily populated).
    this._procTreeChunkCache = new Map();

    // Reusable shadow-queue arrays for drawBuildings() and drawTrees().
    // Allocated once and reset each frame with .length=0 to avoid per-frame GC.
    // _buildingShadowInf is a parallel array of infection booleans matching
    // _buildingShadowQueue so the shadow pass never recomputes infection.has().
    this._buildingShadowQueue = [];
    this._buildingShadowInf = [];
    this._treeShadowQueue = [];

    // Cached per-frame sun shadow basis so multiple shadow draws don't
    // renormalize the same vector every call.
    this._sunShadowBasis = { x: 0, y: 1, z: 0 };
    this._sunShadowFrame = -Infinity;
    this._getSunShadowBasis();

    // Per-render-pass uniform deduplication.
    // _renderPassId increments each time drawLandscape() starts a new player's
    // view, allowing drawTrees() and drawBuildings() to skip re-uploading the
    // same fog/sun/ambient/invViewMatrix/time/pulse uniforms that drawLandscape()
    // already set.  uPalette and uSentinelGlows are uploaded in applyShader()
    // (not here) so they are unaffected by this guard.
    // Index 0 = terrain shader, index 1 = fill-colour shader.
    this._renderPassId = 0;
    this._uniformUploadedPassId = [-1, -1];

    /** @type {Map<string,p5.Geometry>} Chunk-level mesh cache for overlays (infection/barriers). */
    this._overlayCaches = new Map();
    this._treeChunkMeshCache = new Map();
    this._treeShadowChunkCache = new Map();
    this._buildingChunkMeshCache = new Map();
    this._buildingShadowChunkCache = new Map();
    this._bakedShadowSun = { x: 0, y: 1, z: 0 };
    this._buildingBucketsCount = 0;

    // Hook TileManager invalidation so the overlay cache stays in sync.
    // Note: gameState.barrierTiles is initialized later in setup();
    // we hook it lazily in _drawTileOverlays if needed.
    infection.onInvalidate = (tx, tz) => {
      this._invalidateOverlay(0, tx, tz);
      this._invalidateChunkProps(tx, tz);
    };
  }

  _invalidateChunkProps(tx, tz) {
    const cx = tx >> 4, cz = tz >> 4;
    const bk = `${cx},${cz}`;
    const k = tx + "," + tz;

    let treeHit = false;
    const trees = this.getProceduralTreesForChunk(cx, cz);
    for (let i = 0; i < trees.length; i++) {
        if (trees[i].k === k) { treeHit = true; break; }
    }
    if (treeHit) this._treeChunkMeshCache.delete(bk);

    let bldgHit = false;
    const bldgs = this._getBuildingsForChunk(cx, cz);
    for (let i = 0; i < bldgs.length; i++) {
        if (bldgs[i]._tileKey === k) { bldgHit = true; break; }
    }
    if (bldgHit) {
        this._buildingChunkMeshCache.delete(bk);
        this._buildingShadowChunkCache.delete(bk);
    }
  }

  /**
   * Updates the fog far distance at most once per frame using exponential
   * smoothing so quality-step changes do not visibly "pump" the fog line.
   * @returns {number} Current smoothed fog far distance (world units).
   */
  _getFogFarWorld() {
    let frame = (typeof frameCount === 'number') ? frameCount : -1;
    if (frame === this._fogFrameStamp) return this._fogFarWorldSmoothed;

    this._fogFrameStamp = frame;
    const target = VIEW_FAR * TILE;
    const dtMs = (typeof deltaTime === 'number' && Number.isFinite(deltaTime))
      ? Math.max(0, Math.min(deltaTime, 100))
      : 16.67;
    const alpha = 1.0 - Math.exp(-dtMs / 320.0);
    this._fogFarWorldSmoothed += (target - this._fogFarWorldSmoothed) * alpha;
    return this._fogFarWorldSmoothed;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /** Compiles the GLSL shaders. Must be called after the p5 WEBGL canvas exists. */
  init() {
    this.shader = createShader(TERRAIN_VERT, TERRAIN_FRAG);
    // Fill-colour shader: same vertex transform as terrain but colour comes from
    // a per-draw uFillColor uniform instead of the aVertexColor material-ID system.
    // Used for box/cylinder enemies (crab, squid, scorpion, colossus) so they receive
    // the same fog, lighting and shockwave effects as vertex-based enemies and terrain.
    this.fillShader = createShader(TERRAIN_VERT, FILL_COLOR_FRAG);
    // Shadow shader: reads baked vertex colour (RGBA) and fades the alpha to zero
    // across the fog distance range, so shadows blend into the fog correctly.
    this.shadowShader = createShader(TERRAIN_VERT, SHADOW_FRAG);
  }

  // ---------------------------------------------------------------------------
  // Pulse effects
  // ---------------------------------------------------------------------------

  /**
   * Registers a new expanding shockwave ring on the terrain surface.
   * @param {number} x    World-space X origin of the pulse.
   * @param {number} z    World-space Z origin of the pulse.
   * @param {number} type 0 = bomb (red), 1 = unused (blue), 2 = explosion (gold), 3 = curing (small), 4 = crab (orange).
   */
  addPulse(x, z, type = 0.0) {
    // Prepend so the newest pulse is first; cap list at 5 so the shader array stays in sync.
    this.activePulses.unshift({ x, z, start: millis() / 1000.0, type });
    if (this.activePulses.length > 5) this.activePulses.length = 5;
  }

  // ---------------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------------

  /**
   * Evicts the altitude and geometry caches if they grow too large.
   * Called once per frame from the main draw loop to prevent unbounded memory use.
   *
   * altCache is cleared in full — it rebuilds cheaply one entry at a time as tiles
   * are visited, producing no perceptible stutter.
   *
   * chunkCache is trimmed by evicting only the oldest half rather than clearing
   * entirely.  Clearing all 500+ chunks at once forces ~50 buildGeometry() calls
   * in the same frame (all visible chunks must be rebuilt), causing a visible
   * frame stutter.  Halving the cache retains the most recently built chunks,
   * which are most likely to still be in the current view, so far fewer chunks
   * need rebuilding on the next frame.
   */
  clearCaches() {
    if (this.altCache.size > 100000) this.altCache.clear();
    if (this.chunkCache.size > 500) {
      // Evict the oldest half (Maps iterate in insertion order).
      const keys = this.chunkCache.keys();
      for (let i = 0; i < 250; i++) this.chunkCache.delete(keys.next().value);
    }

    // Tree chunks are cheap metadata; keep more before trimming.
    if (this._procTreeChunkCache.size > 1200) {
      const keys = this._procTreeChunkCache.keys();
      for (let i = 0; i < 600; i++) this._procTreeChunkCache.delete(keys.next().value);
    }

    // Overlay caches (infection/barrier geometry per chunk).
    if (this._overlayCaches.size > 600) {
      const keys = this._overlayCaches.keys();
      for (let i = 0, n = this._overlayCaches.size >> 1; i < n; i++) this._overlayCaches.delete(keys.next().value);
    }
    if (this._treeChunkMeshCache.size > 600) {
      const keys = this._treeChunkMeshCache.keys();
      for (let i = 0, n = this._treeChunkMeshCache.size >> 1; i < n; i++) this._treeChunkMeshCache.delete(keys.next().value);
    }
    if (this._treeShadowChunkCache.size > 600) {
      const keys = this._treeShadowChunkCache.keys();
      for (let i = 0, n = this._treeShadowChunkCache.size >> 1; i < n; i++) this._treeShadowChunkCache.delete(keys.next().value);
    }
    if (this._buildingChunkMeshCache.size > 600) {
      const keys = this._buildingChunkMeshCache.keys();
      for (let i = 0, n = this._buildingChunkMeshCache.size >> 1; i < n; i++) this._buildingChunkMeshCache.delete(keys.next().value);
    }
    if (this._buildingShadowChunkCache.size > 600) {
      const keys = this._buildingShadowChunkCache.keys();
      for (let i = 0, n = this._buildingShadowChunkCache.size >> 1; i < n; i++) this._buildingShadowChunkCache.delete(keys.next().value);
    }
  }

  /**
   * Resets the terrain system by clearing all memoised altitude and geometry caches.
   * Required when mountain peaks or other global terrain parameters are modified.
   */
  reset() {
    this.altCache.clear();
    this.chunkCache.clear();
    this._procTreeChunkCache.clear();
    this._overlayCaches.clear();
    this._treeChunkMeshCache.clear();
    this._treeShadowChunkCache.clear();
    this._buildingChunkMeshCache.clear();
    this._buildingShadowChunkCache.clear();
    this._buildingBucketsCount = 0;
    if (this._buildingBuckets) this._buildingBuckets.clear();
    this._fogFrameStamp = -1;
  }

  // ---------------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a lightweight camera descriptor (position + forward vector) derived
   * from the player's ship position and yaw.  Used for frustum culling and
   * fog-depth calculations without needing access to the p5 camera object.
   * @param {{x,y,z,yaw,pitch}} s  Ship state object.
   * @param {boolean} [firstPerson=false]  True when in cockpit (first-person) view;
   *   the camera sits at the ship rather than 550 units behind it.
   * @returns {{x,z,fwdX,fwdZ,pitch}}
   */
  getCameraParams(s, firstPerson = false) {
    let fwdX = -sin(s.yaw), fwdZ = -cos(s.yaw);
    return firstPerson
      ? { x: s.x, z: s.z, fwdX, fwdZ, pitch: s.pitch }          // Cockpit: eye at ship position
      : { x: s.x - fwdX * 550, z: s.z - fwdZ * 550, fwdX, fwdZ, pitch: s.pitch };  // Chase cam: 550 units behind
  }

  /**
   * Broad frustum test — returns false for world objects that are clearly
   * behind the camera or beyond the horizontal field of view.
   *
   * When `cam.skipFrustum` is true (cockpit view at steep downward pitch) the
   * yaw-based forward vector no longer describes what is visible on the ground
   * plane, so every object within the caller's distance budget is accepted.
   *
   * @param {{x,z,fwdX,fwdZ,fovSlope,skipFrustum}} cam  Camera descriptor from
   *   getCameraParams() with fovSlope and skipFrustum pre-computed by drawLandscape().
   * @param {number} tx  World-space X to test.
   * @param {number} tz  World-space Z to test.
   */
  inFrustum(cam, tx, tz) {
    if (cam.skipFrustum) return true;
    let dx = tx - cam.x, dz = tz - cam.z;
    let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
    if (fwdDist < -TILE * 5) return false;
    let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
    let halfWidth = (fwdDist > 0 ? fwdDist : 0) * cam.fovSlope + TILE * 6;
    return Math.abs(rightDist) <= halfWidth;
  }

  /** Deterministic 0..1 hash from integer tile coordinates. */
  _treeHash01(tx, tz, salt = 0) {
    return Math.abs(Math.sin((tx + salt * 17.0) * 12.9898 + (tz - salt * 13.0) * 78.233) * 43758.5453) % 1;
  }

  /** Returns spawn density [0..1] for a procedural tree sample point. */
  _getProceduralTreeDensity(tx, tz) {
    // Coarse spacing keeps total draw count low while still covering the world.
    if ((tx & 1) !== 0 || (tz & 1) !== 0) return 0;

    // Forest mask creates broad biomes; grove noise forms dense clustered woods.
    const forest = noise(tx * 0.014 + 180.0, tz * 0.014 - 260.0);
    if (forest < 0.36) return 0;

    const grove = noise(tx * 0.052 - 90.0, tz * 0.052 + 140.0);
    const patch = noise(tx * 0.120 + 22.0, tz * 0.120 - 38.0);

    const r = this._treeHash01(tx, tz, 1.0);
    let density = map(forest, 0.36, 1.0, 0.10, 0.52, true);

    // Strong dense-core clustering with clear glades between forests.
    if (grove < 0.28) density *= 0.08;
    else if (grove > 0.62) density *= 1.85;

    // Fine patch variation so forests feel organic, not uniform carpets.
    if (patch < 0.30) density *= 0.55;
    else if (patch > 0.70) density *= 1.30;

    return constrain(density, 0.0, 0.78);
  }

  /**
   * Returns true when a procedural tree should exist at this tile sample point.
   * Uses low-frequency noise as a "forest mask" and hash noise for local variation.
   */
  hasProceduralTree(tx, tz) {
    const density = this._getProceduralTreeDensity(tx, tz);
    if (density <= 0) return false;
    const r = this._treeHash01(tx, tz, 1.0);
    return r < density;
  }

  /** Builds deterministic tree instance data for a tile sample point. */
  getProceduralTree(tx, tz) {
    const jx = (this._treeHash01(tx, tz, 2.0) - 0.5) * TILE * 0.70;
    const jz = (this._treeHash01(tx, tz, 3.0) - 0.5) * TILE * 0.70;
    return {
      x: tx * TILE + TILE * 0.5 + jx,
      z: tz * TILE + TILE * 0.5 + jz,
      variant: floor(this._treeHash01(tx, tz, 4.0) * 3),
      trunkH: 26 + this._treeHash01(tx, tz, 5.0) * 24,
      canopyScale: 1.0 + this._treeHash01(tx, tz, 6.0) * 0.8
    };
  }

  /** Returns deterministic procedural tree instance for tile sample, or null. */
  tryGetProceduralTree(tx, tz) {
    const density = this._getProceduralTreeDensity(tx, tz);
    if (density <= 0) return null;
    const r = this._treeHash01(tx, tz, 1.0);
    if (r >= density) return null;
    const t = this.getProceduralTree(tx, tz);
    t.tx = tx;
    t.tz = tz;
    t._score = density + this._treeHash01(tx, tz, 8.0) * 0.15;
    return t;
  }

  /**
   * Lazily builds deterministic procedural trees for a chunk and caps per-chunk
   * tree count to keep draw cost bounded while preserving clustered structure.
   */
  getProceduralTreesForChunk(cx, cz) {
    const key = `${cx},${cz}`;
    const cached = this._procTreeChunkCache.get(key);
    if (cached) return cached;

    const out = [];
    const tx0 = cx * CHUNK_SIZE;
    const tz0 = cz * CHUNK_SIZE;

    for (let tz = tz0; tz < tz0 + CHUNK_SIZE; tz += 2) {
      for (let tx = tx0; tx < tx0 + CHUNK_SIZE; tx += 2) {
        const t = this.tryGetProceduralTree(tx, tz);
        if (t) out.push(t);
      }
    }

    const maxTreesPerChunk = (typeof gameState !== 'undefined' && gameState.isMobile) ? 9 : 13;
    if (out.length > maxTreesPerChunk) {
      out.sort((a, b) => b._score - a._score);
      out.length = maxTreesPerChunk;
    }

    // Static world: cache expensive lookups once per tree instance.
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      t.k = tileKey(t.tx, t.tz);
      t.y = this.getAltitude(t.x, t.z);
    }

    this._procTreeChunkCache.set(key, out);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Altitude lookups
  // ---------------------------------------------------------------------------

  /**
   * Returns the altitude at a grid-corner position, using a multi-octave noise
   * formula.  Results are memoised in altCache for performance.
   * @param {number} tx  Tile-grid X index.
   * @param {number} tz  Tile-grid Z index.
   * @returns {number}   World-space Y of the terrain surface at this grid point.
   */
  getGridAltitude(tx, tz) {
    let key = tileKey(tx, tz);
    let cached = this.altCache.get(key);
    if (cached !== undefined) return cached;

    let x = tx * TILE, z = tz * TILE;
    let alt;
    if (isLaunchpad(x, z)) {
      alt = LAUNCH_ALT;
    } else {
      // Three-octave Perlin noise.  Each octave uses a distinct offset so the
      // noise field is asymmetric across the x=z diagonal (breaking the mirroring
      // symmetry that arises when both axes share the same frequency).
      // The offset values are arbitrary large constants chosen to shift each octave
      // into a visually unrelated region of the noise space.
      let xs = x * 0.0008, zs = z * 0.0008;
      let elevation = noise(xs, zs) +
        0.5 * noise(xs * 2.5 + 31.7, zs * 2.5 + 83.3) +
        0.25 * noise(xs * 5 + 67.1, zs * 5 + 124.9);
      alt = 300 - Math.pow(elevation / 1.75, 2.0) * 550;

      // Blend in Gaussian bumps for the forced mountain peaks.
      // _s2 and _skipDistSq are pre-computed in constants.js for each peak.
      for (let peak of MOUNTAIN_PEAKS) {
        let dx = x - peak.x, dz = z - peak.z;
        let dSq = dx * dx + dz * dz;
        if (dSq > peak._skipDistSq) continue;  // Contribution < 0.5 units — skip Math.exp
        alt -= peak.strength * Math.exp(-dSq / peak._s2);
      }
    }

    this.altCache.set(key, alt);
    return alt;
  }

  /**
   * Returns the smoothly interpolated terrain altitude at any world-space (x, z).
   * Uses bilinear interpolation across the four surrounding grid corners so that
   * collisions and shadow placement are sub-tile accurate.
   * @param {number} x  World-space X.
   * @param {number} z  World-space Z.
   * @returns {number}  Interpolated world-space Y altitude.
   */
  getAltitude(x, z) {
    if (isLaunchpad(x, z)) return LAUNCH_ALT;

    let tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    let fx = (x - tx * TILE) / TILE, fz = (z - tz * TILE) / TILE;

    if (fx === 0 && fz === 0) return this.getGridAltitude(tx, tz);

    let y00 = this.getGridAltitude(tx, tz);
    let y10 = this.getGridAltitude(tx + 1, tz);
    let y01 = this.getGridAltitude(tx, tz + 1);
    let y11 = this.getGridAltitude(tx + 1, tz + 1);

    // Split the quad into two triangles along the diagonal and interpolate.
    if (fx + fz <= 1) return y00 + (y10 - y00) * fx + (y01 - y00) * fz;
    return y11 + (y01 - y11) * (1 - fx) + (y10 - y11) * (1 - fz);
  }

  // ---------------------------------------------------------------------------
  // Geometry builders (results cached so they are only built once per chunk)
  // ---------------------------------------------------------------------------

  /**
   * Builds or retrieves the cached p5 geometry mesh for one terrain chunk.
   * Only tiles whose lowest corner is below sea level are included — underwater
   * tiles are skipped entirely to reduce polygon count.
   * @param {number} cx  Chunk grid X index.
   * @param {number} cz  Chunk grid Z index.
   * @returns {p5.Geometry}
   */
  getChunkGeometry(cx, cz) {
    let key = cx + ',' + cz;
    let cached = this.chunkCache.get(key);
    if (cached !== undefined) return cached;

    if (this._isBuildingShadow) return null; // Safety: do not nest build calls

    let startX = cx * CHUNK_SIZE;
    let startZ = cz * CHUNK_SIZE;

    // Pre-scan: skip buildGeometry() entirely if the whole chunk is submerged.
    // Note: aboveSea(y) returns true when a tile is submerged (WEBGL Y-axis is inverted;
    // larger Y values are deeper underwater). We look for at least one tile whose highest
    // corner (!aboveSea) is above sea level — that means the chunk has renderable terrain.
    let hasRenderableTile = false;
    scanRows: for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
      for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
        let minY = Math.min(
          this.getGridAltitude(tx, tz),
          this.getGridAltitude(tx + 1, tz),
          this.getGridAltitude(tx, tz + 1),
          this.getGridAltitude(tx + 1, tz + 1)
        );
        if (!aboveSea(minY)) { hasRenderableTile = true; break scanRows; }
      }
    }

    if (!hasRenderableTile) {
      this.chunkCache.set(key, null);
      return null;
    }

    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        beginShape(TRIANGLES);
        fill(34, 139, 34); // Unified Terrain Tag: Forest Green

        for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
          for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
            let xP = tx * TILE, zP = tz * TILE;
            let xP1 = xP + TILE, zP1 = zP + TILE;
            // Grid corners are always exact tile boundaries (fx=0, fz=0), so call
            // getGridAltitude() directly — it hits the altCache with a single Map.get()
            // and skips the bilinear interpolation logic in getAltitude().
            let y00 = this.getGridAltitude(tx, tz);
            let y10 = this.getGridAltitude(tx + 1, tz);
            let y01 = this.getGridAltitude(tx, tz + 1);
            let y11 = this.getGridAltitude(tx + 1, tz + 1);
            let minY = Math.min(y00, y10, y01, y11);
            if (aboveSea(minY)) continue;

            // Tag the material (R), organic noise (G), random jitter (B) and parity (A)
            let avgY = (y00 + y10 + y01 + y11) * 0.25;
            let isShore = (avgY > SEA - 15);

            let noiseVal = noise(tx * 0.15, tz * 0.15);
            let randVal = Math.abs(Math.sin(tx * 12.9898 + tz * 78.233)) * 43758.5453 % 1;
            let parity = ((tx + tz) % 2 === 0) ? 1.0 : 0.85;

            fill(isShore ? 2 : 1, noiseVal * 255, randVal * 255, parity * 255);

            // Provide explicit face normals so terrain shader lighting has
            // stable directional data regardless of p5's internal normal path.
            let e1x = xP1 - xP, e1y = y10 - y00, e1z = 0;
            let e2x = 0, e2y = y01 - y00, e2z = zP1 - zP;
            let n1x = e1y * e2z - e1z * e2y;
            let n1y = e1z * e2x - e1x * e2z;
            let n1z = e1x * e2y - e1y * e2x;
            normal(n1x, n1y, n1z);
            vertex(xP, y00, zP); vertex(xP1, y10, zP); vertex(xP, y01, zP1);

            e1x = xP1 - xP1; e1y = y11 - y10; e1z = zP1 - zP;
            e2x = xP - xP1; e2y = y01 - y10; e2z = zP1 - zP;
            let n2x = e1y * e2z - e1z * e2y;
            let n2y = e1z * e2x - e1x * e2z;
            let n2z = e1x * e2y - e1y * e2x;
            normal(n2x, n2y, n2z);
            vertex(xP1, y10, zP); vertex(xP1, y11, zP1); vertex(xP, y01, zP1);
          }
        }
        endShape();
      });
    } catch (err) {
      console.error("[Viron] Chunk geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    // Always cache (including null) so chunks are not rebuilt every frame.
    this.chunkCache.set(key, geom);
    return geom;
  }

  // ---------------------------------------------------------------------------
  // Fog colour helper
  // ---------------------------------------------------------------------------

  /**
   * Blends an RGB colour toward the sky colour based on world-space depth, matching
   * the fog applied by the GLSL fragment shader so that CPU-drawn objects (trees,
   * buildings, shadows) fade out consistently with the terrain.
   * @param {number[]} col    Base RGB colour [r, g, b].
   * @param {number}   depth  Signed forward distance from the camera.
   * @returns {number[]} Fog-blended RGB array.
   */
  getFogColor(col, depth) {
    const fogFar = this._getFogFarWorld();
    let fogEnd = fogFar + 400;
    let fogStart = fogFar - 800;
    let f = constrain(map(depth, fogStart, fogEnd, 0, 1), 0, 1);
    return [
      lerp(col[0], SKY_R, f),
      lerp(col[1], SKY_G, f),
      lerp(col[2], SKY_B, f)
    ];
  }

  /**
   * Returns the scalar fog blend factor [0, 1] for a given depth.
   * Zero-allocation alternative to getFogColor() for callers that need to apply
   * the same fog factor to multiple colours without allocating intermediate arrays.
   * @param {number} depth  Signed forward distance from the camera.
   * @returns {number}
   */
  getFogFactor(depth) {
    const fogFar = this._getFogFarWorld();
    return constrain(map(depth, fogFar - 800, fogFar + 400, 0, 1), 0, 1);
  }

  /**
   * Calls p5 fill() with an RGB colour fog-blended toward the sky colour —
   * matches the GLSL fog but emits zero intermediate array allocations.
   * @param {number} r      Base red   [0–255].
   * @param {number} g      Base green [0–255].
   * @param {number} b      Base blue  [0–255].
   * @param {number} depth  Signed forward distance from the camera.
   */
  fillFogColor(r, g, b, depth) {
    const f = this.getFogFactor(depth);
    fill(lerp(r, SKY_R, f), lerp(g, SKY_G, f), lerp(b, SKY_B, f));
  }

  /** Enables or disables WebGL backface culling when available. */
  _setBackfaceCulling(enabled) {
    const gl = (typeof drawingContext !== 'undefined') ? drawingContext : null;
    if (!gl || !gl.enable || !gl.disable || gl.CULL_FACE === undefined) return;
    if (enabled) {
      gl.enable(gl.CULL_FACE);
      if (gl.cullFace && gl.BACK !== undefined) gl.cullFace(gl.BACK);
    } else {
      gl.disable(gl.CULL_FACE);
    }
  }

  // ---------------------------------------------------------------------------
  // Shader application
  // ---------------------------------------------------------------------------

  /**
   * Uploads uniforms shared by both the terrain shader and the fill-colour shader:
   * fog, sun direction/colour, ambient, inverse-view matrix, time, and pulse data.
   * Accepts the target shader object as a parameter so both callers can reuse the
   * same pre-allocated buffers without any redundant array allocations.
   *
   * Within a single player's render pass (landscape → trees → buildings → enemies)
   * the camera and all environment constants are unchanged, so the heavy uniforms
   * (fog, sun, ambient, palette, invViewMatrix) are only uploaded on the FIRST bind
   * within that pass.  uTime and uPulses are also constant within a pass so they
   * are always part of the single full upload, not re-uploaded on subsequent binds.
   *
   * @param {p5.Shader} sh  The shader to upload into (this.shader or this.fillShader).
   */
  _uploadSharedUniforms(sh) {
    const shIdx = (sh === this.shader) ? 0 : 1;

    // If this shader was already fully uploaded for the current render pass
    // (identified by _renderPassId, incremented at the top of drawLandscape()),
    // the WebGL program already holds the correct values — skip all uploads.
    if (this._uniformUploadedPassId[shIdx] === this._renderPassId) return;
    this._uniformUploadedPassId[shIdx] = this._renderPassId;

    const fogFar = this._getFogFarWorld();

    // Fill pre-allocated uniform buffers in-place — avoids allocating a new JS
    // array literal for every setUniform() call each frame.
    this._uFogDistArr[0] = fogFar - 1500; this._uFogDistArr[1] = fogFar;
    this._uFogColorArr[0] = SKY_R / 255.0; this._uFogColorArr[1] = SKY_G / 255.0; this._uFogColorArr[2] = SKY_B / 255.0;
    // SUN_DIR_NX/NY/NZ are the pre-normalized sun direction constants.
    this._uSunDirArr[0] = SUN_DIR_NX; this._uSunDirArr[1] = SUN_DIR_NY; this._uSunDirArr[2] = SUN_DIR_NZ;
    this._uSunColorArr[0] = SHADER_SUN_R; this._uSunColorArr[1] = SHADER_SUN_G; this._uSunColorArr[2] = SHADER_SUN_B;
    this._uAmbLowArr[0] = SHADER_AMB_L_R; this._uAmbLowArr[1] = SHADER_AMB_L_G; this._uAmbLowArr[2] = SHADER_AMB_L_B;
    this._uAmbHighArr[0] = SHADER_AMB_H_R; this._uAmbHighArr[1] = SHADER_AMB_H_G; this._uAmbHighArr[2] = SHADER_AMB_H_B;

    const r = _renderer;
    if (r && r.uViewMatrix) {
      if (!this._invViewMat) this._invViewMat = new p5.Matrix();
      this._invViewMat.set(r.uViewMatrix);
      this._invViewMat.invert(this._invViewMat);
      sh.setUniform('uInvViewMatrix', this._invViewMat.mat4);
    }

    sh.setUniform('uTime', millis() / 1000.0);
    sh.setUniform('uFogDist', this._uFogDistArr);
    sh.setUniform('uFogColor', this._uFogColorArr);
    sh.setUniform('uSunDir', this._uSunDirArr);
    sh.setUniform('uSunColor', this._uSunColorArr);
    sh.setUniform('uAmbientLow', this._uAmbLowArr);
    sh.setUniform('uAmbientHigh', this._uAmbHighArr);

    // Write pulse data into the pre-allocated buffer (avoids a new array each frame).
    const pulseArr = this._pulseArr;
    for (let i = 0; i < 5; i++) {
      const base = i * 4;
      if (i < this.activePulses.length) {
        pulseArr[base] = this.activePulses[i].x;
        pulseArr[base + 1] = this.activePulses[i].z;
        pulseArr[base + 2] = this.activePulses[i].start;
        pulseArr[base + 3] = this.activePulses[i].type || 0.0;
      } else {
        pulseArr[base] = 0.0;
        pulseArr[base + 1] = 0.0;
        pulseArr[base + 2] = -9999.0;  // Inactive: age never reaches 0
        pulseArr[base + 3] = 0.0;
      }
    }
    sh.setUniform('uPulses', pulseArr);
  }

  /**
   * Binds the terrain GLSL shader and uploads per-frame uniforms:
   *   • uTime     — elapsed seconds, drives pulse ring expansion
   *   • uFogDist  — [fogStart, fogEnd] in world units
   *   • uFogColor — sky/fog RGB colour (derived from SKY_R/G/B constants)
   *   • uPulses   — flat array of up to 5 pulse descriptors [x, z, startTime, type]
   * Must be called before any model() draw calls that should use the terrain shader.
   */
  applyShader() {
    shader(this.shader);

    // _uploadSharedUniforms updates this._uniformUploadedPassId[0], so we must
    // check it BEFORE calling that method to know if terrain-specific uniforms
    // are also needed this pass.
    const needsTerrainUpload = (this._uniformUploadedPassId[0] !== this._renderPassId);

    this._uploadSharedUniforms(this.shader);

    if (!needsTerrainUpload) return;

    this.shader.setUniform('uTileSize', TILE);
    this.shader.setUniform('uPalette', TERRAIN_PALETTE_FLAT);

    // Write sentinel glow data into the pre-allocated buffer.
    const glowArr = this._glowArr;
    for (let i = 0; i < 16; i++) {
      const base = i * 4;
      if (i < this.sentinelGlows.length) {
        const g = this.sentinelGlows[i];
        glowArr[base] = g.x;
        glowArr[base + 1] = g.z;
        glowArr[base + 2] = g.radius;
        glowArr[base + 3] = 1.0;  // active
      } else {
        glowArr[base] = 0.0;
        glowArr[base + 1] = 0.0;
        glowArr[base + 2] = 0.0;
        glowArr[base + 3] = 0.0;  // inactive slot
      }
    }
    this.shader.setUniform('uSentinelGlows', glowArr);
  }

  /**
   * Binds the fill-colour shader and uploads per-frame uniforms.
   * Replaces setSceneLighting() for box/cylinder enemies so they receive
   * the same fog, lighting and shockwave effects as vertex-based enemies.
   *
   * Call setFillColor() immediately before each box()/cylinder() draw to
   * set the per-part colour via the uFillColor uniform.
   */
  applyFillColorShader() {
    if (!this.fillShader) return;
    shader(this.fillShader);
    this._uploadSharedUniforms(this.fillShader);

    this._uFillColorArr[0] = 1.0; this._uFillColorArr[1] = 1.0; this._uFillColorArr[2] = 1.0;
    this.fillShader.setUniform('uFillColor', this._uFillColorArr);
    this.fillShader.setUniform('uScanlineWeight', 1.0);
  }

  /**
   * Sets the intensity of holographic scanlines in the fill-colour shader.
   * @param {number} w  0 = disabled, 1 = normal.
   */
  setScanlineWeight(w) {
    if (!this.fillShader) return;
    this.fillShader.setUniform('uScanlineWeight', w);
  }

  /**
   * Updates the uFillColor uniform for the currently bound fill-colour shader.
   * Must be called immediately before drawing each box()/cylinder() body part.
   *
   * @param {number} r  Red channel 0–255.
   * @param {number} g  Green channel 0–255.
   * @param {number} b  Blue channel 0–255.
   */
  setFillColor(r, g, b) {
    if (!this.fillShader) return;
    this._uFillColorArr[0] = r / 255.0;
    this._uFillColorArr[1] = g / 255.0;
    this._uFillColorArr[2] = b / 255.0;
    this.fillShader.setUniform('uFillColor', this._uFillColorArr);
  }

  /**
   * Binds the shadow GLSL shader and uploads the fog-distance uniform.
   * Must be called before any shadow model()/beginShape() draw calls so that
   * shadow alpha fades out correctly in the fog zone.
   *
   * The fog-distance values in _uFogDistArr are written by _uploadSharedUniforms()
   * during the terrain/tree/building shader passes (drawLandscape → drawTrees →
   * drawBuildings) which always execute before shadow rendering in the same frame.
   * Reusing those cached values here avoids redundant fog calculations and keeps
   * the shadow fog boundary in exact lock-step with the terrain fog boundary.
   */
  applyShadowShader() {
    if (!this.shadowShader) return;
    shader(this.shadowShader);
    this.shadowShader.setUniform('uFogDist', this._uFogDistArr);
  }

  /**
   * Invalidates cached overlay geometry for the chunk containing (tx, tz).
   * Removes all material variants for the given manager/chunk combination.
   * @param {number} managerId 0=infection, 1=barriers.
   * @param {number} tx Tile X.
   * @param {number} tz Tile Z.
   * @private
   */
  _invalidateOverlay(managerId, tx, tz) {
    const bk = chunkKey(tx >> 4, tz >> 4);
    const prefix = `${managerId}_${bk}_`;
    for (const k of this._overlayCaches.keys()) {
      if (k.startsWith(prefix)) this._overlayCaches.delete(k);
    }
  }

  /**
   * Returns true if a chunk centre is within the camera frustum.
   * Shared frustum test used by _drawTerrainChunks, _drawTileOverlays and drawTrees.
   * @param {object} cam       Camera descriptor with x, z, fwdX, fwdZ, fovSlope, skipFrustum.
   * @param {number} cx        Chunk grid X.
   * @param {number} cz        Chunk grid Z.
   * @param {number} chunkHalf Half-width of a chunk in world units (margin).
   * @returns {boolean}
   * @private
   */
  _isChunkVisible(cam, cx, cz, chunkHalf) {
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

  /**
   * Renders sets of tile overlay quads using the currently bound terrain shader.
   * Uses cached chunk-level meshes to avoid expensive per-tile vertex() calls.
   *
   * @param {object}   manager     TileManager instance (infection or barrierTiles).
   * @param {object}   typeConfigs Mapping of type names to [matEven, matOdd] ID pairs.
   * @param {number}   yOffset     Y offset applied to each vertex corner altitude.
   * @param {object}   cam         Camera descriptor.
   * @param {number}   fovSlope    FOV slope for lateral frustum culling.
   * @param {number}   minTx       ignored (dist handled by pass-through chunks)
   * @param {number}   maxTx       ignored
   * @param {number}   minTz       ignored
   * @param {number}   maxTz       ignored
   * @param {string}   tag         Profiler tag.
   * @param {number}   minCx       Chunk-space min X (required).
   * @param {number}   maxCx       Chunk-space max X.
   * @param {number}   minCz       Chunk-space min Z.
   * @param {number}   maxCz       Chunk-space max Z.
   */
  _drawTileOverlays(manager, typeConfigs, yOffset, cam, fovSlope, minTx, maxTx, minTz, maxTz, tag, minCx, maxCx, minCz, maxCz) {
    const profiler = getVironProfiler();
    const overlayStart = profiler ? performance.now() : 0;
    const managerId = (manager === infection) ? 0 : 1;

    // Ensure we have the invalidation hook
    if (!manager.onInvalidate) {
      manager.onInvalidate = (tx, tz) => this._invalidateOverlay(managerId, tx, tz);
    }

    let totalTiles = 0;
    const chunkHalf = CHUNK_SIZE * TILE;

    // Polygon offset prevents Z-fighting between overlay quads and the terrain
    // mesh that sits at the same altitude plane.
    const _gl = (typeof drawingContext !== 'undefined') ? drawingContext : null;
    if (_gl) {
      _gl.enable(_gl.POLYGON_OFFSET_FILL);
      _gl.polygonOffset(-1.0, -2.0);
    }

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bk = chunkKey(cx, cz);
        const tileList = manager.buckets ? manager.buckets.get(bk) : null;
        if (!tileList || tileList.length === 0) continue;

        // Chunk-level frustum culling
        if (!this._isChunkVisible(cam, cx, cz, chunkHalf)) continue;

        // Collect distinct material cache keys for this chunk to check validity
        // before doing the more expensive per-tile material bucketing.
        const matIdSet = new Set();
        for (let i = 0; i < tileList.length; i++) {
          const t = tileList[i];
          const type = t.type || 'default';
          const parity = (t.tx + t.tz) % 2 === 0 ? 0 : 1;
          const config = typeConfigs[type] || typeConfigs['default'];
          if (config) matIdSet.add(config[parity]);
        }

        // Fast path: if every material variant is already cached, skip bucketing
        // and draw directly from the cache.
        let allCached = true;
        for (const matId of matIdSet) {
          if (this._overlayCaches.get(`${managerId}_${bk}_${matId}`) === undefined) {
            allCached = false;
            break;
          }
        }

        if (allCached) {
          for (const matId of matIdSet) {
            const geom = this._overlayCaches.get(`${managerId}_${bk}_${matId}`);
            if (geom) {
              model(geom);
              totalTiles += tileList.length; // Approximate — counted once per matId set
            }
          }
          continue;
        }

        // Slow path: split tiles by material ID and bake any missing geometry.
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
          let geom = this._overlayCaches.get(cacheKey);

          if (geom === undefined) {
            const mList = matBuckets[matId];
            geom = _safeBuildGeometry(() => {
              beginShape(TRIANGLES);
              normal(0, 1, 0);
              fill(parseInt(matId), 0, 0, 255);
              for (let i = 0; i < mList.length; i++) {
                const t = mList[i];
                if (!t.verts) {
                  const xP = t.tx * TILE, zP = t.tz * TILE, xP1 = xP + TILE, zP1 = zP + TILE;
                  const y00 = this.getGridAltitude(t.tx, t.tz) + yOffset;
                  const y10 = this.getGridAltitude(t.tx + 1, t.tz) + yOffset;
                  const y01 = this.getGridAltitude(t.tx, t.tz + 1) + yOffset;
                  const y11 = this.getGridAltitude(t.tx + 1, t.tz + 1) + yOffset;
                  t.verts = new Float32Array([
                    xP, y00, zP, xP1, y10, zP, xP, y01, zP1,
                    xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1
                  ]);
                }
                const v = t.verts;
                for (let j = 0; j < 18; j += 3) vertex(v[j], v[j + 1], v[j + 2]);
              }
              endShape();
            });
            this._overlayCaches.set(cacheKey, geom);
          }

          if (geom) {
            model(geom);
            totalTiles += matBuckets[matId].length;
          }
        }
      }
    }

    if (_gl) {
      _gl.disable(_gl.POLYGON_OFFSET_FILL);
    }

    if (profiler && tag) {
      profiler.recordOverlay(tag, totalTiles, performance.now() - overlayStart);
    }
  }


  /**
   * Renders the visible terrain chunks, infected tile overlays, sea plane and
   * launchpad missile decorations for one player's viewport.
   *
   * Draw order:
   *   1. Terrain chunks (via cached geometry + terrain shader)
   *   2. Infected tile overlays (pulsing red/yellow quads drawn on top)
   *   3. Static sea plane (flat quad at SEA+3)
   *   4. Launchpad missile decorations (standard lighting restored first)
   *
   * Camera is computed once here and stored as this._cam so drawTrees,
   * drawBuildings and enemies.draw can reuse it without recomputing sin/cos.
   *
   * @param {{x,y,z,yaw,pitch}} s  The ship whose viewport is being rendered.
   * @param {number} viewAspect    viewW / viewH of the actual WebGL viewport — must
   *                               match the aspect passed to p5's perspective() so
   *                               frustum culling matches what the camera sees.
   * @param {boolean} [firstPerson=false]  Whether to render from a first-person camera.
   */
  drawLandscape(s, viewAspect, firstPerson = false) {
    const gx = toTile(s.x), gz = toTile(s.z);
    noStroke();

    // Start a new render pass for this player's viewport.
    // Incrementing here lets _uploadSharedUniforms() skip re-uploading the
    // fog/sun/ambient uniforms when drawTrees() and drawBuildings() call
    // applyShader() later in the same _drawSharedWorld() call.
    this._renderPassId++;

    // Compute camera params once and cache on the instance so drawTrees,
    // drawBuildings and enemies.draw reuse the same values this frame.
    const cam = this.getCameraParams(s, firstPerson);

    // Pre-compute FOV slope once — used for chunk culling, infected-tile culling,
    // and inFrustum() calls in drawTrees/drawBuildings.
    // 0.57735 = tan(30°), matching the PI/3 perspective FOV used in renderPlayerView.
    // The +0.3 padding ensures objects at oblique angles are never incorrectly culled.
    // viewAspect must match the value passed to perspective() so culling is accurate.
    cam.fovSlope = 0.57735 * viewAspect + 0.3;  // Attached to cam so inFrustum() reuses it

    // In cockpit (first-person) view the camera pitch can exceed 45° downward.
    // At that angle the yaw-based horizontal forward vector no longer correctly
    // describes what is visible on the ground plane, so the directional frustum
    // tests would incorrectly cull chunks/trees/buildings that are visible below
    // the camera.  Setting skipFrustum bypasses those checks and relies solely on
    // the VIEW_FAR distance budget to limit what is drawn.
    cam.skipFrustum = firstPerson && Math.abs(cam.pitch) > Math.PI / 4;

    this._cam = cam;

    // p5 lighting silently overrides custom shaders that don't declare lighting
    // uniforms; disable it for the terrain pass.
    noLights();
    const profiler = getVironProfiler();
    const shaderStart = profiler ? performance.now() : 0;
    this.applyShader();
    if (profiler) profiler.record('shader', performance.now() - shaderStart);

    const terrainStart = profiler ? performance.now() : 0;
    const minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    const maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    const minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    const maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    this._drawTerrainChunks(cam, minCx, maxCx, minCz, maxCz);

    const minTx = gx - VIEW_FAR, maxTx = gx + VIEW_FAR;
    const minTz = gz - VIEW_FAR, maxTz = gz + VIEW_FAR;

    // Viron tile overlays (infection) — pulsing red/yellow quads on top of terrain.
    if (infection.count > 0) {
      this._drawTileOverlays(
        infection,
        { normal: [10, 11], yellow: [14, 15] },
        -0.5, cam, cam.fovSlope, minTx, maxTx, minTz, maxTz, 'infection',
        minCx, maxCx, minCz, maxCz
      );
    }

    // Barrier tile overlays — drawn in two checkerboard-parity passes so fill()
    // is never called inside an active shape (~2,000 GPU flushes avoided per frame).
    // Bucket-based iteration keeps cost O(visible tiles) regardless of total count.
    if (gameState.barrierTiles && gameState.barrierTiles.size > 0) {
      this._drawTileOverlays(
        gameState.barrierTiles,
        { default: [20, 21] },
        -0.3, cam, cam.fovSlope, minTx, maxTx, minTz, maxTz, 'barrier',
        minCx, maxCx, minCz, maxCz
      );
    }

    this._drawSeaPlane(s);
    if (profiler) profiler.record('terrain', performance.now() - terrainStart);

    // Exit the terrain GLSL shader and restore p5 lighting for subsequent
    // non-terrain draw calls (trees, buildings, enemies, ships).
    // noLights() was called at the top of this function to prevent p5's light
    // uniforms from interfering with the custom terrain GLSL, so lights must be
    // re-established here before returning.
    resetShader();
    setSceneLighting();

    this._drawLaunchpadMissiles(cam);
  }

  /**
   * Renders all visible terrain chunk meshes under the currently bound terrain
   * shader, applying chunk-level frustum culling to skip non-visible chunks.
   *
   * Chunk-level culling uses the chunk centre with a one-chunk lateral margin so
   * no partially-visible edge chunk is accidentally dropped.  Culling is skipped
   * when cam.skipFrustum is set (cockpit view at steep pitch).
   *
   * @param {object} cam      Camera descriptor (x, z, fwdX, fwdZ, fovSlope, skipFrustum).
   * @param {number} minCx    Min chunk-grid X to iterate.
   * @param {number} maxCx    Max chunk-grid X to iterate.
   * @param {number} minCz    Min chunk-grid Z to iterate.
   * @param {number} maxCz    Max chunk-grid Z to iterate.
   * @private
   */
  _drawTerrainChunks(cam, minCx, maxCx, minCz, maxCz) {
    const chunkHalf = CHUNK_SIZE * TILE;
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!this._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        const geom = this.getChunkGeometry(cx, cz);
        if (geom) model(geom);
      }
    }
  }

  /**
   * Renders the static sea plane under the currently bound terrain shader.
   *
   * A single flat quad at SEA covers the visible area.  The terrain shader
   * (mat 30) animates the surface with normal-mapped ripples.  Polygon offset
   * (-1, -4) gives the sea a tiny depth advantage at the shore boundary to
   * prevent Z-fighting without affecting above-water geometry.
   *
   * sy = SEA (not SEA+3): placing the plane exactly at sea level ensures that
   * all submerged terrain vertices (Y > SEA) are behind the sea in the depth
   * buffer, preventing the flickering seen when sy was elevated.
   *
   * @param {{x:number, z:number}} s  Ship state — used to centre the sea quad.
   * @private
   */
  _drawSeaPlane(s) {
    const seaSize = VIEW_FAR * TILE * 1.5;
    const seaCx   = toTile(s.x) * TILE, seaCz = toTile(s.z) * TILE;
    const sx0     = seaCx - seaSize, sx1 = seaCx + seaSize;
    const sz0     = seaCz - seaSize, sz1 = seaCz + seaSize;
    const gl      = drawingContext;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1.0, -4.0);
    fill(30, 45, 150);  // mat=30 triggers the sea GLSL branch
    beginShape(TRIANGLES);
    normal(0, -1, 0);   // Upward-facing in WebGL's Y-inverted coordinate system
    vertex(sx0, SEA, sz0); vertex(sx1, SEA, sz0); vertex(sx0, SEA, sz1);
    vertex(sx1, SEA, sz0); vertex(sx1, SEA, sz1); vertex(sx0, SEA, sz1);
    endShape();
    gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  /**
   * Renders the Zarch-tribute missile decorations lined up along the launchpad.
   * Called after resetShader() / setSceneLighting() so these use standard p5
   * lighting rather than the terrain shader.
   *
   * @param {object} cam  Camera descriptor (x, z, fwdX, fwdZ) for fog depth calc.
   * @private
   */
  _drawLaunchpadMissiles(cam) {
    push();
    const mX = LAUNCH_MAX - 100;
    for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
      // Both colours share the same depth — compute fog factor once and reuse.
      const fogF = this.getFogFactor((mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ);
      push();
      translate(mX, LAUNCH_ALT, mZ);
      fill(lerp(60, SKY_R, fogF), lerp(60, SKY_G, fogF), lerp(60, SKY_B, fogF));
      push(); translate(0, -10, 0); box(30, 20, 30); pop();                        // Stand
      fill(lerp(255, SKY_R, fogF), lerp(140, SKY_G, fogF), lerp(20, SKY_B, fogF));
      push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop(); // Rocket body
      pop();
    }
    pop();
  }



  /**
   * Computes normalized sun projection data reused by all ground shadow draws.
   * @returns {{x:number,y:number,z:number}}
   */
  _getSunShadowBasis() {
    const frame = typeof frameCount === 'number' ? frameCount : 0;
    if (frame !== this._sunShadowFrame) {
      const clampedSunNY = Math.max(SUN_DIR_MIN_Y, SUN_DIR_NY);
      this._sunShadowBasis = {
        x: SUN_DIR_NX,
        y: clampedSunNY,
        z: SUN_DIR_NZ
      };
      this._sunShadowFrame = frame;
    }
    return this._sunShadowBasis;
  }

  _shadowOpacityFactor(casterH) {
    return shadowOpacityFactor(casterH);
  }

  _shadowShift(casterH, sun) {
    return shadowShift(casterH, sun);
  }

  /**
   * 2D convex hull in XZ plane for projected shadow polygons.
   */
  _shadowHullXZ(points) {
    if (points.length <= 2) return points.slice();
    // points is already {x, z} objects (the concat result is always a fresh temp array).
    // Sort in-place — the redundant .map(p => ({x, z})) only existed to copy objects
    // before sorting, but that copy is unnecessary since the input is already {x, z}.
    const pts = points.sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));

    const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /**
   * Draws a cast shadow polygon from a base footprint and caster height.
   * Small shadows are drawn as simpler polygons; large shadows (like from
   * tall sentinel buildings) are recursively subdivided to conform to
   * terrain bumps and avoid "bright chunks" caused by clipping.
   */
  _drawProjectedFootprintShadow(wx, wz, groundY, casterH, footprint, alpha, sun, isFloating = false, isBaking = false) {
    const shift = this._shadowShift(casterH, sun);
    let rawHull;
    if (isFloating) {
      const top = footprint.map(p => ({ x: wx + p.x + sun.x * shift, z: wz + p.z + sun.z * shift }));
      rawHull = this._shadowHullXZ(top);
    } else {
      const base = footprint.map(p => ({ x: wx + p.x, z: wz + p.z }));
      const top = base.map(p => ({ x: p.x + sun.x * shift, z: p.z + sun.z * shift }));
      rawHull = this._shadowHullXZ(base.concat(top));
    }
    if (rawHull.length < 3) return;

    // 1. Subdivide the hull boundary into a flat array [x, z, x, z, ...] to avoid objects
    const hullFlat = [];
    const edgeRes = TILE * 0.75;
    const edgeResSq = edgeRes * edgeRes;
    for (let i = 0; i < rawHull.length; i++) {
      let p1 = rawHull[i], p2 = rawHull[(i + 1) % rawHull.length];
      hullFlat.push(p1.x, p1.z);
      let dx = p2.x - p1.x;
      let dz = p2.z - p1.z;
      let dSq = dx * dx + dz * dz;
      if (dSq > edgeResSq) {
        let steps = Math.ceil(Math.sqrt(dSq) / edgeRes);
        let stepScale = 1.0 / steps;
        for (let s = 1; s < steps; s++) {
          let f = s * stepScale;
          hullFlat.push(p1.x + dx * f, p1.z + dz * f);
        }
      }
    }

    // --- Triangle Fan from center with per-vertex conformal lift ---
    let cx = 0, cz = 0;
    const numPts = hullFlat.length / 2;
    for (let i = 0; i < hullFlat.length; i += 2) {
      cx += hullFlat[i];
      cz += hullFlat[i + 1];
    }
    cx /= numPts;
    cz /= numPts;

    // Threshold tuned for robust terrain coverage; depth 5 allows precise "draping"
    const threshold = TILE * TILE * 0.4; // Tighter threshold for better geometry tracking 
    const liftY = -3.5; // Aggressive lift to stay above terrain triangles quad-splits
    const maxDepth = gameState.isMobile ? 4 : 5;

    // Hard cap on emitted triangles to prevent push.apply overflowing V8's
    // call-stack argument limit (~65 536).  p5's addGeometry uses
    //   push.apply(dest, _toConsumableArray(array))
    // which passes every element as a C-stack argument.  The largest array is
    // vertexColors at 4 values per vertex, so the safe ceiling is:
    //   MAX_SHADOW_TRIS * 3 vertices * 4 color-values < 65 536
    //   → MAX_SHADOW_TRIS < 5 461
    // Using 5 000 gives 15 000 vertices / 60 000 vertexColors — comfortably safe.
    // triCount is a closure variable intentionally shared across all recursive
    // emitTri calls — this is the standard single-threaded JS accumulator pattern.
    const MAX_SHADOW_TRIS = 5000;
    let triCount = 0;

    const lightsWereOn = (typeof SUN_KEY_R !== 'undefined');

    noStroke();
    const shadowAlpha = alpha * this._shadowOpacityFactor(casterH);
    // Bake the precise shadow color/alpha into the vertex colors
    fill(0, 0, 0, shadowAlpha);

    if (!isBaking) {
      if (lightsWereOn) noLights();
      this.applyShadowShader();
      _beginShadowStencil();
    }

    beginShape(TRIANGLES);
    normal(0, 1, 0); // Always set normals so the mesh is complete and valid for WebGL shaders

    // Zero-allocation inner subdivision loop
    const emitTri = (x1, z1, x2, z2, x3, z3, depth) => {
      if (triCount >= MAX_SHADOW_TRIS) {
        // Cap reached: shadow is partially drawn but safe. This only occurs for
        // extreme configurations (very tall building + very low sun angle) and
        // is far preferable to a RangeError crashing all geometry caching.
        return;
      }
      let dx12 = x1 - x2, dz12 = z1 - z2;
      let dx23 = x2 - x3, dz23 = z2 - z3;
      let dx31 = x3 - x1, dz31 = z3 - z1;

      let d1 = dx12 * dx12 + dz12 * dz12;
      let d2 = dx23 * dx23 + dz23 * dz23;
      let d3 = dx31 * dx31 + dz31 * dz31;

      if (depth < maxDepth && (d1 > threshold || d2 > threshold || d3 > threshold)) {
        let m12x = (x1 + x2) * 0.5, m12z = (z1 + z2) * 0.5;
        let m23x = (x2 + x3) * 0.5, m23z = (z2 + z3) * 0.5;
        let m31x = (x3 + x1) * 0.5, m31z = (z3 + z1) * 0.5;
        emitTri(x1, z1, m12x, m12z, m31x, m31z, depth + 1);
        emitTri(x2, z2, m23x, m23z, m12x, m12z, depth + 1);
        emitTri(x3, z3, m31x, m31z, m23x, m23z, depth + 1);
        emitTri(m12x, m12z, m23x, m23z, m31x, m31z, depth + 1);
      } else {
        triCount++;
        vertex(x1, this.getAltitude(x1, z1) + liftY, z1);
        vertex(x2, this.getAltitude(x2, z2) + liftY, z2);
        vertex(x3, this.getAltitude(x3, z3) + liftY, z3);
      }
    };

    for (let i = 0; i < numPts; i++) {
      let idx1 = i * 2;
      let idx2 = ((i + 1) % numPts) * 2;
      emitTri(cx, cz, hullFlat[idx1], hullFlat[idx1 + 1], hullFlat[idx2], hullFlat[idx2 + 1], 0);
    }

    endShape();
    if (!isBaking) {
      _endShadowStencil();
      resetShader();
      if (lightsWereOn && typeof setSceneLighting === 'function') setSceneLighting();
    }
  }

  /**
   * Draws one projected ellipse footprint for a caster at height casterH.
   */
  _drawProjectedEllipseShadow(wx, wz, groundY, casterH, rx, rz, alpha, sun, isFloating = false) {
    const pts = [];
    const steps = 16; // Higher step count: smoother ellipse silhouette at close range
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * TWO_PI;
      pts.push({ x: Math.cos(a) * rx * 0.5, z: Math.sin(a) * rz * 0.5 });
    }
    this._drawProjectedFootprintShadow(wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  }

  /**
   * Draws one projected rectangular footprint for a caster at height casterH.
   */
  _drawProjectedRectShadow(wx, wz, groundY, casterH, w, d, alpha, sun, isFloating = false) {
    const hw = w * 0.5, hd = d * 0.5;
    const pts = [
      { x: -hw, z: -hd },
      { x: hw, z: -hd },
      { x: hw, z: hd },
      { x: -hw, z: hd }
    ];
    this._drawProjectedFootprintShadow(wx, wz, groundY, casterH, pts, alpha, sun, isFloating);
  }

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
  }

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

  _getTreeGeom(t, inf) {
    const { trunkH: h, canopyScale: sc, variant: vi } = t;
    // Cache both key variants (clean + infected) on the tree object so toFixed()
    // string allocation is paid only once per tree lifetime.
    // t._geomKeyPair[0] = clean key, t._geomKeyPair[1] = infected key.
    if (!t._geomKeyPair) {
      const base = `tree_${vi}_${sc.toFixed(2)}_${h.toFixed(1)}_`;
      t._geomKeyPair = [base + 'false', base + 'true'];
    }
    const key = t._geomKeyPair[inf ? 1 : 0];
    if (!this._geoms) this._geoms = new Map();
    if (this._geoms.has(key)) return this._geoms.get(key);

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        let tv = TREE_VARIANTS[vi];

        // Ensure R values avoid terrain palette indices (1,2, 10,11, 20,21)
        const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;

        fill(safeR(inf ? 80 : 100), inf ? 40 : 65, inf ? 20 : 25);
        push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

        let c1 = inf ? tv.infected : tv.healthy;
        fill(safeR(c1[0]), c1[1], c1[2]);

        if (vi === 2) {
          push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
        } else {
          let cn = tv.cones[0];
          push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();
          if (tv.cones2) {
            let c2 = inf ? tv.infected2 : tv.healthy2;
            fill(safeR(c2[0]), c2[1], c2[2]);
            let cn2 = tv.cones2[0];
            push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
          }
        }
      });
    } catch (err) {
      console.error("[Viron] Tree geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    this._geoms.set(key, geom);
    return geom;
  }

  /**
   * Draws all trees within rendering range, applying fog colour blending and
   * infection tinting using the terrain shader and single coherent meshes.
   * Ground shadows are projected from component silhouettes (trunk + canopy tiers).
   * @param {{x,y,z,yaw}} s  Ship state (used as the view origin for culling).
   */

  _getChunkTreeMesh(cx, cz) {
    const key = `${cx},${cz}`;
    if (this._treeChunkMeshCache.has(key)) return this._treeChunkMeshCache.get(key);

    if (this._bakeStart && performance.now() - this._bakeStart > 4.0) return null;

    const trees = this.getProceduralTreesForChunk(cx, cz);
    
    let hasRenderable = false;
    for (const t of trees) {
        if (!aboveSea(t.y) && !isLaunchpad(t.x, t.z)) {
            hasRenderable = true;
            break;
        }
    }

    if (!hasRenderable) {
      this._treeChunkMeshCache.set(key, null);
      return null;
    }

    // Pre-warm base geometric variants before opening the chunk builder,
    // as p5.js does not support nested buildGeometry() calls.
    for (const t of trees) {
        if (!aboveSea(t.y) && !isLaunchpad(t.x, t.z)) {
            const inf = infection.has(t.k);
            this._getTreeGeom(t, inf);
        }
    }

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          const inf = infection.has(t.k);
          const tGeom = this._getTreeGeom(t, inf);
          if (tGeom) {
            push();
            translate(t.x, t.y, t.z);
            model(tGeom);
            pop();
          }
        }
      });
    } catch (err) {
      console.error("[Viron] Chunk tree geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    this._treeChunkMeshCache.set(key, geom);
    return geom;
  }

  _getChunkTreeShadow(cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = this._treeShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (this._bakeStart && performance.now() - this._bakeStart > 4.0) {
      // Time budget exceeded. Since sun changed, we have a STALE shadow geometry.
      // Return it to prevent expensive fallback individual rendering while waiting for background baking.
      if (cached && cached.geom) return cached.geom;
      return null;
    }

    const trees = this.getProceduralTreesForChunk(cx, cz);
    let hasRenderable = false;
    for (const t of trees) {
        if (!aboveSea(t.y) && !isLaunchpad(t.x, t.z)) {
            hasRenderable = true;
            break;
        }
    }
    if (!hasRenderable) {
      this._treeShadowChunkCache.set(key, { geom: null, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
      return null;
    }

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          if (!t._shadowHull) {
            const { trunkH: h, canopyScale: sc, variant: vi } = t;
            const hrx = (vi === 2) ? 20 * sc : 17 * sc;
            const hrz = (vi === 2) ? 14 * sc : 12 * sc;
            const trunkHalf = 2.5;
            const footprint = [];
            footprint.push(
              { x: -trunkHalf, z: -trunkHalf }, { x: trunkHalf, z: -trunkHalf },
              { x: trunkHalf, z: trunkHalf }, { x: -trunkHalf, z: trunkHalf }
            );
            for (let i = 0; i < 16; i++) {
              const a = (i / 16) * TWO_PI;
              footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
            }
            t._footprint = footprint;
            t._shadowCasterH = h + (vi === 2 ? 24 : 18) * sc;
            t._shadowHull = true;
          }
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          this._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      });
    } catch (err) {
      console.error("[Viron] Chunk tree shadow geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    this._treeShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  }

  drawTrees(s) {
    this._bakeStart = performance.now();
    const profiler = getVironProfiler();
    const start = profiler ? performance.now() : 0;

    let cam = this._cam || this.getCameraParams(s);
    let gx = toTile(s.x), gz = toTile(s.z);
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    noStroke();
    this.applyShader();

    const chunkHalf = CHUNK_SIZE * TILE;
    const sun = this._getSunShadowBasis();
    const visibleChunks = [];

    // We purposefully DO NOT globally clear shadow caches here anymore when sun changes.
    // Chunk caching handles stale retries internally so we don't drop 50 chunks at once.
    if (sun.x !== this._bakedShadowSun.x || sun.y !== this._bakedShadowSun.y || sun.z !== this._bakedShadowSun.z) {
      this._bakedShadowSun = { x: sun.x, y: sun.y, z: sun.z };
    }

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!this._isChunkVisible(cam, cx, cz, chunkHalf)) continue;
        
        visibleChunks.push({ cx, cz });
        const mesh = this._getChunkTreeMesh(cx, cz);
        if (mesh) {
          model(mesh);
        } else if (!this._treeChunkMeshCache.has(`${cx},${cz}`)) {
          // Fallback: draw individually if chunk generation timed out
          const trees = this.getProceduralTreesForChunk(cx, cz);
          for (const t of trees) {
            if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
            const inf = infection.has(t.k);
            const tGeom = this._getTreeGeom(t, inf);
            if (tGeom) {
              push(); translate(t.x, t.y, t.z); model(tGeom); pop();
            }
          }
        }
      }
    }

    resetShader();
    setSceneLighting();

    noLights(); noStroke();
    this.applyShadowShader();
    _beginShadowStencil();
    for (const c of visibleChunks) {
      const shadowMesh = this._getChunkTreeShadow(c.cx, c.cz, sun);
      if (shadowMesh) {
        model(shadowMesh);
      } else if (!this._treeShadowChunkCache.has(`${c.cx},${c.cz}`)) {
        // Fallback: draw individually if chunk shadow timed out
        const trees = this.getProceduralTreesForChunk(c.cx, c.cz);
        for (const t of trees) {
          if (aboveSea(t.y) || isLaunchpad(t.x, t.z)) continue;
          if (!t._shadowHull) {
            const { trunkH: h, canopyScale: sc, variant: vi } = t;
            const hrx = (vi === 2) ? 20 * sc : 17 * sc;
            const hrz = (vi === 2) ? 14 * sc : 12 * sc;
            const trunkHalf = 2.5;
            const footprint = [];
            footprint.push(
              { x: -trunkHalf, z: -trunkHalf }, { x: trunkHalf, z: -trunkHalf },
              { x: trunkHalf, z: trunkHalf }, { x: -trunkHalf, z: trunkHalf }
            );
            for (let i = 0; i < 16; i++) {
              const a = (i / 16) * TWO_PI;
              footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
            }
            t._footprint = footprint;
            t._shadowCasterH = h + (vi === 2 ? 24 : 18) * sc;
            t._shadowHull = true;
          }
          const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
          // isBaking=true because the caller (drawTrees) has already applied the shadow shader and stencil setup
          this._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        }
      }
    }
    _endShadowStencil();
    resetShader();
    setSceneLighting();

    if (profiler) profiler.record('trees', performance.now() - start);
  }


  _getBuildingGeom(b, inf) {
    // Cache both key variants (clean + infected) on the building so toFixed()
    // string allocation is paid only once per building lifetime rather than
    // every frame.  b._geomKeyPair[0] = clean key, b._geomKeyPair[1] = infected key.
    if (!b._geomKeyPair) {
      const base = `bldg_${b.type}_${b.w.toFixed(1)}_${b.h.toFixed(1)}_${b.d.toFixed(1)}_`;
      const colSuffix = (b.type === 2) ? `_${b.col[0]}_${b.col[1]}_${b.col[2]}` : '';
      // Type 5 (Chinese hut) selects variant A or B from position, so include position
      // in the key so different huts with identical dimensions don't share cached geometry.
      const posSuffix = (b.type === 5) ? `_${b.x | 0}_${b.z | 0}` : '';
      b._geomKeyPair = [base + 'false' + colSuffix + posSuffix, base + 'true' + colSuffix + posSuffix];
    }
    const key = b._geomKeyPair[inf ? 1 : 0];

    if (!this._geoms) this._geoms = new Map();
    if (this._geoms.has(key)) return this._geoms.get(key);

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        if      (b.type === 0) buildType0Geometry(b, inf);
        else if (b.type === 1) buildType1Geometry(b, inf);
        else if (b.type === 2) buildType2Geometry(b, inf);
        else if (b.type === 4) buildType4Geometry(b, inf);
        else if (b.type === 5) buildType5Geometry(b, inf);
      });
    } catch (err) {
      console.error("[Viron] Building geometry build failed:", err);
    } finally {
      this._isBuildingShadow = false;
    }

    this._geoms.set(key, geom);
    return geom;
  }

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
              this._buildingChunkMeshCache.delete(bk);
              this._buildingShadowChunkCache.delete(bk);
           }
        }
        for (const bk of newBuckets.keys()) {
           if (!this._buildingBuckets.has(bk)) {
              this._buildingChunkMeshCache.delete(bk);
              this._buildingShadowChunkCache.delete(bk);
           }
        }
      } else {
        // Initial setup or full reset
        this._buildingChunkMeshCache.clear();
        this._buildingShadowChunkCache.clear();
      }

      this._buildingBuckets = newBuckets;
      this._buildingBucketsCount = newCount;
    }
    return this._buildingBuckets.get(`${cx},${cz}`) || [];
  }

  _getChunkBuildingMesh(cx, cz) {
    const key = `${cx},${cz}`;
    if (this._buildingChunkMeshCache.has(key)) return this._buildingChunkMeshCache.get(key);

    if (this._bakeStart && performance.now() - this._bakeStart > 4.0) return null;

    const bldgs = this._getBuildingsForChunk(cx, cz);
    let hasStatic = false;
    for (const b of bldgs) {
      if (b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        hasStatic = true; break;
      }
    }

    if (!hasStatic) {
      this._buildingChunkMeshCache.set(key, null);
      return null;
    }

    // Pre-warm base geometric variants before opening the chunk builder.
    for (const b of bldgs) {
      if (b.type !== 3 && !aboveSea(b.y) && !isLaunchpad(b.x, b.z)) {
        if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
        const inf = infection.has(b._tileKey);
        this._getBuildingGeom(b, inf);
      }
    }

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const b of bldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          
          if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
          const inf = infection.has(b._tileKey);
          
          const bGeom = this._getBuildingGeom(b, inf);
          if (bGeom) {
              push();
              translate(b.x, b.y, b.z);
              model(bGeom);
              pop();
          }
        }
      });
    } catch (err) { console.error(err); } finally { this._isBuildingShadow = false; }
    
    this._buildingChunkMeshCache.set(key, geom);
    return geom;
  }

  _getChunkBuildingShadow(cx, cz, sun) {
    const key = `${cx},${cz}`;
    let cached = this._buildingShadowChunkCache.get(key);
    if (cached && cached.sunX === sun.x && cached.sunY === sun.y && cached.sunZ === sun.z) {
      return cached.geom;
    }

    if (this._bakeStart && performance.now() - this._bakeStart > 4.0) {
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
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        for (const b of bldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          
          if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
          const inf = infection.has(b._tileKey);
          
          if (!b._shadowHull) {
            const { footprint, casterH } = getBuildingFootprint(b);
            b._footprint = footprint;
            b._shadowCasterH = casterH;
            b._shadowHull = true;
          }
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? (inf ? 75 : 65) : (b.type === 0 ? 85 : 80);
          
          this._drawProjectedFootprintShadow(b.x, b.z, b.y, casterH, b._footprint, baseAlpha, sun, false, true);
        }
      });
    } catch (err) { console.error(err); } finally { this._isBuildingShadow = false; }
    
    this._buildingShadowChunkCache.set(key, { geom, sunX: sun.x, sunY: sun.y, sunZ: sun.z });
    return geom;
  }

  drawBuildings(s) {
    this._bakeStart = performance.now(); // Reset bake budget per pass over chunks
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
        const mesh = this._getChunkBuildingMesh(cx, cz);
        if (mesh) {
          model(mesh);
        } else if (!this._buildingChunkMeshCache.has(`${cx},${cz}`)) {
          // Fallback: draw individually if chunk building mesh timed out
          const chunkBldgs = this._getBuildingsForChunk(cx, cz);
          for (const b of chunkBldgs) {
            if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
            if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
            const inf = infection.has(b._tileKey);
            const bGeom = this._getBuildingGeom(b, inf);
            if (bGeom) {
              push(); translate(b.x, b.y, b.z); model(bGeom); pop();
            }
          }
        }

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
        const chunkBldgs = this._getBuildingsForChunk(c.cx, c.cz);
        for (const b of chunkBldgs) {
          if (b.type === 3 || aboveSea(b.y) || isLaunchpad(b.x, b.z)) continue;
          if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
          const inf = infection.has(b._tileKey);
          if (!b._shadowHull) {
            const { footprint, casterH } = getBuildingFootprint(b);
            b._footprint = footprint;
            b._shadowCasterH = casterH;
            b._shadowHull = true;
          }
          const casterH = b._shadowCasterH || b.h;
          const baseAlpha = (b.type === 4) ? (inf ? 75 : 65) : (b.type === 0 ? 85 : 80);
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
  }

}

// Singleton instance used by all other modules
const terrain = new Terrain();
