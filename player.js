// =============================================================================
// player.js — Player / ship functions
//
// Covers the full lifecycle of a player-controlled ship:
//   • createPlayer / resetShip     — construction and respawn
//   • updateShipInput              — keyboard, mouse and mobile control integration
//   • updateProjectilePhysics      — bullet and homing-missile simulation
//   • shipDisplay / drawShipShadow — 3D rendering
//   • killPlayer                   — death handling (explosion, pulse, respawn timer)
//   • fireMissile                  — missile launch
//   • renderProjectiles            — draws bullets and missiles for one player
// =============================================================================

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

/** Fallback ship-design object used when the player's designIndex has no entry in SHIP_DESIGNS. */
const DEFAULT_SHIP_DESIGN = { turnRate: YAW_RATE, pitchRate: PITCH_RATE, thrust: 0.45, mass: 1.0 };

/**
 * Returns the world-space X spawn position for a given player.
 * In single-player mode both players share the centre (420); in two-player
 * mode they are offset to avoid spawning inside each other.
 * @param {object} p  Player object (uses p.id).
 * @returns {number}  World-space X offset for the launchpad position.
 */
function getSpawnX(p) {
  return gameState.numPlayers === 1 ? 420 : (p.id === 0 ? 320 : 520);
}

/**
 * Resets a player's ship state to the launchpad at the given X offset.
 * Called on game start and on respawn.
 * @param {object} p        Player object (ship state is written to p.ship).
 * @param {number} offsetX  World-space X of the spawn position.
 */
function resetShip(p, offsetX) {
  p.ship = { x: offsetX, y: LAUNCH_ALT, z: 420, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 };
  let d = SHIP_DESIGNS[p.designIndex || 0];
  if (d) {
    p.missilesRemaining = d.startingMissiles ?? d.missileCapacity ?? 1;
  } else {
    p.missilesRemaining = 1;
  }
  p.normalShotMode = 'single';
  p.weaponMode = 0; // Reset to NORMAL weapon mode
}

/**
 * Constructs a new player object with default state and an initial ship.
 * @param {number}   id          Player index (0 or 1).
 * @param {object}   keys        Key-binding object from constants.js (P1_KEYS or P2_KEYS).
 * @param {number}   offsetX     World-space X spawn offset.
 * @param {number[]} labelColor  RGB colour used for HUD text and bullet colour.
 * @returns {object}  Fully initialised player state object.
 */
function createPlayer(id, keys, offsetX, labelColor) {
  let p = {
    id, keys, labelColor,
    score: 0,
    dead: false,
    respawnTimer: 0,
    bullets: [],
    homingMissiles: [],
    tankShells: [],
    missilesRemaining: 1,
    normalShotMode: 'single',     // single|double|triple|spread (from powerup upgrades)
    weaponMode: 0,                // 0=NORMAL, 1=MISSILE, 2=BARRIER (index into WEAPON_MODES)
    shootHeld: false,             // Edge-detect for shoot key (prevents missile/barrier auto-repeat)
    aimTarget: null,              // Per-player locked ENEMY target for missile homing (never a virus tile)
    mobileMissilePressed: false,  // Tracks the mobile missile button edge so it fires once per tap
    lpDeaths: 0,                  // Tracks consecutive deaths on an occupied launchpad
    designIndex: 0,               // Current ship visual design index
    ready: false                  // Selection status for ship-select screen
  };
  resetShip(p, offsetX);
  return p;
}

// ---------------------------------------------------------------------------
// Projectile factory
// ---------------------------------------------------------------------------

/**
 * Returns the forward unit vector and trig components for pitch/yaw angles.
 * Used to compute both projectile velocities and barrel-offset world positions.
 * @param {number} pitch  Pitch angle (radians).
 * @param {number} yaw    Yaw angle (radians).
 * @returns {{fx,fy,fz,cp,sp,cy,sy}}
 */
function _calcForwardDir(pitch, yaw) {
  const cp = cos(pitch), sp = sin(pitch);
  const cy = cos(yaw), sy = sin(yaw);
  return { fx: -cp * sy, fy: sp, fz: -cp * cy, cp, sp, cy, sy };
}

