// =============================================================================
// enemyBossBehaviors.js — Stateless functions for Boss enemy AI
//
// @exports   EnemyBossAI   — namespace: updateColossus(), updateKraken()
// =============================================================================

const EnemyBossAI = {

  updateColossus(e, alivePlayers, refShip, ctx) {
    let tShip = ctx._getTargetShip(e, alivePlayers, refShip);
    let { d } = ctx._steer2D(e, tShip.x, tShip.z, 1.2, 0.025);

    const gyCo = ctx._moveOnGround(e, 0);

    if (e.hitFlash > 0) e.hitFlash--;

    ctx._updateBurstFire(e, tShip, d, {
      range: 2500,
      interval: 120,
      count: 3,
      spacing: 8,
      speed: 14,
      spread: 0.12,
      scaleKey: 'colossusScale',
      muzzleYFactor: 240,
      bulletLife: BOSS_BULLET_LIFE || 1200
    });

    if (Math.random() < 0.06) {
      ctx._tryInfectGround(e, gyCo, 'normal', 1.0, true);
    }
  },

  updateKraken(e, alivePlayers, refShip, ctx) {
    const tShip = ctx._getTargetShip(e, alivePlayers, refShip);
    let { d } = ctx._steer2D(e, tShip.x, tShip.z, 0.9, 0.018);

    const testX = e.x + e.vx;
    const testZ = e.z + e.vz;
    const gyTestX = typeof terrain !== 'undefined' && terrain ? terrain.getAltitude(testX, e.z) : 0;
    const gyTestZ = typeof terrain !== 'undefined' && terrain ? terrain.getAltitude(e.x, testZ) : 0;
    
    // Check if the tile is above sea level using the global helper aboveSea()
    if (typeof aboveSea !== 'undefined') {
      if (!aboveSea(gyTestX)) e.vx *= -1;
      if (!aboveSea(gyTestZ)) e.vz *= -1;
    }

    e.x += e.vx;
    e.z += e.vz;
    e.y = typeof SEA !== 'undefined' ? SEA : 0;

    if (e.hitFlash > 0) e.hitFlash--;

    ctx._updateBurstFire(e, tShip, d, {
      range: 3000,
      interval: 150,
      count: 3,
      spacing: 10,
      speed: 12,
      spread: 0.14,
      scaleKey: 'krakenScale',
      muzzleYFactor: 80,
      bulletLife: typeof BOSS_BULLET_LIFE !== 'undefined' ? BOSS_BULLET_LIFE : 1200
    });

    e._tentacleTimer = (e._tentacleTimer || 0) + 1;
    if (d < 2800 && e._tentacleTimer >= 220) {
      e._tentacleTimer = 0;
      const kScale = e.krakenScale || 1;
      const lashY = e.y - 40 * kScale;
      for (let t = 0; t < 4; t++) {
        const a = (t / 4) * (typeof TWO_PI !== 'undefined' ? TWO_PI : Math.PI * 2) + (Math.random() * 0.6 - 0.3);
        if (typeof particleSystem !== 'undefined') {
          particleSystem.enemyBullets.push({
            x: e.x, y: lashY, z: e.z,
            vx: Math.cos(a) * 8, vy: (Math.random() * -1), vz: Math.sin(a) * 8,
            life: typeof KRAKEN_TENTACLE_LIFE !== 'undefined' ? KRAKEN_TENTACLE_LIFE : 900
          });
        }
      }
      const adx = tShip.x - e.x, adz = tShip.z - e.z;
      const ad = typeof mag2 !== 'undefined' ? mag2(adx, adz) : Math.sqrt(adx*adx + adz*adz);
      if (ad > 0) {
        if (typeof particleSystem !== 'undefined') {
          particleSystem.enemyBullets.push({
            x: e.x, y: lashY, z: e.z,
            vx: (adx / ad) * 10, vy: -0.5, vz: (adz / ad) * 10,
            life: typeof KRAKEN_TENTACLE_LIFE !== 'undefined' ? KRAKEN_TENTACLE_LIFE : 900
          });
        }
      }
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, lashY, e.z);
    }
  }
};
