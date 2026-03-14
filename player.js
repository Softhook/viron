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
  let cp = cos(s.pitch), sp = sin(s.pitch);
  let cy = cos(s.yaw), sy = sin(s.yaw);

  // Forward unit vector in world space
  let fx = -cp * sy;
  let fy = sp;
  let fz = -cp * cy;

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

  let y1 = ly * cp - lz * sp;
  let z1 = ly * sp + lz * cp;

  return {
    x: s.x + z1 * sy,
    y: s.y + y1,
    z: s.z + z1 * cy,
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

  if (typeof gameSFX !== 'undefined') gameSFX.playShot(ship.x, ship.y, ship.z);
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

  // Custom spawn with ly aligned to the tank turret (-20)
  const s = p.ship;
  const cp = cos(s.pitch + turretPitchOffset), sp = sin(s.pitch + turretPitchOffset);
  const cy = cos(s.yaw), sy = sin(s.yaw);
  const fx = -cp * sy, fy = sp, fz = -cp * cy;

  const lz = -45, ly = -20; // 45 units forward, 20 units UP from centre
  const y1 = ly * cp - lz * sp;
  const z1 = ly * sp + lz * cp;

  let shell = {
    x: s.x + z1 * sy,
    y: s.y + y1,
    z: s.z + z1 * cy,
    vx: fx * power + s.vx,
    vy: fy * power + s.vy,
    vz: fz * power + s.vz,
    life
  };

  p.tankShells.push(shell);

  if (typeof gameSFX !== 'undefined') {
    gameSFX.playShot(p.ship.x, p.ship.y, p.ship.z);
    gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
  }
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
    p.homingMissiles.push(spawnProjectile(p.ship, 8, 300));
    if (typeof gameSFX !== 'undefined') gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
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
  if (typeof gameSFX !== 'undefined') gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
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
 * Returns the world-space thrust force vector of the ship.
 * The thrust direction is determined by the player's ship design settings.
 * @param {{pitch,yaw}} s  Ship state.
 * @param {number} designIdx  Index into SHIP_DESIGNS.
 * @returns {{x,y,z}}  Thrust force vector in world space.
 */
function shipUpDir(s, designIdx) {
  let p = s.pitch, y = s.yaw;
  let alpha = 0;
  if (typeof SHIP_DESIGNS !== 'undefined' && SHIP_DESIGNS[designIdx]) {
    alpha = SHIP_DESIGNS[designIdx].thrustAngle || 0;
  }

  if (typeof SHIP_DESIGNS !== 'undefined' && SHIP_DESIGNS[designIdx] && SHIP_DESIGNS[designIdx].isGroundVehicle) {
    return {
      x: -Math.sin(y),
      y: 0,
      z: -Math.cos(y)
    };
  }

  // Rotation of [0, -1, 0] (local up) by 'alpha' backward, then by pitch/yaw
  // Result: x = -sin(p + alpha)*sin(y), y = -cos(p + alpha), z = -sin(p + alpha)*cos(y)
  return {
    x: -Math.sin(p + alpha) * Math.sin(y),
    y: -Math.cos(p + alpha),
    z: -Math.sin(p + alpha) * Math.cos(y)
  };
}

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
  // Sky-tinted shadow: dark cool blue (sky fill colors the shadow, not pure black)
  fill(AMBIENT_R * SHADOW_AMBIENT_RG_SCALE, AMBIENT_G * SHADOW_AMBIENT_RG_SCALE, AMBIENT_B * SHADOW_AMBIENT_B_SCALE, alpha * getOpacityFactor(casterH));
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
  if (typeof SHIP_DESIGNS !== 'undefined' && SHIP_DESIGNS[designIdx] && SHIP_DESIGNS[designIdx].footprint) {
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
    if (gameState.isMobile && p.id === 0 && typeof mobileController !== 'undefined') {
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
  if (!gameState.isMobile || p.id !== 0 || typeof mobileController === 'undefined') {
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
 * Integrates one frame of ground-vehicle physics (suspension, friction, wall stop).
 * @param {object}  p           Player state.
 * @param {object}  d           Ship design object.
 * @param {boolean} isThrusting Whether thrust is active this frame.
 * @param {boolean} isBraking   Whether braking is active this frame.
 * @returns {boolean}  True if the caller should return early (water boundary hit).
 */
function _updateGroundVehicle(p, d, isThrusting, isBraking) {
  let s = p.ship;
  let m = d.mass || 1.0;

  s.y += s.vy;
  let alt = terrain.getAltitude(s.x, s.z);
  let surfaceY = d.canTravelOnWater ? Math.min(SEA, alt) : alt;
  let groundY = surfaceY - 12;

  if (s.y > groundY) {
    // Contact with ground — clamp and handle slope kick
    let terrainPush = groundY - (s.y - s.vy);
    if (terrainPush < -8) {
      // Major upward slope: small vertical kick (heavier feel at 0.18 vs original 0.35)
      s.vy = terrainPush * (0.18 / m);
    } else {
      s.vy = 0;
    }
    s.y = groundY;
  } else {
    // Airborne — glue to surface unless moving fast or high enough
    let speedSq = s.vx * s.vx + s.vz * s.vz;
    let hoverHeight = groundY - s.y;
    if (hoverHeight < 20 && speedSq < 45) {
      s.y = groundY;
      s.vy = 0;
    } else {
      s.vy += GRAV;
    }
  }

  if (isThrusting) {
    let pw = (d.thrust || 0.45) / m;
    let dVec = shipUpDir(s, p.designIndex);
    s.vx += dVec.x * pw;
    s.vz += dVec.z * pw;
    // Dust particles when near the ground
    if (_simTick % 4 === 0 && s.y > groundY - 5) {
      particleSystem.particles.push({
        x: s.x, y: s.y + 10, z: s.z,
        vx: random(-1.5, 1.5), vy: -random(1, 3), vz: random(-1.5, 1.5),
        life: random(40, 70), decay: 4, seed: random(1), size: random(6, 12),
        color: [140, 130, 110]
      });
    }
  }

  if (isBraking) {
    let br = d.brakeRate ?? 0.94;
    s.vx *= br; s.vz *= br;
  }

  // Higher ground friction than air drag — prevents sliding
  let groundFriction = isThrusting ? 0.95 : 0.85;
  s.vx *= groundFriction; s.vz *= groundFriction;
  // Snap near-zero velocity to zero for responsive feel
  if (Math.abs(s.vx) < 0.05) s.vx = 0;
  if (Math.abs(s.vz) < 0.05) s.vz = 0;

  s.x += s.vx; s.z += s.vz;

  // Water boundary — stop instead of explode
  if (!d.canTravelOnWater && terrain.getAltitude(s.x, s.z) >= SEA - 1) {
    s.x -= s.vx; s.z -= s.vz;
    s.vx = 0; s.vz = 0;
    return true;  // Skip thrust sound and weapon fire
  }
  return false;
}

/**
 * Integrates one frame of aircraft physics (gravity, aerodynamic lift, drag,
 * terrain and sea collision).  Emits exhaust particles while thrusting.
 * @param {object}  p           Player state.
 * @param {object}  d           Ship design object.
 * @param {boolean} isThrusting Whether thrust is active this frame.
 * @param {boolean} isBraking   Whether braking is active this frame.
 * @returns {boolean}  True if the caller should return early (player killed).
 */
function _updateAircraft(p, d, isThrusting, isBraking) {
  let s = p.ship;
  let m = d.mass || 1.0;

  s.vy += GRAV;  // Gravity

  // Aerodynamic lift: project velocity onto the forward axis; lift acts along the up axis
  let cp_L = Math.cos(s.pitch), sp_L = Math.sin(s.pitch);
  let cy_L = Math.cos(s.yaw), sy_L = Math.sin(s.yaw);
  let fx_L = -cp_L * sy_L, fy_L = sp_L, fz_L = -cp_L * cy_L;
  let ux_L = -sp_L * sy_L, uy_L = -cp_L, uz_L = -sp_L * cy_L;
  let fSpd = s.vx * fx_L + s.vy * fy_L + s.vz * fz_L;
  let currentDrag = d.drag || DRAG;

  if (fSpd > 0) {
    let liftAccel = fSpd * (d.lift ?? LIFT_FACTOR);
    s.vx += ux_L * liftAccel;
    s.vy += uy_L * liftAccel;
    s.vz += uz_L * liftAccel;
    // Induced drag: lift generation bleeds forward momentum
    currentDrag -= (fSpd * INDUCED_DRAG * 0.01);
  }

  if (isThrusting) {
    let pw = (d.thrust || 0.45) / m;
    let dVec = shipUpDir(s, p.designIndex);
    s.vx += dVec.x * pw; s.vy += dVec.y * pw; s.vz += dVec.z * pw;

    // Exhaust smoke — adaptive emission rate under heavy particle load
    const totalParticles = particleSystem.particles.length;
    const fogLoad = particleSystem.fogCount;
    const emitEvery = totalParticles > 700 ? 5 : (totalParticles > 500 || fogLoad > 130 ? 4 : 3);
    if (_simTick % emitEvery === 0) {
      let cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
      let cx = Math.cos(s.pitch), sx = Math.sin(s.pitch);
      let tLocal = (pt) => {
        let x = pt[0], y = pt[1], z = pt[2];
        let y1 = y * cx - z * sx;
        let z1 = y * sx + z * cx;
        let x2 = x * cy + z1 * sy;
        let z2 = -x * sy + z1 * cy;
        return { x: x2 + s.x, y: y1 + s.y, z: z2 + s.z };
      };
      let alpha = (typeof SHIP_DESIGNS !== 'undefined' && SHIP_DESIGNS[p.designIndex])
        ? (SHIP_DESIGNS[p.designIndex].thrustAngle || 0) : 0;
      const pa = s.pitch + alpha;
      let exDir = {
        x: Math.sin(pa) * Math.sin(s.yaw),
        y: Math.cos(pa),
        z: Math.sin(pa) * Math.cos(s.yaw)
      };
      let engPos = (typeof SHIP_DESIGNS !== 'undefined' && SHIP_DESIGNS[p.designIndex])
        ? SHIP_DESIGNS[p.designIndex].draw(null)
        : [{ x: -13, y: 5, z: 20 }, { x: 13, y: 5, z: 20 }];
      const emitChance = totalParticles > 700 ? 0.28 : (totalParticles > 500 ? 0.42 : 0.65);
      engPos.forEach(pos => {
        if (random() > emitChance) return;
        let wPos = tLocal([pos.x, pos.y, pos.z + 2]);
        particleSystem.particles.push({
          x: wPos.x, y: wPos.y, z: wPos.z,
          vx: exDir.x * random(4, 7) + random(-0.8, 0.8),
          vy: exDir.y * random(4, 7) + random(-0.8, 0.8),
          vz: exDir.z * random(4, 7) + random(-0.8, 0.8),
          life: random(190, 240), decay: random(4.2, 6.0), seed: random(1.0), size: random(11, 18),
          isThrust: true,
          color: [random(150, 195), random(150, 195), random(150, 195)]
        });
      });
    }
  }

  if (isBraking) {
    let br = d.brakeRate ?? 0.96;
    s.vx *= br; s.vy *= br; s.vz *= br;
  }

  s.vx *= currentDrag; s.vy *= currentDrag; s.vz *= currentDrag;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  // Sea collision — instant death
  if (s.y > SEA - 12) {
    killPlayer(p);
    return true;
  }

  // Terrain collision — soft bounce or kill on hard impact
  let g = terrain.getAltitude(s.x, s.z);

  // --- Ground Effect Cushion ---
  // Apply a slight upward force when descending near the ground.
  // This makes it easier to flare for a soft landing.
  let distToGround = g - s.y;
  if (distToGround < 40 && s.vy > 0) {
    let cushion = (1.0 - (distToGround / 40)) * 0.08;
    s.vy = Math.max(0, s.vy - cushion);
  }

  if (s.y > g - 12) {
    if (s.vy > 4.2) killPlayer(p);
    else { s.y = g - 12; s.vy = 0; s.vx *= 0.8; s.vz *= 0.8; }
  }
  return false;
}

/**
 * Fires the player's currently selected weapon based on the shoot input state.
 * Handles rate-limiting, edge-detection, and mode-specific weapon logic.
 * @param {object}  p          Player state.
 * @param {boolean} isShooting Whether the shoot input is active this frame.
 */
function _handleWeaponFire(p, isShooting) {
  let s = p.ship;
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
  if (p.dead || (typeof gameState !== 'undefined' && gameState.mode === 'gameover')) return;

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
  if (typeof gameSFX !== 'undefined') {
    gameSFX.setThrust(p.id, isThrusting, p.ship.x, p.ship.y, p.ship.z);
  }

  _handleWeaponFire(p, isShooting);
}

/**
 * Kills the player: spawns a ship-type explosion, triggers a shockwave pulse on
 * the terrain, marks the player dead and starts the 120-frame (~2 s) respawn timer.
 * All in-flight bullets are discarded.
 * @param {object} p  Player state object.
 */
function killPlayer(p) {
  if (typeof gameSFX !== 'undefined') gameSFX.setThrust(p.id, false);
  particleSystem.addExplosion(p.ship.x, p.ship.y, p.ship.z);
  terrain.addPulse(p.ship.x, p.ship.z, 2.0);  // Yellow ship-explosion ring (type 2)
  if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(30);
  p.dead = true;
  p.respawnTimer = 120;  // 120 physics ticks = 2 s (physics always runs at 60 Hz)
  p.bullets = [];
  p.tankShells = [];
  p.normalShotMode = 'single';
  p.weaponMode = 0; // Reset to NORMAL weapon mode

  // --- "Launch Pad Taken Over" detection ---
  // If the player dies on the launch pad while an enemy is also on the pad,
  // we increment a special counter.  Two such deaths end the game.
  if (isLaunchpad(p.ship.x, p.ship.z)) {
    let enemyOnPad = enemyManager.enemies.some(e => isLaunchpad(e.x, e.z));
    if (enemyOnPad) {
      p.lpDeaths = (p.lpDeaths || 0) + 1;
      if (p.lpDeaths >= 3) {
        if (typeof gameState !== 'undefined') {
          gameState.setGameOver('LAUNCH PAD TAKEN OVER');
        }
      }
    } else {
      p.lpDeaths = 0; // Enemy cleared the pad, reset counter
    }
  } else {
    p.lpDeaths = 0; // Died elsewhere, reset counter
  }
}

/**
 * Advances bullet and homing-missile physics for one frame.
 *
 * Bullets: linear motion, 2-life-per-frame decay.  Removed when they hit terrain
 * or expire; terrain hit attempts to clear infected tiles.
 *
 * Homing missiles: use a lerped velocity toward the nearest enemy (blend factor
 * 0.12) capped at maxSpd = 10.  Emit a smoke trail every other frame.  On terrain
 * impact they trigger an explosion and attempt to clear infection.
 *
 * @param {object} p  Player state object containing bullets[] and homingMissiles[].
 */
function updateProjectilePhysics(p) {
  // --- Bullets ---
  let assistEnabled = aimAssist.enabled;
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];

    if (assistEnabled && b.life > 240) {
      let bestTarget = null;
      let bestDot = 0.985;
      let speed = Math.hypot(b.vx, b.vy, b.vz);

      if (speed > 0) {
        let bDirX = b.vx / speed, bDirY = b.vy / speed, bDirZ = b.vz / speed;
        for (let e of enemyManager.enemies) {
          let dx = e.x - b.x, dy = e.y - b.y, dz = e.z - b.z;
          let dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < 1440000 && dSq > 400) {
            let d = Math.sqrt(dSq);
            let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
            if (dot > bestDot) {
              bestDot = dot;
              bestTarget = aimAssist._getPredictedPos(b, e, speed, d);
            }
          }
        }
        if (!bestTarget && _simTick % 2 === 0) {
          let bTx = Math.floor(b.x / 120), bTz = Math.floor(b.z / 120);
          for (let tz = bTz - 2; tz <= bTz + 2; tz++) {
            for (let tx = bTx - 2; tx <= bTx + 2; tx++) {
              let k = tileKey(tx, tz);
              if (infection.has(k)) {
                let txPos = tx * 120 + 60, tzPos = tz * 120 + 60;
                let tyPos = terrain.getAltitude(txPos, tzPos);
                let dx = txPos - b.x, dy = tyPos - b.y, dz = tzPos - b.z;
                let dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < 360000) {
                  let d = Math.sqrt(dSq);
                  let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
                  if (dot > bestDot) {
                    bestDot = dot;
                    bestTarget = { x: txPos, y: tyPos, z: tzPos };
                  }
                }
              }
            }
          }
        }
      }

      if (bestTarget) {
        let dx = bestTarget.x - b.x, dy = bestTarget.y - b.y, dz = bestTarget.z - b.z;
        let d = Math.hypot(dx, dy, dz);
        let steer = 0.04;
        b.vx = lerp(b.vx, (dx / d) * speed, steer);
        b.vy = lerp(b.vy, (dy / d) * speed, steer);
        b.vz = lerp(b.vz, (dz / d) * speed, steer);
      }
    }

    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life -= 2;
    if (b.life <= 0) {
      swapRemove(p.bullets, i);
    } else if (b.y > terrain.getAltitude(b.x, b.z)) {
      clearInfectionAt(b.x, b.z, p);
      swapRemove(p.bullets, i);
    }
  }

  // --- Homing missiles ---
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i];
    const maxSpd = 10;
    let target = p.aimTarget || findNearest(enemyManager.enemies, m.x, m.y, m.z);

    if (target) {
      let dest = aimAssist.enabled ? aimAssist._getPredictedPos(m, target, maxSpd) : target;
      let dx = dest.x - m.x, dy = dest.y - m.y, dz = dest.z - m.z;
      let dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > 0) {
        let mg = Math.sqrt(dSq);
        let bl = 0.12;
        m.vx = lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = lerp(m.vz, (dz / mg) * maxSpd, bl);
      }
    }

    let spSq = m.vx * m.vx + m.vy * m.vy + m.vz * m.vz;
    if (spSq > maxSpd * maxSpd) {
      let sp = Math.sqrt(spSq);
      m.vx = (m.vx / sp) * maxSpd;
      m.vy = (m.vy / sp) * maxSpd;
      m.vz = (m.vz / sp) * maxSpd;
    }

    m.x += m.vx; m.y += m.vy; m.z += m.vz;
    m.life--;

    if (_simTick % 2 === 0) {
      particleSystem.particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5),
        life: 120, decay: 5, seed: random(1.0), size: random(2, 5)
      });
    }

    let gnd = terrain.getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        particleSystem.addExplosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, p);
      }
      swapRemove(p.homingMissiles, i);
    }
  }

  // --- Tank Shells ---
  for (let i = p.tankShells.length - 1; i >= 0; i--) {
    let s = p.tankShells[i];
    s.vy += 0.15; // Gravity
    s.x += s.vx; s.y += s.vy; s.z += s.vz;
    s.life--;

    let g = terrain.getAltitude(s.x, s.z);
    if (s.life <= 0 || s.y > g) {
      // AOE Destruction of infection and enemies
      let impactRad = TANK_SHELL_CLEAR_R * TILE;
      let impactRadSq = impactRad * impactRad;

      // Kill nearby enemies
      for (let j = enemyManager.enemies.length - 1; j >= 0; j--) {
        let e = enemyManager.enemies[j];
        let dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;
        if (dx * dx + dy * dy + dz * dz < impactRadSq) {
          particleSystem.addExplosion(e.x, e.y, e.z, enemyManager.getColor(e.type), e.type);
          swapRemove(enemyManager.enemies, j);
          p.score += 300;
        }
      }

      let tx = toTile(s.x), tz = toTile(s.z);
      let cleared = clearInfectionRadius(tx, tz, TANK_SHELL_CLEAR_R);
      if (cleared > 0) {
        p.score += cleared * 50;
      }
      terrain.addPulse(s.x, s.z, 2.0);
      if (typeof gameRenderer !== 'undefined') gameRenderer.setShake(15);
      if (typeof gameSFX !== 'undefined') {
        gameSFX.setThrust(p.id, false);
        gameSFX.playClearInfection(s.x, g, s.z);
      }
      swapRemove(p.tankShells, i);
    }
  }
}