/**
 * Converts a local barrel offset (lz forward, ly up) into a world-space
 * displacement, given the pre-computed trig components from _calcForwardDir.
 * @param {number} lz  Local z offset (negative = forward in model space).
 * @param {number} ly  Local y offset (negative = upward in world space).
 * @param {number} cp  cos(pitch).
 * @param {number} sp  sin(pitch).
 * @param {number} cy  cos(yaw).
 * @param {number} sy  sin(yaw).
 * @returns {{dx,dy,dz}}  World-space displacement to add to the ship position.
 */
function _calcBarrelOffset(lz, ly, cp, sp, cy, sy) {
  const y1 = ly * cp - lz * sp;
  const z1 = ly * sp + lz * cp;
  return { dx: z1 * sy, dy: y1, dz: z1 * cy };
}

/**
 * Calculates the initial position and velocity for a projectile fired from
 * the given ship state.  The spawn point is offset 30 units in front of and
 * 10 units below the ship nose so the projectile starts at the gun barrel.
 *
 * @param {{x,y,z,vx,vy,vz,pitch,yaw}} s  Ship state.
 * @param {number} power  Initial forward speed added to the ship's velocity.
 * @param {number} life   Lifetime counter (decremented each frame).
 * @returns {{x,y,z,vx,vy,vz,life}}  Projectile state object.
 */
function spawnProjectile(s, power, life) {
  const { fx, fy, fz, cp, sp, cy, sy } = _calcForwardDir(s.pitch, s.yaw);

  // Barrel offset: 30 units forward. Ground vehicles have guns on top (negative ly),
  // while aircraft typically have them slightly below center (positive ly).
  // Ship objects don't carry a designIdx; use terrain proximity as a heuristic
  // for ground-vehicle detection instead (Ironclad Tank uses fireTankShell, so
  // only Jeep and Hovercraft reach this path).
  let lz = -30, ly = 10;
  if (terrain && s.y > terrain.getAltitude(s.x, s.z) - 30) {
    ly = -14; // Spawn from the top for ground vehicles
    lz = -40; // And a bit further forward
  }

  const { dx, dy, dz } = _calcBarrelOffset(lz, ly, cp, sp, cy, sy);

  return {
    x: s.x + dx, y: s.y + dy, z: s.z + dz,
    vx: fx * power + s.vx,
    vy: fy * power + s.vy,
    vz: fz * power + s.vz,
    life
  };
}

/**
 * Spawns a projectile from a temporary yaw/pitch offset relative to the ship.
 * Used for multi-shot upgrades (double/triple/spread) without changing ship state.
 */
function spawnProjectileOffset(s, power, life, yawOffset, pitchOffset = 0) {
  return spawnProjectile({
    x: s.x, y: s.y, z: s.z,
    vx: s.vx, vy: s.vy, vz: s.vz,
    pitch: s.pitch + pitchOffset,
    yaw: s.yaw + yawOffset
  }, power, life);
}

/**
 * Fires the player's normal weapon pattern.
 * Pattern is controlled by p.normalShotMode and can be upgraded by powerups.
 */
function fireNormalPattern(p, s) {
  const ship = s || p.ship;
  const mode = p.normalShotMode || 'single';
  const power = 25;
  const life = 1000;

  if (mode === 'double') {
    p.bullets.push(spawnProjectileOffset(ship, power, life, -0.055));
    p.bullets.push(spawnProjectileOffset(ship, power, life, 0.055));
  } else if (mode === 'triple') {
    p.bullets.push(spawnProjectileOffset(ship, power, life, -0.08));
    p.bullets.push(spawnProjectile(ship, power, life));
    p.bullets.push(spawnProjectileOffset(ship, power, life, 0.08));
  } else if (mode === 'spread') {
    p.bullets.push(spawnProjectileOffset(ship, power, life, -0.05 + random(-0.03, 0.03)));
    p.bullets.push(spawnProjectileOffset(ship, power, life, random(-0.025, 0.025)));
    p.bullets.push(spawnProjectileOffset(ship, power, life, 0.05 + random(-0.03, 0.03)));
  } else {
    p.bullets.push(spawnProjectile(ship, power, life));
  }

  gameSFX?.playShot(ship.x, ship.y, ship.z);
}

/**
 * Fires a heavy tank shell that follows a parabolic trajectory and explodes on
 * impact with the ground, clearing a large area.
 */
