// =============================================================================
// particles.js — ParticleSystem class
//
// Owns and updates three types of projectile / effect objects:
//   • particles     — generic VFX: thrust exhaust, missile smoke, explosions
//   • bombs         — infection payloads dropped by enemy aircraft
//   • enemyBullets  — straight-line projectiles fired by fighters and crabs
//
// @exports   ParticleSystem  — class definition
// @exports   particleSystem  — singleton
// =============================================================================

// --- Bomb Physics & Infection Constants ---
const BOMB_FALL_SPEED = 8;
const MEGA_BOMB_TILE_RAD = 4;
const MEGA_BOMB_TILE_RAD_SQ = 16;

// -----------------------------------------------------------------------------
// Soft-particle GLSL — adapted from SoftDiffuseColoredShader
//
// The vertex shader is a standard MVP transform that passes UV coordinates
// through to the fragment shader.
//
// The fragment shader achieves two effects simultaneously:
//   1. Billowy diffuse shape — samples a radial-gradient cloud sprite
//      (sTexture) so each particle looks like a soft puff rather than a
//      hard-edged sphere or square.
//   2. Soft intersection with geometry — linearises both the pre-particle
//      scene depth (from sDepth, captured in a pre-pass) and the current
//      fragment depth (gl_FragCoord.z), then applies a smoothstep fade so
//      particles dissolve where they intersect terrain or other opaque
//      objects instead of popping through them.
// -----------------------------------------------------------------------------
const SOFT_PARTICLE_VERT = `
precision mediump float;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}`;

const SOFT_PARTICLE_FRAG = `
precision highp float;
uniform vec2  uCameraRange;      // [near, far] clip distances
uniform vec2  uInvViewportSize;  // [1/physicalWidth, 1/physicalHeight]
uniform float uTransitionSize;   // smoothstep width for depth fade
float calc_depth(in float z) {
  // Depth-buffer values are in [0, 1]; convert to NDC z in [-1, 1] first,
  // then apply the standard perspective linearization using near/far.
  float z_ndc = z * 2.0 - 1.0;
  return (2.0 * uCameraRange.x * uCameraRange.y) /
    (uCameraRange.y + uCameraRange.x - z_ndc * (uCameraRange.y - uCameraRange.x));
}
uniform sampler2D sDepth;       // opaque-scene depth texture (pre-particle pass)
uniform sampler2D sTexture;     // cloud gradient sprite (white centre, transparent edge)
uniform vec4      uParticleColor; // rgba in [0, 1]
varying vec2 vTexCoord;
void main() {
  vec4 diffuse    = texture2D(sTexture, vTexCoord) * uParticleColor;
  vec2 coords     = gl_FragCoord.xy * uInvViewportSize;
  float geometryZ = calc_depth(texture2D(sDepth, coords).r);
  float sceneZ    = calc_depth(gl_FragCoord.z);
  float a = clamp(geometryZ - sceneZ, 0.0, 1.0);
  float b = smoothstep(0.0, uTransitionSize, a);
  gl_FragColor = diffuse * b;
}`;

/** Compiled soft-particle GLSL shader; null until ParticleSystem.init(). */
let _softShader = null;
/** 64×64 2D p5.Graphics: white radial-gradient cloud sprite. */
let _cloudTex = null;
/** Pre-computed wave expansion values for explosion particles. */
const _EXPLOSION_WAVE_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  _EXPLOSION_WAVE_LUT[i] = 2000.0 * Math.pow(1.0 - i / 255, 0.6);
}

// Module-level cap so addFogParticle() does not re-declare it on every call.
const _MAX_FOG_PARTICLES = 220;

// Pre-allocated uniform upload buffers for the soft-particle shader.
// Avoids creating new array literals inside the render() hot path each frame.
// _softCameraRangeBuf  — [camNear, camFar] (set once per render() call)
// _softInvViewportBuf  — [1/(w*pxD), 1/(h*pxD)] (set once per render() call)
const _softCameraRangeBuf  = new Float32Array(2);
const _softInvViewportBuf  = new Float32Array(2);

