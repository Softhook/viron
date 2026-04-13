// =============================================================================
// enemyAirBehaviors.js — Stateless functions for airborne enemy AI
//
// Methods accept the current enemy entity and the context (the EnemyManager)
// to maintain explicit dependencies without relying on implicit 'this'.
//
// @exports   EnemyAirAI    — namespace: updateBomber(), updateSeeder(),
//                            updateFighter(), updateHunter(), etc.
// =============================================================================

import { p } from './p5Context.js';
import {
  ENEMY_BULLET_LIFE, BOMBER_DROP_INTERVAL_TICKS,
  FIGHTER_STATE_TOGGLE_TICKS, BOMBER_BOUNDARY_LIMIT,
  SEEDER_BOUNDARY_LIMIT, mag3
} from './constants.js';
import { physicsEngine } from './PhysicsEngine.js';
import { particleSystem } from './particles.js';
import { gameSFX } from './sfx.js';

export const EnemyAirAI = {

  updateBomber(e, refShip, ctx) {
    e.y += Math.sin(physicsEngine.tickCount * 0.02 + e.id);

    ctx._applyTerrainAvoidance(e, 200, 0.4);
    ctx._updateFlyingMovement(e, 0.92, 1.5);
    ctx._reflectWithinRefBounds(e, refShip, BOMBER_BOUNDARY_LIMIT);

    e.bombTimer++;
    if (e.bombTimer > BOMBER_DROP_INTERVAL_TICKS) {
      e.bombTimer = 0;
      ctx._tryDropBomb(e, 'mega', false);
    }
  },

  updateHunter(e, alivePlayers, refShip, ctx) {
    let tShip = ctx._getTargetShip(e, alivePlayers, refShip);
    ctx._steer3D(e, tShip.x, tShip.y, tShip.z, 5.0, 0.1);

    ctx._applyTerrainAvoidance(e, 100, 1.0);
    ctx._updateFlyingMovement(e);
  },

  updateFighter(e, alivePlayers, refShip, ctx) {
    let tShip = ctx._getTargetShip(e, alivePlayers, refShip);

    e.stateTimer = (e.stateTimer || 0) + 1;
    if (e.stateTimer > FIGHTER_STATE_TOGGLE_TICKS) {
      e.stateTimer = 0;
      e.aggressive = Math.random() > 0.5;
      if (!e.aggressive) {
        e.wanderX = e.x + p.random(-1500, 1500);
        e.wanderZ = e.z + p.random(-1500, 1500);
      }
    }

    let tx = e.aggressive ? tShip.x : (e.wanderX || e.x);
    let tz = e.aggressive ? tShip.z : (e.wanderZ || e.z);
    let ty = e.aggressive ? tShip.y : -600;

    let { dx, dy, dz, d } = ctx._steer3D(e, tx, ty, tz, 2.5, 0.05);

    ctx._applyTerrainAvoidance(e, 150, 0.5);
    ctx._updateFlyingMovement(e);

    e.fireTimer++;
    if (e.aggressive && d < 1200 && e.fireTimer > 90) {
      e.fireTimer = 0;
      let pvx = (dx / d) + p.random(-0.2, 0.2);
      let pvy = (dy / d) + p.random(-0.2, 0.2);
      let pvz = (dz / d) + p.random(-0.2, 0.2);
      let pd = mag3(pvx, pvy, pvz);
      particleSystem.enemyBullets.push({
        x: e.x, y: e.y, z: e.z,
        vx: (pvx / pd) * 10, vy: (pvy / pd) * 10, vz: (pvz / pd) * 10,
        life: ENEMY_BULLET_LIFE
      });
      gameSFX?.playEnemyShot('fighter', e.x, e.y, e.z);
    }

    if (!e.aggressive) {
      e.bombTimer = (e.bombTimer || 0) + 1;
      if (e.bombTimer > 300 && Math.random() < 0.002) {
        e.bombTimer = 0;
        ctx._tryDropBomb(e, 'normal', true);
      }
    }
  },

  updateSeeder(e, refShip, ctx) {
    e.y += Math.sin(physicsEngine.tickCount * 0.05 + e.id) * 2;

    ctx._applyTerrainAvoidance(e, 250, 0.3);
    ctx._updateFlyingMovement(e, 0.92);
    ctx._reflectWithinRefBounds(e, refShip, SEEDER_BOUNDARY_LIMIT);

    if (Math.random() < 0.008) {
      ctx._tryDropBomb(e, 'normal', true);
    }
  },

  updateSquid(e, alivePlayers, refShip, ctx) {
    let tShip = ctx._getTargetShip(e, alivePlayers, refShip);
    let { d } = ctx._steer3D(e, tShip.x, tShip.y, tShip.z, 3.5, 0.05);

    ctx._applyTerrainAvoidance(e, 150, 1.0);

    if (e.inkSqueeze && e.inkSqueeze > 0) e.inkSqueeze--;

    if (e.inkCooldown === undefined) e.inkCooldown = Math.floor(p.random(120, 200));
    e.inkCooldown--;
    if (e.inkCooldown <= 0) {
      let shouldSquirt = (d < 1500 && Math.random() < 0.4) || Math.random() < 0.05;
      if (shouldSquirt) {
        let vm = Math.max(mag3(e.vx || 0, e.vy || 0, e.vz || 0), 0.001);
        let bx = -(e.vx || 0) / vm, by = -(e.vy || 0) / vm, bz = -(e.vz || 0) / vm;
        
        const count = 3 + Math.floor(p.random(3));
        for (let i = 0; i < count; i++) {
          particleSystem.addFogParticle({
            x: e.x + bx * 34 + p.random(-20, 20),
            y: e.y + by * 20 + p.random(-20, 20),
            z: e.z + bz * 34 + p.random(-20, 20),
            vx: bx * (1.2 + p.random(0.5)) + p.random(-0.4, 0.4),
            vy: by * (0.8 + p.random(0.4)) + p.random(-0.3, 0.3),
            vz: bz * (1.2 + p.random(0.5)) + p.random(-0.4, 0.4),
            life: p.random(300, 400),
            decay: 0.9 + p.random(0.1),
            size: p.random(850, 1100),
            color: [1, 1, 2],
            isInkBurst: true
          });
        }
        
        e.inkSqueeze = 14;
        const recoil = 0.35;
        e.vx += (e.vx || 0) * recoil;
        e.vy += (e.vy || 0) * recoil;
        e.vz += (e.vz || 0) * recoil;
      }
      e.inkCooldown = Math.floor(p.random(180, 280));
    }

    ctx._updateFlyingMovement(e);
  }
};