function fireTankShell(p) {
  const power = 19; // Increased from 16 for longer range
  const life = 240; // Increased from 180 for longer flight time

  // Give the shell a slight upward kick so it always arcs even at flat aim
  const turretPitchOffset = -0.15;

  const s = p.ship;
  const { fx, fy, fz, cp, sp, cy, sy } = _calcForwardDir(s.pitch + turretPitchOffset, s.yaw);
  // Turret barrel: 45 units forward, 20 units UP from centre
  const { dx, dy, dz } = _calcBarrelOffset(-45, -20, cp, sp, cy, sy);

  p.tankShells.push({
    x: s.x + dx, y: s.y + dy, z: s.z + dz,
    vx: fx * power + s.vx,
    vy: fy * power + s.vy,
    vz: fz * power + s.vz,
    life
  });

  gameSFX?.playShot(s.x, s.y, s.z);
  gameSFX?.playMissileFire(s.x, s.y, s.z);
}

/**
 * Fires a homing missile from the player's ship if missiles are available.
 * Decrements missilesRemaining, pushes the missile into homingMissiles[], and
 * plays a launch sound effect.
 * @param {object} p  Player state object.
 */
function fireMissile(p) {
  if (p.missilesRemaining > 0 && !p.dead) {
    p.missilesRemaining--;
    p.homingMissiles.push(spawnProjectile(p.ship, 8, 500));
    gameSFX?.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
  }
}

/**
 * Fires a barrier projectile from the player's ship.  The barrier travels
 * forward, is affected by gravity, and embeds itself in the ground on landing.
 * Once landed it acts as a permanent wall segment for this level.
 * @param {object} p  Player state object.
 */
function fireBarrier(p) {
  if (p.dead) return;
  gameState.inFlightBarriers.push(spawnProjectile(p.ship, 14, 300));
  gameSFX?.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
}

/**
 * Fires the player's currently selected weapon:
 *   NORMAL (0) — fires a single bullet burst
 *   MISSILE (1) — launches a homing missile
 *   BARRIER (2) — places a barrier projectile
 * @param {object} p  Player state object.
 */
function fireActiveWeapon(p) {
  if (p.dead) return;
  let mode = p.weaponMode;
  if (mode === 1) fireMissile(p);
  else if (mode === 2) fireBarrier(p);
  else {
    // NORMAL: fires based on the currently active upgrade shot pattern
    // or the ship's specific weapon type.
    let d = SHIP_DESIGNS[p.designIndex];
    if (d && d.shotType === 'tank_shell') {
      fireTankShell(p);
    } else {
      fireNormalPattern(p, p.ship);
    }
  }
}

// ---------------------------------------------------------------------------
// Ship geometry helpers
// ---------------------------------------------------------------------------



/**
 * Draws a soft semi-transparent ellipse shadow directly on the ground below
 * any object.  Skipped when the ground is below sea level (shadow would be
 * invisible under water).
 * @param {number} x       World X of the object.
 * @param {number} groundY World Y of the ground directly below the object.
 * @param {number} z       World Z of the object.
 * @param {number} w       Shadow ellipse width.
 * @param {number} h       Shadow ellipse height.
 * @param {number} casterH Approximate caster height used to project shadow offset.
 */
const _fallbackSunBasis = (() => {
  const sunY = Math.max(SUN_DIR_MIN_Y, SUN_DIR_NY);
  return { x: SUN_DIR_NX, y: sunY, z: SUN_DIR_NZ };
})();

function _shadowSunBasis() {
  // Share the same cached, normalized sun basis used by terrain shadows so
  // player/enemy shadows align perfectly and avoid per-draw hypot cost.
  if (terrain && typeof terrain._getSunShadowBasis === 'function') {
    return terrain._getSunShadowBasis();
  }
  if (terrain && terrain._sunShadowBasis) return terrain._sunShadowBasis;
  return _fallbackSunBasis;
}

