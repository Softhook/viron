// =============================================================================
// TERRAIN CONFIGURATION (The "Brain")
// Edit these swatches to change the look of the world instantly.
// =============================================================================
const TERRAIN_PALETTE = {
  // Material 1: Inland (6 swatches)
  inland: [
    [60, 180, 60], [30, 120, 40], [180, 200, 50],
    [220, 200, 80], [210, 130, 140], [180, 140, 70]
  ],
  // Material 2: Shore (3 swatches)
  shore: [
    [230, 210, 80], [200, 180, 60], [150, 180, 50]
  ],
  // Viron (Red/Dark/Scan)
  viron: [
    [217, 13, 5],     // cRed index 0
    [46, 5, 2],       // cDark index 1
    [255, 140, 25]    // cScan index 2
  ],
  // Barriers
  barrier: [
    [245, 247, 255],  // Pearl base
    [235, 235, 240]   // Subtle parity shift
  ]
};

// Flattened palette — normalised 0-1, built once at module load rather than
// every frame so applyShader() never allocates a temporary array per draw call.
// Index layout: 0-5 Inland, 6-8 Shore, 9-11 Viron (Red/Dark/Scan), 12-13 Barrier.
const TERRAIN_PALETTE_FLAT = (() => {
  let p = TERRAIN_PALETTE;
  let arr = [];
  for (let c of p.inland) arr.push(...c);
  for (let c of p.shore) arr.push(...c);
  for (let c of p.viron) arr.push(...c);
  for (let c of p.barrier) arr.push(...c);
  return arr.map(v => v / 255.0);
})();

// --- GLSL vertex shader ---
// Passes world-space position through to the fragment shader so the pulse rings
// can be computed in world space rather than screen space.
const TERRAIN_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec4 aVertexColor;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
varying vec4 vColor;
varying vec4 vWorldPos;

