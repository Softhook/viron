// =============================================================================
// shipPhysics.js — Physics integration for vehicles (air and ground)
// =============================================================================

/**
 * Returns the world-space thrust force vector of the ship.
 * The thrust direction is determined by the player's ship design settings.
 * @param {{pitch,yaw}} s  Ship state.
 * @param {number} designIdx  Index into SHIP_DESIGNS.
 * @returns {{x,y,z}}  Thrust force vector in world space.
 */
function shipUpDir(s, designIdx) {
  let p = s.pitch, y = s.yaw;
  const design = SHIP_DESIGNS?.[designIdx];
  const alpha = design?.thrustAngle || 0;

  if (design?.isGroundVehicle) {
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
    if (typeof _simTick !== 'undefined' && _simTick % 4 === 0 && s.y > groundY - 5) {
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
    if (typeof _simTick !== 'undefined' && _simTick % emitEvery === 0) {
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
      let alpha = SHIP_DESIGNS?.[p.designIndex]?.thrustAngle ?? 0;
      const pa = s.pitch + alpha;
      let exDir = {
        x: Math.sin(pa) * Math.sin(s.yaw),
        y: Math.cos(pa),
        z: Math.sin(pa) * Math.cos(s.yaw)
      };
      let engPos = SHIP_DESIGNS?.[p.designIndex]?.draw(null)
        ?? [{ x: -13, y: 5, z: 20 }, { x: 13, y: 5, z: 20 }];
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

  // --- Strafing Run Mode (Dive Dampening) ---
  let rawGroundY = terrain.getAltitude(s.x, s.z);
  let surfaceY = Math.min(SEA, rawGroundY); // Account for water! (smaller Y is higher up)
  let altitude = surfaceY - s.y;

  if (s.pitch > 0.05 && s.vy > 0 && altitude > 0 && altitude < 1000) {
    let proximityFactor = 1.0 - Math.pow(altitude / 1000, 3);
    let normalizedAngle = (d.thrustAngle || 0) / (Math.PI / 2);
    let thrustTypeFactor = 0.4 + (0.6 * normalizedAngle);
    let biteStrength = 0.95 * proximityFactor * thrustTypeFactor;
    let safeSinkRate = 0.1 + (altitude / 200);

    if (s.vy > safeSinkRate) {
      s.vy = s.vy * (1.0 - biteStrength) + safeSinkRate * biteStrength;
    }
  }

  s.vx *= currentDrag; s.vy *= currentDrag; s.vz *= currentDrag;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  // Sea collision — instant death
  if (s.y > SEA - 12) {
    killPlayer(p);
    return true;
  }

  // Terrain collision — soft bounce or kill on hard impact
  let g = rawGroundY;

  // Ground Effect Cushion
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
