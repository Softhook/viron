// === ENEMY MANAGER ===
class EnemyManager {
  constructor() {
    this.enemies = [];
  }

  clear() {
    this.enemies = [];
  }

  getColor(type) {
    if (type === 'fighter') return [255, 150, 0];
    if (type === 'bomber') return [180, 20, 180];
    if (type === 'crab') return [200, 80, 20];
    if (type === 'hunter') return [40, 255, 40];
    if (type === 'squid') return [100, 100, 150];
    return [220, 30, 30];
  }

  spawn(forceSeeder = false) {
    let type = 'seeder';
    if (!forceSeeder && level > 0) {
      let r = random();
      if (r < 0.3) type = 'fighter';
      else if (r < 0.5) type = 'bomber';
      else if (r < 0.7) type = 'crab';
      else if (r < 0.8) type = 'hunter';
      else if (r < 0.9) type = 'squid';
    }
    let ex = random(-4000, 4000);
    let ez = random(-4000, 4000);
    let ey = random(-300, -800);
    if (type === 'crab') {
      ey = terrain.getAltitude(ex, ez) - 10;
    }
    this.enemies.push({
      x: ex, y: ey, z: ez,
      vx: random(-2, 2), vz: random(-2, 2), id: random(),
      type: type,
      fireTimer: 0,
      bombTimer: 0
    });
  }

  update() {
    let alivePlayers = players.filter(p => !p.dead).map(p => p.ship);
    let refShip = alivePlayers[0] || players[0].ship;

    for (let e of this.enemies) {
      if (e.type === 'fighter') this.updateFighter(e, alivePlayers, refShip);
      else if (e.type === 'bomber') this.updateBomber(e, refShip);
      else if (e.type === 'crab') this.updateCrab(e, alivePlayers, refShip);
      else if (e.type === 'hunter') this.updateHunter(e, alivePlayers, refShip);
      else if (e.type === 'squid') this.updateSquid(e, alivePlayers, refShip);
      else this.updateSeeder(e, refShip);
    }
  }