function _shadowHull2D(points) {
  if (points.length <= 2) return points.slice();
  if (terrain && typeof terrain._shadowHullXZ === 'function') {
    return terrain._shadowHullXZ(points);
  }
  const pts = points.map(p => ({ x: p.x, z: p.z })).sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
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

function _drawProjectedShadowFromFootprint(x, groundY, z, localPts, casterH, yaw = 0, alpha = 50) {
  if (aboveSea(groundY)) return;
  const sun = _shadowSunBasis();
  const getShadowShift = (h) => {
    if (terrain && typeof terrain._shadowShift === 'function') return terrain._shadowShift(h, sun);
    return shadowShift(h, sun);
  };
  const getOpacityFactor = (h) => {
    if (terrain && typeof terrain._shadowOpacityFactor === 'function') return terrain._shadowOpacityFactor(h);
    return shadowOpacityFactor(h);
  };
  const useTerrainShadow = terrain && typeof terrain._drawProjectedFootprintShadow === 'function';
  if (useTerrainShadow) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rotated = localPts.map(p => ({
      x: p.x * cy + p.z * sy,
      z: -p.x * sy + p.z * cy
    }));
    terrain._drawProjectedFootprintShadow(x, z, groundY, casterH, rotated, alpha, sun, true);
    return;
  }

  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rotated = localPts.map(p => ({
    x: p.x * cy + p.z * sy,
    z: -p.x * sy + p.z * cy
  }));

  const shift = getShadowShift(casterH);
  const top = rotated.map(p => ({ x: x + p.x + sun.x * shift, z: z + p.z + sun.z * shift }));
  const hull = _shadowHull2D(top);
  if (hull.length < 3) return;

  noStroke();
  // Pure black shadow with alpha is most consistent for darkening background terrain.
  fill(0, 0, 0, alpha * getOpacityFactor(casterH));

  _beginShadowStencil();
  beginShape();
  for (const p of hull) {
    vertex(p.x, terrain.getAltitude(p.x, p.z) - 0.7, p.z);
  }
  endShape(CLOSE);
  _endShadowStencil();
}

function drawShadow(x, groundY, z, w, h, casterH = 80, yaw = 0) {
  const hw = w * 0.5, hh = h * 0.5;
  const rectPts = [
    { x: -hw, z: -hh },
    { x: hw, z: -hh },
    { x: hw, z: hh },
    { x: -hw, z: hh }
  ];
  _drawProjectedShadowFromFootprint(x, groundY, z, rectPts, casterH, yaw, 80);
}

/**
 * Draws the perspective-correct triangular ground shadow for the player's ship.
 * The shadow spreads outward and fades as altitude increases.
 * @param {number} x       Ship world X.
 * @param {number} groundY Ground altitude below the ship.
 * @param {number} z       Ship world Z.
 * @param {number} yaw     Ship yaw (used to orient the shadow).
 * @param {number} alt     Ship current altitude Y.
 */
function drawShipShadow(x, groundY, z, yaw, alt, designIdx = 0) {
  // Ground altitude is authoritative for projection; recompute if available to avoid
  // shadows sticking directly below the ship when caller passes an imprecise value.
  const gy = (terrain && typeof terrain.getAltitude === 'function') ? terrain.getAltitude(x, z) : groundY;
  if (aboveSea(gy)) return;
  // WEBGL Y axis is inverted: larger Y values are deeper. Height above ground is (groundY - alt).
  // Player ship physics keeps the hull center at (terrainY - 12) when grounded.
  // Remove this built-in ride clearance from shadow projection so shadows sit under
  // both aircraft and ground vehicles instead of appearing laterally detached.
  const groundClearance = 12;
  const rawShadowHeight = max(0, gy - alt - groundClearance);
  const shadowHeight = max(rawShadowHeight, 0.08);
  const alpha = map(rawShadowHeight, 0, 600, 95, 40, true);

  let shipFootprint = [
    { x: -13, z: 13 },
    { x: 13, z: 13 },
    { x: 0, z: -23 }
  ];
  if (SHIP_DESIGNS?.[designIdx]?.footprint) {
    shipFootprint = SHIP_DESIGNS[designIdx].footprint;
  }

  _drawProjectedShadowFromFootprint(x, gy, z, shipFootprint, shadowHeight, yaw, alpha);
}

// ---------------------------------------------------------------------------
// Ship rendering
// ---------------------------------------------------------------------------

/**
 * Renders the player's ship as four coloured triangular faces forming a low-poly
 * tetrahedron.  The tintColor parameter blends each face toward the player's
 * label colour so P1 (blue) and P2 (orange) are visually distinct.
 *
 * The terrain shader is applied before rendering the faces (so the ship picks up
 * pulse ring effects) and then reset afterward so subsequent objects use normal
 * lighting.
 *
 * @param {{x,y,z,pitch,yaw}} s    Ship state.
 * @param {number[]}          tintColor  RGB player colour [r, g, b].
 */