// -----------------------------------------------------------------------------
// Explosion particle batching — size-bucket approach
//
// Each point() call in p5's WebGL mode is batched into an internal VBO.  The
// batch is flushed to the GPU whenever strokeWeight() changes, because point
// size is a per-program uniform, not a per-vertex attribute.  A typical
// explosion has 400 particles, each with a unique perspective-scaled size,
// which would trigger 400 flushes under the naïve approach.
//
// Fix: sort particles into 4 size buckets and render each bucket with a single
// strokeWeight() call.  Particle colours still differ per point (stroke()),
// but colour IS a per-vertex attribute in p5's point shader so it does not
// force a flush.  Result: 400 draw-calls → 4 draw-calls per explosion frame.
//
// Layout per entry: x, y, z, r, g, b, alpha  (7 floats)
// -----------------------------------------------------------------------------
// Cap per bucket: sized to hold a full desktop explosion (400 particles) in the
// worst case where all particles land in the same bucket, with a 50% safety
// margin (600).  Four buckets × 600 = 2400 entries, a modest overall memory use.
const _EXP_BUCKET_MAX = 600;
// Representative strokeWeight for each bucket range: [1.5,4) [4,16) [16,32) [32,64].
// Values use the geometric mean of each range (√(lo×hi)), which perceptually
// balances the range on a log scale matching how point-size affects visuals:
//   bucket 0: √(1.5×4)  ≈ 2.45 → 2.5
//   bucket 1: √(4×16)   = 8.0
//   bucket 2: √(16×32)  ≈ 22.6 → 24.0  (rounded for a clean number)
//   bucket 3: √(32×64)  ≈ 45.3 → 48.0  (rounded for a clean number)
// The exact weight only affects particles at bucket boundaries; mid-bucket
// particles are rendered at the correct order-of-magnitude size.
const _EXP_BUCKET_WEIGHTS = [2.5, 8.0, 24.0, 48.0];
const _expBucketBufs = [
  new Float32Array(_EXP_BUCKET_MAX * 7),
  new Float32Array(_EXP_BUCKET_MAX * 7),
  new Float32Array(_EXP_BUCKET_MAX * 7),
  new Float32Array(_EXP_BUCKET_MAX * 7),
];
const _expBucketCounts = new Int32Array(4);

/**
 * Computes the RGB colour for a soft (non-explosion) particle at normalised age `t`
 * and writes the result into the shared `_softColorBuf` to avoid per-call allocation.
 *
 * Three colour models:
 *   • Fog / ink particles (p.isFog + p.color): fade toward a near-black haze.
 *   • Tinted particles (p.color): fade to dark grey; thrust exhaust is desaturated.
 *   • Seed-coloured sparks (no p.color): rainbow-hue derived from p.seed, then cool
 *     through bright → vivid → dim over the particle lifetime.
 *
 * @param {object} p  Particle state object.
 * @param {number} t  Age fraction in [0, 1] (0 = fresh, 1 = expired).
 * @returns {number[]}  The shared `_softColorBuf` [r, g, b] — valid until next call.
 */
// Shared buffer — avoids a per-particle heap allocation inside the render loop.
// Safe because _calcSoftParticleColor is called non-reentrantly once per particle.
const _softColorBuf = [0, 0, 0];

