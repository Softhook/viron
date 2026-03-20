// =============================================================================
// agentManager.js — Base Class for Entity Managers (Villagers & Wizards)
// =============================================================================

class AgentManager {
  constructor(hubType, config = {}) {
    this.agents = [];
    this._visible = [];
    this.hubs = [];
    this.activeHubs = [];
    this.hubType = hubType;
    this.config = Object.assign({
      maxHealth: 100,
      healRate: 0.5,
      infectionDam: 1.2,
      speed: 1.0,
      searchRadius: 4,
      targetHysteresisSq: 4,
      stopDist: 100,
      maxWanderDistSq: 1440 * 1440,
      wanderSpeedMult: 0.3
    }, config);
    this._frameCounter = 0;
  }

  update() {
    this._frameCounter++;
    if (this._frameCounter >= 30) {
      this._frameCounter = 0;
      this._updateActiveHubs((CULL_DIST + 1000) * (CULL_DIST + 1000));
    }
  }

  getTargetHubs() {
    if (typeof window !== 'undefined' && window.BENCHMARK && window.BENCHMARK.disableVillagerCulling) {
      return this.hubs;
    }
    return this.activeHubs;
  }

  clear() {
    if (typeof gameState !== 'undefined' && gameState.level === 1) {
      this.agents.length = 0;
    }
    this.hubs = gameState.buildings.filter(b => b.type === this.hubType);
    this.activeHubs = [];
    this._frameCounter = 0;
    this._updateActiveHubs((CULL_DIST + 1000) * (CULL_DIST + 1000));
  }

  _updateActiveHubs(simDistSq) {
    this.activeHubs.length = 0;
    if (!gameState.players || gameState.players.length === 0) return;

    for (const b of this.hubs) {
      let isActive = false;
      for (const p of gameState.players) {
        if (!p.dead && p.ship) {
          const dx = b.x - p.ship.x;
          const dz = b.z - p.ship.z;
          if (dx * dx + dz * dz <= simDistSq) {
            isActive = true;
            break;
          }
        }
      }
      if (isActive) this.activeHubs.push(b);
    }
  }

  _applyHealthAndPhysics(u) {
    const tk = tileKey(toTile(u.x), toTile(u.z));
    if (infection.has(tk)) {
      u.health -= this.config.infectionDam;
      if (u.health <= 0) return false;
    } else if (u.health < this.config.maxHealth) {
      u.health = Math.min(this.config.maxHealth, u.health + this.config.healRate);
    }

    u.x += u.vx;
    u.z += u.vz;
    const gy = terrain.getAltitude(u.x, u.z);
    u.y = gy;

    if (aboveSea(gy)) return false;
    return true;
  }

  _smoothRotation(u) {
    let targetAngle = u.facingAngle;
    if ((u.isCasting || u.isCuring) && u.targetAngle !== undefined) {
      targetAngle = u.targetAngle;
    } else if (u.vx * u.vx + u.vz * u.vz > 0.0025) {
      targetAngle = Math.atan2(u.vx, u.vz);
    }

    const TWO_PI_MATH = Math.PI * 2;
    let diff = targetAngle - u.facingAngle;
    diff = ((diff + Math.PI) % TWO_PI_MATH + TWO_PI_MATH) % TWO_PI_MATH - Math.PI; 
    u.facingAngle += diff * 0.15;
  }

  _findNearestInfection(u, searchRadius, hystSq) {
    const utx = toTile(u.x), utz = toTile(u.z);
    let bestDist = Infinity;
    let bestTx = null, bestTz = null;

    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const tx = utx + dx, tz = utz + dz;
        if (infection.has(tileKey(tx, tz))) {
          const distSq = dx * dx + dz * dz;
          if (distSq < bestDist) {
            bestDist = distSq;
            bestTx = tx;
            bestTz = tz;
          }
        }
      }
    }

    if (bestTx !== null && u.targetTx !== null &&
        infection.has(tileKey(u.targetTx, u.targetTz))) {
      const curDx = u.targetTx - utx, curDz = u.targetTz - utz;
      const curDistSq = curDx * curDx + curDz * curDz;
      if (bestDist + hystSq >= curDistSq) return;
    }

    u.targetTx = bestTx;
    u.targetTz = bestTz;
  }

  _cullVisible(s, cullDistSq) {
    const sx = s.x, sz = s.z;
    const vis = this._visible;
    vis.length = 0;
    const cam = terrain._cam;
    for (let i = 0; i < this.agents.length; i++) {
      const u = this.agents[i];
      if ((u.x - sx) ** 2 + (u.z - sz) ** 2 > cullDistSq) continue;
      if (cam && !terrain.inFrustum(cam, u.x, u.z)) continue;
      vis.push(u);
    }
    return vis;
  }

  _steerTowardInfection(u, homeX, homeZ) {
    const dxFromHome = u.x - homeX;
    const dzFromHome = u.z - homeZ;
    const distFromHomeSq = dxFromHome * dxFromHome + dzFromHome * dzFromHome;
    
    // Enforce max wander distance: leash back to home.
    if (distFromHomeSq > this.config.maxWanderDistSq) {
      u.targetTx = null;
      u.targetTz = null;
      if (this.onWanderExceeded) this.onWanderExceeded(u);
      
      const d = Math.sqrt(distFromHomeSq);
      if (d > 0) {
        u.vx = lerp(u.vx || 0, (-dxFromHome / d) * this.config.speed, 0.15);
        u.vz = lerp(u.vz || 0, (-dzFromHome / d) * this.config.speed, 0.15);
      }
      return;
    }

    // Retarget periodically or when target is clean
    u._retargetTimer = (u._retargetTimer || 0) + 1;
    const needsRetarget = u.targetTx === null ||
      u._retargetTimer > 60 ||
      (u.targetTx !== null && !infection.has(tileKey(u.targetTx, u.targetTz)));
    
    if (needsRetarget) {
      u._retargetTimer = 0;
      this._findNearestInfection(u, this.config.searchRadius, this.config.targetHysteresisSq);
    }

    if (u.targetTx !== null) {
      const targetWx = u.targetTx * TILE + TILE * 0.5;
      const targetWz = u.targetTz * TILE + TILE * 0.5;
      const dx = targetWx - u.x;
      const dz = targetWz - u.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      
      if (d > this.config.stopDist) {
        u.vx = lerp(u.vx || 0, (dx / d) * this.config.speed, 0.15);
        u.vz = lerp(u.vz || 0, (dz / d) * this.config.speed, 0.15);
        if (this.onWalkToTarget) this.onWalkToTarget(u);
      } else {
        // Within range — stop and face target
        u.vx = 0;
        u.vz = 0;
        u.targetAngle = Math.atan2(dx, dz);
        if (this.onReachTarget) this.onReachTarget(u);
      }
    } else {
      // No target — wander slowly
      if (this.onNoTarget) this.onNoTarget(u);
      
      // Use Math.random since random is global p5
      if (typeof random !== 'undefined' ? random() < 0.02 : Math.random() < 0.02) {
        const angle = typeof random !== 'undefined' ? random(Math.PI * 2) : Math.random() * Math.PI * 2;
        u.vx = Math.cos(angle) * this.config.speed * this.config.wanderSpeedMult;
        u.vz = Math.sin(angle) * this.config.speed * this.config.wanderSpeedMult;
      }
    }
  }

  killAgent(u, idx) {
    if (this.onAgentDeath) this.onAgentDeath(u);
    swapRemove(this.agents, idx);
  }
}