function shipDisplay(s, tintColor) {
  terrain.applyShader();
  noStroke();

  let cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);

  // Find the player to get their design index and input state
  let p = gameState.players.find(player => player.labelColor === tintColor);
  let designIdx = p ? (p.designIndex || 0) : 0;
  const isGround = SHIP_DESIGNS[designIdx] && SHIP_DESIGNS[designIdx].isGroundVehicle;

  // Ground vehicles stay flat against the horizon (body pitch = 0)
  // while their guns/aim can tilt.
  let bodyPitch = isGround ? 0 : s.pitch;
  let cx = Math.cos(bodyPitch), sx = Math.sin(bodyPitch);

  // Aim transform used for rotating turrets/guns independently
  let acx = Math.cos(s.pitch), asx = Math.sin(s.pitch);

  // Transform a local-space point through pitch then yaw and offset to world space
  let transform = (pt) => {
    let x = pt[0], y = pt[1], z = pt[2];
    let y1 = y * cx - z * sx;
    let z1 = y * sx + z * cx;
    let x2 = x * cy + z1 * sy;
    let z2 = -x * sy + z1 * cy;
    return [x2 + s.x, y1 + s.y, z2 + s.z];
  };

  let aimTransform = (pt) => {
    let x = pt[0], y = pt[1], z = pt[2];
    let y1 = y * acx - z * asx;
    let z1 = y * asx + z * acx;
    let x2 = x * cy + z1 * sy;
    let z2 = -x * sy + z1 * cy;
    return [x2 + s.x, y1 + s.y, z2 + s.z];
  };

  let r = tintColor[0], g = tintColor[1], b = tintColor[2];
  let dark = [r * 0.4, g * 0.4, b * 0.4];
  let light = [lerp(r, 255, 0.4), lerp(g, 255, 0.4), lerp(b, 255, 0.4)];
  let engineGray = [80, 80, 85];

  const drawFace = (pts, col, xform) => {
    const activeTransform = xform || transform;
    if (pts.length >= 3) {
      // Calculate world-space normal for the face
      let p0 = activeTransform(pts[0]), p1 = activeTransform(pts[1]), p2 = activeTransform(pts[2]);
      let v1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      let v2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      let nx = v1[1] * v2[2] - v1[2] * v2[1];
      let ny = v1[2] * v2[0] - v1[0] * v2[2];
      let nz = v1[0] * v2[1] - v1[1] * v2[0];
      let mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (mag > 0) {
        // The drawFace pts are pre-transformed to world space via activeTransform().
        // Cross product v1 × v2 gives the face normal; we always pass it as-is.
        // For the ship geometry in shipDesigns.js, triangles are consistently wound
        // CCW when viewed from outside, so this gives an outward-pointing normal.
        normal(nx / mag, ny / mag, nz / mag);
      }
    }

    fill(col[0], col[1], col[2], col[3] || 255);
    beginShape();
    for (let p of pts) {
      let t = activeTransform(p);
      vertex(t[0], t[1], t[2]);
    }
    endShape(CLOSE);
  };

  let isPushing = false;
  if (p) {
    isPushing = keyIsDown(p.keys.thrust) || (p.id === 0 && !gameState.isMobile && gameState.rightMouseDown);
    if (gameState.isMobile && p.id === 0 && mobileController) {
      isPushing = isPushing || mobileController.getInputs(s, [], 0, 0).thrust;
    }
  }

  let flamePoints = [], thrustAngle = 0;
  if (SHIP_DESIGNS[designIdx]) {
    thrustAngle = SHIP_DESIGNS[designIdx].thrustAngle || 0;
    flamePoints = SHIP_DESIGNS[designIdx].draw(drawFace, tintColor, engineGray, light, dark, isPushing, s, transform, aimTransform);
  }

  // Reset material state to avoid specular leakage into subsequent draws (like shadows)
  specularMaterial(0);
  shininess(0);

  resetShader();
  setSceneLighting();

  // --- Afterburner / Thrust Flames (Skipped for ground vehicles) ---
  if (p && !isGround) {
    const drawThrustFlame = (flamePt) => {
      push();
      // Add a dedicated light from the camera's perspective to illuminate the back of the thrust cone
      // This ensures the specular highlight actually catches the geometry instead of being in shadow
      directionalLight(255, 255, 255, 0, 0, -1);

      // 1. Move to engine nozzle in world space
      let t = transform([flamePt.x, flamePt.y, flamePt.z]);
      translate(t[0], t[1], t[2]);

      // 2. Orient to match ship + design's thrust offset
      rotateY(s.yaw);
      rotateX(s.pitch + thrustAngle);

      let flicker = 1.0 + Math.sin(frameCount * 0.8) * 0.15;
      let power = isPushing ? 1.0 : 0.3;
      noStroke();

      // Cone 1: Hot Core
      // p5 cone is centered; shift it down by half-height to anchor apex at nozzle
      let h1 = 15 * power * flicker;
      push();
      translate(0, h1 / 2, 0);
      specularMaterial(255);
      shininess(60);
      fill(isPushing ? 200 : 80, 230, 255, isPushing ? 255 : 180);
      cone(4 * power * flicker, h1, 8);
      pop();

      // Cone 2: Middle Flame
      let h2 = 30 * power * flicker;
      push();
      translate(0, h2 / 2 + 5 * power, 0); // Start slightly further out
      specularMaterial(255);
      shininess(40);
      fill(50, 150, 255, isPushing ? 200 : 80);
      cone(7 * power * flicker, h2, 8);
      pop();

      if (isPushing) {
        // Outer Exhaust Glow
        let h3 = 50 * flicker;
        push();
        translate(0, h3 / 2 + 15, 0);
        fill(255, 100, 0, 120);
        cone(12 * flicker, h3, 6);
        pop();

        // Engine Glow Point (small highlight at nozzle)
        specularMaterial(255);
        fill(255, 255, 255);
        sphere(3);
      }
      pop();
    };

    if (Array.isArray(flamePoints)) {
      flamePoints.forEach(fp => drawThrustFlame(fp));
    }
  }

  resetShader();
  setSceneLighting();

  let gy = terrain.getAltitude(s.x, s.z);
  drawShipShadow(s.x, gy, s.z, s.yaw, s.y, designIdx);
}

