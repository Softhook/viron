// =============================================================================
// enemyGroundBehaviors.js — Stateless functions for ground-based enemy AI
//
// @exports   EnemyGroundAI   — namespace: updateCrab(), updateScorpion(),
//                              updateYellowCrab(), etc.
// =============================================================================

const EnemyGroundAI = {

  updateCrab(e, alivePlayers, refShip, ctx) {
    EnemyGroundAI._updateCrabAI(e, alivePlayers, refShip, ctx, 1.2, 0.02, 'normal', 1.0);
  },

  updateYellowCrab(e, alivePlayers, refShip, ctx) {
    EnemyGroundAI._updateCrabAI(e, alivePlayers, refShip, ctx, 1.5, 0.04, 'yellow', 1.0);
  },

  _updateCrabAI(e, alivePlayers, refShip, ctx, speed, infProb, infType, pulseType) {
    let tShip = ctx._getTargetShip(e, alivePlayers, refShip);
    let { d } = ctx._steer2D(e, tShip.x, tShip.z, speed, 0.05);

    const gyC = ctx._moveOnGround(e);

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      ctx._fireUpwardShot(e, 'crab');
    }

    if (Math.random() < infProb) {
      ctx._tryInfectGround(e, gyC, infType, pulseType);
    }
  },

  updateScorpion(e, alivePlayers, refShip, ctx) {
    const LP_CENTER = (LAUNCH_MIN + LAUNCH_MAX) / 2;

    let targetX, targetZ;

    if (isLaunchpad(e.x, e.z)) {
      let tShip = ctx._getTargetShip(e, alivePlayers, refShip);
      targetX = tShip.x;
      targetZ = tShip.z;
    } else {
      if (!e._skipSentinels) e._skipSentinels = new Map();
      for (const [s, expiry] of e._skipSentinels) {
        if (physicsEngine.tickCount >= expiry) e._skipSentinels.delete(s);
      }

      let bestDist = Infinity;
      targetX = null; targetZ = null;
      let chosen = null;
      for (let b of gameState.buildings) {
        if (b.type !== 4) continue;
        if (e._skipSentinels.has(b)) continue;
        const sk = tileKey(toTile(b.x), toTile(b.z));
        if (infection.has(sk)) continue;
        if (gameState.barrierTiles.has(sk)) continue;
        const distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
        if (distSq < bestDist) { bestDist = distSq; targetX = b.x; targetZ = b.z; chosen = b; }
      }

      if (chosen !== e._scorpionTarget) {
        e._scorpionTarget = chosen;
        e._scorpionStuckTicks = 0;
        e._scorpionPrevDistSq = chosen !== null
          ? (chosen.x - e.x) ** 2 + (chosen.z - e.z) ** 2
          : Infinity;
      } else if (chosen !== null) {
        const curDistSq = (chosen.x - e.x) ** 2 + (chosen.z - e.z) ** 2;
        if (curDistSq >= (e._scorpionPrevDistSq || Infinity)) {
          e._scorpionStuckTicks = (e._scorpionStuckTicks || 0) + 1;
        } else {
          e._scorpionStuckTicks = Math.max(0, (e._scorpionStuckTicks || 0) - 1);
        }
        e._scorpionPrevDistSq = curDistSq;
        if (e._scorpionStuckTicks > SCORPION_STUCK_THRESHOLD_TICKS) {
          e._skipSentinels.set(chosen, physicsEngine.tickCount + SCORPION_SKIP_DURATION_TICKS);
          e._scorpionTarget = null;
          e._scorpionStuckTicks = 0;
          e._scorpionPrevDistSq = Infinity;
          targetX = null; targetZ = null;
          let altBest = Infinity;
          for (let b of gameState.buildings) {
            if (b.type !== 4 || e._skipSentinels.has(b)) continue;
            const sk = tileKey(toTile(b.x), toTile(b.z));
            if (infection.has(sk) || gameState.barrierTiles.has(sk)) continue;
            const distSq = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
            if (distSq < altBest) { altBest = distSq; targetX = b.x; targetZ = b.z; }
          }
        }
      }

      if (targetX === null) {
        targetX = LP_CENTER;
        targetZ = LP_CENTER;
      }
    }

    ctx._steer2D(e, targetX, targetZ, 1.5, 0.04);
    const gyS = ctx._moveOnGround(e, -20);

    if (Math.random() < 0.025) {
      ctx._tryInfectGround(e, gyS);
    }

    e.fireTimer = (e.fireTimer || 0) + 1;
    let target = ctx._getTargetShip(e, alivePlayers, refShip);
    if (target) {
      let pd = mag2(target.x - e.x, target.z - e.z);
      if (pd < 1200 && e.fireTimer > 150) {
        e.fireTimer = 0;
        ctx._fireUpwardShot(e, 'crab', -10);
      }
    }
  },

  updateWolf(e, alivePlayers, refShip, ctx) {
    let targetX = null, targetZ = null;
    let bestDistSq = Infinity;

    if (typeof villagerManager !== 'undefined' && villagerManager) {
      for (let v of villagerManager.villagers) {
        const d2 = (v.x - e.x) ** 2 + (v.z - e.z) ** 2;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          targetX = v.x;
          targetZ = v.z;
        }
      }
    }

    if (targetX !== null && bestDistSq < 3600) {
      if (typeof villagerManager !== 'undefined' && villagerManager) {
        for (let i = villagerManager.villagers.length - 1; i >= 0; i--) {
          const v = villagerManager.villagers[i];
          if ((v.x - e.x) ** 2 + (v.z - e.z) ** 2 < 3600) {
            villagerManager.killVillagerAtIndex(i);
            break;
          }
        }
      }
    }

    if (targetX === null || bestDistSq > 800 * 800) {
      if (!e._wolfNextVillage) {
        let villageBest = Infinity;
        for (let b of gameState.buildings) {
          if (b.type !== 2) continue;
          if (b === e._wolfLastVillage) {
            const d2ToLast = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
            if (d2ToLast < 250 * 250) continue;
            else e._wolfLastVillage = null;
          }
          const d2 = (b.x - e.x) ** 2 + (b.z - e.z) ** 2;
          if (d2 < villageBest) {
            villageBest = d2;
            e._wolfNextVillage = b;
          }
        }
      }

      if (e._wolfNextVillage) {
        targetX = e._wolfNextVillage.x;
        targetZ = e._wolfNextVillage.z;
      }
    }

    if (e._wolfNextVillage) {
      const vd2 = (e._wolfNextVillage.x - e.x) ** 2 + (e._wolfNextVillage.z - e.z) ** 2;
      if (vd2 < 150 * 150) {
        e._wolfLastVillage = e._wolfNextVillage;
        e._wolfNextVillage = null;
      }
    }

    if (targetX === null) {
      const tShip = ctx._getTargetShip(e, alivePlayers, refShip);
      targetX = tShip.x;
      targetZ = tShip.z;
    }

    ctx._steer2D(e, targetX, targetZ, 2.0, 0.05);

    const gyW = ctx._moveOnGround(e);

    if (Math.random() < 0.03) {
      ctx._tryInfectGround(e, gyW, 'normal', 1.0, true);
    }
  }
};
