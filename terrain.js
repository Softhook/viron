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
  ],
  // Yellow Viron (Yellow/Dark/Luminous) - Virulent Virus
  yellowViron: [
    [255, 255, 0],     // Yellow index 0
    [60, 60, 0],       // Dark index 1
    [255, 255, 100]    // Scan index 2
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
  for (let c of p.yellowViron) arr.push(...c);
  return arr.map(v => v / 255.0);
})();

// --- GLSL vertex shader ---
// Passes world-space position through to the fragment shader so the pulse rings
// can be computed in world space rather than screen space.
const TERRAIN_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec4 aVertexColor;
attribute vec3 aNormal;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform mat3 uNormalMatrix;
varying vec4 vColor;
varying vec4 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;
uniform mat4 uInvViewMatrix;

void main() {
  vec4 viewSpace = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * viewSpace;
  
  vViewNormal = normalize(uNormalMatrix * aNormal);
  vViewPos = viewSpace.xyz;
  
  // By transforming viewSpace back to world space using the inverse view matrix,
  // we get true world position and world normals even when the geometry (like enemies)
  // is subjected to local translate() and rotate() calls in p5.
  vWorldPos = uInvViewMatrix * viewSpace;
  vNormal = normalize(mat3(uInvViewMatrix) * vViewNormal);
  
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
varying vec3 vNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;
uniform float uTime;
uniform vec4 uPulses[5];
uniform vec2 uFogDist;
// Steady sentinel glows: xy = world position, z = glow radius, w = 1.0 if active
uniform vec4 uSentinelGlows[2];
// uPalette: array of vec3 colors for dynamic re-coloring
uniform vec3 uPalette[17];
uniform float uTileSize;
uniform vec3 uFogColor;
// Terrain-local lighting uniforms (used while p5 built-in lights are disabled).
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbientLow;
uniform vec3 uAmbientHigh;

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
  } else if (mat >= 14 && mat <= 15) {
    // ── Green Viron (Mat 14=Even, 15=Odd) ─────────────────────────────
    float xP = vWorldPos.x / uTileSize;
    float zP = vWorldPos.z / uTileSize;
    float pulse = sin(uTime * 4.8 + xP * 0.08 + zP * 0.08) * 0.5 + 0.5; // Faster pulse
    float scanPos = uTime / 8.0; // Faster scan
    float scan = smoothstep(0.98, 1.0, 1.0 - abs(fract(xP * 0.02 + zP * 0.01 - scanPos) - 0.5) * 2.0);
    float af = clamp(mix(1.3, 0.8, (vWorldPos.y - 200.0) / -350.0), 0.8, 1.3); // Brighter
    float parity = (mat == 14) ? 1.0 : 0.75;
    vec3 gGreen = uPalette[14] * parity;
    vec3 gDark  = uPalette[15] * parity;
    vec3 gScan  = uPalette[16] * parity; 
    baseColor = mix(gDark, gGreen, pulse);
    baseColor += gScan * scan * 2.0; // More intense scan
    baseColor *= af;
  } else if (mat >= 20 && mat <= 21) {
    // ── Barrier (Mat 20=Even, 21=Odd) ────────────────────────────────
    float xP = vWorldPos.x / uTileSize;
    float zP = vWorldPos.z / uTileSize;
    float shimmer = sin(uTime * 0.7 + xP * 0.15 + zP * 0.1) * 0.5 + 0.5;
    float parity = (mat == 20) ? 1.0 : 0.90;
    vec3 pearlBase = uPalette[12];
    baseColor = pearlBase * parity * (0.88 + 0.12 * shimmer);
  } else if (mat == 30) {
    // ── Sea plane (Mat 30) ────────────────────────────────────────────
    // Fixed deep-blue base colour, unaffected by shockwave pulse effects
    // (mat 30 > 21 so it is excluded from the cyberColor accumulation below).
    baseColor = vec3(15.0/255.0, 45.0/255.0, 150.0/255.0);
  } else if (mat >= 250 && mat <= 251) {
    // ── Powerup (Mat 250=Healthy, 251=Infected) ────────────────────────
    baseColor = (mat == 250) ? vec3(60.0/255.0, 180.0/255.0, 240.0/255.0) : vec3(200.0/255.0, 50.0/255.0, 50.0/255.0);
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
    bool isLaunchpadFrag = (tPos.x >= 0.0 && tPos.x < 7.0 && tPos.y >= 0.0 && tPos.y < 7.0);
    if (isLaunchpadFrag) {
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
  
  // === Directional lighting — Lambert + hemisphere ambient + sky fill ===
  //
  // Previous design bugs fixed:
  //   • warmKey * diffuse double-multiplied diffuse (quadratic → 2.1× at ndl=1, overexposed)
  //   • max(lightTerm, 0.46) floor killed all shadow contrast (shadows never darker than 46%)
  //   • Additive coolShadow+dawnFill pushed even backlit faces above 60% brightness
  vec3 n = normalize(vNormal);
  float hemi = n.y * -0.5 + 0.5;

  // Hemisphere ambient: warm ground-bounce low, cool sky-dome high
  vec3 ambient = mix(uAmbientLow, uAmbientHigh, hemi);

  // Invert uSunDir because the uniform stores the direction light TRAVELS.
  // We need the vector TO the sun for the Lambert dot product to correctly shade surfaces.
  vec3 toSun = normalize(-uSunDir);

  // Pure Lambert — direct sun
  // ndl    = one-sided Lambert for terrain/landscape (backs go dark — correct for solid ground)
  // ndlAbs = two-sided Lambert for ships/enemies — handles inconsistent vertex winding gracefully
  //          An inverted normal shows the same shading as the front face, not black.
  float ndl    = max(dot(n, toSun), 0.0);
  float ndlAbs = abs(dot(n, toSun));
  vec3 keyLight = uSunColor * ndl;

  // Combine: brighter ambient base + warm sun key
  vec3 lightTerm = ambient + keyLight;
  
  // Very low floor: allows genuine shadow darkness
  lightTerm = max(lightTerm, vec3(0.06, 0.08, 0.12));
  vec3 litBase;
  if (mat >= 10 && mat <= 21) {
    // Keep Viron and Barrier emissive in shadow so they don't turn black
    litBase = baseColor * max(lightTerm, vec3(0.85));
  } else if (mat >= 250 && mat <= 251) {
    // Powerups are glowing holograms but retain 3D shading
    litBase = baseColor * max(lightTerm, vec3(0.8));
    litBase += baseColor * 0.3; // Give it an extra emissive boost
  } else if (mat >= 1 && mat <= 2) {
    // Terrain (landscape): one-sided Lambert — back faces are genuinely underground, so black is fine
    litBase = baseColor * lightTerm;
  } else {
    // Ships, trees, enemies: use two-sided Lambert (abs) so winding order inconsistencies
    // don't produce completely black faces. A flipped normal gives the same luminance as its twin.
    vec3 shipKeyLight = uSunColor * ndlAbs;
    vec3 shipLightTerm = max(ambient + shipKeyLight, vec3(0.15, 0.18, 0.22));
    litBase = baseColor * shipLightTerm;
  }

  // Keep pulses and sentinel glows emissive so they read clearly at all times.
  // We constrain this to ground/infection materials (mat <= 21) so that ships, trees,
  // and floating units do not glow completely when a bomb detonates underneath them.
  vec3 outColor = litBase;
  if (mat <= 21) {
    outColor += cyberColor;
  }
  
  // --- Fresnel Rim Lighting ---
  // V points from surface to camera in view space. Nv is the surface normal in view space.
  vec3 V = normalize(-vViewPos);
  float fresnel = 1.0 - max(dot(normalize(vViewNormal), V), 0.0);
  fresnel *= fresnel; // pow(fresnel, 2.0) -> fast square
  
  // Mask 1: Sun direction (Lambert ndl). Only rim-light the sun-facing side.
  float litMask = smoothstep(0.0, 0.2, ndl);
  
  // Mask 2: Ambient Hemisphere (-vNormal.y). Only rim-light top-facing surfaces (so bottoms aren't rim-lit).
  // In p5.js coordinates, -Y is UP. So a top-facing plane has vNormal.y = -1.0.
  // vNormal interpolation can un-normalize it slightly, but for a fast Y-mask, the raw varying is close enough.
  float rimMask = smoothstep(-0.2, 0.5, -vNormal.y);
  
  // Combine rim masks. Skip rim on launchpad (already white — would over-saturate).
  // Use a fast world-position check duplicated from the launchpad branch above.
  vec2 tPosRim = floor(vWorldPos.xz / uTileSize + 0.001);
  bool skipRim = (mat >= 1 && mat <= 2) &&
                 (tPosRim.x >= 0.0 && tPosRim.x < 7.0 &&
                  tPosRim.y >= 0.0 && tPosRim.y < 7.0);

  vec3 rim = uFogColor * fresnel * litMask * rimMask;
  if (!skipRim) {
    if (mat == 30) {
      outColor += baseColor * rim * 3.0;
    } else if (mat >= 1 && mat <= 21) {
      // Terrain / Trees / Infection: Soft diffuse rim
      outColor += baseColor * rim * 1.2;
    } else {
      // Ships and Powerups: Harder specular rim
      outColor += rim * 0.7;
    }
  }

  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  outColor = mix(outColor, uFogColor, fogFactor);

  gl_FragColor = vec4(outColor, 1.0);
}
`;

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

    // Pre-allocated scalar-uniform buffers — each would otherwise allocate a new JS
    // array literal every frame inside applyShader().
    this._uFogDistArr = new Float32Array(2);
    this._uFogColorArr = new Float32Array(3);
    this._uSunDirArr = new Float32Array(3);
    this._uSunColorArr = new Float32Array(3);
    this._uAmbLowArr = new Float32Array(3);
    this._uAmbHighArr = new Float32Array(3);

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

    // Cached per-frame sun shadow basis so multiple shadow draws don't
    // renormalize the same vector every call.
    this._sunShadowBasis = { x: 0, y: 1, z: 0 };
    this._sunShadowFrame = -Infinity;
    this._getSunShadowBasis();

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

    // Tree chunks are cheap metadata; keep more before trimming.
    if (this._procTreeChunkCache.size > 1200) {
      const keys = this._procTreeChunkCache.keys();
      for (let i = 0; i < 600; i++) this._procTreeChunkCache.delete(keys.next().value);
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

    const maxTreesPerChunk = isMobile ? 9 : 13;
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
   * Binds the terrain GLSL shader and uploads per-frame uniforms:
   *   • uTime     — elapsed seconds, drives pulse ring expansion
   *   • uFogDist  — [fogStart, fogEnd] in world units
   *   • uFogColor — sky/fog RGB colour (derived from SKY_R/G/B constants)
   *   • uPulses   — flat array of up to 5 pulse descriptors [x, z, startTime, type]
   * Must be called before any model() draw calls that should use the terrain shader.
   */
  applyShader() {
    shader(this.shader);
    const fogFar = this._getFogFarWorld();

    // Fill pre-allocated uniform buffers in-place — avoids allocating a new JS
    // array literal for every setUniform() call each frame.
    this._uFogDistArr[0] = fogFar - 800; this._uFogDistArr[1] = fogFar + 400;
    this._uFogColorArr[0] = SKY_R / 255.0; this._uFogColorArr[1] = SKY_G / 255.0; this._uFogColorArr[2] = SKY_B / 255.0;
    // SUN_DIR_NX/NY/NZ are the pre-normalized sun direction constants; no temp
    // array or Math.hypot call needed.
    this._uSunDirArr[0] = SUN_DIR_NX; this._uSunDirArr[1] = SUN_DIR_NY; this._uSunDirArr[2] = SUN_DIR_NZ;
    this._uSunColorArr[0] = SHADER_SUN_R; this._uSunColorArr[1] = SHADER_SUN_G; this._uSunColorArr[2] = SHADER_SUN_B;
    this._uAmbLowArr[0] = SHADER_AMB_L_R; this._uAmbLowArr[1] = SHADER_AMB_L_G; this._uAmbLowArr[2] = SHADER_AMB_L_B;
    this._uAmbHighArr[0] = SHADER_AMB_H_R; this._uAmbHighArr[1] = SHADER_AMB_H_G; this._uAmbHighArr[2] = SHADER_AMB_H_B;

    const r = _renderer;
    if (r && r.uViewMatrix) {
      if (!this._invViewMat) this._invViewMat = new p5.Matrix();
      this._invViewMat.set(r.uViewMatrix);
      this._invViewMat.invert(this._invViewMat);
      this.shader.setUniform('uInvViewMatrix', this._invViewMat.mat4);
    }

    this.shader.setUniform('uTime', millis() / 1000.0);
    this.shader.setUniform('uFogDist', this._uFogDistArr);
    this.shader.setUniform('uFogColor', this._uFogColorArr);
    this.shader.setUniform('uTileSize', TILE);
    this.shader.setUniform('uPalette', TERRAIN_PALETTE_FLAT);
    this.shader.setUniform('uSunDir', this._uSunDirArr);
    this.shader.setUniform('uSunColor', this._uSunColorArr);
    this.shader.setUniform('uAmbientLow', this._uAmbLowArr);
    this.shader.setUniform('uAmbientHigh', this._uAmbHighArr);

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
   * Renders sets of tile overlay quads using the currently bound terrain shader.
   *
   * @param {object}   manager     TileManager instance (infection or barrierTiles).
   * @param {object}   typeConfigs Mapping of type names to [matEven, matOdd] ID pairs.
   * @param {number}   yOffset     Y offset applied to each vertex corner altitude.
   * @param {object}   cam         Camera descriptor.
   * @param {number}   fovSlope    FOV slope for lateral frustum culling.
   * @param {number}   minTx       Tile-space view bound (min X).
   * @param {number}   maxTx       Tile-space view bound (max X).
   * @param {number}   minTz       Tile-space view bound (min Z).
   * @param {number}   maxTz       Tile-space view bound (max Z).
   * @param {string}   tag         Profiler tag.
   * @param {number}   [minCx]     Chunk-space min X (optional for bucketed iteration).
   * @param {number}   [maxCx]     Chunk-space max X.
   * @param {number}   [minCz]     Chunk-space min Z.
   * @param {number}   [maxCz]     Chunk-space max Z.
   */
  _drawTileOverlays(manager, typeConfigs, yOffset, cam, fovSlope, minTx, maxTx, minTz, maxTz, tag, minCx, maxCx, minCz, maxCz) {
    const profiler = getVironProfiler();
    const overlayStart = profiler ? performance.now() : 0;

    if (!this._buckets) this._buckets = {};
    for (const k in this._buckets) this._buckets[k].length = 0;

    let overlayCount = 0;

    const processTile = (t) => {
      if (t.tx < minTx || t.tx > maxTx || t.tz < minTz || t.tz > maxTz) return;

      const tcx = t.tx * TILE + TILE * 0.5, tcz = t.tz * TILE + TILE * 0.5;
      const tdx = tcx - cam.x, tdz = tcz - cam.z;
      if (!cam.skipFrustum) {
        const tFwd = tdx * cam.fwdX + tdz * cam.fwdZ;
        if (tFwd < -TILE * 2) return;
        if (Math.abs(tdx * -cam.fwdZ + tdz * cam.fwdX) > (tFwd > 0 ? tFwd : 0) * fovSlope + TILE * 4) return;
      }

      const type = t.type || 'default';
      const parity = (t.tx + t.tz) % 2 === 0 ? 0 : 1;
      const config = typeConfigs[type] || typeConfigs['default'];
      if (!config) return;

      const matId = (parity === 0) ? config[0] : config[1];
      if (!this._buckets[matId]) this._buckets[matId] = [];
      this._buckets[matId].push(t);

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
      overlayCount++;
    };

    if (manager.buckets && minCx !== undefined) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const arr = manager.buckets.get(`${cx},${cz}`);
          if (arr) {
            for (let i = 0; i < arr.length; i++) processTile(arr[i]);
          }
        }
      }
    } else {
      const list = manager.keyList || manager.values();
      for (let i = 0; i < list.length; i++) processTile(list[i]);
    }

    const _gl = (typeof drawingContext !== 'undefined') ? drawingContext : null;
    if (_gl && overlayCount > 0) {
      _gl.enable(_gl.POLYGON_OFFSET_FILL);
      _gl.polygonOffset(-1.0, -2.0);
    }

    for (const matId in this._buckets) {
      const tileList = this._buckets[matId];
      if (tileList.length === 0) continue;

      fill(parseInt(matId), 0, 0, 255);
      beginShape(TRIANGLES);
      normal(0, 1, 0);
      for (let i = 0; i < tileList.length; i++) {
        const v = tileList[i].verts;
        for (let j = 0; j < 18; j += 3) vertex(v[j], v[j + 1], v[j + 2]);
      }
      endShape();
    }

    if (_gl && overlayCount > 0) {
      _gl.disable(_gl.POLYGON_OFFSET_FILL);
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
   * @param {boolean} [firstPerson=false]  Whether to render from a first-person camera.
   */
  drawLandscape(s, viewAspect, firstPerson = false) {
    let gx = toTile(s.x), gz = toTile(s.z);
    noStroke();

    // Compute camera params once and cache on the instance so drawTrees,
    // drawBuildings and enemies.draw reuse the same values this frame.
    let cam = this.getCameraParams(s, firstPerson);

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
        // Skipped when cam.skipFrustum is set (cockpit view at steep pitch) because
        // the yaw-based forward vector does not reflect the true visible area then.
        if (!cam.skipFrustum) {
          let chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
          let chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;
          let dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
          let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
          if (fwdDist < -chunkHalf) continue;   // More than one chunk behind
          let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
          let halfWidth = (fwdDist > 0 ? fwdDist : 0) * fovSlope + chunkHalf;
          if (Math.abs(rightDist) > halfWidth) continue;  // Lateral frustum cull
        }

        let geom = this.getChunkGeometry(cx, cz);
        if (geom) model(geom);
      }
    }

    const minTx = gx - VIEW_FAR, maxTx = gx + VIEW_FAR;
    const minTz = gz - VIEW_FAR, maxTz = gz + VIEW_FAR;

    // Build Viron tile overlays for the full visible tile range.
    // All infection tiles that pass normal view/frustum tests remain drawable.
    if (infection.count > 0) {
      this._drawTileOverlays(
        infection,
        { normal: [10, 11], green: [14, 15] },
        -0.5, cam, fovSlope, minTx, maxTx, minTz, maxTz, 'infection',
        minCx, maxCx, minCz, maxCz
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
      this._drawTileOverlays(
        barrierTiles,
        { default: [20, 21] },
        -0.3, cam, fovSlope, minTx, maxTx, minTz, maxTz, 'barrier',
        minCx, maxCx, minCz, maxCz
      );
    }

    // Static sea plane — a single flat quad at SEA covering the visible area.
    // No per-vertex sine calculations; all four corners share the same Y so there
    // is no per-frame geometry work beyond issuing the two-triangle draw call.
    // The sea is drawn while the terrain shader is still active so it receives the
    // same fog blending that hides terrain chunk pop-in at the view boundary.
    // mat = 30 — the sea uses a dedicated material ID outside the [0, 21] range so
    // it is never affected by shockwave pulse (cyberColor) effects; those effects are
    // restricted to mat <= 21 (ground/infection materials).  The GLSL mat == 30 branch
    // sets the deep-blue base colour directly.  The surface normal uses (0, -1, 0) —
    // the correct upward-facing orientation in WEBGL's Y-inverted coordinate system —
    // so the sea receives proper sun and sky-dome lighting instead of only dark ambient.
    //
    // sy = SEA (not SEA+3): placing the plane exactly at sea surface level ensures that
    // all submerged terrain vertices (Y > SEA) are behind the sea in the depth buffer.
    // The previous SEA+3 offset allowed vertices at Y=200–202 to win depth tests and
    // show through the sea, causing the flickering reported on mobile.  Polygon offset
    // (-1,-4) gives the sea a tiny depth advantage at the exact shore boundary where
    // terrain triangles intersect the sea surface, preventing residual Z-fighting
    // without affecting any above-water geometry (which is always closer to the camera).
    let seaSize = VIEW_FAR * TILE * 1.5;
    let seaCx = toTile(s.x) * TILE, seaCz = toTile(s.z) * TILE;
    let sx0 = seaCx - seaSize, sx1 = seaCx + seaSize;
    let sz0 = seaCz - seaSize, sz1 = seaCz + seaSize;
    let sy = SEA;
    const gl = drawingContext;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1.0, -4.0);
    fill(30, 45, 150);
    beginShape(TRIANGLES);
    normal(0, -1, 0);
    vertex(sx0, sy, sz0); vertex(sx1, sy, sz0); vertex(sx0, sy, sz1);
    vertex(sx1, sy, sz0); vertex(sx1, sy, sz1); vertex(sx0, sy, sz1);
    endShape();
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // Exit the terrain GLSL shader and restore p5 lighting for subsequent
    // non-terrain draw calls (trees, buildings, enemies, ships).
    // noLights() was called at the top of this function to prevent p5's light
    // uniforms from interfering with the custom terrain GLSL, so lights must be
    // re-established here before returning.
    resetShader();
    setSceneLighting();

    // Zarch-tribute: missiles lined up along the right side of the launchpad
    push();
    let mX = LAUNCH_MAX - 100;
    for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
      let mDepth = (mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ;
      // Use getFogFactor() + inline lerps — both colours share the same depth so
      // the factor only needs to be computed once per missile decoration.
      const fogF = this.getFogFactor(mDepth);
      push();
      translate(mX, LAUNCH_ALT, mZ);
      fill(lerp(60, SKY_R, fogF), lerp(60, SKY_G, fogF), lerp(60, SKY_B, fogF));
      push(); translate(0, -10, 0); box(30, 20, 30); pop();          // Stand
      fill(lerp(255, SKY_R, fogF), lerp(140, SKY_G, fogF), lerp(20, SKY_B, fogF));
      push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();  // Rocket body
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
    const maxDepth = (typeof isMobile !== 'undefined' && isMobile) ? 4 : 5;

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
    fill(AMBIENT_R * SHADOW_AMBIENT_RG_SCALE, AMBIENT_G * SHADOW_AMBIENT_RG_SCALE, AMBIENT_B * SHADOW_AMBIENT_B_SCALE, shadowAlpha);

    if (!isBaking) {
      if (lightsWereOn) noLights();
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
   * Draws a single cached projected shadow for a tree.
   * Hull is computed once and stored on the tree object (static geometry, fixed sun).
   */
  _drawTreeShadow(t, groundY, sun) {
    // If the sun has moved since we last baked this shadow, invalidate the cached 
    // geometry so it re-builds at the new solar angle.
    if (t._bakedSun && (t._bakedSun.x !== sun.x || t._bakedSun.y !== sun.y || t._bakedSun.z !== sun.z)) {
      t._shadowGeom = null;
      t._shadowBakeFails = 0; // sun changed → fresh bake attempt; reset failure count
    }

    if (!t._shadowHull) {
      const { trunkH: h, canopyScale: sc, variant: vi } = t;
      // Half-radii matching _drawProjectedEllipseShadow(rx, rz) → rx*0.5, rz*0.5
      const hrx = (vi === 2) ? 20 * sc : 17 * sc;
      const hrz = (vi === 2) ? 14 * sc : 12 * sc;
      const casterH = h + (vi === 2 ? 24 : 18) * sc;
      const trunkHalf = 2.5; // trunk box half-extent (full box size 5x5)
      const footprint = [];
      // Trunk footprint (merge components into one hull to avoid crescent gaps)
      footprint.push(
        { x: -trunkHalf, z: -trunkHalf }, { x: trunkHalf, z: -trunkHalf },
        { x: trunkHalf, z: trunkHalf }, { x: -trunkHalf, z: trunkHalf }
      );
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TWO_PI;
        footprint.push({ x: Math.cos(a) * hrx, z: Math.sin(a) * hrz });
      }
      t._footprint = footprint;
      t._shadowCasterH = casterH;
      t._shadowHull = true;
    }

    const casterHForOpacity = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;

    // t._shadowGeom lifecycle:
    //   undefined  → not yet attempted
    //   null       → invalidated or bake failed (but not exhausted); rebuild next frame
    //   false      → bake permanently skipped (degenerate hull or failures exhausted)
    //   p5.Geometry → valid cached shadow mesh
    if (t._shadowGeom == null && !this._isBuildingShadow) {
      if (!sun || !t._footprint) return;
      this._isBuildingShadow = true;
      try {
        t._bakedSun = { x: sun.x, y: sun.y, z: sun.z };
        let built = _safeBuildGeometry(() => {
          this._drawProjectedFootprintShadow(t.x, t.z, groundY, casterHForOpacity, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        });
        // Use false (not null) for an empty result so the == null guard above
        // won't trigger a rebuild every frame for a permanently-degenerate hull.
        const tGeom = (built && built.vertices.length) ? built : false;
        t._shadowGeom = tGeom;
        if (tGeom) t._shadowBakeFails = 0;
      } catch (err) {
        console.error("[Viron] Shadow bake failed for tree:", err);
        t._shadowBakeFails = (t._shadowBakeFails || 0) + 1;
        // Give up after 3 failures to avoid calling buildGeometry every frame.
        t._shadowGeom = (t._shadowBakeFails >= 3) ? false : null;
      } finally {
        this._isBuildingShadow = false;
      }
    }

    if (!t._shadowGeom) return;

    const shadowAlpha = TREE_SHADOW_BASE_ALPHA * this._shadowOpacityFactor(casterHForOpacity);
    const lightsWereOn = (typeof SUN_KEY_R !== 'undefined');
    if (lightsWereOn) noLights();
    noStroke();
    fill(AMBIENT_R * SHADOW_AMBIENT_RG_SCALE, AMBIENT_G * SHADOW_AMBIENT_RG_SCALE, AMBIENT_B * SHADOW_AMBIENT_B_SCALE, shadowAlpha);

    _beginShadowStencil();

    push();
    model(t._shadowGeom);
    pop();

    _endShadowStencil();
    if (lightsWereOn && typeof setSceneLighting === 'function') setSceneLighting();
  }

  /**
   * Draws a single cached projected shadow for a building.
   *
   * Previous design had 2-3 overlapping draw calls per building causing:
   *   • Composited alpha overlap (type 4 reached ~70% opacity at center — unphysical)
   *   • 2-3× more WebGL draw calls per building per frame
   *   • O(n log n) convex hull recomputed every frame for static geometry
   *
   * New design: one shadow hull per building, cached after first frame,
   * sky-tinted dark-blue shadow color (physical: sky fill colors the shadow).
   */
  _drawBuildingShadow(b, groundY, inf, sun) {
    const bw = b.w, bh = b.h, bd = b.d;

    // If the sun has moved since we last baked this shadow, invalidate the cached 
    // geometry so it re-builds at the new solar angle.
    if (b._bakedSun && (b._bakedSun.x !== sun.x || b._bakedSun.y !== sun.y || b._bakedSun.z !== sun.z)) {
      b._shadowGeom = null;
      b._shadowBakeFails = 0; // sun changed → fresh bake attempt; reset failure count
    }

    // Type 3 (floating UFO): animated caster height — cannot cache hull.
    if (b.type === 3) {
      const floatY = groundY - bh - 100 - sin(frameCount * 0.02 + b.x) * 50;
      const casterH = max(35, groundY - floatY);
      this._drawProjectedEllipseShadow(b.x, b.z, groundY, casterH, bw * 2.2, bw * 1.4, 34, sun, true);
      return;
    }

    // Static types (0, 1, 2, 4): compute hull once, cache on the building object.
    // Sun direction and building position are both constant, so the hull never changes.
    if (!b._shadowHull) {
      let footprint, casterH;
      if (b.type === 0) {
        // Geometric structure: rectangular shadow at full height (body + funnel)
        const hw = bw * 0.5, hd = bd * 0.5;
        footprint = [{ x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd }];
        casterH = bh + bw * 0.35;
      } else if (b.type === 1) {
        // Water tower: ellipse shadow at full height (cylinder + sphere dome)
        footprint = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TWO_PI;
          footprint.push({ x: Math.cos(a) * bw * 0.5, z: Math.sin(a) * bw * 0.425 });
        }
        casterH = bh + bw * 0.5;
      } else if (b.type === 2) {
        // Industrial complex: wide rectangular shadow at full smokestack height
        const hw = bw * 0.75, hd = bd * 0.75;
        footprint = [{ x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd }];
        casterH = bh;
      } else {
        // Type 4 — sentinel tower: ellipse shadow at full tower height
        footprint = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TWO_PI;
          footprint.push({ x: Math.cos(a) * bw * 1.1, z: Math.sin(a) * bw * 0.92 });
        }
        casterH = bh;
      }
      b._footprint = footprint;
      b._shadowCasterH = casterH;
      b._shadowHull = true;
    }

    const casterHForOpacity = b._shadowCasterH || b.h;
    const baseAlpha = (b.type === 4) ? (inf ? 44 : 38) : (b.type === 0 ? 50 : 46);

    // b._shadowGeom lifecycle:
    //   undefined  → not yet attempted
    //   null       → invalidated or bake failed (but not exhausted); rebuild next frame
    //   false      → bake permanently skipped (degenerate hull or failures exhausted)
    //   p5.Geometry → valid cached shadow mesh
    if (b._shadowGeom == null && !this._isBuildingShadow) {
      if (!sun || !b._footprint) return;
      this._isBuildingShadow = true;
      try {
        b._bakedSun = { x: sun.x, y: sun.y, z: sun.z };
        let built = _safeBuildGeometry(() => {
          this._drawProjectedFootprintShadow(b.x, b.z, groundY, casterHForOpacity, b._footprint, baseAlpha, sun, false, true);
        });
        // Use false (not null) for an empty result so the == null guard above
        // won't trigger a rebuild every frame for a permanently-degenerate hull.
        const bGeom = (built && built.vertices.length) ? built : false;
        b._shadowGeom = bGeom;
        if (bGeom) b._shadowBakeFails = 0;
      } catch (err) {
        console.error("[Viron] Shadow bake failed for building:", err);
        b._shadowBakeFails = (b._shadowBakeFails || 0) + 1;
        // Give up after 3 failures to avoid calling buildGeometry every frame.
        b._shadowGeom = (b._shadowBakeFails >= 3) ? false : null;
      } finally {
        this._isBuildingShadow = false;
      }
    }

    if (!b._shadowGeom) return;

    const shadowAlpha = baseAlpha * this._shadowOpacityFactor(casterHForOpacity);
    const lightsWereOn = (typeof SUN_KEY_R !== 'undefined');
    if (lightsWereOn) noLights();
    noStroke();
    fill(AMBIENT_R * SHADOW_AMBIENT_RG_SCALE, AMBIENT_G * SHADOW_AMBIENT_RG_SCALE, AMBIENT_B * SHADOW_AMBIENT_B_SCALE, shadowAlpha);

    _beginShadowStencil();

    push();
    model(b._shadowGeom);
    pop();

    _endShadowStencil();
    if (lightsWereOn && typeof setSceneLighting === 'function') setSceneLighting();
  }



  _getPowerupGeom(b, inf) {
    const key = `pu_${(b.w).toFixed(1)}_${(b.h).toFixed(1)}_${inf}`;
    if (!this._geoms) this._geoms = new Map();
    if (this._geoms.has(key)) return this._geoms.get(key);

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        fill(inf ? 251 : 250, inf ? 50 : 180, inf ? 50 : 240);
        push();
        cone(b.w, b.h / 2, 4, 1);
        pop();
        push();
        rotateX(PI);
        cone(b.w, b.h / 2, 4, 1);
        pop();
      });
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
    const key = `tree_${vi}_${sc.toFixed(2)}_${h.toFixed(1)}_${inf}`;
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
  drawTrees(s) {
    let treeCullDist = VIEW_FAR * TILE;
    let cullSq = treeCullDist * treeCullDist;
    // Uses the same camera params cached by drawLandscape
    let cam = this._cam || this.getCameraParams(s);
    const shadowQueue = [];

    let gx = toTile(s.x), gz = toTile(s.z);
    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    noStroke();

    // Apply terrain shader so trees inherit world fog and lighting.
    this.applyShader();

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const trees = this.getProceduralTreesForChunk(cx, cz);
        for (let t of trees) {
          let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
          if (dSq >= cullSq || !this.inFrustum(cam, t.x, t.z)) continue;

          let y = t.y;
          if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

          let inf = infection.has(t.k);
          let geom = this._getTreeGeom(t, inf);

          if (geom) {
            push();
            translate(t.x, y, t.z);
            model(geom);
            pop();
          }

          if (dSq < 9000000) shadowQueue.push(t);
        }
      }
    }

    resetShader();
    setSceneLighting();

    // Draw projected component shadows in one pass.
    const sun = this._getSunShadowBasis();
    noStroke();
    for (let i = 0; i < shadowQueue.length; i++) {
      const t = shadowQueue[i];
      this._drawTreeShadow(t, t.y, sun);
    }
  }

  _getBuildingGeom(b, inf) {
    const key = (b.type === 2)
      ? `bldg_${b.type}_${b.w.toFixed(1)}_${b.h.toFixed(1)}_${b.d.toFixed(1)}_${inf}_${b.col[0]}_${b.col[1]}_${b.col[2]}`
      : `bldg_${b.type}_${b.w.toFixed(1)}_${b.h.toFixed(1)}_${b.d.toFixed(1)}_${inf}`;

    if (!this._geoms) this._geoms = new Map();
    if (this._geoms.has(key)) return this._geoms.get(key);

    if (this._isBuildingShadow) return null;
    this._isBuildingShadow = true;
    let geom = null;
    try {
      geom = _safeBuildGeometry(() => {
        // Ensure R values avoid terrain palette indices (1,2, 10,11, 20,21)
        const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;

        if (b.type === 0) {
          fill(safeR(inf ? 200 : 220), inf ? 50 : 220, inf ? 50 : 220);
          push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();
          fill(safeR(inf ? 150 : 220), inf ? 30 : 50, inf ? 30 : 50);
          push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();
        } else if (b.type === 1) {
          fill(safeR(inf ? 200 : 150), inf ? 50 : 160, inf ? 50 : 170);
          push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();
          fill(safeR(inf ? 150 : 80), inf ? 30 : 180, inf ? 30 : 220);
          push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();
        } else if (b.type === 2) {
          fill(safeR(inf ? 200 : b.col[0]), inf ? 50 : b.col[1], inf ? 50 : b.col[2]);
          push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
          push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();
          fill(safeR(inf ? 120 : 80), inf ? 20 : 80, inf ? 20 : 80);
          push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();
        } else if (b.type === 4) {
          let steelR = safeR(inf ? 160 : 52), steelG = inf ? 38 : 68, steelB = inf ? 38 : 90;
          let plinthR = safeR(inf ? 130 : 38), plinthG = inf ? 28 : 52, plinthB = inf ? 28 : 72;
          let accentR = safeR(inf ? 200 : 40), accentG = inf ? 55 : 200, accentB = inf ? 20 : 185;
          let reactorR = safeR(inf ? 255 : 80), reactorG = inf ? 100 : 240, reactorB = inf ? 30 : 215;
          let spireR = safeR(inf ? 240 : 160), spireG = inf ? 80 : 240, spireB = inf ? 40 : 255;
          let bw = b.w, bh = b.h;

          fill(plinthR, plinthG, plinthB);
          push(); translate(0, -bh * 0.04, 0); cylinder(bw * 1.1, bh * 0.08, 6, 1); pop();
          fill(accentR, accentG, accentB);
          push(); translate(0, -bh * 0.08, 0); cylinder(bw * 1.05, bh * 0.015, 6, 1); pop();

          fill(steelR, steelG, steelB);
          push(); translate(0, -bh * 0.23, 0); cylinder(bw * 0.75, bh * 0.30, 8, 1); pop();
          fill(accentR, accentG, accentB);
          push(); translate(0, -bh * 0.37, 0); cylinder(bw * 0.78, bh * 0.018, 8, 1); pop();

          fill(steelR, steelG, steelB);
          push(); translate(0, -bh * 0.52, 0); cylinder(bw * 0.48, bh * 0.24, 8, 1); pop();
          fill(accentR, accentG, accentB);
          push(); translate(0, -bh * 0.64, 0); cylinder(bw * 0.51, bh * 0.016, 8, 1); pop();

          fill(reactorR, reactorG, reactorB);
          push(); translate(0, -bh * 0.40, 0); sphere(bw * 0.3, 8, 6); pop();

          fill(steelR, steelG, steelB);
          push(); translate(0, -bh * 0.76, 0); cylinder(bw * 0.28, bh * 0.20, 8, 1); pop();
          fill(accentR, accentG, accentB);
          push(); translate(0, -bh * 0.85, 0); cylinder(bw * 0.31, bh * 0.014, 8, 1); pop();

          fill(spireR, spireG, spireB);
          push(); translate(0, -bh * 0.99, 0); cone(bw * 0.18, bh * 0.24, 6, 1); pop();
          fill(reactorR, reactorG, reactorB);
          push(); translate(0, -bh * 1.11, 0); sphere(bw * 0.08, 6, 4); pop();
        }
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
  drawBuildings(s) {
    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    let cam = this._cam || this.getCameraParams(s);
    const sun = this._getSunShadowBasis();
    const shadowQueue = [];

    // Apply terrain shader to natively handle fog and lighting
    this.applyShader();

    for (let b of buildings) {
      let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, b.x, b.z)) continue;
      let y = b.y;
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

      let inf = infection.has(tileKey(toTile(b.x), toTile(b.z)));

      push(); translate(b.x, y, b.z); noStroke();

      if (b.type === 3) {
        // Floating UFO handles its own animation, drawn immediately rather than cached
        push();
        let floatY = y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
        translate(0, floatY - y, 0);
        rotateY(frameCount * 0.01 + b.x);
        rotateZ(frameCount * 0.015 + b.z);
        let geom = this._getPowerupGeom(b, inf);
        if (geom) model(geom);
        pop();
      } else {
        let bGeom = this._getBuildingGeom(b, inf);
        if (bGeom) model(bGeom);
        // Rotating crown for type 4
        if (b.type === 4) {
          const safeR = (r) => (r === 1 || r === 2 || r === 10 || r === 11 || r === 20 || r === 21 || r === 30) ? r + 1 : r;
          fill(safeR(inf ? 220 : 20), inf ? 60 : 230, inf ? 20 : 210);
          push();
          translate(0, -b.h * 0.87, 0);
          rotateY(frameCount * 0.032 + b.x * 0.001);
          torus(b.w * 0.32, b.w * 0.07, 14, 6);
          pop();
        }
      }

      pop();

      // Defer ground shadow drawing
      if (dSq < 2250000) shadowQueue.push({ b, y, inf });
    }

    resetShader();
    setSceneLighting();

    for (let q of shadowQueue) {
      this._drawBuildingShadow(q.b, q.y, q.inf, sun);
    }
  }
}

// Singleton instance used by all other modules
const terrain = new Terrain();
