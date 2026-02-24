// =============================================================================
// terrain.js — Terrain class
//
// Owns all terrain-related state and rendering:
//   • GLSL shader with fog and pulse ring effects
//   • Altitude cache  — memoised per tile-grid coordinate
//   • Chunk geometry cache — pre-built p5 buildGeometry meshes
//   • Active pulses   — time-stamped ring effects triggered by explosions / infection
//   • drawLandscape / drawTrees / drawBuildings rendering methods
// =============================================================================

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

void main() {  
  vec3 cyberColor = vec3(0.0);
  
  // Bomb drop pulses
  for (int i = 0; i < 5; i++) {
    float age = uTime - uPulses[i].z;
    if (age >= 0.0 && age < 3.0) { // Lasts for 3 seconds
      float type = uPulses[i].w;
      // Scale differences by 0.01 before taking length to avoid fp16 overflow on mobile
      vec2 diff = (vWorldPos.xz - uPulses[i].xy) * 0.01;
      float distToPulse = length(diff) * 100.0;
      
      // type 3 = sentinel (small localised cyan ring)
      float radius = type == 1.0 ? age * 300.0 : (type == 2.0 ? age * 1200.0 : (type == 3.0 ? age * 150.0 : age * 800.0));
      float ringThickness = type == 1.0 ? 30.0 : (type == 2.0 ? 150.0 : (type == 3.0 ? 18.0 : 80.0));
      float ring = smoothstep(radius - ringThickness, radius, distToPulse) * (1.0 - smoothstep(radius, radius + ringThickness, distToPulse));
      
      float fade = 1.0 - (age / 3.0);
      vec3 pulseColor = type == 1.0 ? vec3(0.2, 0.6, 1.0) : (type == 2.0 ? vec3(1.0, 0.8, 0.2) : (type == 3.0 ? vec3(0.0, 0.9, 0.8) : vec3(1.0, 0.1, 0.1))); // Blue crab, yellow ship, cyan sentinel, red bomb
      cyberColor += pulseColor * ring * fade * 2.0; 
    }
  }
  
  vec3 outColor = vColor.rgb + cyberColor;
  
  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  vec3 fogColor = vec3(30.0 / 255.0, 60.0 / 255.0, 120.0 / 255.0);
  outColor = mix(outColor, fogColor, fogFactor);

  gl_FragColor = vec4(outColor, vColor.a);
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
    this.activePulses = [{ x, z, start: millis() / 1000.0, type }, ...this.activePulses].slice(0, 5);
  }

  // ---------------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------------

  /**
   * Evicts the altitude and geometry caches if they grow too large.
   * Called once per frame from the main draw loop to prevent unbounded memory use.
   */
  clearCaches() {
    if (this.altCache.size > 10000) this.altCache.clear();
    if (this.chunkCache.size > 200) this.chunkCache.clear();
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
   * @param {{x,z,fwdX,fwdZ}} cam  Camera descriptor from getCameraParams().
   * @param {number} tx  World-space X to test.
   * @param {number} tz  World-space Z to test.
   */
  inFrustum(cam, tx, tz) {
    let dx = tx - cam.x, dz = tz - cam.z;
    let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
    if (fwdDist < -TILE * 5) return false;
    let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
    let aspect = (numPlayers === 1 ? width : width * 0.5) / height;
    let slope = 0.57735 * aspect + 0.3;
    let halfWidth = (fwdDist > 0 ? fwdDist : 0) * slope + TILE * 6;
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

      // Blend in Gaussian bumps for the forced mountain peaks
      // Each peak may carry its own `sigma` field; fall back to the global SENTINEL_PEAK_SIGMA.
      for (let peak of MOUNTAIN_PEAKS) {
        let sigma = peak.sigma !== undefined ? peak.sigma : SENTINEL_PEAK_SIGMA;
        let s2 = 2 * sigma * sigma;
        let dx = x - peak.x, dz = z - peak.z;
        let falloff = Math.exp(-(dx * dx + dz * dz) / s2);
        alt -= peak.strength * falloff;
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

      for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
        for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
          let xP = tx * TILE, zP = tz * TILE;
          let xP1 = xP + TILE, zP1 = zP + TILE;
          let y00 = this.getAltitude(xP, zP), y10 = this.getAltitude(xP1, zP);
          let y01 = this.getAltitude(xP, zP1), y11 = this.getAltitude(xP1, zP1);
          let avgY = (y00 + y10 + y01 + y11) * 0.25;
          let minY = Math.min(y00, y10, y01, y11);
          if (aboveSea(minY)) continue;  // Skip fully submerged tiles

          let chk = (tx + tz) % 2 === 0;  // Checkerboard shading variation

          let baseR, baseG, baseB;
          let isSkirt = isLaunchpad(xP, zP) || isLaunchpad(xP1, zP) || isLaunchpad(xP, zP1) || isLaunchpad(xP1, zP1);

          if (isSkirt) {
            // Launchpad tiles are pure white
            baseR = 255; baseG = 255; baseB = 255;
          } else {
            // Use a deterministic pseudo-random value per tile for colour variety
            let rand = Math.abs(Math.sin(tx * 12.9898 + tz * 78.233)) * 43758.5453 % 1;
            if (avgY > SEA - 15) {
              // Near-shore sandy / grassy colours
              let colors = [[230, 210, 80], [200, 180, 60], [150, 180, 50]];
              let col = colors[Math.floor(rand * 3)];
              baseR = col[0]; baseG = col[1]; baseB = col[2];
            } else {
              // Inland colour patches blended with Perlin noise for organic look
              let colors = [
                [60, 180, 60], [30, 120, 40], [180, 200, 50],
                [220, 200, 80], [210, 130, 140], [180, 140, 70]
              ];
              let patch = noise(tx * 0.15, tz * 0.15);
              let colIdx = Math.floor((patch * 2.0 + rand * 0.2) * 6) % 6;
              let col = colors[colIdx];
              baseR = col[0]; baseG = col[1]; baseB = col[2];
            }
          }

          // Dark checkerboard rows add subtle ground texture variation
          let finalR = chk ? baseR : baseR * 0.85;
          let finalG = chk ? baseG : baseG * 0.85;
          let finalB = chk ? baseB : baseB * 0.85;

          fill(finalR, finalG, finalB);
          // Each tile is two triangles sharing the diagonal
          vertex(xP, y00, zP); vertex(xP1, y10, zP); vertex(xP, y01, zP1);
          vertex(xP1, y10, zP); vertex(xP1, y11, zP1); vertex(xP, y01, zP1);
        }
      }
      endShape();
    });

    this.chunkCache.set(key, geom);
    return geom;
  }

  /**
   * Builds a simple two-triangle sea plane centred on the current ship position.
   * Rebuilt every frame (not cached) so the sea follows the player without a seam.
   * @param {number} seaSize  Half-extent of the sea quad in world units.
   * @param {number[]} seaC   RGB colour array [r, g, b].
   * @param {number} sx       Ship world-space X (used to centre the quad).
   * @param {number} sz       Ship world-space Z.
   * @returns {p5.Geometry}
   */
  getSeaGeometry(seaSize, seaC, sx, sz) {
    return buildGeometry(() => {
      fill(seaC[0], seaC[1], seaC[2]);
      beginShape(TRIANGLES);
      let y = SEA + 3;  // Slightly above sea level to avoid z-fighting with shore tiles
      let cx = toTile(sx) * TILE, cz = toTile(sz) * TILE;
      vertex(cx - seaSize, y, cz - seaSize);
      vertex(cx + seaSize, y, cz - seaSize);
      vertex(cx - seaSize, y, cz + seaSize);
      vertex(cx + seaSize, y, cz - seaSize);
      vertex(cx + seaSize, y, cz + seaSize);
      vertex(cx - seaSize, y, cz + seaSize);
      endShape();
    });
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
   *   • uPulses   — flat array of up to 5 pulse descriptors [x, z, startTime, type]
   * Must be called before any model() draw calls that should use the terrain shader.
   */
  applyShader() {
    shader(this.shader);
    this.shader.setUniform('uTime', millis() / 1000.0);
    this.shader.setUniform('uFogDist', [VIEW_FAR * TILE - 800, VIEW_FAR * TILE + 400]);

    // Build the flat uniform array expected by the GLSL array declaration
    let pulseArr = [];
    for (let i = 0; i < 5; i++) {
      if (i < this.activePulses.length) {
        pulseArr.push(
          this.activePulses[i].x,
          this.activePulses[i].z,
          this.activePulses[i].start,
          this.activePulses[i].type || 0.0
        );
      } else {
        pulseArr.push(0.0, 0.0, -9999.0, 0.0);  // Inactive slot: start = -9999 so age never triggers
      }
    }
    this.shader.setUniform('uPulses', pulseArr);
  }

  // ---------------------------------------------------------------------------
  // Draw methods
  // ---------------------------------------------------------------------------

  /**
   * Renders the visible terrain chunks, infected tile overlays, sea plane and
   * launchpad missile decorations for one player's viewport.
   *
   * Draw order:
   *   1. Terrain chunks (via cached geometry + terrain shader)
   *   2. Infected tile overlays (pulsing green quads drawn on top)
   *   3. Sea plane (flat quad at SEA+3)
   *   4. Launchpad missile decorations (standard lighting restored first)
   *
   * @param {{x,y,z,yaw,pitch}} s  The ship whose viewport is being rendered.
   */
  drawLandscape(s) {
    let gx = toTile(s.x), gz = toTile(s.z);
    noStroke();

    let infected = [];
    let cam = this.getCameraParams(s);

    // p5 lighting silently overrides custom shaders that don't declare lighting
    // uniforms; disable it for the terrain pass.
    noLights();
    this.applyShader();

    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        // Rough back-face cull at chunk level — skip chunks entirely behind the camera
        let chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
        let chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;
        let dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
        let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
        if (fwdDist < -CHUNK_SIZE * TILE * 1.5) continue;

        model(this.getChunkGeometry(cx, cz));

        // Collect infected tiles within this chunk for the overlay pass below
        for (let tx = cx * CHUNK_SIZE; tx < (cx + 1) * CHUNK_SIZE; tx++) {
          for (let tz = cz * CHUNK_SIZE; tz < (cz + 1) * CHUNK_SIZE; tz++) {
            if (infectedTiles[tileKey(tx, tz)]) {
              let xP = tx * TILE, zP = tz * TILE;
              let xP1 = xP + TILE, zP1 = zP + TILE;

              // Slightly below ground (- 0.5) to avoid z-fighting with base terrain
              let y00 = this.getAltitude(xP, zP) - 0.5, y10 = this.getAltitude(xP1, zP) - 0.5;
              let y01 = this.getAltitude(xP, zP1) - 0.5, y11 = this.getAltitude(xP1, zP1) - 0.5;

              let avgY = (this.getAltitude(xP, zP) + this.getAltitude(xP1, zP) +
                this.getAltitude(xP, zP1) + this.getAltitude(xP1, zP1)) * 0.25;
              let v = [xP, y00, zP, xP1, y10, zP, xP, y01, zP1, xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1];

              // Animate the green glow with a sine wave per-tile offset
              let chk = (tx + tz) % 2 === 0;
              let pulse = sin(frameCount * 0.08 + tx * 0.5 + tz * 0.3) * 0.5 + 0.5;
              // Altitude factor: brighter near sea (danger), dimmer inland
              let af = map(avgY, -100, SEA, 1.15, 0.65);
              let base = chk ? [160, 255, 10, 40, 10, 25] : [120, 200, 5, 25, 5, 15];
              infected.push({
                v,
                r: lerp(base[0], base[1], pulse) * af,
                g: lerp(base[2], base[3], pulse) * af,
                b: lerp(base[4], base[5], pulse) * af
              });
            }
          }
        }
      }
    }

    // Draw all infected overlays in a single beginShape/endShape call to minimise draw calls
    if (infected.length) {
      beginShape(TRIANGLES);
      for (let t of infected) {
        fill(t.r, t.g, t.b);
        let v = t.v;
        vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
        vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
      }
      endShape();
    }

    // Animated sea — colour oscillates slightly for a water shimmer effect
    let p = sin(frameCount * 0.03) * 8;
    let seaC = [15, 45 + p, 150 + p];
    model(this.getSeaGeometry(VIEW_FAR * TILE * 1.5, seaC, s.x, s.z));

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
    let cam = this.getCameraParams(s);

    for (let t of trees) {
      let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, t.x, t.z)) continue;
      let y = this.getAltitude(t.x, t.z);
      if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

      push(); translate(t.x, y, t.z); noStroke();
      let { trunkH: h, canopyScale: sc, variant: vi } = t;
      let inf = !!infectedTiles[tileKey(toTile(t.x), toTile(t.z))];

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
   *   0 — House (box + pyramid roof)
   *   1 — Water tower (cylinder + dome)
   *   2 — Industrial complex (layered boxes + smokestack)
   *   3 — Orbiting UFO power-up (double-cone, floats above ground)
   * @param {{x,y,z,yaw}} s  Ship state used as view origin for culling.
   */
  drawBuildings(s) {
    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    let cam = this.getCameraParams(s);

    for (let b of buildings) {
      let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, b.x, b.z)) continue;
      let y = this.getAltitude(b.x, b.z);
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

      let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];
      let depth = (b.x - cam.x) * cam.fwdX + (b.z - cam.z) * cam.fwdZ;
      push(); translate(b.x, y, b.z); noStroke();

      if (b.type === 0) {
        // House: white box body + red pyramid roof (turns red when infected)
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
        // Sentinel: tall narrow tower on a mountain peak with a rotating emitter dish.
        // Healthy = dark steel body + cyan emitter; infected = red body + orange emitter.
        let towerR = b.w / 5;

        // Main tower shaft
        let tc = this.getFogColor(inf ? [180, 40, 40] : [55, 70, 90], depth);
        fill(tc[0], tc[1], tc[2]);
        push(); translate(0, -b.h / 2, 0); cylinder(towerR, b.h, 8, 1); pop();

        // Four angled support struts at the base
        let stc = this.getFogColor(inf ? [140, 30, 30] : [45, 60, 75], depth);
        fill(stc[0], stc[1], stc[2]);
        for (let i = 0; i < 4; i++) {
          let a = (i / 4) * TWO_PI + PI / 4;
          push();
          translate(sin(a) * b.w * 0.55, -b.h * 0.15, cos(a) * b.w * 0.55);
          rotateZ(sin(a) * 0.45); rotateX(cos(a) * 0.45);
          translate(0, -b.h * 0.1, 0);
          cylinder(towerR * 0.6, b.h * 0.22, 4, 1);
          pop();
        }

        // Rotating emitter ring + inner cone at the tower tip
        let ec = this.getFogColor(inf ? [255, 90, 20] : [0, 220, 200], depth);
        fill(ec[0], ec[1], ec[2]);
        push();
        translate(0, -b.h - b.w * 0.4, 0);
        rotateY(frameCount * 0.025 + b.x * 0.001);
        torus(b.w * 0.4, b.w * 0.1, 12, 6);
        pop();
        push();
        translate(0, -b.h - b.w * 0.55, 0);
        cone(b.w * 0.25, b.w * 0.5, 6, 1);
        pop();
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
