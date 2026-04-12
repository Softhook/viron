/**
 * Vehicle - Encapsulates 3D physics, movement models, and orientation for player ships.
 * Supports both ground-hugging and airborne movement modes.
 *
 * @exports   Vehicle       — class definition (used exclusively by player.js)
 */

// --- Vehicle physics constants ---
// Ship hull offset from terrain surface (world-units of Y clearance).
const SHIP_GROUND_CLEARANCE = 12;
// Vertical velocity above which a ground contact is treated as a crash.
const LANDING_CRASH_SPEED = 4.2;
// Distance from terrain at which the ground-proximity air cushion begins.
const CUSHION_RANGE = 40;
// Lateral velocity multiplier applied on a non-lethal ground contact.
const GROUND_LANDING_FRICTION = 0.8;
class Vehicle {
  constructor(x, y, z, designIndex) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.designIndex = designIndex;
  }

  /**
   * Resets vehicle state to a specific position.
   */
  reset(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.pitch = 0;
    this.yaw = 0;
  }

  /**
   * Main physics integration step.
   * @param {object} design  Ship design parameters (turnRate, thrust, mass, etc.)
   * @param {object} inputs  Active input states (thrust, brake)
   * @param {object} deltas  Steering deltas (yaw, pitch)
   */
  update(design, inputs, deltas) {
    this.yaw += deltas.yaw;
    this.pitch = constrain(this.pitch + deltas.pitch, -PI / 2.2, PI / 2.2);

    if (design.isGroundVehicle) {
      return this._updateGround(design, inputs.thrust, inputs.brake);
    } else {
      return this._updateAir(design, inputs.thrust, inputs.brake);
    }
  }

  /**
   * Ground-vehicle movement model.
   * @private
   */
  _updateGround(d, isThrusting, isBraking) {
    const m = d.mass || 1.0;
    this.y += this.vy;
    
    const alt = terrain.getAltitude(this.x, this.z);
    const surfaceY = d.canTravelOnWater ? Math.min(SEA, alt) : alt;
    const groundY = surfaceY - SHIP_GROUND_CLEARANCE;

    if (this.y > groundY) {
      const terrainPush = groundY - (this.y - this.vy);
      if (terrainPush < -8) {
        this.vy = terrainPush * (0.18 / m);
      } else {
        this.vy = 0;
      }
      this.y = groundY;
    } else {
      const speedSq = this.vx * this.vx + this.vz * this.vz;
      const hoverHeight = groundY - this.y;
      if (hoverHeight < 20 && speedSq < 45) {
        this.y = groundY;
        this.vy = 0;
      } else {
        this.vy += GRAV;
      }
    }

    if (isThrusting) {
      const pw = (d.thrust || 0.45) / m;
      const dVec = this.getThrustVector(d);
      this.vx += dVec.x * pw;
      this.vz += dVec.z * pw;
      this._emitGroundDust(groundY);
    }

    if (isBraking) {
      const br = d.brakeRate ?? 0.94;
      this.vx *= br; this.vz *= br;
    }

    const groundFriction = isThrusting ? 0.95 : 0.85;
    this.vx *= groundFriction; this.vz *= groundFriction;
    if (Math.abs(this.vx) < 0.05) this.vx = 0;
    if (Math.abs(this.vz) < 0.05) this.vz = 0;

    this.x += this.vx; this.z += this.vz;

    if (!d.canTravelOnWater && terrain.getAltitude(this.x, this.z) >= SEA - 1) {
      this.x -= this.vx; this.z -= this.vz;
      this.vx = 0; this.vz = 0;
      return 'stopped';
    }
    return 'ok';
  }

  /**
   * Airborne movement model.
   * @private
   */
  _updateAir(d, isThrusting, isBraking) {
    const m = d.mass || 1.0;
    this.vy += GRAV;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const fx = -cp * sy, fy = sp, fz = -cp * cy;
    const ux = -sp * sy, uy = -cp, uz = -sp * cy;
    const fSpd = this.vx * fx + this.vy * fy + this.vz * fz;
    let currentDrag = d.drag || DRAG;

    if (fSpd > 0) {
      const liftAccel = fSpd * (d.lift ?? LIFT_FACTOR);
      this.vx += ux * liftAccel;
      this.vy += uy * liftAccel;
      this.vz += uz * liftAccel;
      currentDrag -= (fSpd * INDUCED_DRAG * 0.01);
    }

    if (isThrusting) {
      const pw = (d.thrust || 0.45) / m;
      const dVec = this.getThrustVector(d);
      this.vx += dVec.x * pw;
      this.vy += dVec.y * pw;
      this.vz += dVec.z * pw;
      this._emitExhaust(d);
    }

    if (isBraking) {
      const br = d.brakeRate ?? 0.96;
      this.vx *= br; this.vy *= br; this.vz *= br;
    }

    // Dive Dampening
    const rawGroundY = terrain.getAltitude(this.x, this.z);
    const surfaceY = Math.min(SEA, rawGroundY);
    const altitude = surfaceY - this.y;

    if (this.vy > 0 && altitude > 0 && altitude < 1000) {
      const proximityFactor = 1.0 - Math.pow(altitude / 1000, 3);
      const normalizedAngle = (d.thrustAngle || 0) / (Math.PI / 2);
      const thrustTypeFactor = 0.4 + (0.6 * normalizedAngle);
      const biteStrength = 0.95 * proximityFactor * thrustTypeFactor;
      const safeSinkRate = 0.1 + (altitude / 200);
      if (this.vy > safeSinkRate) {
        this.vy = this.vy * (1.0 - biteStrength) + safeSinkRate * biteStrength;
      }
    }

    this.vx *= currentDrag; this.vy *= currentDrag; this.vz *= currentDrag;
    this.x += this.vx; this.y += this.vy; this.z += this.vz;

    if (this.y > SEA - SHIP_GROUND_CLEARANCE) return 'killed';

    const distToGround = rawGroundY - this.y;
    if (distToGround < CUSHION_RANGE && this.vy > 0) {
      const cushion = (1.0 - (distToGround / CUSHION_RANGE)) * 0.08;
      this.vy = Math.max(0, this.vy - cushion);
    }

    if (this.y > rawGroundY - SHIP_GROUND_CLEARANCE) {
      if (this.vy > LANDING_CRASH_SPEED) return 'killed';
      else {
        this.y = rawGroundY - SHIP_GROUND_CLEARANCE;
        this.vy = 0;
        this.vx *= GROUND_LANDING_FRICTION;
        this.vz *= GROUND_LANDING_FRICTION;
      }
    }
    return 'ok';
  }

  getThrustVector(design) {
    const p = this.pitch, y = this.yaw;
    const alpha = design.thrustAngle || 0;
    if (design.isGroundVehicle) {
      return { x: -Math.sin(y), y: 0, z: -Math.cos(y) };
    }
    return {
      x: -Math.sin(p + alpha) * Math.sin(y),
      y: -Math.cos(p + alpha),
      z: -Math.sin(p + alpha) * Math.cos(y)
    };
  }

  _emitGroundDust(groundY) {
    if (physicsEngine.tickCount % 4 === 0 && this.y > groundY - 5) {
      particleSystem.particles.push({
        x: this.x, y: this.y + 10, z: this.z,
        vx: random(-1.5, 1.5), vy: -random(1, 3), vz: random(-1.5, 1.5),
        life: random(40, 70), decay: 4, seed: random(1), size: random(6, 12),
        color: [140, 130, 110]
      });
    }
  }

  _emitExhaust(d) {
    const totalParticles = particleSystem.particles.length;
    const fogLoad = particleSystem.fogCount;
    const emitEvery = totalParticles > 700 ? 5 : (totalParticles > 500 || fogLoad > 130 ? 4 : 3);
    if (physicsEngine.tickCount % emitEvery !== 0) return;

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cx = Math.cos(this.pitch), sx = Math.sin(this.pitch);
    const alpha = d.thrustAngle ?? 0;
    const pa = this.pitch + alpha;
    const exDir = { x: Math.sin(pa) * Math.sin(this.yaw), y: Math.cos(pa), z: Math.sin(pa) * Math.cos(this.yaw) };
    const engPos = d.draw(null) ?? [{ x: -13, y: 5, z: 20 }, { x: 13, y: 5, z: 20 }];
    const emitChance = totalParticles > 700 ? 0.28 : (totalParticles > 500 ? 0.42 : 0.65);

    engPos.forEach(pos => {
      if (random() > emitChance) return;
      const y1 = pos.y * cx - (pos.z + 2) * sx;
      const z1 = pos.y * sx + (pos.z + 2) * cx;
      const wx = (pos.x * cy + z1 * sy) + this.x;
      const wy = y1 + this.y;
      const wz = (-pos.x * sy + z1 * cy) + this.z;
      particleSystem.particles.push({
        x: wx, y: wy, z: wz,
        vx: exDir.x * random(4, 7) + random(-0.8, 0.8),
        vy: exDir.y * random(4, 7) + random(-0.8, 0.8),
        vz: exDir.z * random(4, 7) + random(-0.8, 0.8),
        life: random(190, 240), decay: random(4.2, 6.0), seed: random(1.0), size: random(11, 18),
        isThrust: true, color: [random(150, 195), random(150, 195), random(150, 195)]
      });
    });
  }
}
