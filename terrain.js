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

// Shared GLSL snippets embedded into both fragment shaders via template literals.
// Both shaders declare the same uniforms (uPulses, uTime, vWorldPos, uFogDist,
// uFogColor) so the snippets work without modification in either context.

// Pulse loop: declares cyberColor and accumulates shockwave ring contributions.
const _GLSL_PULSE_LOOP = `
  vec3 cyberColor = vec3(0.0);
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
`;

// Fog tail: blends outColor to the sky colour beyond the view boundary.
const _GLSL_FOG = `
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  outColor = mix(outColor, uFogColor, fogFactor);
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
uniform mat4 uInvViewMatrix;

// Hash function for procedural noise
float hash(vec2 p) {
  // Wrap p to prevent precision breakdown at large world coordinates,
  // then use standard robust sine hash to prevent structural patterns.
  p = mod(p, 5000.0);
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

// 2D Value Noise
float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Smooth Hermite interpolation
  vec2 u = f * f * (3.0 - 2.0 * f);
  // Mix 4 corners - PREVIOUS VERSION WAS BUGGED, using u.x for both interpolations
  float a = hash(i + vec2(0.0, 0.0));
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractional Brownian Motion (2 octaves for speed)
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(100.0);
  mat2 rot = mat2(0.877, 0.479, -0.479, 0.877); // Precalculated cos/sin 0.5
  for (int i = 0; i < 2; ++i) { // Reduced to 2 octaves
    v += a * noise2D(p);
    p = rot * p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

// =============================================================================
// Per-material colour helpers
// Each function returns the base colour for its material family and sets the
// specular intensity / shininess via inout parameters.  Uniforms and varyings
// (uTime, uPalette, uTileSize, vWorldPos, vColor, vNormal) are accessed as
// GLSL globals so callers need not thread them through every call site.
// =============================================================================

// Red Viron biological surface (mat 10 = even tile, mat 11 = odd tile).
vec3 computeVironColor(int mat, inout float specInt, inout float specShin) {
  float af      = clamp(mix(1.15, 0.7, (vWorldPos.y - 200.0) / -350.0), 0.7, 1.15);
  float parity  = (mat == 10) ? 1.0 : 0.75;
  float xP      = vWorldPos.x / uTileSize;
  float zP      = vWorldPos.z / uTileSize;
  float pulse   = sin(uTime * 3.6 + xP * 0.05 + zP * 0.05) * 0.5 + 0.5;
  float scanPos = uTime / 10.0;
  float scan    = smoothstep(0.98, 1.0, 1.0 - abs(fract(xP * 0.02 + zP * 0.01 - scanPos) - 0.5) * 2.0);
  vec3 cRed  = uPalette[9]  * parity;
  vec3 cDark = uPalette[10] * parity;
  vec3 cScan = uPalette[11] * parity;
  specInt  = 0.45;
  specShin = 12.0;
  return (mix(cDark, cRed, pulse) + cScan * scan * 1.5) * af;
}

// Yellow Viron biological surface (mat 14 = even tile, mat 15 = odd tile).
vec3 computeYellowVironColor(int mat, inout float specInt, inout float specShin) {
  float af      = clamp(mix(1.3, 0.8, (vWorldPos.y - 200.0) / -350.0), 0.8, 1.3);
  float parity  = (mat == 14) ? 1.0 : 0.75;
  float xP      = vWorldPos.x / uTileSize;
  float zP      = vWorldPos.z / uTileSize;
  float pulse   = sin(uTime * 4.8 + xP * 0.08 + zP * 0.08) * 0.5 + 0.5;
  float scanPos = uTime / 8.0;
  float scan    = smoothstep(0.98, 1.0, 1.0 - abs(fract(xP * 0.02 + zP * 0.01 - scanPos) - 0.5) * 2.0);
  vec3 yYellow = uPalette[14] * parity;
  vec3 yDark   = uPalette[15] * parity;
  vec3 yScan   = uPalette[16] * parity;
  specInt  = 0.5;
  specShin = 16.0;
  return (mix(yDark, yYellow, pulse) + yScan * scan * 2.0) * af;
}

// Barrier pearl surface (mat 20 = even tile, mat 21 = odd tile).
vec3 computeBarrierColor(int mat, inout float specInt, inout float specShin) {
  float xP      = vWorldPos.x / uTileSize;
  float zP      = vWorldPos.z / uTileSize;
  float shimmer = sin(uTime * 0.7 + xP * 0.15 + zP * 0.1) * 0.5 + 0.5;
  float parity  = (mat == 20) ? 1.0 : 0.90;
  specInt  = 2.0;
  specShin = 64.0;
  return uPalette[12] * parity * (0.88 + 0.12 * shimmer);
}

// Animated sea surface (mat 30) with normal-mapped ripples.
// Modifies n in-place for downstream lighting.
vec3 computeSeaColor(inout vec3 n, inout float specInt, inout float specShin) {
  vec3  waterBase  = vec3(15.0/255.0, 45.0/255.0, 150.0/255.0);
  vec3  crestColor = vec3(25.0/255.0, 65.0/255.0, 165.0/255.0);
  float tDist      = gl_FragCoord.z / gl_FragCoord.w;
  float noiseFade  = 1.0 - smoothstep(uFogDist.y * 0.8, uFogDist.y * 0.95, tDist);
  vec3  col        = waterBase;
  if (noiseFade > 0.0) {
    vec2  wPos = vWorldPos.xz * 0.06;
    float t    = uTime * 0.4;
    float n1   = noise2D(wPos + vec2(t, t * 0.5));
    float n2   = noise2D(wPos - vec2(t * 0.8, -t * 0.3) + vec2(n1 * 2.0));
    n.x += (n1 - 0.5) * 0.4 * noiseFade;
    n.z += (n2 - 0.5) * 0.4 * noiseFade;
    n = normalize(n);
    float ripple = smoothstep(0.4, 0.8, n2);
    float glint  = smoothstep(0.7, 1.0, n2) * 0.15;
    col = mix(waterBase, mix(waterBase, crestColor, ripple) + vec3(glint), noiseFade);
  }
  specInt  = 0.9;
  specShin = 64.0;
  return col;
}

// Terrain / shore surface (mat 1 = inland, mat 2 = shore) with procedural
// bump mapping.  Modifies n in-place for downstream lighting.
vec3 computeLandscapeColor(int mat, inout vec3 n, inout float specInt, inout float specShin) {
  float noisePatch = vColor.g;
  float rand       = vColor.b;
  float parity     = vColor.a;
  // Tile-grid X and Z indices computed separately as floats (GLSL has no vec3.xz
  // swizzle write, and vec2.y would misleadingly suggest a vertical axis).
  float tileTx = floor(vWorldPos.x / uTileSize + 0.001);
  float tileTz = floor(vWorldPos.z / uTileSize + 0.001);
  vec3  baseColor;
  // Launchpad tiles are plain white — no bump or colour variation.
  if (tileTx >= 0.0 && tileTx < 7.0 && tileTz >= 0.0 && tileTz < 7.0) {
    return vec3(1.0) * parity;
  }
  if (mat == 2) { // Shore
    float idx = floor(rand * 3.0);
    baseColor = (idx < 1.0) ? uPalette[6] : (idx < 2.0 ? uPalette[7] : uPalette[8]);
  } else { // Inland
    float val = mod(floor((noisePatch * 2.0 + rand * 0.2) * 6.0), 6.0);
    if      (val < 1.0) baseColor = uPalette[0];
    else if (val < 2.0) baseColor = uPalette[1];
    else if (val < 3.0) baseColor = uPalette[2];
    else if (val < 4.0) baseColor = uPalette[3];
    else if (val < 5.0) baseColor = uPalette[4];
    else                baseColor = uPalette[5];
  }
  float steepness  = 1.0 - max(-vNormal.y, 0.0);
  float cliffBlend = smoothstep(0.05, 0.18, steepness);
  baseColor = mix(baseColor, vec3(0.12, 0.11, 0.10), cliffBlend);
  float tDist    = gl_FragCoord.z / gl_FragCoord.w;
  float noiseFade = 1.0 - smoothstep(uFogDist.y * 0.8, uFogDist.y * 0.95, tDist);
  if (noiseFade > 0.0) {
    float f1 = noise2D(vWorldPos.xz * 0.03);
    float f2 = noise2D(vWorldPos.xz * 0.13 + vec2(42.1, 13.7));
    float ruggedNoise = f1 * 0.6 + f2 * 0.4;
    // Physically tilt the lighting normal based on procedural detail (bump mapping).
    n.x += (f1 - 0.5) * 0.3 * noiseFade * (1.0 + cliffBlend * 1.5);
    n.z += (f2 - 0.5) * 0.3 * noiseFade * (1.0 + cliffBlend * 1.5);
    n = normalize(n);
    float noiseShift = 0.7 + (ruggedNoise * mix(0.4, 0.9, cliffBlend) * 1.4);
    baseColor = mix(baseColor, baseColor * noiseShift, noiseFade);
  }
  // Glossy sheen on steep rock faces gives a slightly damp, sheer geological look.
  specInt  = mix(0.0, 0.4, cliffBlend);
  specShin = 16.0;
  return baseColor * parity;
}

// Blinn-Phong hemisphere lighting.  Returns the lit base colour and outputs
// ndl (Lambert term) for downstream rim-light masking.
vec3 computeBlinnPhong(vec3 n, vec3 baseColor, int mat,
                       float specInt, float specShin, out float ndl) {
  float hemi       = n.y * -0.5 + 0.5;
  vec3  ambient    = mix(uAmbientLow, uAmbientHigh, hemi);
  vec3  toSun      = normalize(-uSunDir);
  ndl              = max(dot(n, toSun), 0.0);
  vec3  lightTerm  = max(ambient + uSunColor * ndl, vec3(0.06, 0.08, 0.12));
  vec3  worldCamPos = uInvViewMatrix[3].xyz;
  vec3  V           = normalize(worldCamPos - vWorldPos.xyz);
  vec3  H           = normalize(toSun + V);
  float specTerm    = pow(max(dot(n, H), 0.0), specShin) * ndl;
  vec3  specColor   = uSunColor * specTerm * specInt;
  if (mat >= 10 && mat <= 21) {
    return baseColor * max(lightTerm, vec3(0.85)) + specColor;
  } else if (mat >= 250 && mat <= 251) {
    return baseColor * max(lightTerm, vec3(0.8)) + specColor + baseColor * 0.3;
  } else if (mat >= 1 && mat <= 2) {
    return baseColor * lightTerm + specColor;
  } else if (mat == 30) {
    return baseColor * lightTerm + specColor * 1.5;
  } else {
    return baseColor * max(lightTerm, vec3(0.18, 0.20, 0.25)) + specColor;
  }
}

// Fresnel rim lighting.  Skips launchpad fragments to keep the pad clean.
vec3 applyRimLighting(vec3 outColor, vec3 baseColor, int mat, float ndl) {
  vec3  localViewDir = normalize(-vViewPos);
  float fresnel  = 1.0 - max(dot(normalize(vViewNormal), localViewDir), 0.0);
  fresnel       *= fresnel;
  float litMask  = smoothstep(0.0, 0.2, ndl);
  float rimMask  = smoothstep(-0.2, 0.5, -vNormal.y);
  // Skip rim on launchpad landscape tiles.
  if (mat >= 1 && mat <= 2) {
    // tileTx and tileTz are the X/Z tile indices computed from the world position.
    float tileTx = floor(vWorldPos.x / uTileSize + 0.001);
    float tileTz = floor(vWorldPos.z / uTileSize + 0.001);
    if (tileTx >= 0.0 && tileTx < 7.0 && tileTz >= 0.0 && tileTz < 7.0) {
      return outColor;
    }
  }
  vec3 rim = uFogColor * fresnel * litMask * rimMask;
  if (mat == 30) {
    outColor += baseColor * rim * 3.0;
  } else if (mat >= 1 && mat <= 21) {
    outColor += baseColor * rim * 1.2;
  } else if (mat >= 40 && mat <= 47) {
    outColor += baseColor * rim * 1.5;
  } else {
    outColor += rim * 0.7;
  }
  return outColor;
}

void main() {
  int  mat               = int(vColor.r * 255.0 + 0.5);
  vec3 baseColor         = vColor.rgb;
  vec3 n                 = normalize(vNormal);
  float specularIntensity = 0.0;
  float specularShininess = 16.0;

  // ── Per-material colour and specular parameters ──────────────────────────
  if      (mat >= 10 && mat <= 11)  { baseColor = computeVironColor(mat, specularIntensity, specularShininess); }
  else if (mat >= 14 && mat <= 15)  { baseColor = computeYellowVironColor(mat, specularIntensity, specularShininess); }
  else if (mat >= 20 && mat <= 21)  { baseColor = computeBarrierColor(mat, specularIntensity, specularShininess); }
  else if (mat == 30)               { baseColor = computeSeaColor(n, specularIntensity, specularShininess); }
  else if (mat >= 250 && mat <= 251) {
    baseColor = (mat == 250) ? vec3(60.0/255.0, 180.0/255.0, 240.0/255.0)
                              : vec3(200.0/255.0, 50.0/255.0, 50.0/255.0);
    specularIntensity = 0.4;
    specularShininess = 16.0;
  }
  else if (mat >= 1 && mat <= 2)    { baseColor = computeLandscapeColor(mat, n, specularIntensity, specularShininess); }

  // ── Shockwave pulse rings ─────────────────────────────────────────────────
  ${_GLSL_PULSE_LOOP}

  // ── Sentinel steady glows ─────────────────────────────────────────────────
  for (int j = 0; j < 2; j++) {
    if (uSentinelGlows[j].w < 0.5) continue;
    vec2  diff2    = (vWorldPos.xz - uSentinelGlows[j].xy) * 0.01;
    float dist2    = length(diff2) * 100.0;
    float glowR    = uSentinelGlows[j].z;
    float innerGlow = smoothstep(glowR * 1.1, 0.0, dist2) * 0.18;
    float ringW    = glowR * 0.12;
    float ring2    = smoothstep(glowR - ringW, glowR, dist2) *
                     (1.0 - smoothstep(glowR, glowR + ringW, dist2));
    float breath   = 0.6 + 0.4 * sin(uTime * 1.6 + uSentinelGlows[j].x * 0.002);
    cyberColor += vec3(0.0, 0.9, 0.8) * (ring2 * breath * 2.2 + innerGlow * breath);
  }

  // ── Blinn-Phong lighting ──────────────────────────────────────────────────
  float ndl;
  vec3 outColor = computeBlinnPhong(n, baseColor, mat, specularIntensity, specularShininess, ndl);
  if (mat <= 21) { outColor += cyberColor; }

  // ── Topographic scanlines (landscape only) ────────────────────────────────
  if (mat >= 1 && mat <= 2) { outColor -= vec3(sin(vWorldPos.y * 1.5) * 0.04); }

  // ── Fresnel rim lighting ──────────────────────────────────────────────────
  outColor = applyRimLighting(outColor, baseColor, mat, ndl);

  // ── Distance fog ─────────────────────────────────────────────────────────
  ${_GLSL_FOG}

  gl_FragColor = vec4(outColor, 1.0);
}
`;