// ---------------------------------------------------------------------------
// Input and physics update — helper functions
// ---------------------------------------------------------------------------

/**
 * Applies mouse-look steering and aim assist for player 1 (pointer-lock path).
 * Mutates p.ship.yaw, p.ship.pitch and p.aimTarget.
 * @param {object} p  Player state.
 */
function _applyMouseSteering(p) {
  if (p.id !== 0 || gameState.isMobile || !document.pointerLockElement) return;

  gameState.smoothedMX = lerp(gameState.smoothedMX, movedX, MOUSE_SMOOTHING);
  gameState.smoothedMY = lerp(gameState.smoothedMY, movedY, MOUSE_SMOOTHING);

  let newYaw = p.ship.yaw - gameState.smoothedMX * MOUSE_SENSITIVITY;
  // Pitch polarity: behind-ship → mouse-down = nose up; first-person → nose down.
  let pitchSign = gameState.firstPersonView ? 1 : -1;
  let newPitch = p.ship.pitch + pitchSign * gameState.smoothedMY * MOUSE_SENSITIVITY;

  if (aimAssist.enabled) {
    let assist = aimAssist.getAssistDeltas(p.ship, enemyManager.enemies, false);
    newYaw += assist.yawDelta;
    newPitch += assist.pitchDelta;
    // Only an enemy lock sets aimTarget — virus-tile assist steers the nose only
    p.aimTarget = aimAssist.lastTracking.target;
  }
  p.ship.yaw = newYaw;
  p.ship.pitch = constrain(newPitch, -PI / 2.2, PI / 2.2);
}

/**
 * Merges mobile joystick / button state into the running isThrusting / isShooting
 * flags, fires one-shot weapons (missiles, barrier), and applies aim-assist deltas
 * from the mobile path.
 * @param {object}  p           Player state.
 * @param {boolean} isThrusting Current thrust state from keyboard/mouse.
 * @param {boolean} isShooting  Current shoot state from keyboard/mouse.
 * @returns {{isThrusting: boolean, isShooting: boolean}}  Updated flags.
 */