/**
 * Advances all in-flight barrier projectiles one frame.
 * On landing, snaps to tile grid and adds key to barrierTiles (dedup is automatic).
 */
function updateBarrierPhysics() {
  for (let i = gameState.inFlightBarriers.length - 1; i >= 0; i--) {
    let b = gameState.inFlightBarriers[i];
    b.vy += 0.15;  // Gravity
    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life--;
    if (b.y >= terrain.getAltitude(b.x, b.z) || b.life <= 0) {
      if (b.life > 0) { // Landed (not expired)
        let tx = Math.floor(b.x / TILE), tz = Math.floor(b.z / TILE);
        gameState.barrierTiles.add(tileKey(tx, tz));
      }
      swapRemove(gameState.inFlightBarriers, i);
    }
  }
}

/**
 * Renders all in-flight barrier projectiles as small white cubes.
 * Called once per viewport from the main render loop.
 * @param {number} camX  Camera world X.
 * @param {number} camZ  Camera world Z.
 */
function renderInFlightBarriers(camX, camZ) {
  if (!gameState.inFlightBarriers.length) return;
  const cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  noStroke(); fill(255, 255, 255, 220);
  for (let b of gameState.inFlightBarriers) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); box(8); pop();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the player's bullets (small coloured spheres) and homing missiles
 * (cyan cubes) from the perspective of the given viewport camera.
 * Objects beyond 80% of CULL_DIST are skipped.
 * @param {object} p     Player state containing bullets[] and homingMissiles[].
 * @param {number} camX  Camera world X (viewport camera, not ship).
 * @param {number} camZ  Camera world Z.
 */