// Pre-allocated RGBA Float32Array passed to the soft-particle shader each frame.
// Eliminates the temporary [r/255, g/255, b/255, alpha] array literal that would
// otherwise be allocated once per visible soft particle per frame (~220/frame → GC).
const _softShaderColorBuf = new Float32Array(4);
function _calcSoftParticleColor(p, t) {
  let r, g, b;
  if (p.isFog && p.color) {
    if (p.isInkBurst) {
      let f = Math.min(t * 0.7, 1.0);
      r = lerp(p.color[0], 3, f); g = lerp(p.color[1], 3, f); b = lerp(p.color[2], 4, f);
    } else {
      let f = Math.min(t * 0.9, 1.0);
      r = lerp(p.color[0], 8, f); g = lerp(p.color[1], 8, f); b = lerp(p.color[2], 10, f);
    }
  } else if (p.color) {
    let f = Math.min(t * 1.5, 1.0);
    r = lerp(p.color[0], 30, f); g = lerp(p.color[1], 30, f); b = lerp(p.color[2], 30, f);
    if (p.isThrust) {
      // Desaturate exhaust smoke toward grey
      let grey = (r + g + b) / 3;
      r = lerp(r, grey, 0.75); g = lerp(g, grey, 0.75); b = lerp(b, grey, 0.75);
    }
  } else {
    // Seed-based rainbow hue: bright flash → vivid colour → dim ember
    let seed = p.seed || 1.0;
    let kr = (5 + seed * 6) % 6, kg = (3 + seed * 6) % 6, kb = (1 + seed * 6) % 6;
    let vr = 255 * (1 - Math.max(Math.min(kr, 4 - kr, 1), 0));
    let vg = 255 * (1 - Math.max(Math.min(kg, 4 - kg, 1), 0));
    let vb = 255 * (1 - Math.max(Math.min(kb, 4 - kb, 1), 0));
    if (t < 0.15) {
      let f = t / 0.15; r = lerp(255, vr, f); g = lerp(255, vg, f); b = lerp(255, vb, f);
    } else if (t < 0.6) {
      let f = (t - 0.15) / 0.45; r = lerp(vr, vr * 0.4, f); g = lerp(vg, vg * 0.4, f); b = lerp(vb, vb * 0.4, f);
    } else {
      let f = (t - 0.6) / 0.4; r = lerp(vr * 0.4, 15, f); g = lerp(vg * 0.4, 15, f); b = lerp(vb * 0.4, 15, f);
    }
  }
  _softColorBuf[0] = r; _softColorBuf[1] = g; _softColorBuf[2] = b;
  return _softColorBuf;
}