function _applyMobileInputs(p, isThrusting, isShooting) {
  if (!gameState.isMobile || p.id !== 0 || !mobileController) {
    return { isThrusting, isShooting };
  }

  let inputs = mobileController.getInputs(p.ship, enemyManager.enemies, YAW_RATE, PITCH_RATE);
  isThrusting = isThrusting || inputs.thrust;
  isShooting = isShooting || inputs.shoot;

  // Edge-detect missile button (fires once per tap)
  if (inputs.missile && !p.mobileMissilePressed) {
    fireMissile(p);
    p.mobileMissilePressed = true;
  } else if (!inputs.missile) {
    p.mobileMissilePressed = false;
  }

  // Barrier fires continuously while held (same 8-tick cadence as normal bullets)
  if (inputs.barrier && _simTick % 8 === 0) fireBarrier(p);

  p.ship.yaw += inputs.yawDelta + inputs.assistYaw;
  p.ship.pitch = constrain(p.ship.pitch + inputs.pitchDelta + inputs.assistPitch, -PI / 2.2, PI / 2.2);
  p.aimTarget = aimAssist.lastTracking.target;

  return { isThrusting, isShooting };
}

/**
 * Applies keyboard turn / pitch inputs and aim assist for non-mouse players.
 * Mutates p.ship.yaw, p.ship.pitch and p.aimTarget.
 * @param {object} p  Player state.
 * @param {object} d  Ship design object (provides turnRate, pitchRate, mass).
 */
function _applyKeyboardSteering(p, d) {
  let m = d.mass || 1.0;
  let currentYawRate = (d.turnRate || YAW_RATE) / m;
  let currentPitchRate = (d.pitchRate || PITCH_RATE) / m;
  let k = p.keys;

  if (keyIsDown(k.left)) p.ship.yaw += currentYawRate;
  if (keyIsDown(k.right)) p.ship.yaw -= currentYawRate;
  // Keyboard pitch: pitchUp always adds, pitchDown always subtracts (camera-independent).
  if (keyIsDown(k.pitchUp)) p.ship.pitch = constrain(p.ship.pitch + currentPitchRate, -PI / 2.2, PI / 2.2);
  if (keyIsDown(k.pitchDown)) p.ship.pitch = constrain(p.ship.pitch - currentPitchRate, -PI / 2.2, PI / 2.2);

  // Aim assist for keyboard players (P2 always; P1 when not using mouse pointer-lock).
  const isKeyboardPlayer = !(p.id === 0 && document.pointerLockElement);
  if (!gameState.isMobile && aimAssist.enabled && isKeyboardPlayer) {
    let kAssist = aimAssist.getAssistDeltas(p.ship, enemyManager.enemies, false);
    p.ship.yaw += kAssist.yawDelta;
    p.ship.pitch = constrain(p.ship.pitch + kAssist.pitchDelta, -PI / 2.2, PI / 2.2);
    p.aimTarget = aimAssist.lastTracking.target;
  }
}



/**
 * Fires the player's currently selected weapon based on the shoot input state.
 * Handles rate-limiting, edge-detection, and mode-specific weapon logic.
 * @param {object}  p          Player state.
 * @param {boolean} isShooting Whether the shoot input is active this frame.
 */
function _handleWeaponFire(p, isShooting) {
  let s = p.ship;
  // Safety cooldown: ignore shooting inputs for 500ms after entering PLAYING mode
  // to avoid "bleeding" touch events from the confirm button.
  if (gameState.mode === 'playing') {
    if (millis() - gameState.playingStartTime < 500) return;
  }

  if (p.weaponMode === 0) {
    // NORMAL: rate-limited burst fire; tank shells slower than standard bullets
    if (isShooting) {
      let des = SHIP_DESIGNS[p.designIndex];
      let isTank = (des && des.shotType === 'tank_shell');
      let rate = isTank ? 15 : 8;
      if (_simTick % rate === 0) {
        if (isTank) fireTankShell(p);
        else fireNormalPattern(p, s);
      }
    }
    p.shootHeld = isShooting;
  } else if (p.weaponMode === 1) {
    // MISSILE: edge-detect — fires once per press
    if (isShooting && !p.shootHeld) fireMissile(p);
    p.shootHeld = isShooting;
  } else if (p.weaponMode === 2) {
    // BARRIER: auto-repeat at the same 8-tick cadence as normal bullets
    if (isShooting && _simTick % 8 === 0) fireBarrier(p);
    // Track shootHeld so switching modes resets missile edge-detection
    p.shootHeld = isShooting;
  }
}

