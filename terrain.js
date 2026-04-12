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

// Trees / buildings per buildGeometry() batch call.  Keeping batches small
// (~4 trees ≈ 2 ms, ~2 buildings ≈ 2–4 ms) means a cold-cache chunk no longer
// causes a 7–9 ms single-frame spike; un-baked geometry falls back to per-item
// individual draws until baking completes over several frames.
const TREE_BATCH_SIZE = 4;
const BUILDING_BATCH_SIZE = 2;

// Maximum total wall-clock time (ms) that buildGeometry() bake calls are allowed
// to consume in a single frame across all chunks and all types.  Acts as a safety
// valve for the case where many chunks appear simultaneously (e.g. fast travel).
// Each individual bake costs ~0.5–2 ms, so BAKE_BUDGET_MS=4 allows 1–8 batches
// per frame under typical conditions.  Different chunks may each do one bake per
// frame as long as this budget is not exceeded, which is enforced separately by
// the per-chunk _chunksBakedThisFrame Set.
// Note: this is a soft limit — the budget is checked before starting a bake, so
// the last batch of a given frame may push the actual total slightly above 4 ms.
// The overshoot is bounded by one batch (~0.5–2 ms), which is acceptable.
// Shadow bakes in isBaking mode use maxDepth=1 (~2.5 ms each at Dusk/Dawn low sun),
// so a budget of 4 ms allows ~2 shadow bakes per frame, keeping the warmup window
// short after any time-of-day change without dominating the frame budget.
const BAKE_BUDGET_MS = 4.0;

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
    this._treeBakeState = new Map();
    this._treeShadowChunkCache = new Map();
    this._buildingBakeState = new Map();
    this._buildingShadowChunkCache = new Map();
    this._bakedShadowSun = { x: 0, y: 1, z: 0 };
    this._buildingBucketsCount = 0;
    // Mutex flag: true while a _safeBuildGeometry() bake call is in progress,
    // preventing re-entrant geometry builds.  Must be initialized to false so a
    // stray exception in an earlier bake cannot permanently lock out all
    // subsequent baking for the remainder of the session.
    this._isBuildingShadow = false;
    // Per-frame bake tracking.  _bakeFrame is the last frameCount for which the
    // bake window was opened by drawTrees() (so terrain rendering time does not
    // consume the baking allowance).  drawBuildings() shares the window by checking
    // _bakeFrame === currentFrame.
    //
    // _chunksBakedThisFrame: Set of "cx,cz" keys for chunks that have already
    // performed one buildGeometry() call this frame.  Prevents any single chunk
    // from doing compound baking (e.g. tree mesh + shadow + building mesh all in
    // the same frame), which would stack multiple ~1–2 ms costs into a single
    // 5+ ms spike.  Multiple DIFFERENT chunks can each bake once per frame, which
    // is far better than the previous global counter that serialised ALL chunks.
    //
    // _bakeBudgetUsedMs: wall-clock ms spent on buildGeometry() this frame across
    // all chunks.  Safety valve: once this exceeds BAKE_BUDGET_MS, no further bakes
    // fire this frame regardless of per-chunk token state.  Prevents runaway cost
    // when many chunks appear simultaneously (fast travel / first load).
    this._bakeFrame = -1;
    this._chunksBakedThisFrame = new Set();
    this._bakeBudgetUsedMs = 0;

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
    // Use numeric tileKey to match tree.k and building._tileKey which are both
    // set via tileKey() — NOT a "tx,tz" string. Mismatching types caused the
    // === comparison to always be false, so baked chunk meshes were never
    // invalidated when infection spread to them.
    const k = tileKey(tx, tz);

    let treeHit = false;
    const trees = this.getProceduralTreesForChunk(cx, cz);
    for (let i = 0; i < trees.length; i++) {
        if (trees[i].k === k) { treeHit = true; break; }
    }
    if (treeHit) {
      this._treeBakeState.delete(bk);
    }

    let bldgHit = false;
    const bldgs = this._getBuildingsForChunk(cx, cz);
    for (let i = 0; i < bldgs.length; i++) {
        if (bldgs[i]._tileKey === k) { bldgHit = true; break; }
    }
    if (bldgHit) {
        this._buildingBakeState.delete(bk);
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

  /**
   * Resets the terrain system by clearing all memoised altitude and geometry caches.
   * Required when mountain peaks or other global terrain parameters are modified.
   */
  /**
   * @param {number} [seed] Optional new world seed. If it matches the current seed,
   *                      caches are preserved to allow seamless session restarts.
   */
  reset(seed) {
    if (seed !== undefined && seed === this._seed) {
      // Seed is unchanged: preserve the expensive geometry caches (Terrain, Trees, Buildings)
      // but clear ephemeral state that might fluctuate (active pulses).
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
    this._bakeFrame = -1;
    this._chunksBakedThisFrame.clear();
    this._bakeBudgetUsedMs = 0;
    this._buildingBucketsCount = 0;
    if (this._buildingBuckets) this._buildingBuckets.clear();
    if (this._geoms) this._geoms.clear();
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
    if (!this._overlayDirtyQueue) this._overlayDirtyQueue = new Set();
    this._overlayDirtyQueue.add(`${managerId}_${bk}`);
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

    if (this._overlayDirtyQueue && this._overlayDirtyQueue.size > 0) {
      // Drain the entire queue synchronously so visual updates (heals/infections) perfectly
      // match the game state. Real-time overlay geometry builds are extremely fast, 
      // making rate-limiting unnecessary and heavily susceptible to visual latency.
      for (const dirtyPrefix of this._overlayDirtyQueue) {
        const searchPrefix = `${dirtyPrefix}_`;
        for (const k of this._overlayCaches.keys()) {
          if (k.startsWith(searchPrefix)) this._overlayCaches.delete(k);
        }
      }
      this._overlayDirtyQueue.clear();
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

}