void main() {
  vec4 viewSpace = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * viewSpace;
  vWorldPos = vec4(aPosition, 1.0);
  vColor = aVertexColor;
}
`;

// --- GLSL fragment shader ---
// Applies two effects on top of the vertex colour:
//   1. Expanding shockwave rings (up to 5 simultaneous pulses, typed as
//      normal bomb = 0, crab infection = 1, ship explosion = 2).
//   2. Distance fog that blends to the sky colour at the view boundary,
//      smoothly hiding chunk-load pop-in.
const TERRAIN_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
varying vec4 vWorldPos;
uniform float uTime;
uniform vec4 uPulses[5];
uniform vec2 uFogDist;
// Steady sentinel glows: xy = world position, z = glow radius, w = 1.0 if active
uniform vec4 uSentinelGlows[2];
// uPalette: array of vec3 colors for dynamic re-coloring
uniform vec3 uPalette[14];
uniform float uTileSize;
uniform vec3 uFogColor;

void main() {
  // Material IDs (from R channel)
  int mat = int(vColor.r * 255.0 + 0.5);
  vec3 baseColor = vColor.rgb;
  
  if (mat >= 10 && mat <= 11) {
    // ── Viron (Mat 10=Even, 11=Odd) ───────────────────────────────────
    float xP = vWorldPos.x / uTileSize;
    float zP = vWorldPos.z / uTileSize;
    float pulse = sin(uTime * 3.6 + xP * 0.05 + zP * 0.05) * 0.5 + 0.5;
    float scanPos = uTime / 10.0;
    float scan = smoothstep(0.98, 1.0, 1.0 - abs(fract(xP * 0.02 + zP * 0.01 - scanPos) - 0.5) * 2.0);
    float af = clamp(mix(1.15, 0.7, (vWorldPos.y - 200.0) / -350.0), 0.7, 1.15);
    float parity = (mat == 10) ? 1.0 : 0.75;
    vec3 cRed    = uPalette[9] * parity;
    vec3 cDark   = uPalette[10] * parity;
    vec3 cScan   = uPalette[11] * parity; 
    baseColor = mix(cDark, cRed, pulse);
    baseColor += cScan * scan * 1.5;      
    baseColor *= af;
  } else if (mat >= 20 && mat <= 21) {
    // ── Barrier (Mat 20=Even, 21=Odd) ────────────────────────────────
    float xP = vWorldPos.x / uTileSize;
    float zP = vWorldPos.z / uTileSize;
    float shimmer = sin(uTime * 0.7 + xP * 0.15 + zP * 0.1) * 0.5 + 0.5;
    float parity = (mat == 20) ? 1.0 : 0.90;
    vec3 pearlBase = uPalette[12];
    baseColor = pearlBase * parity * (0.88 + 0.12 * shimmer);
  } else if (mat >= 1 && mat <= 2) {
    // ── Landscape (Mat 1=Inland, 2=Shore) ────────────────────────────
    // Use pre-computed Organic Tags from vColor
    float noisePatch = vColor.g;
    float rand = vColor.b;
    float parity = vColor.a;
    
    // Position-based check for the Launchpad.
    // The 0.001 bias (= 0.12 world units) handles floating-point precision at
    // exact tile boundaries without misclassifying vertices that are genuinely
    // on the far edge of the launchpad (the old 0.01 offset = 1.2 world units
    // was large enough to cause a visible seam at the launchpad boundary).
    vec2 tPos = floor(vWorldPos.xz / uTileSize + 0.001);
    if (tPos.x >= 0.0 && tPos.x < 7.0 && tPos.y >= 0.0 && tPos.y < 7.0) {
      baseColor = vec3(1.0);
    } else {
      if (mat == 2) { // Shore
        float idx = floor(rand * 3.0);
        baseColor = (idx < 1.0) ? uPalette[6] : (idx < 2.0 ? uPalette[7] : uPalette[8]);
      } else { // Inland
        // Exact weight-match to original JS: (noise * 2.0 + rand * 0.2) * 6
        float val = mod(floor((noisePatch * 2.0 + rand * 0.2) * 6.0), 6.0);
        if (val < 1.0) baseColor = uPalette[0];
        else if (val < 2.0) baseColor = uPalette[1];
        else if (val < 3.0) baseColor = uPalette[2];
        else if (val < 4.0) baseColor = uPalette[3];
        else if (val < 5.0) baseColor = uPalette[4];
        else baseColor = uPalette[5];
      }
    }
    baseColor *= parity;
  }

  vec3 cyberColor = vec3(0.0);
  
  // Expanding shockwave pulses (bombs, infection, explosions)
  for (int i = 0; i < 5; i++) {
    float age = uTime - uPulses[i].z;
    if (age >= 0.0 && age < 3.0) {
      float type = uPulses[i].w;
      vec2 diff = (vWorldPos.xz - uPulses[i].xy) * 0.01;
      float distToPulse = length(diff) * 100.0;
      float radius = type == 1.0 ? age * 300.0 : (type == 2.0 ? age * 1200.0 : age * 800.0);
      float ringThickness = type == 1.0 ? 30.0 : (type == 2.0 ? 150.0 : 80.0);
      float ring = smoothstep(radius - ringThickness, radius, distToPulse) * (1.0 - smoothstep(radius, radius + ringThickness, distToPulse));
      float fade = 1.0 - (age / 3.0);
      vec3 pulseColor = type == 1.0 ? vec3(0.2, 0.6, 1.0) : (type == 2.0 ? vec3(1.0, 0.8, 0.2) : vec3(1.0, 0.1, 0.1));
      cyberColor += pulseColor * ring * fade * 2.0;
    }
  }

  // Steady sentinel base glows — fixed-radius breathing ring for healthy sentinels
  for (int j = 0; j < 2; j++) {
    if (uSentinelGlows[j].w < 0.5) continue;  // inactive slot
    vec2 diff2 = (vWorldPos.xz - uSentinelGlows[j].xy) * 0.01;
    float dist2 = length(diff2) * 100.0;
    float glowR = uSentinelGlows[j].z;
    // Inner soft fill + sharp edge ring
    float innerGlow = smoothstep(glowR * 1.1, 0.0, dist2) * 0.18;  // soft filled disc
    float ringW = glowR * 0.12;
    float ring2 = smoothstep(glowR - ringW, glowR, dist2) * (1.0 - smoothstep(glowR, glowR + ringW, dist2));
    // Breathe brightness with a slow sine wave, phase-offset by x position
    float breath = 0.6 + 0.4 * sin(uTime * 1.6 + uSentinelGlows[j].x * 0.002);
    cyberColor += vec3(0.0, 0.9, 0.8) * (ring2 * breath * 2.2 + innerGlow * breath);
  }
  
  vec3 outColor = baseColor + cyberColor;
  
  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  outColor = mix(outColor, uFogColor, fogFactor);

  gl_FragColor = vec4(outColor, 1.0);
}
`;

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
    // glowArr   : 2 sentinels × 4 floats (x, z, radius, active)
    this._pulseArr = new Float32Array(20);
    this._glowArr = new Float32Array(8);

    // Pre-allocated overlay buffers for batching viron/barrier quads.
    // Fixed size based on MAX_INF (2000) with a 2x safety margin.
    // Each tile = 6 vertices × 3 floats = 18 floats.
    this._overlayBuffer0 = new Float32Array(5000 * 18);
    this._overlayBuffer1 = new Float32Array(5000 * 18);
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /** Compiles the GLSL shader. Must be called after the p5 WEBGL canvas exists. */
  init() {
    this.shader = createShader(TERRAIN_VERT, TERRAIN_FRAG);
  }

  // ---------------------------------------------------------------------------
  // Pulse effects
  // ---------------------------------------------------------------------------

  /**
   * Registers a new expanding shockwave ring on the terrain surface.
   * @param {number} x    World-space X origin of the pulse.
   * @param {number} z    World-space Z origin of the pulse.
   * @param {number} type 0 = bomb/normal, 1 = crab infection, 2 = ship explosion.
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
    if (this.altCache.size > 25000) this.altCache.clear();
    if (this.chunkCache.size > 500) {
      // Evict the oldest half (Maps iterate in insertion order).
      const keys = this.chunkCache.keys();
      for (let i = 0; i < 250; i++) this.chunkCache.delete(keys.next().value);
    }
  }

  // ---------------------------------------------------------------------------
  // Camera helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns a lightweight camera descriptor (position + forward vector) derived
   * from the player's ship position and yaw.  Used for frustum culling and
   * fog-depth calculations without needing access to the p5 camera object.
   * @param {{x,y,z,yaw,pitch}} s  Ship state object.
   * @returns {{x,z,fwdX,fwdZ}}
   */
  getCameraParams(s) {
    let fwdX = -sin(s.yaw), fwdZ = -cos(s.yaw);
    return {
      x: s.x - fwdX * 550,  // Camera sits 550 units behind the ship
      z: s.z - fwdZ * 550,
      fwdX,
      fwdZ
    };
  }

  /**
   * Broad frustum test — returns false for world objects that are clearly
   * behind the camera or beyond the horizontal field of view.
   * @param {{x,z,fwdX,fwdZ,fovSlope}} cam  Camera descriptor from getCameraParams() with
   *                                          fovSlope pre-computed by drawLandscape().
   * @param {number} tx  World-space X to test.
   * @param {number} tz  World-space Z to test.
   */
  inFrustum(cam, tx, tz) {
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

    let geom = buildGeometry(() => {
      let startX = cx * CHUNK_SIZE;
      let startZ = cz * CHUNK_SIZE;

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

          vertex(xP, y00, zP); vertex(xP1, y10, zP); vertex(xP, y01, zP1);
          vertex(xP1, y10, zP); vertex(xP1, y11, zP1); vertex(xP, y01, zP1);
        }
      }
      endShape();
    });

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
    let fogEnd = VIEW_FAR * TILE + 400;
    let fogStart = VIEW_FAR * TILE - 800;
    let f = constrain(map(depth, fogStart, fogEnd, 0, 1), 0, 1);
    return [
      lerp(col[0], SKY_R, f),
      lerp(col[1], SKY_G, f),
      lerp(col[2], SKY_B, f)
    ];
  }

  // ---------------------------------------------------------------------------
  // Shader application
  // ---------------------------------------------------------------------------

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
    this.shader.setUniform('uTime', millis() / 1000.0);
    this.shader.setUniform('uFogDist', [VIEW_FAR * TILE - 800, VIEW_FAR * TILE + 400]);
    this.shader.setUniform('uFogColor', [SKY_R / 255.0, SKY_G / 255.0, SKY_B / 255.0]);
    this.shader.setUniform('uTileSize', TILE);
    this.shader.setUniform('uPalette', TERRAIN_PALETTE_FLAT);

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
    this.shader.setUniform('uPulses', pulseArr);

    // Write sentinel glow data into the pre-allocated buffer.
    const glowArr = this._glowArr;
    for (let i = 0; i < 2; i++) {
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

  // ---------------------------------------------------------------------------
  // Draw methods
  // ---------------------------------------------------------------------------

  /**
   * Renders a set of tile overlay quads (infection or barrier) using the
   * currently bound terrain shader.  All visible tiles are sorted into two
   * parity buckets so each parity is drawn in a single beginShape/endShape
   * pass, avoiding per-tile GPU flushes.
   *
   * @param {Iterable} tiles   Iterable yielding {tx, tz, verts} tile objects.
   *                           `verts` is lazily populated here when null.
   * @param {number} matEven   Material ID (R channel) for even-parity tiles.
   * @param {number} matOdd    Material ID for odd-parity tiles.
   * @param {number} yOffset   Y offset applied to each vertex corner altitude.
   * @param {object} cam       Camera descriptor from getCameraParams().
   * @param {number} fovSlope  FOV slope for lateral frustum culling.
   * @param {number} minTx     Tile-space view bound (min X).
   * @param {number} maxTx     Tile-space view bound (max X).
   * @param {number} minTz     Tile-space view bound (min Z).
   * @param {number} maxTz     Tile-space view bound (max Z).
   * @param {string} tag       Profiler tag to label this overlay batch.
   */
  _drawTileOverlays(tiles, matEven, matOdd, yOffset, cam, fovSlope, minTx, maxTx, minTz, maxTz, tag) {
    const profiler = getVironProfiler();
    const overlayStart = profiler ? performance.now() : 0;
    let overlayCount = 0;

    // Use pre-allocated Float32Arrays to avoid per-frame GC churn.
    const b0 = this._overlayBuffer0;
    const b1 = this._overlayBuffer1;
    let i0 = 0, i1 = 0;

    for (const t of tiles) {
      if (t.tx < minTx || t.tx > maxTx || t.tz < minTz || t.tz > maxTz) continue;

      const tcx = t.tx * TILE + TILE * 0.5, tcz = t.tz * TILE + TILE * 0.5;
      const tdx = tcx - cam.x, tdz = tcz - cam.z;
      const tFwd = tdx * cam.fwdX + tdz * cam.fwdZ;
      if (tFwd < -TILE * 2) continue;
      if (Math.abs(tdx * -cam.fwdZ + tdz * cam.fwdX) > (tFwd > 0 ? tFwd : 0) * fovSlope + TILE * 4) continue;

      if (!t.verts) {
        const xP = t.tx * TILE, zP = t.tz * TILE, xP1 = xP + TILE, zP1 = zP + TILE;
        // Vertex data is stored in a simple array; TypedArray.set() handles the conversion during copy.
        t.verts = [
          xP, this.getAltitude(xP, zP) + yOffset, zP,
          xP1, this.getAltitude(xP1, zP) + yOffset, zP,
          xP, this.getAltitude(xP, zP1) + yOffset, zP1,
          xP1, this.getAltitude(xP1, zP) + yOffset, zP,
          xP1, this.getAltitude(xP1, zP1) + yOffset, zP1,
          xP, this.getAltitude(xP, zP1) + yOffset, zP1
        ];
      }

      overlayCount++;
      if (((t.tx + t.tz) % 2 === 0)) {
        b0.set(t.verts, i0);
        i0 += 18;
      } else {
        b1.set(t.verts, i1);
        i1 += 18;
      }
    }

    if (i0 > 0) {
      fill(matEven, 0, 0, 255);
      beginShape(TRIANGLES);
      for (let i = 0; i < i0; i += 3) vertex(b0[i], b0[i + 1], b0[i + 2]);
      endShape();
    }
    if (i1 > 0) {
      fill(matOdd, 0, 0, 255);
      beginShape(TRIANGLES);
      for (let i = 0; i < i1; i += 3) vertex(b1[i], b1[i + 1], b1[i + 2]);
      endShape();
    }
    if (profiler && tag) {
      const elapsed = performance.now() - overlayStart;
      profiler.recordOverlay(tag, overlayCount, elapsed);
    }
  }

  /**
   * Renders the visible terrain chunks, infected tile overlays, sea plane and
   * launchpad missile decorations for one player's viewport.
   *
   * Draw order:
   *   1. Terrain chunks (via cached geometry + terrain shader)
   *   2. Infected tile overlays (pulsing green quads drawn on top)
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
   */
  drawLandscape(s, viewAspect) {
    let gx = toTile(s.x), gz = toTile(s.z);
    noStroke();

    // Compute camera params once and cache on the instance so drawTrees,
    // drawBuildings and enemies.draw reuse the same values this frame.
    let cam = this.getCameraParams(s);

    // Pre-compute FOV slope once — used for chunk culling, infected-tile culling,
    // and inFrustum() calls in drawTrees/drawBuildings.
    // 0.57735 = tan(30°), matching the PI/3 perspective FOV used in renderPlayerView.
    // The +0.3 padding ensures objects at oblique angles are never incorrectly culled.
    // viewAspect must match the value passed to perspective() so culling is accurate.
    cam.fovSlope = 0.57735 * viewAspect + 0.3;  // Attached to cam so inFrustum() reuses it
    this._cam = cam;

    let fovSlope = cam.fovSlope;
    let chunkHalf = CHUNK_SIZE * TILE;   // One chunk width — used as lateral margin

    // p5 lighting silently overrides custom shaders that don't declare lighting
    // uniforms; disable it for the terrain pass.
    noLights();
    const profiler = getVironProfiler();
    const shaderStart = profiler ? performance.now() : 0;
    this.applyShader();
    if (profiler) profiler.record('shader', performance.now() - shaderStart);

    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        // Full frustum cull at chunk level — skip chunks behind OR to the sides.
        // Uses the chunk centre with a one-chunk lateral margin so no
        // partially-visible edge chunk is accidentally dropped.
        let chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
        let chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;
        let dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
        let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
        if (fwdDist < -chunkHalf) continue;   // More than one chunk behind
        let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
        let halfWidth = (fwdDist > 0 ? fwdDist : 0) * fovSlope + chunkHalf;
        if (Math.abs(rightDist) > halfWidth) continue;  // Lateral frustum cull

        model(this.getChunkGeometry(cx, cz));
      }
    }

    const minTx = gx - VIEW_FAR, maxTx = gx + VIEW_FAR;
    const minTz = gz - VIEW_FAR, maxTz = gz + VIEW_FAR;

    // Build Viron tile overlays.
    // Uses the same chunk-bucket path as barriers: iterates only tiles whose
    // chunk overlaps the current view rectangle, so cost is O(visible tiles)
    // regardless of how many infected tiles exist elsewhere in the world.
    {
      const _iBuckets = infection.buckets;
      const _infSource = _iBuckets
        ? (function* (b, x0, x1, z0, z1) {
            for (let cz = z0; cz <= z1; cz++) {
              for (let cx = x0; cx <= x1; cx++) {
                const arr = b.get(`${cx},${cz}`);
                if (arr) yield* arr;
              }
            }
          })(infection.buckets, minCx, maxCx, minCz, maxCz)
        : infection.keys();
      this._drawTileOverlays(
        _infSource, 10, 11, -0.5,
        cam, fovSlope, minTx, maxTx, minTz, maxTz, 'infection'
      );
    }

    // --- Barrier tile overlays ---
    // Reads from the global barrierTiles Map — iterates once to cull and collect
    // visible tile vertices, then draws in exactly TWO beginShape/endShape passes
    // (one per checkerboard parity) so fill() is never called inside an active
    // shape.  Calling fill() mid-shape forces p5's WEBGL renderer to flush its
    // internal vertex buffer on every colour change; with 2,000 barrier tiles
    // alternating between two colours that would be ~2,000 GPU flushes per frame.
    //
    // When barrierTiles.buckets is populated (always true at runtime since it is
    // constructed with withBuckets=true), we iterate only chunk buckets that
    // overlap the current view rectangle instead of the entire global tile list.
    // Cost becomes O(visible tiles) regardless of total barrier count.
    if (typeof barrierTiles !== 'undefined' && barrierTiles.size > 0) {
      const _bBuckets = barrierTiles.buckets;
      const _barrierSource = _bBuckets
        ? (function* (b, x0, x1, z0, z1) {
            for (let cz = z0; cz <= z1; cz++) {
              for (let cx = x0; cx <= x1; cx++) {
                const arr = b.get(`${cx},${cz}`);
                if (arr) yield* arr;
              }
            }
          })(barrierTiles.buckets, minCx, maxCx, minCz, maxCz)
        : barrierTiles.values();
      this._drawTileOverlays(
        _barrierSource, 20, 21, -0.3,
        cam, fovSlope, minTx, maxTx, minTz, maxTz, 'barrier'
      );
    }

    // Static sea plane — a single flat quad at SEA + 3 covering the visible area.
    // No per-vertex sine calculations; all four corners share the same Y so there
    // is no per-frame geometry work beyond issuing the two-triangle draw call.
    // The sea is drawn while the terrain shader is still active so it receives the
    // same fog blending that hides terrain chunk pop-in at the view boundary.
    // mat = int(15 * 255/255 + 0.5) = 15, which matches no material branch in the
    // shader, so vColor.rgb falls through as the raw sea blue — this is intentional.
    let seaSize = VIEW_FAR * TILE * 1.5;
    let seaCx = toTile(s.x) * TILE, seaCz = toTile(s.z) * TILE;
    let sx0 = seaCx - seaSize, sx1 = seaCx + seaSize;
    let sz0 = seaCz - seaSize, sz1 = seaCz + seaSize;
    let sy = SEA + 3;
    fill(15, 45, 150);
    beginShape(TRIANGLES);
    vertex(sx0, sy, sz0); vertex(sx1, sy, sz0); vertex(sx0, sy, sz1);
    vertex(sx1, sy, sz0); vertex(sx1, sy, sz1); vertex(sx0, sy, sz1);
    endShape();

    // Restore standard lighting for subsequent non-terrain objects
    resetShader();
    setSceneLighting();

    // Zarch-tribute: missiles lined up along the right side of the launchpad
    push();
    let mX = LAUNCH_MAX - 100;
    for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
      let mDepth = (mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ;
      let bCol = this.getFogColor([60, 60, 60], mDepth);
      let mCol = this.getFogColor([255, 140, 20], mDepth);
      push();
      translate(mX, LAUNCH_ALT, mZ);
      fill(bCol[0], bCol[1], bCol[2]);
      push(); translate(0, -10, 0); box(30, 20, 30); pop();          // Stand
      fill(mCol[0], mCol[1], mCol[2]);
      push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();  // Rocket body
      pop();
    }
    pop();
  }



  /**
   * Draws all trees within rendering range, applying fog colour blending and
   * infection tinting.  Healthy trees are green; infected trees turn red-brown.
   * A ground shadow ellipse is rendered for close trees (within 1500 units).
   * @param {{x,y,z,yaw}} s  Ship state (used as the view origin for culling).
   */
  drawTrees(s) {
    let treeCullDist = VIEW_FAR * TILE;
    let cullSq = treeCullDist * treeCullDist;
    // Reuse the camera params computed in drawLandscape for this frame.
    let cam = this._cam || this.getCameraParams(s);

    for (let t of trees) {
      let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, t.x, t.z)) continue;
      let y = t.y;  // Pre-cached at setup — no Map lookup needed
      if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

      push(); translate(t.x, y, t.z); noStroke();
      let { trunkH: h, canopyScale: sc, variant: vi } = t;
      let inf = infection.has(tileKey(toTile(t.x), toTile(t.z)));

      let depth = (t.x - cam.x) * cam.fwdX + (t.z - cam.z) * cam.fwdZ;

      // Trunk — slightly darker/redder when infected
      let trCol = this.getFogColor([inf ? 80 : 100, inf ? 40 : 65, inf ? 20 : 25], depth);
      fill(trCol[0], trCol[1], trCol[2]);
      push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

      // Canopy (first layer)
      let tv = TREE_VARIANTS[vi];
      let c1Col = this.getFogColor(inf ? tv.infected : tv.healthy, depth);
      fill(c1Col[0], c1Col[1], c1Col[2]);

      if (vi === 2) {
        // Conifer: single tall cone
        push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
      } else {
        let cn = tv.cones[0];
        push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();

        // Second canopy layer (variant 1 only)
        if (tv.cones2) {
          let c2Col = this.getFogColor(inf ? tv.infected2 : tv.healthy2, depth);
          fill(c2Col[0], c2Col[1], c2Col[2]);
          let cn2 = tv.cones2[0];
          push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
        }
      }

      // Soft ground shadow for nearby trees only (performance optimisation)
      if (dSq < 2250000) {
        push(); translate(0, -0.5, 8); rotateX(PI / 2); fill(0, 0, 0, 40); ellipse(0, 0, 20 * sc, 12 * sc); pop();
      }
      pop();
    }
  }

  /**
   * Draws all buildings within rendering range with fog blending and infection
   * tinting.  Four building archetypes are supported:
   *   0 — Geometric structure (box body + inverted-pyramid roof funnel)
   *   1 — Water tower (cylinder + dome)
   *   2 — Industrial complex (layered boxes + smokestack)
   *   3 — Orbiting UFO power-up (double-cone, floats above ground)
   * @param {{x,y,z,yaw}} s  Ship state used as view origin for culling.
   */
  drawBuildings(s) {
    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    // Reuse the camera params computed in drawLandscape for this frame.
    let cam = this._cam || this.getCameraParams(s);

    for (let b of buildings) {
      let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, b.x, b.z)) continue;
      let y = b.y;  // Pre-cached at setup — no Map lookup needed
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

      let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));
      let depth = (b.x - cam.x) * cam.fwdX + (b.z - cam.z) * cam.fwdZ;
      push(); translate(b.x, y, b.z); noStroke();

      if (b.type === 0) {
        // Geometric structure: white box body + inverted-pyramid roof funnel (turns red when infected)
        let bc = this.getFogColor(inf ? [200, 50, 50] : [220, 220, 220], depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();
        let rc = this.getFogColor(inf ? [150, 30, 30] : [220, 50, 50], depth);
        fill(rc[0], rc[1], rc[2]);
        push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();

      } else if (b.type === 1) {
        // Water tower: grey cylinder body + light-blue dome top
        let bc = this.getFogColor(inf ? [200, 50, 50] : [150, 160, 170], depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();
        let tc = this.getFogColor(inf ? [150, 30, 30] : [80, 180, 220], depth);
        fill(tc[0], tc[1], tc[2]);
        push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();

      } else if (b.type === 2) {
        // Industrial: flat wide base + offset annex + smokestack
        let bc = this.getFogColor(inf ? [200, 50, 50] : b.col, depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
        push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();
        let sc = this.getFogColor(inf ? [120, 20, 20] : [80, 80, 80], depth);
        fill(sc[0], sc[1], sc[2]);
        push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();

      } else if (b.type === 3) {
        // Type 3 — floating UFO power-up: double-cone orbiting above the ground
        let bc = this.getFogColor(inf ? [200, 50, 50] : [60, 180, 240], depth);
        fill(bc[0], bc[1], bc[2]);
        push();
        let floatY = y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
        translate(0, floatY - y, 0);
        rotateY(frameCount * 0.01 + b.x);
        rotateZ(frameCount * 0.015 + b.z);
        cone(b.w, b.h / 2, 4, 1);
        rotateX(PI);
        cone(b.w, b.h / 2, 4, 1);
        pop();

      } else if (b.type === 4) {
        // Sentinel: iconic multi-tiered energy tower on a mountain peak.
        // Healthy = cold steel/cyan energy; infected = corroded red/orange.
        // Structure layers (bottom to top):
        //   1. Wide hexagonal base plinth
        //   2. Tier 1 — wide lower section
        //   3. Tier 2 — mid section (narrower)
        //   4. Central energy reactor sphere
        //   5. Tier 3 — upper section (narrowest)
        //   6. Pinnacle spire + rotating crown ring
        // Steady ground glow is rendered by the terrain GLSL shader (uSentinelGlows).

        // Colours
        let cSteel = inf ? [160, 38, 38] : [52, 68, 90];
        let cPlinth = inf ? [130, 28, 28] : [38, 52, 72];
        let cAccent = inf ? [200, 55, 20] : [40, 200, 185];
        let cReactor = inf ? [255, 100, 30] : [80, 240, 215];
        let cGlow = inf ? [220, 60, 20] : [20, 230, 210];
        let cSpire = inf ? [240, 80, 40] : [160, 240, 255];

        // Fog-blended colours
        let fcSteel = this.getFogColor(cSteel, depth);
        let fcPlinth = this.getFogColor(cPlinth, depth);
        let fcAccent = this.getFogColor(cAccent, depth);
        let fcReactor = this.getFogColor(cReactor, depth);
        let fcGlow = this.getFogColor(cGlow, depth);
        let fcSpire = this.getFogColor(cSpire, depth);

        let bw = b.w;   // base width reference (40)
        let bh = b.h;   // total height reference (200)

        // ── 1. Wide hexagonal base plinth ───────────────────────────────
        fill(fcPlinth[0], fcPlinth[1], fcPlinth[2]);
        push(); translate(0, -bh * 0.04, 0); cylinder(bw * 1.1, bh * 0.08, 6, 1); pop();
        // Plinth rim band
        fill(fcAccent[0], fcAccent[1], fcAccent[2]);
        push(); translate(0, -bh * 0.08, 0); cylinder(bw * 1.05, bh * 0.015, 6, 1); pop();

        // ── 2. Tier 1 — wide lower section ──────────────────────────────
        fill(fcSteel[0], fcSteel[1], fcSteel[2]);
        push(); translate(0, -bh * 0.23, 0); cylinder(bw * 0.75, bh * 0.30, 8, 1); pop();
        // Tier 1 accent band
        fill(fcAccent[0], fcAccent[1], fcAccent[2]);
        push(); translate(0, -bh * 0.37, 0); cylinder(bw * 0.78, bh * 0.018, 8, 1); pop();

        // ── 3. Tier 2 — mid section ─────────────────────────────────────
        fill(fcSteel[0], fcSteel[1], fcSteel[2]);
        push(); translate(0, -bh * 0.52, 0); cylinder(bw * 0.48, bh * 0.24, 8, 1); pop();
        // Tier 2 accent band
        fill(fcAccent[0], fcAccent[1], fcAccent[2]);
        push(); translate(0, -bh * 0.64, 0); cylinder(bw * 0.51, bh * 0.016, 8, 1); pop();

        // ── 4. Central energy reactor sphere (mid-height) ────────────────
        fill(fcReactor[0], fcReactor[1], fcReactor[2]);
        push(); translate(0, -bh * 0.40, 0); sphere(bw * 0.3, 8, 6); pop();

        // ── 5. Tier 3 — upper section ────────────────────────────────────
        fill(fcSteel[0], fcSteel[1], fcSteel[2]);
        push(); translate(0, -bh * 0.76, 0); cylinder(bw * 0.28, bh * 0.20, 8, 1); pop();
        // Tier 3 accent band
        fill(fcAccent[0], fcAccent[1], fcAccent[2]);
        push(); translate(0, -bh * 0.85, 0); cylinder(bw * 0.31, bh * 0.014, 8, 1); pop();

        // ── 6. Pinnacle spire + rotating crown ring ──────────────────────
        // Tier 3 top = -bh*0.86. Crown ring sits right there.
        fill(fcGlow[0], fcGlow[1], fcGlow[2]);
        push();
        translate(0, -bh * 0.87, 0);
        rotateY(frameCount * 0.032 + b.x * 0.001);
        torus(bw * 0.32, bw * 0.07, 14, 6);
        pop();

        // Spire cone — p5 cone() points upward by default; no PI rotation needed.
        // Centre at -bh*0.99 → base at -bh*0.87 (crown level), tip at -bh*1.11.
        fill(fcSpire[0], fcSpire[1], fcSpire[2]);
        push(); translate(0, -bh * 0.99, 0); cone(bw * 0.18, bh * 0.24, 6, 1); pop();
        // Tip ball at the very apex
        fill(fcReactor[0], fcReactor[1], fcReactor[2]);
        push(); translate(0, -bh * 1.11, 0); sphere(bw * 0.08, 6, 4); pop();
        // (The ground-level energy ring glow is rendered by the terrain shader
        //  via the uSentinelGlows uniform — no 3D halo tori needed here.)
      }
      pop();

      // Ground shadow only for nearby buildings
      if (dSq < 2250000) {
        drawShadow(b.x, y, b.z, b.w * 1.5, b.d * 1.5);
      }
    }
  }
}

// Singleton instance used by all other modules
const terrain = new Terrain();