function renderProjectiles(p, camX, camZ) {
  let cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  let bulletR = 4; // Player bullet size control (sphere radius)
  let bulletDetailX = 4;
  let bulletDetailY = 3;
  let br = p.labelColor[0], bg = p.labelColor[1], bb = p.labelColor[2];

  // Bullets use low-poly flat spheres for a simple explosion-like look.
  noLights();
  noStroke();
  fill(br, bg, bb);

  for (let b of p.bullets) {
    let dx = b.x - camX;
    let dz = b.z - camZ;
    if (dx * dx + dz * dz > cullSq) continue;
    push(); translate(b.x, b.y, b.z);
    sphere(bulletR, bulletDetailX, bulletDetailY);
    pop();
  }

  for (let m of p.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;

    push();
    translate(m.x, m.y, m.z);

    // Direct orientation toward velocity vector
    let h = Math.sqrt(m.vx * m.vx + m.vz * m.vz);
    rotateY(Math.atan2(m.vx, m.vz));
    rotateX(Math.atan2(-m.vy, h));

    noStroke();

    // Body (Main Fuselage)
    fill(0, 180, 255);
    box(3, 3, 14);

    // Nose Cone (Pointed Tip)
    push();
    translate(0, 0, 10);
    rotateX(PI / 2);
    fill(255);
    cone(2, 6, 4); // Low-poly pyramid-like nose
    pop();

    // Faint Glow / Core
    fill(255, 255, 255, 100);
    box(1, 1, 16);

    // Fins (Tail stabilizers)
    fill(0, 100, 255);
    translate(0, 0, -6);
    box(10, 1, 4); // Horizontal fins
    box(1, 10, 4); // Vertical fins

    pop();
  }

  // Draw Tank Shells
  for (let s of p.tankShells) {
    if ((s.x - camX) ** 2 + (s.z - camZ) ** 2 > cullSq) continue;
    push();
    translate(s.x, s.y, s.z);
    // Draw as a larger, glowing grey "shell"
    noStroke();
    fill(100, 100, 110);
    sphere(8, 6, 4); // Larger than bullets
    fill(255, 150, 50, 200); // Glow
    sphere(5, 4, 3);
    pop();
  }
}