  updateBomber(e, refShip) {
    e.x += e.vx * 1.5; e.z += e.vz * 1.5; e.y += sin(frameCount * 0.02 + e.id);
    if (abs(e.x - refShip.x) > 4000) e.vx *= -1;
    if (abs(e.z - refShip.z) > 4000) e.vz *= -1;

    e.bombTimer++;
    if (e.bombTimer > 600) {
      e.bombTimer = 0;
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        particleSystem.bombs.push({ x: e.x, y: e.y, z: e.z, k: tileKey(tx, tz), type: 'mega' });
        if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop('mega', e.x, e.y, e.z);
      }
    }
  }

  updateCrab(e, alivePlayers, refShip) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dz = tShip.z - e.z;
    let d = Math.hypot(dx, dz);
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * 1.2, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * 1.2, 0.05);
    }

    e.x += e.vx; e.z += e.vz;

    let gy = terrain.getAltitude(e.x, e.z);
    e.y = gy - 10;

    e.fireTimer++;
    if (d < 1500 && e.fireTimer > 180) {
      e.fireTimer = 0;
      particleSystem.enemyBullets.push({
        x: e.x, y: e.y - 10, z: e.z,
        vx: 0, vy: -12, vz: 0, life: 100
      });
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('crab', e.x, e.y - 10, e.z);
    }

    if (random() < 0.02) {
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (!infectedTiles[k]) {
          infectedTiles[k] = { tick: frameCount };
          if (isLaunchpad(e.x, e.z)) {
            if (millis() - lastAlarmTime > 1000) {
              if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
              lastAlarmTime = millis();
            }
          }
          terrain.addPulse(e.x, e.z, 1.0);
        }
      }
    }
  }

  updateHunter(e, alivePlayers, refShip) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dy = tShip.y - e.y, dz = tShip.z - e.z;
    let d = Math.hypot(dx, dy, dz);
    let speed = 5.0;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.1);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.1);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.1);
    }
    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 50) e.vy -= 1.0;

    e.x += e.vx; e.y += e.vy; e.z += e.vz;
  }

  updateFighter(e, alivePlayers, refShip) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    e.stateTimer = (e.stateTimer || 0) + 1;
    if (e.stateTimer > 120) {
      e.stateTimer = 0;
      e.aggressive = random() > 0.5;
      if (!e.aggressive) {
        e.wanderX = e.x + random(-1500, 1500);
        e.wanderZ = e.z + random(-1500, 1500);
      }
    }

    let tx = e.aggressive ? tShip.x : (e.wanderX || e.x);
    let tz = e.aggressive ? tShip.z : (e.wanderZ || e.z);
    let ty = e.aggressive ? tShip.y : -600;

    let dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    let d = Math.hypot(dx, dy, dz);

    let speed = 2.5;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
    }

    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 150) e.vy -= 0.5;

    e.x += e.vx; e.y += e.vy; e.z += e.vz;

    e.fireTimer++;
    if (e.aggressive && d < 1200 && e.fireTimer > 90) {
      e.fireTimer = 0;
      let pvx = (dx / d) + random(-0.2, 0.2);
      let pvy = (dy / d) + random(-0.2, 0.2);
      let pvz = (dz / d) + random(-0.2, 0.2);
      let pd = Math.hypot(pvx, pvy, pvz);
      particleSystem.enemyBullets.push({
        x: e.x, y: e.y, z: e.z,
        vx: (pvx / pd) * 10, vy: (pvy / pd) * 10, vz: (pvz / pd) * 10, life: 120
      });
      if (typeof gameSFX !== 'undefined') gameSFX.playEnemyShot('fighter', e.x, e.y, e.z);
    }
  }

  updateSeeder(e, refShip) {
    e.x += e.vx; e.z += e.vz; e.y += sin(frameCount * 0.05 + e.id) * 2;
    if (abs(e.x - refShip.x) > 5000) e.vx *= -1;
    if (abs(e.z - refShip.z) > 5000) e.vz *= -1;

    if (random() < 0.008) {
      let gy = terrain.getAltitude(e.x, e.z);
      if (!aboveSea(gy)) {
        let tx = toTile(e.x), tz = toTile(e.z);
        let k = tileKey(tx, tz);
        if (!infectedTiles[k]) {
          particleSystem.bombs.push({ x: e.x, y: e.y, z: e.z, k: k });
          if (typeof gameSFX !== 'undefined') gameSFX.playBombDrop('normal', e.x, e.y, e.z);
        }
      }
    }
  }

  updateSquid(e, alivePlayers, refShip) {
    let target = findNearest(alivePlayers, e.x, e.y, e.z);
    let tShip = target || refShip;

    let dx = tShip.x - e.x, dy = tShip.y - e.y, dz = tShip.z - e.z;
    let d = Math.hypot(dx, dy, dz);
    let speed = 3.5;
    if (d > 0) {
      e.vx = lerp(e.vx || 0, (dx / d) * speed, 0.05);
      e.vy = lerp(e.vy || 0, (dy / d) * speed, 0.05);
      e.vz = lerp(e.vz || 0, (dz / d) * speed, 0.05);
    }
    let gy = terrain.getAltitude(e.x, e.z);
    if (e.y > gy - 150) e.vy -= 1.0;

    e.x += e.vx; e.y += e.vy; e.z += e.vz;

    if (frameCount % 5 === 0) {
      particleSystem.particles.push({
        x: e.x + random(-10, 10),
        y: e.y + random(-10, 10),
        z: e.z + random(-10, 10),
        isFog: true,
        vx: e.vx * 0.2 + random(-0.5, 0.5),
        vy: e.vy * 0.2 + random(-0.5, 0.5),
        vz: e.vz * 0.2 + random(-0.5, 0.5),
        life: 255,
        decay: 3,
        size: random(30, 80),
        color: [10, 10, 12]
      });
    }
  }

  draw(s) {
    let cam = terrain.getCameraParams(s);
    let cullSq = CULL_DIST * CULL_DIST;

    for (let e of this.enemies) {
      if ((e.x - s.x) ** 2 + (e.z - s.z) ** 2 > cullSq) continue;

      let depth = (e.x - cam.x) * cam.fwdX + (e.z - cam.z) * cam.fwdZ;

      push(); translate(e.x, e.y, e.z);

      if (e.type === 'crab') {
        translate(0, -10, 0);
      }

      scale(2);

      if (e.type === 'fighter') {
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) {
          let yaw = atan2(fvX, fvZ);
          rotateY(yaw);
          let pitch = asin(fvY / d);
          rotateX(-pitch);
        }
        noStroke();
        let ec = terrain.getFogColor([255, 150, 0], depth);
        fill(ec[0], ec[1], ec[2]);
        beginShape(TRIANGLES);
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(15, 0, -15);
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, -10, 0);
        vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, -10, 0);
        vertex(0, 0, 20); vertex(-15, 0, -15); vertex(0, 10, 0);
        vertex(0, 0, 20); vertex(15, 0, -15); vertex(0, 10, 0);
        endShape();
      } else if (e.type === 'bomber') {
        rotateY(frameCount * 0.05);
        noStroke();
        let bc = terrain.getFogColor([180, 20, 180], depth);
        fill(bc[0], bc[1], bc[2]);
        beginShape(TRIANGLES);
        vertex(0, -40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
        vertex(0, -40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
        vertex(0, -40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
        vertex(0, -40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
        vertex(0, 40, 0); vertex(-40, 0, -40); vertex(40, 0, -40);
        vertex(0, 40, 0); vertex(-40, 0, 40); vertex(40, 0, 40);
        vertex(0, 40, 0); vertex(-40, 0, -40); vertex(-40, 0, 40);
        vertex(0, 40, 0); vertex(40, 0, -40); vertex(40, 0, 40);
        endShape();
      } else if (e.type === 'crab') {
        let yaw = atan2(e.vx || 0, e.vz || 0);
        rotateY(yaw);
        noStroke();
        let cc = terrain.getFogColor([200, 80, 20], depth);
        let ccDark = terrain.getFogColor([150, 40, 10], depth);

        fill(cc[0], cc[1], cc[2]);
        push(); box(36, 16, 30); pop();
        push(); translate(0, -8, 0); box(24, 8, 20); pop();

        push();
        fill(10, 10, 10);
        translate(-8, -10, 15);
        box(4, 8, 4);
        translate(16, 0, 0);
        box(4, 8, 4);
        pop();

        fill(ccDark[0], ccDark[1], ccDark[2]);
        let walkPhase = frameCount * 0.3 + e.id;
        for (let side = -1; side <= 1; side += 2) {
          for (let i = -1; i <= 1; i++) {
            let legPhase = walkPhase + i * PI / 3 * side;
            let lift = max(0, sin(legPhase));
            let stride = cos(legPhase);

            push();
            translate(side * 16, 0, i * 10);
            rotateZ(side * (-0.2 - lift * 0.4));
            rotateY(stride * 0.3);
            translate(side * 10, -3, 0);
            box(20, 6, 6);
            translate(side * 8, 0, 0);
            rotateZ(side * 0.8);
            translate(side * 10, 0, 0);
            box(22, 4, 4);
            pop();
          }
        }

        fill(cc[0], cc[1], cc[2]);
        for (let side = -1; side <= 1; side += 2) {
          let pincerLift = sin(frameCount * 0.1 + e.id) * 0.1;
          push();
          translate(side * 16, 0, 14);
          rotateY(side * -0.6);
          rotateZ(side * (-0.3 + pincerLift));
          translate(side * 10, 0, 0);
          box(20, 6, 8);
          translate(side * 10, 0, 0);
          rotateY(side * -1.2);
          translate(side * 8, 0, 0);
          box(16, 8, 10);
          translate(side * 10, 0, 0);
          box(12, 10, 12);

          let nip = abs(sin(frameCount * 0.2 + e.id * 3)) * 0.5;
          push();
          translate(side * 6, 0, -4);
          rotateY(side * -nip);
          translate(side * 8, 0, 0);
          box(16, 5, 4);
          pop();

          push();
          translate(side * 6, 0, 4);
          rotateY(side * nip);
          translate(side * 8, 0, 0);
          box(16, 5, 4);
          pop();

          pop();
        }
      } else if (e.type === 'hunter') {
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) {
          rotateY(atan2(fvX, fvZ));
          rotateX(-asin(fvY / d));
        }
        noStroke();
        let hc = terrain.getFogColor([40, 255, 40], depth);
        fill(hc[0], hc[1], hc[2]);
        beginShape(TRIANGLES);
        vertex(0, 0, 30); vertex(-8, 0, -20); vertex(8, 0, -20);
        vertex(0, 0, 30); vertex(-8, 0, -20); vertex(0, -10, 0);
        vertex(0, 0, 30); vertex(8, 0, -20); vertex(0, -10, 0);
        endShape();
      } else if (e.type === 'squid') {
        let fvX = e.vx || 0.1, fvY = e.vy || 0, fvZ = e.vz || 0.1;
        let d = Math.hypot(fvX, fvY, fvZ);
        if (d > 0) {
          rotateY(atan2(fvX, fvZ));
          rotateX(-asin(fvY / d));
        }
        noStroke();
        let sqc = terrain.getFogColor([30, 30, 35], depth);
        fill(sqc[0], sqc[1], sqc[2]);

        push();
        rotateX(PI / 2);
        cylinder(12, 40, 8, 1);

        let tentaclePhase = frameCount * 0.1 + e.id;
        for (let i = 0; i < 8; i++) {
          push();
          let a = (i / 8) * TWO_PI;
          translate(sin(a) * 8, 20, cos(a) * 8);
          rotateX(sin(tentaclePhase + a) * 0.4);
          rotateZ(cos(tentaclePhase + a) * 0.4);
          translate(0, 15, 0);
          cylinder(2, 30, 4, 1);
          pop();
        }
        pop();
      } else {
        rotateY(frameCount * 0.15); noStroke();
        for (let [yOff, col] of [[-10, [220, 30, 30]], [6, [170, 15, 15]]]) {
          let oc = terrain.getFogColor(col, depth);
          fill(oc[0], oc[1], oc[2]);
          beginShape(TRIANGLES);
          vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(22, 0, 0);
          vertex(0, yOff, 25); vertex(-22, 0, 0); vertex(22, 0, 0);
          vertex(0, yOff, -25); vertex(-22, 0, 0); vertex(0, yOff, 25);
          vertex(0, yOff, -25); vertex(22, 0, 0); vertex(0, yOff, 25);
          endShape();
        }
        let cc = terrain.getFogColor([255, 60, 60], depth);
        fill(cc[0], cc[1], cc[2]);
        push(); translate(0, -14, 0); box(3, 14, 3); pop();
      }
      pop();

      let sSize = e.type === 'bomber' ? 60 : (e.type === 'fighter' || e.type === 'hunter' ? 25 : 40);
      drawShadow(e.x, terrain.getAltitude(e.x, e.z), e.z, sSize * 2, sSize * 2);
    }
  }
}

const enemyManager = new EnemyManager();
