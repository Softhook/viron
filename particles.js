// =============================================================================
// particles.js — ParticleSystem class
//
// Owns and updates three types of projectile / effect objects:
//   • particles     — generic VFX: thrust exhaust, missile smoke, explosions
//   • bombs         — infection payloads dropped by enemy aircraft
//   • enemyBullets  — straight-line projectiles fired by fighters and crabs
// =============================================================================

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
let _cloudTex   = null;

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
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Empties all particle, bomb and enemy-bullet arrays. Called at level start. */
  clear() {
    this.particles   = [];
    this.bombs       = [];
    this.enemyBullets = [];
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
    const ctx  = _cloudTex.drawingContext;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,    'rgba(255,255,255,0.90)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    grad.addColorStop(0.70, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1.0,  'rgba(255,255,255,0.00)');
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
    if (typeof gameSFX !== 'undefined') {
      if (type) gameSFX.playExplosion(type === 'bomber' || type === 'mega', type, x, y, z);
      else      gameSFX.playExplosion(baseColor === undefined || baseColor === null, '', x, y, z);
    }

    let isCustom = baseColor !== undefined && baseColor !== null;

    for (let i = 0; i < 350; i++) {
      let speed = random(5.0, 45.0);
      let a1 = random(TWO_PI);
      let a2 = random(TWO_PI);

      // Default fire palette: bright yellow core → orange mid → dark smoke
      let br = 255, bg = 200, bb = 50;
      let er = 200, eg = 30,  eb = 10;
      let sr = 40,  sg = 20,  sb = 20;

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
        er = br * 0.8;       eg = bg * 0.8;       eb = bb * 0.8;
        sr = br * 0.3 + 10;  sg = bg * 0.3 + 10;  sb = bb * 0.3 + 10;
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
        // Swap-and-pop for O(1) removal (order doesn't matter for particles)
        let last = this.particles.pop();
        if (i < this.particles.length) this.particles[i] = last;
      }
    }

    // --- Bombs ---
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      let b = this.bombs[i];
      b.y += 8;  // Bombs fall upward visually (world Y axis is inverted)
      let gy = terrain.getAltitude(b.x, b.z);
      if (b.y > gy) {
        if (b.type === 'mega') {
          // Mega bomb: infect a circular patch of radius 4 tiles
          let tx = toTile(b.x), tz = toTile(b.z);
          let hitLP = false;
          for (let r = -4; r <= 4; r++) {
            for (let c = -4; c <= 4; c++) {
              if (r * r + c * c <= 16) {
                let nx = tx + r, nz = tz + c;
                if (aboveSea(terrain.getAltitude(nx * TILE, nz * TILE))) continue;
                let nk = tileKey(nx, nz);
                if (infection.add(nk)) {
                  if (isLaunchpad(nx * TILE, nz * TILE)) hitLP = true;
                }
              }
            }
          }
          if (hitLP && millis() - lastAlarmTime > 1000) {
            if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
            lastAlarmTime = millis();
          }
        } else {
          // Normal bomb: infect the single tile recorded when the bomb was spawned
          if (infection.add(b.k)) {
            if (isLaunchpad(b.x, b.z)) {
              if (millis() - lastAlarmTime > 1000) {
                if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
                lastAlarmTime = millis();
              }
            }
          }
        }
        terrain.addPulse(b.x, b.z, 0.0);  // Trigger red ground ring
        if (typeof gameSFX !== 'undefined') gameSFX.playExplosion(b.type === 'mega', b.type === 'mega' ? 'bomber' : 'normal', b.x, b.y, b.z);
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
   * Explosion particles are always rendered as unlit spheres.
   * Enemy bullets are rendered as small red spheres.
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
    let pxD    = pixelDensity();

    if (this.particles.length > 0) {
      noLights();  // Particles are emissive — skip directional shading
      noStroke();

      // ── Soft billboard particles: exhaust, squid fog, missile smoke ──────
      // Uses the GLSL soft-particle shader + gradient sprite when the scene
      // depth FBO is available (WebGL2); falls back to unlit spheres otherwise.
      const useSoftShader = (_softShader && _cloudTex && sceneFBO);
      if (useSoftShader) {
        // Soft billboard quads handle depth-fade via the sDepth texture, so
        // disable DEPTH_TEST to prevent stale/blitted depth values from
        // clipping them.  Re-enabled below for hard-geometry particles.
        drawingContext.disable(drawingContext.DEPTH_TEST);
        shader(_softShader);
        _softShader.setUniform('sTexture',         _cloudTex);
        _softShader.setUniform('sDepth',           sceneFBO.depth);
        _softShader.setUniform('uCameraRange',     [camNear, camFar]);
        _softShader.setUniform('uInvViewportSize', [1 / (width * pxD), 1 / (height * pxD)]);
        _softShader.setUniform('uTransitionSize',  0.05);
      }

      for (let p of this.particles) {
        if (p.isExplosion) continue;  // Handled in the explosion loop below
        if ((p.x - camX) ** 2 + (p.z - camZ) ** 2 > cullSq) continue;

        let lifeNorm = p.life / 255.0;
        let t        = 1.0 - lifeNorm;
        // Alpha in [0, 1] — fade in over the first 40 % of lifetime
        let alpha    = lifeNorm < 0.4 ? lifeNorm / 0.4 : 1.0;
        if (p.isFog) alpha *= 0.55;  // Squid ink: gradient sprite already fades edges; 0.55 base keeps cloud visible but translucent

        let r, g, b;
        if (p.color) {
          // Exhaust / powerup sparks: fade from base colour to dark grey
          let f = Math.min(t * 1.5, 1.0);
          r = lerp(p.color[0], 30, f);
          g = lerp(p.color[1], 30, f);
          b = lerp(p.color[2], 30, f);
        } else {
          // Missile smoke: seed-derived hue cycle
          let seed = p.seed || 1.0;
          let kr = (5 + seed * 6) % 6;
          let kg = (3 + seed * 6) % 6;
          let kb = (1 + seed * 6) % 6;
          let vr = 255 * (1 - Math.max(Math.min(kr, 4 - kr, 1), 0));
          let vg = 255 * (1 - Math.max(Math.min(kg, 4 - kg, 1), 0));
          let vb = 255 * (1 - Math.max(Math.min(kb, 4 - kb, 1), 0));
          if (t < 0.15) {
            let f = t / 0.15;
            r = lerp(255, vr, f); g = lerp(255, vg, f); b = lerp(255, vb, f);
          } else if (t < 0.6) {
            let f = (t - 0.15) / 0.45;
            r = lerp(vr, vr * 0.4, f); g = lerp(vg, vg * 0.4, f); b = lerp(vb, vb * 0.4, f);
          } else {
            let f = (t - 0.6) / 0.4;
            r = lerp(vr * 0.4, 15, f); g = lerp(vg * 0.4, 15, f); b = lerp(vb * 0.4, 15, f);
          }
        }

        if (useSoftShader) {
          // Billboard: rotate the plane so its face points toward the camera.
          // forward = normalize(camera − particle)
          let fx = camCX - p.x, fy = camCY - p.y, fz = camCZ - p.z;
          let dist = Math.hypot(fx, fy, fz);
          if (dist < 0.001) continue;
          fx /= dist; fy /= dist; fz /= dist;
          // right = cross(worldUp=(0,1,0), forward)  [ry = 0]
          let rx = fz, rz = -fx;
          let rLen = Math.hypot(rx, rz);
          if (rLen > 0.001) { rx /= rLen; rz /= rLen; } else { rx = 1; rz = 0; }
          // up = cross(forward, right)
          let ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;

          _softShader.setUniform('uParticleColor', [r / 255, g / 255, b / 255, alpha]);
          let sz = p.size || 8;
          push();
          translate(p.x, p.y, p.z);
          // applyMatrix is column-major: each group of 4 is one column.
          // Column 0 = right, column 1 = up, column 2 = forward (toward camera).
          applyMatrix(rx, 0,  rz, 0,
                      ux, uy, uz, 0,
                      fx, fy, fz, 0,
                       0,  0,  0, 1);
          plane(sz, sz);
          pop();
        } else {
          // Fallback: unlit sphere when soft shader is unavailable
          push();
          translate(p.x, p.y, p.z);
          fill(r, g, b, alpha * 255);
          sphere((p.size || 8) / 2);
          pop();
        }
      }

      if (useSoftShader) {
        resetShader();
        // Restore depth test for any rendering that follows in the same pass.
        drawingContext.enable(drawingContext.DEPTH_TEST);
      }

      // In the WebGL2 3-pass path (sceneFBO provided), hard particles are
      // rendered inside Pass 1 (renderHardParticles) so they depth-test
      // correctly against the opaque scene.  Skip them here to avoid
      // double-drawing and so the blit in Pass 2 can stay COLOR-only.
      if (!sceneFBO) this._drawHardGeometry(camX, camZ, cullSq);
    } else if (!sceneFBO) {
      // No soft particles but still need bombs / bullets in fallback path.
      this._drawHardGeometry(camX, camZ, (CULL_DIST * 0.6) * (CULL_DIST * 0.6));
    }
  }

  /**
   * Render hard-geometry particles (explosions, bombs, enemy bullets) with
   * normal depth testing.  Called inside Pass 1 (sceneFBO) in the WebGL2
   * path so they occlude correctly against the opaque scene and are captured
   * in the depth texture used by the soft-billboard shader.
   * @param {number} camX  Camera X (world) for culling.
   * @param {number} camZ  Camera Z (world) for culling.
   */
  renderHardParticles(camX, camZ) {
    noLights(); noStroke();
    this._drawHardGeometry(camX, camZ, (CULL_DIST * 0.6) * (CULL_DIST * 0.6));
  }

  /** @private Shared draw logic for explosions, bombs, and enemy bullets. */
  _drawHardGeometry(camX, camZ, cullSq) {
    noLights(); noStroke();

    // Explosion particles: unlit spheres (wave-front colour model)
    for (let p of this.particles) {
      if (!p.isExplosion) continue;
      if ((p.x - camX) ** 2 + (p.z - camZ) ** 2 > cullSq) continue;

      let lifeNorm = p.life / 255.0;
      let t        = 1.0 - lifeNorm;
      let alpha    = lifeNorm < 0.4 ? (lifeNorm / 0.4) * 255 : 255;

      let d    = Math.hypot(p.x - p.cx, p.y - p.cy, p.z - p.cz);
      let wave = 1400.0 * Math.pow(t, 0.6);
      let diff = wave - d;
      if (diff < -50) continue;  // Behind wave front — skip

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

      push();
      translate(p.x, p.y, p.z);
      fill(r, g, b, alpha);
      sphere((p.size || 8) / 2);
      pop();
    }

    // Bombs — narrow red-dark cuboids (falling capsules)
    for (let b of this.bombs) {
      push(); translate(b.x, b.y, b.z); noStroke(); fill(200, 50, 50); box(8, 20, 8); pop();
    }

    // Enemy bullets — red spheres
    noLights(); noStroke();
    for (let b of this.enemyBullets) {
      push(); translate(b.x, b.y, b.z); fill(255, 80, 80); sphere(3); pop();
    }
  }
}

// Singleton instance used by all other modules
const particleSystem = new ParticleSystem();