// --- GLSL fragment shader for fill-colour rendering (box/cylinder enemies) ---
//
// Shares TERRAIN_VERT so world-space position (vWorldPos) is available for
// distance fog and shockwave pulse effects.  Base colour comes from the
// uFillColor uniform rather than the aVertexColor material-ID system, so
// p5 box()/cylinder() primitives are rendered correctly under a custom shader.
const FILL_COLOR_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vWorldPos;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying vec3 vViewPos;

uniform vec3  uFillColor;
uniform vec4  uPulses[5];
uniform float uTime;
uniform vec2  uFogDist;
uniform vec3  uFogColor;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAmbientLow;
uniform vec3  uAmbientHigh;

void main() {
  vec3 baseColor = uFillColor;

  // Shockwave pulse rings — same logic as terrain shader.
  ${_GLSL_PULSE_LOOP}

  // One-sided Lambert + hemisphere ambient. One-sided Lambert correctly darkens
  // back-facing surfaces; a higher ambient floor prevents completely black shadows.
  vec3 n = normalize(vNormal);
  float hemi = n.y * -0.5 + 0.5;
  vec3 ambient = mix(uAmbientLow, uAmbientHigh, hemi);
  vec3 toSun = normalize(-uSunDir);
  float ndl = max(dot(n, toSun), 0.0);
  vec3 litBase = baseColor * max(ambient + uSunColor * ndl, vec3(0.18, 0.20, 0.25));

  vec3 outColor = litBase + cyberColor;

  // 8. Subtle holographic scanlines (World-aligned topographical lines)
  float worldScan = sin(vWorldPos.y * 1.5) * 0.04;
  outColor -= vec3(worldScan);

  // Fresnel rim — ship/enemy variant (same as the else branch in TERRAIN_FRAG).
  vec3 V = normalize(-vViewPos);
  float fresnel = 1.0 - max(dot(normalize(vViewNormal), V), 0.0);
  fresnel *= fresnel;
  float litMask = smoothstep(0.0, 0.2, ndl);
  float rimMask = smoothstep(-0.2, 0.5, -vNormal.y);
  outColor += uFogColor * fresnel * litMask * rimMask * 0.7;

  ${_GLSL_FOG}

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
// Raw-WebGL shadow helpers
// =============================================================================

/**
 * Pre-allocated buffer for the shadow MVP matrix computed each draw pass.
 * Reused every frame to avoid a Float32Array allocation per-pass.
 * @private
 */
const _shadowMVPBuf = new Float32Array(16);

/**
 * Multiplies two column-major 4×4 matrices and writes the result into r.
 * r = a × b  (all three arguments are Float32Array(16) in column-major order).
 * @param {Float32Array} r  Output matrix (16 elements, column-major).
 * @param {Float32Array} a  Left operand (16 elements, column-major).
 * @param {Float32Array} b  Right operand (16 elements, column-major).
 * @private
 */
function _mat4Mul16(r, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0=b[c*4], b1=b[c*4+1], b2=b[c*4+2], b3=b[c*4+3];
    r[c*4]   = a[0]*b0 + a[4]*b1 + a[8]*b2  + a[12]*b3;
    r[c*4+1] = a[1]*b0 + a[5]*b1 + a[9]*b2  + a[13]*b3;
    r[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
    r[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
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

    // Raw WebGL shadow shader: bypasses p5 retained-mode model() which silently
    // produces zero output inside the masterFBO rendering path.
    // Lazily compiled on the first shadow draw.
    this._shadowGLReady = false;
    this._shadowGLProg  = null;
    this._shadowGLMVPLoc   = null;
    this._shadowGLColorLoc = null;
    this._shadowGLPosLoc   = null;

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
  }

  /**
   * Compiles the minimal raw WebGL program used to draw pre-baked shadow VBOs.
   * Called lazily on the first frame that requires shadow rendering.
   * p5's retained-mode model() path silently produces zero output inside the
   * masterFBO, so shadows use a dedicated raw WebGL draw path instead.
   * @private
   */
  _initShadowGL() {
    const gl = drawingContext;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, [
      'attribute vec3 aPos;',
      'uniform mat4 uMVP;',
      'void main(){gl_Position=uMVP*vec4(aPos,1.0);}'
    ].join('\n'));
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, [
      'precision mediump float;',
      'uniform vec4 uCol;',
      'void main(){gl_FragColor=uCol;}'
    ].join('\n'));
    gl.compileShader(fs);

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    this._shadowGLProg      = prog;
    this._shadowGLMVPLoc    = gl.getUniformLocation(prog, 'uMVP');
    this._shadowGLColorLoc  = gl.getUniformLocation(prog, 'uCol');
    this._shadowGLPosLoc    = gl.getAttribLocation(prog, 'aPos');
    this._shadowGLReady     = true;
  }

  /**
   * Extracts the triangle vertices from a baked shadow p5.Geometry into a
   * flat Float32Array, uploads it to a WebGL VBO, and stores the VBO handle
   * plus the pre-computed shadow alpha on `owner`.
   *
   * Called once per bake (not per frame).  The flat array avoids per-frame
   * face/vertex index lookups; the VBO avoids per-frame CPU→GPU uploads.
   *
   * @param {{}} owner       Tree or building descriptor — VBO stored here.
   * @param {p5.Geometry} geom  Baked shadow geometry.
   * @param {number} casterH    Caster height used for the opacity factor.
   * @param {number} baseAlpha  Base alpha in [0, 255] before opacity factor.
   * @private
   */
  _uploadShadowVBO(owner, geom, casterH, baseAlpha) {
    const gl = drawingContext;
    const faces = geom.faces, verts = geom.vertices;
    const flat = new Float32Array(faces.length * 9); // 3 verts × 3 floats
    let vi = 0;
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const v0 = verts[f[0]], v1 = verts[f[1]], v2 = verts[f[2]];
      flat[vi++]=v0.x; flat[vi++]=v0.y; flat[vi++]=v0.z;
      flat[vi++]=v1.x; flat[vi++]=v1.y; flat[vi++]=v1.z;
      flat[vi++]=v2.x; flat[vi++]=v2.y; flat[vi++]=v2.z;
    }
    if (owner._shadowVBO) gl.deleteBuffer(owner._shadowVBO);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, flat, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    owner._shadowVBO        = vbo;
    owner._shadowVBOCount   = faces.length * 3;
    // Store the final alpha in [0, 1] so the render pass just reads it.
    // Ambient colour (AMBIENT_R/G/B) is applied fresh each frame, so
    // time-of-day changes are reflected without requiring a re-bake.
    owner._shadowBaseAlpha  = (baseAlpha * this._shadowOpacityFactor(casterH)) / 255;
  }

  /**
   * Draws all shadow VBOs in `queue` using the raw WebGL shadow shader.
   * One stencil guard spans the entire loop so each screen pixel receives
   * at most one shadow layer regardless of how many polygons overlap it.
   *
   * Objects without a `_shadowVBO` (e.g. type-3 UFO buildings whose shadow
   * is animated and rendered via _drawBuildingShadow) are silently skipped.
   *
   * @param {Array} queue  Array of tree or building descriptors.
   * @private
   */
  _drawRawShadows(queue) {
    if (queue.length === 0) return;
    if (!this._shadowGLReady) this._initShadowGL();

    const gl = drawingContext;

    // MVP = P × V  (shadow geometry is in world space, model matrix = identity).
    _mat4Mul16(_shadowMVPBuf, _renderer.uPMatrix.mat4, _renderer.uViewMatrix.mat4);

    // Per-frame ambient-scaled shadow base colour (RGB, normalised to [0,1]).
    const baseR = AMBIENT_R * SHADOW_AMBIENT_RG_SCALE / 255;
    const baseG = AMBIENT_G * SHADOW_AMBIENT_RG_SCALE / 255;
    const baseB = AMBIENT_B * SHADOW_AMBIENT_B_SCALE / 255;

    // Bind shadow program and upload shared uniforms.
    gl.useProgram(this._shadowGLProg);
    gl.uniformMatrix4fv(this._shadowGLMVPLoc, false, _shadowMVPBuf);
    gl.enableVertexAttribArray(this._shadowGLPosLoc);

    // Premultiplied-alpha blending — matches p5's BLEND mode (ONE, ONE_MINUS_SRC_ALPHA).
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Stencil guard: each fragment is drawn at most once (NOTEQUAL→REPLACE).
    _beginShadowStencil();

    for (const obj of queue) {
      if (!obj._shadowVBO) continue;
      const a = obj._shadowBaseAlpha || 0;
      // Output premultiplied RGBA (rgb already multiplied by alpha).
      gl.uniform4f(this._shadowGLColorLoc, baseR * a, baseG * a, baseB * a, a);
      gl.bindBuffer(gl.ARRAY_BUFFER, obj._shadowVBO);
      gl.vertexAttribPointer(this._shadowGLPosLoc, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, obj._shadowVBOCount);
    }

    _endShadowStencil();

    // Restore attribute and buffer state so p5 is unaffected by the raw GL calls.
    gl.disableVertexAttribArray(this._shadowGLPosLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }



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
    this._uploadSharedUniforms(this.shader);

    this.shader.setUniform('uTileSize', TILE);
    this.shader.setUniform('uPalette', TERRAIN_PALETTE_FLAT);

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

    // Seed with white so the first box() draw before any setFillColor() call
    // renders as a bright, obviously-wrong colour rather than black (which
    // would be invisible and silently mask a missing setFillColor() call).
    this._uFillColorArr[0] = 1.0; this._uFillColorArr[1] = 1.0; this._uFillColorArr[2] = 1.0;
    this.fillShader.setUniform('uFillColor', this._uFillColorArr);
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
          const arr = manager.buckets.get(chunkKey(cx, cz));
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
      const count = tileList.length;
      if (count === 0) continue;

      fill(parseInt(matId), 0, 0, 255);
      beginShape(TRIANGLES);
      normal(0, 1, 0);
      for (let i = 0; i < count; i++) {
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
    const chunkHalf = CHUNK_SIZE * TILE;   // One chunk width — lateral frustum margin
    const fovSlope  = cam.fovSlope;
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (!cam.skipFrustum) {
          const chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
          const chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;
          const dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
          const fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
          if (fwdDist < -chunkHalf) continue;   // More than one chunk behind
          const rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
          const halfWidth = (fwdDist > 0 ? fwdDist : 0) * fovSlope + chunkHalf;
          if (Math.abs(rightDist) > halfWidth) continue;  // Lateral frustum cull
        }
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
      // Both colours share the same depth, so compute fog factor once per missile.
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
   * Ensures the shadow geometry for a tree is baked and cached.
   * Handles sun-change invalidation, hull initialisation, and geometry baking.
   * Called once per shadow-queue entry before the batched render pass.
   * @param {{}} t    Tree descriptor from getProceduralTreesForChunk.
   * @param {{}} sun  Sun shadow basis from _getSunShadowBasis().
   */
  _ensureTreeShadowBaked(t, sun) {
    // Invalidate cached geometry when the sun angle changes.
    if (t._bakedSun && (t._bakedSun.x !== sun.x || t._bakedSun.y !== sun.y || t._bakedSun.z !== sun.z)) {
      t._shadowGeom = null;
      t._shadowBakeFails = 0;
      // Release the raw-GL VBO so it is rebuilt at the new sun angle.
      if (t._shadowVBO) { drawingContext.deleteBuffer(t._shadowVBO); t._shadowVBO = null; }
    }

    if (!t._shadowHull) {
      const { trunkH: h, canopyScale: sc, variant: vi } = t;
      // Half-radii matching _drawProjectedEllipseShadow(rx, rz) → rx*0.5, rz*0.5
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

    // t._shadowGeom lifecycle:
    //   undefined  → not yet attempted
    //   null       → invalidated or bake failed (but not exhausted); rebuild next frame
    //   false      → bake permanently skipped (degenerate hull or failures exhausted)
    //   p5.Geometry → valid cached shadow mesh
    if (t._shadowGeom == null && !this._isBuildingShadow) {
      if (!sun || !t._footprint) return;
      this._isBuildingShadow = true;
      const casterH = t._shadowCasterH || t.trunkH || TREE_DEFAULT_TRUNK_HEIGHT;
      try {
        t._bakedSun = { x: sun.x, y: sun.y, z: sun.z };
        const built = _safeBuildGeometry(() => {
          this._drawProjectedFootprintShadow(t.x, t.z, t.y, casterH, t._footprint, TREE_SHADOW_BASE_ALPHA, sun, false, true);
        });
        t._shadowGeom = (built && built.vertices.length) ? built : false;
        if (t._shadowGeom) {
          t._shadowBakeFails = 0;
          // Upload baked positions to a GPU VBO for the raw-WebGL shadow pass.
          this._uploadShadowVBO(t, t._shadowGeom, casterH, TREE_SHADOW_BASE_ALPHA);
        }
      } catch (err) {
        console.error("[Viron] Shadow bake failed for tree:", err);
        t._shadowBakeFails = (t._shadowBakeFails || 0) + 1;
        t._shadowGeom = (t._shadowBakeFails >= 3) ? false : null;
      } finally {
        this._isBuildingShadow = false;
      }
    }
  }

  /**
   * Ensures the shadow geometry for a static building (types 0, 1, 2, 4) is baked
   * and cached. Handles sun-change invalidation, hull init, and geometry baking.
   * Type 3 (floating UFO) has an animated caster height and is handled separately.
   * @param {{}} b       Building descriptor from gameState.buildings.
   * @param {number} groundY  Ground Y for the bake.
   * @param {{}} sun     Sun shadow basis from _getSunShadowBasis().
   * @param {boolean} inf  Whether the building tile is currently infected.
   */
  _ensureBuildingShadowBaked(b, groundY, sun, inf) {
    // Invalidate cached geometry when the sun angle changes.
    if (b._bakedSun && (b._bakedSun.x !== sun.x || b._bakedSun.y !== sun.y || b._bakedSun.z !== sun.z)) {
      b._shadowGeom = null;
      b._shadowBakeFails = 0;
      // Release the raw-GL VBO so it is rebuilt at the new sun angle.
      if (b._shadowVBO) { drawingContext.deleteBuffer(b._shadowVBO); b._shadowVBO = null; }
    }

    // Invalidate cached geometry when infection state changes (type 4 shadow alpha
    // differs between infected/healthy, so the baked vertex colors must be rebuilt).
    if (b._shadowGeom && b._bakedInf !== inf) {
      b._shadowGeom = null;
      b._shadowBakeFails = 0;
      if (b._shadowVBO) { drawingContext.deleteBuffer(b._shadowVBO); b._shadowVBO = null; }
    }

    if (!b._shadowHull) {
      const bw = b.w, bh = b.h, bd = b.d;
      let footprint, casterH;
      if (b.type === 0) {
        const hw = bw * 0.5, hd = bd * 0.5;
        footprint = [{ x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd }];
        casterH = bh + bw * 0.35;
      } else if (b.type === 1) {
        footprint = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TWO_PI;
          footprint.push({ x: Math.cos(a) * bw * 0.5, z: Math.sin(a) * bw * 0.425 });
        }
        casterH = bh + bw * 0.5;
      } else if (b.type === 2) {
        const hw = bw * 0.75, hd = bd * 0.75;
        footprint = [{ x: -hw, z: -hd }, { x: hw, z: -hd }, { x: hw, z: hd }, { x: -hw, z: hd }];
        casterH = bh;
      } else {
        // Type 4 — sentinel tower
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

    const casterH = b._shadowCasterH || b.h;
    const baseAlpha = (b.type === 4) ? (inf ? 44 : 38) : (b.type === 0 ? 50 : 46);

    // b._shadowGeom lifecycle mirrors tree shadow lifecycle (see _ensureTreeShadowBaked).
    if (b._shadowGeom == null && !this._isBuildingShadow) {
      if (!sun || !b._footprint) return;
      this._isBuildingShadow = true;
      try {
        b._bakedSun = { x: sun.x, y: sun.y, z: sun.z };
        b._bakedInf = inf;
        const built = _safeBuildGeometry(() => {
          this._drawProjectedFootprintShadow(b.x, b.z, groundY, casterH, b._footprint, baseAlpha, sun, false, true);
        });
        b._shadowGeom = (built && built.vertices.length) ? built : false;
        if (b._shadowGeom) {
          b._shadowBakeFails = 0;
          // Upload baked positions to a GPU VBO for the raw-WebGL shadow pass.
          this._uploadShadowVBO(b, b._shadowGeom, casterH, baseAlpha);
        }
      } catch (err) {
        console.error("[Viron] Shadow bake failed for building:", err);
        b._shadowBakeFails = (b._shadowBakeFails || 0) + 1;
        b._shadowGeom = (b._shadowBakeFails >= 3) ? false : null;
      } finally {
        this._isBuildingShadow = false;
      }
    }
  }

  /**
   * Draws a single cached projected shadow for a building.
   *
   * Previous design had 2-3 overlapping draw calls per building causing:
   *   • Composited alpha overlap (type 4 reached ~70% opacity at center — unphysical)
   *   • 2-3× more WebGL draw calls per building per frame
   *   • O(n log n) convex hull recomputed every frame for static geometry
   *
   * New design: one shadow hull per building, cached after first frame.
   * Only used for type 3 (animated UFO) which cannot be batched; the caller in
   * drawBuildings guards `b.type === 3` before invoking this. Static types
   * (0, 1, 2, 4) are now batched in drawBuildings via _ensureBuildingShadowBaked.
   */
  _drawBuildingShadow(b, groundY, sun) {
    // Caller guarantees b.type === 3.
    const bw = b.w, bh = b.h;
    const floatY = groundY - bh - 100 - sin(millis() * 0.0012 + b.x) * 50;
    const casterH = max(35, groundY - floatY);
    this._drawProjectedEllipseShadow(b.x, b.z, groundY, casterH, bw * 2.2, bw * 1.4, 34, sun, true);
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
  drawTrees(s) {
    let treeCullDist = VIEW_FAR * TILE;
    let cullSq = treeCullDist * treeCullDist;
    // Uses the same camera params cached by drawLandscape
    let cam = this._cam || this.getCameraParams(s);
    // Reuse the per-instance shadow queue array to avoid a per-frame allocation.
    const shadowQueue = this._treeShadowQueue;
    shadowQueue.length = 0;

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

    // Draw all tree shadows via raw WebGL VBOs (fastest path; bypasses p5 model()).
    // _ensureTreeShadowBaked() handles baking for any tree that doesn't yet have a
    // cached shadow mesh (and uploads it to a GPU VBO via _uploadShadowVBO).
    // _drawRawShadows() renders all VBOs under one stencil guard, preventing
    // overdraw without toggling WebGL state per tree.
    const sun = this._getSunShadowBasis();
    for (const t of shadowQueue) this._ensureTreeShadowBaked(t, sun);

    noLights(); noStroke();
    this._drawRawShadows(shadowQueue);
    setSceneLighting();
  }

  _getBuildingGeom(b, inf) {
    // Cache both key variants (clean + infected) on the building so toFixed()
    // string allocation is paid only once per building lifetime rather than
    // every frame.  b._geomKeyPair[0] = clean key, b._geomKeyPair[1] = infected key.
    if (!b._geomKeyPair) {
      const base = `bldg_${b.type}_${b.w.toFixed(1)}_${b.h.toFixed(1)}_${b.d.toFixed(1)}_`;
      const colSuffix = (b.type === 2) ? `_${b.col[0]}_${b.col[1]}_${b.col[2]}` : '';
      b._geomKeyPair = [base + 'false' + colSuffix, base + 'true' + colSuffix];
    }
    const key = b._geomKeyPair[inf ? 1 : 0];

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
          fill(inf ? 41 : 40, inf ? 50 : 220, inf ? 50 : 220);
          push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();
          fill(safeR(inf ? 150 : 220), inf ? 30 : 50, inf ? 30 : 50);
          push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();
        } else if (b.type === 1) {
          fill(inf ? 43 : 42, inf ? 50 : 160, inf ? 50 : 170);
          push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();
          fill(safeR(inf ? 150 : 80), inf ? 30 : 180, inf ? 30 : 220);
          push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();
        } else if (b.type === 2) {
          fill(inf ? 45 : 44, inf ? 50 : b.col[1], inf ? 50 : b.col[2]);
          push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
          push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();
          fill(safeR(inf ? 120 : 80), inf ? 20 : 80, inf ? 20 : 80);
          push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();
        } else if (b.type === 4) {
          const matID = inf ? 47 : 46;
          let steelR = matID, steelG = inf ? 38 : 68, steelB = inf ? 38 : 90;
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
    // Reuse the per-instance shadow queue arrays to avoid per-frame allocation.
    // _buildingShadowInf is a parallel array carrying the already-computed
    // infection flag so the shadow pass never recomputes infection.has().
    const shadowQueue = this._buildingShadowQueue;
    const shadowInf   = this._buildingShadowInf;
    shadowQueue.length = 0;
    shadowInf.length   = 0;

    // Apply terrain shader to natively handle fog and lighting
    this.applyShader();

    for (let b of gameState.buildings) {
      let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, b.x, b.z)) continue;
      let y = b.y;
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

      // Cache the numeric tile-key on the building so toTile() + arithmetic
      // is only computed once per building lifetime rather than every frame.
      // Assumes building positions are static after creation — valid for all
      // current building types (spawned once at level start, never moved).
      if (b._tileKey === undefined) b._tileKey = tileKey(toTile(b.x), toTile(b.z));
      let inf = infection.has(b._tileKey);

      push(); translate(b.x, y, b.z); noStroke();

      if (b.type === 3) {
        // Floating UFO handles its own animation, drawn immediately rather than cached
        push();
        // Floating UFO: animation uses millis() so it stays in sync with
        // the _simTick-based collision floatY in gameLoop.js.
        // Equivalences at 60 ticks/s:  frameCount*0.02 → millis()*0.0012
        //   frameCount*0.01 → millis()*0.0006,  frameCount*0.015 → millis()*0.0009
        let floatY = y - b.h - 100 - sin(millis() * 0.0012 + b.x) * 50;
        translate(0, floatY - y, 0);
        rotateY(millis() * 0.0006 + b.x);
        rotateZ(millis() * 0.0009 + b.z);
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
          rotateY(millis() * 0.00192 + b.x * 0.001);
          torus(b.w * 0.32, b.w * 0.07, 14, 6);
          pop();
        }
      }

      pop();

      // Defer ground shadow drawing.  Carry inf so the shadow pass reuses it
      // without calling infection.has() a second time per building.
      if (dSq < 2250000) {
        shadowQueue.push(b);
        shadowInf.push(inf);
      }
    }

    resetShader();
    setSceneLighting();

    // Draw building shadows via raw WebGL VBOs (fastest path; bypasses p5 model()).
    // Type 3 (floating UFO) has an animated caster height and cannot be cached;
    // it is drawn immediately via _drawBuildingShadow (which handles its own stencil).
    // Static types (0, 1, 2, 4) are baked once and rendered via _drawRawShadows.
    noLights(); noStroke();
    for (let qi = 0; qi < shadowQueue.length; qi++) {
      const b = shadowQueue[qi], inf = shadowInf[qi];
      if (b.type === 3) {
        // UFO: animated shadow, handled individually (includes its own stencil setup).
        this._drawBuildingShadow(b, b.y, sun);
      } else {
        this._ensureBuildingShadowBaked(b, b.y, sun, inf);
      }
    }

    // Static types (0, 1, 2, 4): draw via raw WebGL VBOs.
    // Type-3 UFO objects have no _shadowVBO and are skipped automatically.
    this._drawRawShadows(shadowQueue);
    setSceneLighting();
  }
}

// Singleton instance used by all other modules
const terrain = new Terrain();
