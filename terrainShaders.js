// =============================================================================
// terrainShaders.js — Terrain palette configuration and GLSL shader sources
//
// Extracted from terrain.js to keep each file focused on one concern.
// Loaded before terrain.js in index.html so all constants are available
// when the Terrain class is defined.
// =============================================================================

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
// Index layout: 0-5 Inland, 6-8 Shore, 9-11 Viron (Red/Dark/Scan),
//               12-13 Barrier, 14-16 YellowViron (Yellow/Dark/Luminous).
// Total: 17 vec3 swatches → uPalette[17] uniform array.
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
uniform vec4 uSentinelGlows[16];
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

// Hash function for procedural noise — "Hash Without Sine" (Dave Hoskins),
// using only multiply/dot/fract so there are no sin()-induced stripe artefacts
// and no expensive trig ops.
float hash(vec2 p) {
  p = mod(p, 5000.0);
  // p.x is used twice (canonical form) to improve mixing in the 3rd channel.
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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
    float n2   = noise2D(wPos - vec2(t * 0.8, -t * 0.3) + vec2(n1 * 2.0, n1 * 0.7));
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

// Procedural wood-grain surface (mat 60 = normal, mat 61 = infected).
// Simulates horizontal timber planks stacked up the wall.
vec3 computeWoodColor(int mat, inout float specInt, inout float specShin) {
  bool infected = (mat == 61);

  // Plank row index: planks are horizontal bands stacked along the Y axis.
  float plankCoord = vWorldPos.y * 0.09;
  float plankIdx   = floor(plankCoord);

  // Per-plank random phase offset — each plank shows distinct grain.
  float plankPhase = hash(vec2(plankIdx, 3.7)) * 12.0;

  // Grain lines run horizontally (45° XZ diagonal) offset by the plank phase.
  float grainXZ = (vWorldPos.x + vWorldPos.z) * 0.18 + plankPhase;
  float g1 = noise2D(vec2(grainXZ,           plankIdx * 1.73));
  float g2 = noise2D(vec2(grainXZ * 0.4 + 7.1, plankIdx * 0.91 + 8.3));
  float woodPattern = g1 * 0.65 + g2 * 0.35;

  // Thin dark seam where planks meet.
  // Multiply two monotonic smoothsteps so seam stays in [0,1] with
  // well-defined GLSL ES behaviour (reversed-edge smoothstep is UB).
  float seamT = fract(plankCoord);
  float seam  = smoothstep(0.0, 0.14, seamT) * (1.0 - smoothstep(0.86, 1.0, seamT));

  // Warm pine tones, darkened when infected.
  vec3 lightWood = infected ? vec3(0.36, 0.24, 0.09) : vec3(0.74, 0.52, 0.26);
  vec3 darkWood  = infected ? vec3(0.18, 0.11, 0.04) : vec3(0.46, 0.27, 0.09);
  vec3 woodColor = mix(darkWood, lightWood, woodPattern) * seam;

  specInt  = 0.12;
  specShin = 6.0;
  return woodColor;
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
  else if (mat >= 60 && mat <= 61)  { baseColor = computeWoodColor(mat, specularIntensity, specularShininess); }

  // ── Shockwave pulse rings ─────────────────────────────────────────────────
  ${_GLSL_PULSE_LOOP}

  // ── Sentinel steady glows ─────────────────────────────────────────────────
  for (int j = 0; j < 16; j++) {
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

// --- GLSL fragment shader for shadow rendering ---
//
// Shadows have their colour and alpha baked into vertex colours by
// _drawProjectedFootprintShadow (isBaking=true).  The default p5 shader has no
// fog, so baked shadows remain visible even when the caster and terrain have
// already blended into the fog.  This minimal shader reads the baked vertex
// colour and fades its alpha to zero across the same fog range used by the
// terrain/fill-colour shaders, making shadows correctly disappear in the fog.
const SHADOW_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
uniform vec2 uFogDist;

void main() {
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - fogFactor));
}
`;