class ParticleSystem {
  constructor() {
    /** @type {Array} Generic visual-effects particles (exhaust, sparks, explosions). */
    this.particles = [];

    /**
     * @type {Array<{x,y,z,k,type}>} Falling bombs dropped by enemies.
     * Each bomb rises upward (positive-Y axis) and infects tiles on ground impact.
     * type 'mega' (bomber) infects a radius; default infects one tile.
     */
    this.bombs = [];

    /** @type {Array<{x,y,z,vx,vy,vz,life}>} Bullets fired by enemy units. */
    this.enemyBullets = [];

    /** @type {number} Live squid-ink fog particle count (performance throttle input). */
    this.fogCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Empties all particle, bomb and enemy-bullet arrays. Called at level start. */
  clear() {
    this.particles.length = 0;
    this.bombs.length = 0;
    this.enemyBullets.length = 0;
    this.fogCount = 0;
  }

  /**
   * Adds one squid-ink fog particle, respecting a global cap to avoid
   * runaway fill-rate and per-particle update/render cost.
   * @param {{x:number,y:number,z:number,vx:number,vy:number,vz:number,life:number,decay:number,size:number,color:number[],isInkBurst?:boolean}} p
   */
  addFogParticle(p) {
    if (this.fogCount >= _MAX_FOG_PARTICLES) return false;
    this.particles.push({
      x: p.x, y: p.y, z: p.z,
      isFog: true,
      isInkBurst: !!p.isInkBurst,
      vx: p.vx, vy: p.vy, vz: p.vz,
      life: p.life,
      decay: p.decay,
      size: p.size,
      color: p.color || [2, 2, 4]
    });
    this.fogCount++;
    return true;
  }

  /**
   * Creates the radial-gradient cloud sprite and compiles the soft-particle
   * shader.  Must be called once from p5 setup(), after createCanvas().
   * Safe to skip — render() falls back to unlit spheres if not called.
   */
  static init() {
    // 64×64 white radial gradient: opaque centre → fully transparent edge.
    // Used as the diffuse sprite for each billboard particle so the puff
    // looks soft and cloud-like rather than hard-edged.
    _cloudTex = createGraphics(64, 64);
    const ctx = _cloudTex.drawingContext;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.90)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(0.70, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    _softShader = createShader(SOFT_PARTICLE_VERT, SOFT_PARTICLE_FRAG);
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  /**
   * Spawns a burst of 350 explosion particles at the given world position.
   * Particles spread outward in a sphere, then cool from bright core → embers → smoke.
   *
   * The colour transition uses three colour stops:
   *   bright core (br/bg/bb) → mid-range glow (er/eg/eb) → cooled smoke (sr/sg/sb)
   *
   * If baseColor is provided the explosion is tinted to match the enemy type;
   * otherwise the default fire palette (yellow → orange → dark smoke) is used.
   *
   * Also triggers a matching sound effect via gameSFX when available.
   *
   * @param {number}        x          World X of the explosion centre.
   * @param {number}        y          World Y of the explosion centre.
   * @param {number}        z          World Z of the explosion centre.
   * @param {number[]|null} baseColor  Optional RGB tint colour [r, g, b].
   * @param {string|null}   type       Enemy type string used for sound selection.
   */
  addExplosion(x, y, z, baseColor, type) {
    if (gameSFX) {
      if (type) gameSFX.playExplosion(x, y, z, type === 'bomber' || type === 'mega', type);
      else gameSFX.playExplosion(x, y, z, baseColor === undefined || baseColor === null, '');
    }

    let isCustom = baseColor !== undefined && baseColor !== null;
    let count = gameState.isMobile ? 220 : 400;

    for (let i = 0; i < count; i++) {
      let speed = random(5.0, 45.0);
      let a1 = random(TWO_PI);
      let a2 = random(TWO_PI);

      // Default fire palette: bright yellow core → orange mid → dark smoke
      let br = 255, bg = 200, bb = 50;
      let er = 200, eg = 30, eb = 10;
      let sr = 40, sg = 20, sb = 20;

      if (isCustom) {
        // Custom tint: blend base colour toward white for the hot core
        let rV = baseColor[0] + random(-15, 15);
        let gV = baseColor[1] + random(-15, 15);
        let bV = baseColor[2] + random(-15, 15);

        if (random() > 0.6) {
          rV = lerp(rV, 255, 0.8);
          gV = lerp(gV, 255, 0.8);
          bV = lerp(bV, 255, 0.4);
        }

        br = constrain(rV, 0, 255); bg = constrain(gV, 0, 255); bb = constrain(bV, 0, 255);
        er = br * 0.8; eg = bg * 0.8; eb = bb * 0.8;
        sr = br * 0.3 + 10; sg = bg * 0.3 + 10; sb = bb * 0.3 + 10;
      }

      this.particles.push({
        x, y, z,
        cx: x, cy: y, cz: z,    // Origin — used to compute wave-front distance
        isExplosion: true,
        hasExpColor: isCustom,
        br, bg, bb,              // Bright (core) colour
        er, eg, eb,              // Ember (mid) colour
        sr, sg, sb,              // Smoke (outer) colour
        vx: speed * sin(a1) * cos(a2),
        vy: speed * sin(a1) * sin(a2),
        vz: speed * cos(a1),
        life: 255,
        decay: random(2.0, 6.0),
        size: random(8, 26)
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Physics update (called once per frame)
  // ---------------------------------------------------------------------------

  /**
   * Advances the physics simulation for all particles, bombs and enemy bullets.
   *
   * Particles: integrate velocity, apply 2 % drag, decrement life.
   * Bombs:     rise at +8 Y/frame; on ground impact infect tiles and spawn pulse ring.
   * Enemy bullets: integrate velocity, expire on terrain/sea contact.
   */
  updatePhysics() {
    // --- Particles ---
    for (let i = this.particles.length - 1; i >= 0; i--) {
      let p = this.particles[i];
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
      p.life -= (p.decay || 10);
      p.vx *= 0.98; p.vy *= 0.98; p.vz *= 0.98;
      if (p.life <= 0) {
        if (p.isFog && this.fogCount > 0) this.fogCount--;
        // Swap-and-pop for O(1) removal (order doesn't matter for particles)
        let last = this.particles.pop();
        if (i < this.particles.length) this.particles[i] = last;
      }
    }

    // --- Bombs ---
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      let b = this.bombs[i];
      b.y += BOMB_FALL_SPEED;  // Bombs fall upward visually (world Y axis is inverted)
      let gy = terrain.getAltitude(b.x, b.z);
      if (b.y > gy) {
        if (b.type === 'mega') {
          // Mega bomb: infect a circular patch of radius 4 tiles
          let tx = toTile(b.x), tz = toTile(b.z);
          let hitLP = false;
          for (let r = -MEGA_BOMB_TILE_RAD; r <= MEGA_BOMB_TILE_RAD; r++) {
            for (let c = -MEGA_BOMB_TILE_RAD; c <= MEGA_BOMB_TILE_RAD; c++) {
              if (r * r + c * c <= MEGA_BOMB_TILE_RAD_SQ) {
                let nx = tx + r, nz = tz + c;
                if (aboveSea(terrain.getAltitude(nx * TILE, nz * TILE))) continue;
                let nk = tileKey(nx, nz);
                if (infection.add(nk)) {
                  if (isLaunchpad(nx * TILE, nz * TILE)) hitLP = true;
                }
              }
            }
          }
          if (hitLP) maybePlayLaunchpadAlarm();
        } else {
          // Normal bomb: infect the single tile recorded when the bomb was spawned
          if (infection.add(b.k)) {
            if (isLaunchpad(b.x, b.z)) {
              maybePlayLaunchpadAlarm();
            }
          }
        }
        terrain.addPulse(b.x, b.z, 0.0);  // Trigger red ground ring
        gameSFX?.playExplosion(b.x, b.y, b.z, b.type === 'mega', b.type === 'mega' ? 'bomber' : 'normal');
        // Swap-and-pop for O(1) removal (order doesn't matter for bombs)
        let lastBomb = this.bombs.pop();
        if (i < this.bombs.length) this.bombs[i] = lastBomb;
      }
    }

    // --- Enemy bullets ---
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      let b = this.enemyBullets[i];
      b.x += b.vx; b.y += b.vy; b.z += b.vz;
      b.life -= 2;
      if (b.life <= 0 || b.y > terrain.getAltitude(b.x, b.z) || b.y > SEA) {
        // Swap-and-pop for O(1) removal (order doesn't matter for enemy bullets)
        let last = this.enemyBullets.pop();
        if (i < this.enemyBullets.length) this.enemyBullets[i] = last;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering (called once per frame per viewport)
  // ---------------------------------------------------------------------------

  /**
   * Renders all visible particles, bombs and enemy bullets.
   * Objects beyond CULL_DIST * 0.6 are skipped to save draw calls.
   *
   * When sceneFBO is provided (WebGL2 path) soft particles (exhaust / squid
   * fog) are drawn as camera-facing billboard planes using the GLSL soft-
   * particle shader, which:
   *   • Gives a billowy diffuse shape via the cloud-gradient sprite (sTexture).
   *   • Fades particles at geometry intersections by comparing their depth
   *     against the pre-particle scene depth stored in sceneFBO.depth.
   *
   * @param {number}         camX     Ship world X — distance-cull centre.
   * @param {number}         camZ     Ship world Z.
   * @param {number}        [camCX]   Camera world X (billboard orientation).
   * @param {number}        [camCY]   Camera world Y.
   * @param {number}        [camCZ]   Camera world Z.
   * @param {number}        [camNear] Camera near clip plane.
   * @param {number}        [camFar]  Camera far clip plane.
   * @param {p5.Framebuffer}[sceneFBO] Pre-particle opaque-scene framebuffer.
   */
  render(camX, camZ, camCX, camCY, camCZ, camNear, camFar, sceneFBO) {
    let cullSq = (CULL_DIST * 0.6) * (CULL_DIST * 0.6);
    let fogCullSq = (CULL_DIST * 0.42) * (CULL_DIST * 0.42);
    const particleLoad = this.particles.length;
    const renderLoadScale = particleLoad > 700 ? 0.65 : (particleLoad > 500 ? 0.8 : 1.0);
    const MAX_FOG_RENDER = Math.floor(140 * renderLoadScale);
    const MAX_THRUST_RENDER = Math.floor(180 * renderLoadScale);
    let fogRendered = 0;
    let thrustRendered = 0;
    let pxD = pixelDensity();

    if (this.particles.length > 0) {
      noLights();  // Particles are emissive — skip directional shading
      noStroke();

      // ── Soft billboard particles: exhaust, squid fog, missile smoke ──────
      const useDepthSoftShader = (_softShader && _cloudTex && sceneFBO);
      // On mobile (TBDR GPU), gl.disable(DEPTH_TEST) triggers a tile-flush
      // barrier that stalls the pipeline for 4–16 ms.  Fall back to plain
      // sphere rendering instead to keep the depth state unchanged.
      const isMobile = gameState.isMobile;
      const useBillowSprites = (!!_cloudTex && !useDepthSoftShader && !isMobile);
      const disableDepthForSoft = useDepthSoftShader || useBillowSprites;
      if (disableDepthForSoft) {
        drawingContext.disable(drawingContext.DEPTH_TEST);
      }
      if (useDepthSoftShader) {
        shader(_softShader);
        _softShader.setUniform('sTexture', _cloudTex);
        _softShader.setUniform('sDepth', sceneFBO.depth);
        _softCameraRangeBuf[0] = camNear; _softCameraRangeBuf[1] = camFar;
        _softShader.setUniform('uCameraRange', _softCameraRangeBuf);
        _softInvViewportBuf[0] = 1 / (width * pxD); _softInvViewportBuf[1] = 1 / (height * pxD);
        _softShader.setUniform('uInvViewportSize', _softInvViewportBuf);
        _softShader.setUniform('uTransitionSize', 0.05);
      }

      // Pre-fetch the GL uniform location for uParticleColor once per render()
      // call so the per-particle hot path can use gl.uniform4f() directly.
      //
      // p5's Shader.setUniform() copies every array/typed-array value via
      // data.slice(0) for its internal change-detection cache, allocating a new
      // object per call regardless of whether the caller passes a fresh literal
      // or a reused Float32Array.  With ~220 visible soft particles per frame
      // that would be 220 allocations/frame just for this uniform.
      //
      // Bypassing setUniform() with a direct gl.uniform4f() call has zero
      // allocation cost — the four floats are passed as scalar arguments.
      // The shader program is already active (shader() was called above), so
      // no useProgram() call is needed.
      let _directColorLoc = null;
      if (useDepthSoftShader && _softShader && _softShader.uniforms) {
        const _uInfo = _softShader.uniforms['uParticleColor'];
        if (_uInfo && _uInfo.location != null) _directColorLoc = _uInfo.location;
      }

      if (useBillowSprites) texture(_cloudTex);

      for (let i = 0; i < this.particles.length; i++) {
        let p = this.particles[i];
        if (p.isExplosion) continue;
        let dxC = p.x - camX;
        let dzC = p.z - camZ;
        let dSq = dxC * dxC + dzC * dzC;
        if (dSq > cullSq) continue;
        if (p.isFog) {
          if (dSq > fogCullSq) continue;
          if (fogRendered >= MAX_FOG_RENDER) continue;
          fogRendered++;
        }
        if (p.isThrust) {
          if (thrustRendered >= MAX_THRUST_RENDER) continue;
          thrustRendered++;
        }

        let lifeNorm = p.life / 255.0;
        let t = 1.0 - lifeNorm;
        let alpha = lifeNorm < 0.4 ? lifeNorm / 0.4 : 1.0;
        if (p.isFog) alpha *= p.isInkBurst ? 1.15 : 0.85;
        if (p.isThrust) alpha *= 0.42;
        if (alpha <= 0.02) continue;

        let [r, g, b] = _calcSoftParticleColor(p, t);

        if (useDepthSoftShader || useBillowSprites) {
          let dx = (camCX ?? p.x) - p.x, dy = (camCY ?? p.y) - p.y, dz = (camCZ ?? (p.z + 1)) - p.z;
          let horiz = Math.hypot(dx, dz);
          if (horiz < 0.0001 && abs(dy) < 0.0001) continue;
          let yaw = atan2(dx, dz), pitch = -atan2(dy, Math.max(horiz, 0.0001));
          let sz = p.size || 8;
          if (p.isThrust) sz *= (1.0 + t * 1.1);
          // Ink bursts bloom significantly over their life to obscure the screen
          if (p.isFog) sz *= (p.isInkBurst ? (1.5 + t * 6.5) : (1.35 + t * 2.3));
          push(); translate(p.x, p.y, p.z); rotateY(yaw); rotateX(pitch);
          if (useDepthSoftShader) {
            // Direct gl.uniform4f — zero allocations vs setUniform's slice(0) copy.
            if (_directColorLoc !== null) {
              drawingContext.uniform4f(_directColorLoc, r / 255, g / 255, b / 255, alpha);
            } else {
              // Fallback if location unavailable (first frame or driver quirk).
              _softShaderColorBuf[0] = r / 255; _softShaderColorBuf[1] = g / 255;
              _softShaderColorBuf[2] = b / 255; _softShaderColorBuf[3] = alpha;
              _softShader.setUniform('uParticleColor', _softShaderColorBuf);
            }
            plane(sz, sz);
          } else {
            tint(r, g, b, alpha * 255); plane(sz, sz);
          }
          pop();
        } else {
          // Fallback path (mobile/non-shader): apply growth to sphere size so ink still blooms
          let sz = (p.size || 8);
          if (p.isFog) sz *= (p.isInkBurst ? (1.5 + t * 6.5) : (1.35 + t * 2.3));
          push(); translate(p.x, p.y, p.z); fill(r, g, b, alpha * 255); sphere(sz / 2, 5, 4); pop();
        }
      }
      if (useBillowSprites) noTint();
      if (useDepthSoftShader) resetShader();
      if (disableDepthForSoft) drawingContext.enable(drawingContext.DEPTH_TEST);

      if (!sceneFBO) this._drawHardGeometry(camCX ?? camX, camCY ?? 0, camCZ ?? camZ, camX, camZ, cullSq);
    } else if (!sceneFBO) {
      this._drawHardGeometry(camCX ?? camX, camCY ?? 0, camCZ ?? camZ, camX, camZ, (CULL_DIST * 0.6) * (CULL_DIST * 0.6));
    }
  }

  /**
   * Render hard-geometry particles (explosions, bombs, enemy bullets) with
   * normal depth testing.
   * @param {number} cx    Camera X for perspective scaling.
   * @param {number} cy    Camera Y for perspective scaling.
   * @param {number} cz    Camera Z for perspective scaling.
   * @param {number} shipX Ship X for distance culling.
   * @param {number} shipZ Ship Z for distance culling.
   */
  renderHardParticles(cx, cy, cz, shipX, shipZ) {
    noLights(); noStroke();
    this._drawHardGeometry(cx, cy, cz, shipX, shipZ, (CULL_DIST * 0.6) * (CULL_DIST * 0.6));
  }

  /** @private Shared draw logic for explosions, bombs, and enemy bullets. */
  _drawHardGeometry(cx, cy, cz, shipX, shipZ, cullSq) {
    noLights(); noStroke();

    // Explosion particles: unlit points (wave-front colour model).
    //
    // Sort into 4 size buckets before rendering to minimise strokeWeight()
    // changes.  Each strokeWeight() call flushes p5's internal point VBO to
    // the GPU, so bucketing reduces draw-calls from ~N/frame down to 4.
    _expBucketCounts[0] = _expBucketCounts[1] = _expBucketCounts[2] = _expBucketCounts[3] = 0;

    for (let p of this.particles) {
      if (!p.isExplosion) continue;
      if ((p.x - shipX) ** 2 + (p.z - shipZ) ** 2 > cullSq) continue;

      let lifeNorm = p.life / 255.0;
      // Fade out over the last 40% of life, and cap maximum alpha for better transparency
      let alpha = lifeNorm < 0.4 ? (lifeNorm / 0.4) * 140 : 140;

      const wave = _EXPLOSION_WAVE_LUT[p.life | 0] || 0;
      const dx = p.x - p.cx, dy = p.y - p.cy, dz = p.z - p.cz;
      if (Math.abs(dx) > wave + 100 || Math.abs(dy) > wave + 100 || Math.abs(dz) > wave + 100) continue;

      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const diff = wave - d;

      let r, g, b;
      if (diff < 40) {
        let f = (diff + 50) / 90;
        r = lerp(255, p.br, f); g = lerp(255, p.bg, f); b = lerp(255, p.bb, f);
      } else if (diff < 150) {
        let f = (diff - 40) / 110;
        r = lerp(p.br, p.er, f); g = lerp(p.bg, p.eg, f); b = lerp(p.bb, p.eb, f);
      } else if (diff < 350) {
        let f = (diff - 150) / 200;
        r = lerp(p.er, p.sr, f); g = lerp(p.eg, p.sg, f); b = lerp(p.eb, p.sb, f);
      } else {
        r = p.sr; g = p.sg; b = p.sb;
      }

      // Perspective-scale point size. Tuning constant (750) and min-distance
      // floor (120) prevents infinite size when the camera is inside the burst.
      const dToCam = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2);
      const screenSz = (p.size || 10) * (750 / Math.max(dToCam, 120));
      // Clamp to [1.5, 64] to respect hardware POINT_SIZE limits.
      const clampedSz = screenSz < 1.5 ? 1.5 : screenSz > 64 ? 64 : screenSz;

      // Bucket index: 0=[1.5,4) 1=[4,16) 2=[16,32) 3=[32,64]
      const bi = clampedSz < 4 ? 0 : clampedSz < 16 ? 1 : clampedSz < 32 ? 2 : 3;
      const cnt = _expBucketCounts[bi];
      if (cnt >= _EXP_BUCKET_MAX) continue; // safety cap
      const off = cnt * 7;
      const buf = _expBucketBufs[bi];
      buf[off]     = p.x;     buf[off + 1] = p.y;     buf[off + 2] = p.z;
      buf[off + 3] = r;       buf[off + 4] = g;       buf[off + 5] = b;
      buf[off + 6] = alpha;
      _expBucketCounts[bi]++;
    }

    // Render each size bucket with a single strokeWeight() — 4 draw calls max.
    for (let bi = 0; bi < 4; bi++) {
      const cnt = _expBucketCounts[bi];
      if (cnt === 0) continue;
      strokeWeight(_EXP_BUCKET_WEIGHTS[bi]);
      const buf = _expBucketBufs[bi];
      for (let i = 0; i < cnt; i++) {
        const off = i * 7;
        stroke(buf[off + 3], buf[off + 4], buf[off + 5], buf[off + 6]);
        point(buf[off], buf[off + 1], buf[off + 2]);
      }
    }
    noStroke();

    // Bombs 
    for (let b of this.bombs) {
      push(); translate(b.x, b.y, b.z); noStroke(); fill(200, 50, 50); box(8, 20, 8); pop();
    }

    // Enemy bullets 
    for (let b of this.enemyBullets) {
      push(); translate(b.x, b.y, b.z); fill(255, 80, 80); sphere(4, 4, 3); pop();
    }
  }
}

const particleSystem = new ParticleSystem();