// ---------------------------------------------------------------------------
// Input and physics update
// ---------------------------------------------------------------------------

/**
 * Processes all input sources (keyboard, mouse, mobile joystick) and integrates
 * the ship's physics for one frame.
 *
 * Physics model:
 *   1. Gravity applied to vy each tick (GRAV = 0.09).
 *   2. Thrust adds force along the ship's up vector when W/RMB is held.
 *   3. Braking multiplies all velocity components by 0.96.
 *   4. Global drag: velocity × 0.985 every tick.
 *   5. Collision with the ground: land softly if approach speed < 2.8 units/tick,
 *      kill the player on hard impact.
 *   6. Collision with the sea: instant kill.
 *
 * Thrust particles (orange exhaust) are emitted every other frame when thrusting.
 *
 * @param {object} p  Player state object (mutated in place).
 */
function updateShipInput(p) {
  if (p.dead || gameState.mode === 'gameover') return;

  // Reset each frame so stale enemy references never persist across frames.
  p.aimTarget = null;

  const d = SHIP_DESIGNS[p.designIndex] || DEFAULT_SHIP_DESIGN;

  _applyMouseSteering(p);

  let k = p.keys;
  // Track mouse release so clicking to enter pointer-lock doesn't accidentally fire.
  if (!gameState.leftMouseDown) gameState.mouseReleasedSinceStart = true;

  let isThrusting = keyIsDown(k.thrust) || (p.id === 0 && !gameState.isMobile && gameState.rightMouseDown);
  let isBraking = keyIsDown(k.brake);
  let isShooting = keyIsDown(k.shoot) || (p.id === 0 && !gameState.isMobile && gameState.leftMouseDown && gameState.mouseReleasedSinceStart);

  ({ isThrusting, isShooting } = _applyMobileInputs(p, isThrusting, isShooting));
  _applyKeyboardSteering(p, d);

  // Physics: ground vehicles and aircraft use separate models
  if (d.isGroundVehicle) {
    if (_updateGroundVehicle(p, d, isThrusting, isBraking)) return;
  } else {
    if (_updateAircraft(p, d, isThrusting, isBraking)) return;
  }

  // Sustained thrust sound (runs every frame for both vehicle types)
  gameSFX?.setThrust(p.id, isThrusting, p.ship.x, p.ship.y, p.ship.z);

  _handleWeaponFire(p, isShooting);
}

/**
 * Kills the player: spawns a ship-type explosion, triggers a shockwave pulse on
 * the terrain, marks the player dead and starts the 120-frame (~2 s) respawn timer.
 * All in-flight bullets are discarded.
 * @param {object} p  Player state object.
 */
function killPlayer(p) {
  gameSFX?.setThrust(p.id, false);
  particleSystem.addExplosion(p.ship.x, p.ship.y, p.ship.z);
  terrain.addPulse(p.ship.x, p.ship.z, 2.0);  // Yellow ship-explosion ring (type 2)
  gameRenderer?.setShake(30);
  p.dead = true;
  p.respawnTimer = 120;  // 120 physics ticks = 2 s (physics always runs at 60 Hz)
  p.bullets = [];
  p.tankShells = [];
  p.normalShotMode = 'single';
  p.weaponMode = 0; // Reset to NORMAL weapon mode

  // --- "Launch Pad Taken Over" detection ---
  // If the player dies on the launch pad while an enemy is also on the pad,
  // we increment a special counter.  Three such deaths end the game.
  if (isLaunchpad(p.ship.x, p.ship.z)) {
    let enemyOnPad = enemyManager.enemies.some(e => isLaunchpad(e.x, e.z));
    if (enemyOnPad) {
      p.lpDeaths = (p.lpDeaths || 0) + 1;
      if (p.lpDeaths >= 3) {
        gameState.setGameOver('LAUNCH PAD TAKEN OVER');
      }
    } else {
      p.lpDeaths = 0; // Enemy cleared the pad, reset counter
    }
  } else {
    p.lpDeaths = 0; // Died elsewhere, reset counter
  }
}

