// Player ship physics and input handling
function createPlayer(id, keys, offsetX, labelColor) {
  let p = {
    id, keys, labelColor, score: 0, dead: false, respawnTimer: 0,
    bullets: [], homingMissiles: [], missilesRemaining: 1, mobileMissilePressed: false
  };
  resetShip(p, offsetX);
  return p;
}

function resetShip(p, offsetX) {
  p.ship = { x: offsetX, y: LAUNCH_ALT, z: 420, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 };
}

function shipUpDir(s) {
  let sp = sin(s.pitch), cp = cos(s.pitch), sy = sin(s.yaw), cy = cos(s.yaw);
  return { x: sp * -sy, y: -cp, z: sp * -cy };
}

function spawnProjectile(s, power, life) {
  let cp = cos(s.pitch), sp = sin(s.pitch);
  let cy = cos(s.yaw), sy = sin(s.yaw);

  // Front direction (local 0, 0, -1)
  let fx = -cp * sy;
  let fy = sp;
  let fz = -cp * cy;

  // Nose point with clearance: local (0, 10, -30)
  let lz = -30, ly = 10;
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

function fireMissile(p) {
  if (p.missilesRemaining > 0 && !p.dead) {
    p.missilesRemaining--;
    p.homingMissiles.push(spawnProjectile(p.ship, 8, 300));
    if (typeof gameSFX !== 'undefined') gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
  }
}

function updateShipInput(p) {
  if (p.dead) return;

  // Mouse movement (only for player 1 on non-mobile)
  if (p.id === 0 && !isMobile && document.pointerLockElement) {
    smoothedMX = lerp(smoothedMX, movedX, MOUSE_SMOOTHING);
    smoothedMY = lerp(smoothedMY, movedY, MOUSE_SMOOTHING);
    p.ship.yaw -= smoothedMX * MOUSE_SENSITIVITY;
    p.ship.pitch = constrain(p.ship.pitch - smoothedMY * MOUSE_SENSITIVITY, -PI / 2.2, PI / 2.2);
  }
  let k = p.keys;
  if (!leftMouseDown) mouseReleasedSinceStart = true;
  let isThrusting = keyIsDown(k.thrust) || (p.id === 0 && !isMobile && rightMouseDown);
  let isBraking = keyIsDown(k.brake);
  let isShooting = keyIsDown(k.shoot) || (p.id === 0 && !isMobile && leftMouseDown && mouseReleasedSinceStart);

  if (isMobile && p.id === 0 && typeof mobileController !== 'undefined') {
    let inputs = mobileController.getInputs(p.ship, enemies, YAW_RATE, PITCH_RATE);

    isThrusting = isThrusting || inputs.thrust;
    isShooting = isShooting || inputs.shoot;

    if (inputs.missile && !p.mobileMissilePressed) {
      fireMissile(p);
      p.mobileMissilePressed = true;
    } else if (!inputs.missile) {
      p.mobileMissilePressed = false;
    }

    p.ship.yaw += inputs.yawDelta;
    p.ship.pitch = constrain(p.ship.pitch + inputs.pitchDelta, -PI / 2.2, PI / 2.2);
  }

  if (keyIsDown(k.left)) p.ship.yaw += YAW_RATE;
  if (keyIsDown(k.right)) p.ship.yaw -= YAW_RATE;
  if (keyIsDown(k.pitchUp)) p.ship.pitch = constrain(p.ship.pitch + PITCH_RATE, -PI / 2.2, PI / 2.2);
  if (keyIsDown(k.pitchDown)) p.ship.pitch = constrain(p.ship.pitch - PITCH_RATE, -PI / 2.2, PI / 2.2);

  let s = p.ship;
  s.vy += GRAV;

  if (isThrusting) {
    let pw = 0.45;
    let dVec = shipUpDir(s);
    s.vx += dVec.x * pw; s.vy += dVec.y * pw; s.vz += dVec.z * pw;
    if (frameCount % 2 === 0) {
      particles.push({
        x: s.x, y: s.y, z: s.z,
        vx: -dVec.x * 8 + random(-1, 1), vy: -dVec.y * 8 + random(-1, 1), vz: -dVec.z * 8 + random(-1, 1),
        life: 255,
        decay: 10,
        seed: random(1.0),
        size: random(2, 6),
        color: [180, 140, 100]
      });
    }
  }

  if (isBraking) {
    s.vx *= 0.96; s.vy *= 0.96; s.vz *= 0.96;
  }

  if (isShooting && frameCount % 6 === 0) {
    p.bullets.push(spawnProjectile(s, 25, 300));
    if (typeof gameSFX !== 'undefined') gameSFX.playShot(s.x, s.y, s.z);
  }

  s.vx *= 0.985; s.vy *= 0.985; s.vz *= 0.985;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  let g = getAltitude(s.x, s.z);

  if (s.y > SEA - 12) {
    explosion(s.x, SEA, s.z);
    killPlayer(p);
    return;
  }

  if (s.y > g - 12) {
    if (s.vy > 2.8) killPlayer(p);
    else { s.y = g - 12; s.vy = 0; s.vx *= 0.8; s.vz *= 0.8; }
  }
}

function killPlayer(p) {
  explosion(p.ship.x, p.ship.y, p.ship.z);
  addPulse(p.ship.x, p.ship.z, 2.0);
  p.dead = true;
  p.respawnTimer = 120; // ~2 seconds at 60fps
  p.bullets = [];
}

function checkCollisions(p) {
  if (p.dead) return;
  let s = p.ship;

  // Enemy bullets vs player
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    let eb = enemyBullets[i];
    if ((eb.x - s.x) ** 2 + (eb.y - s.y) ** 2 + (eb.z - s.z) ** 2 < 4900) {
      explosion(s.x, s.y, s.z);
      killPlayer(p);
      enemyBullets.splice(i, 1);
      return;
    }
  }

  // Check all enemies against player projectiles and ship body
  for (let j = enemies.length - 1; j >= 0; j--) {
    let e = enemies[j];
    let killed = false;

    // Player Bullets vs Enemy
    for (let i = p.bullets.length - 1; i >= 0; i--) {
      let b = p.bullets[i];
      if ((b.x - e.x) ** 2 + (b.y - e.y) ** 2 + (b.z - e.z) ** 2 < 6400) {
        explosion(e.x, e.y, e.z, getEnemyColor(e.type), e.type);
        enemies.splice(j, 1);
        p.bullets.splice(i, 1);
        p.score += 100;
        killed = true;
        break;
      }
    }

    // Player Missiles vs Enemy
    if (!killed) {
      for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
        let m = p.homingMissiles[i];
        if ((m.x - e.x) ** 2 + (m.y - e.y) ** 2 + (m.z - e.z) ** 2 < 10000) {
          explosion(e.x, e.y, e.z, getEnemyColor(e.type), e.type);
          enemies.splice(j, 1);
          p.homingMissiles.splice(i, 1);
          p.score += 250;
          killed = true;
          break;
        }
      }
    }

    // Enemy body vs Player body
    if (!killed && ((s.x - e.x) ** 2 + (s.y - e.y) ** 2 + (s.z - e.z) ** 2 < 4900)) {
      killPlayer(p);
      return;
    }
  }

  // Powerup (Type 3 Building) vs Player
  for (let i = buildings.length - 1; i >= 0; i--) {
    let b = buildings[i];
    if (b.type === 3) {
      let bGnd = getAltitude(b.x, b.z);
      let floatY = bGnd - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
      let dx = s.x - b.x;
      let dy = s.y - floatY;
      let dz = s.z - b.z;
      let radiusSq = (b.w + 15) ** 2;

      if (dx * dx + dy * dy + dz * dz < radiusSq) {
        let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];
        if (inf) {
          if (p.missilesRemaining > 0) p.missilesRemaining--;
          if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(false, b.x, floatY, b.z);
        } else {
          p.missilesRemaining++;
          p.score += 500;
          if (typeof gameSFX !== 'undefined') gameSFX.playPowerup(true, b.x, floatY, b.z);
        }
        buildings.splice(i, 1);

        for (let j = 0; j < 20; j++) {
          particles.push({
            x: b.x, y: floatY, z: b.z,
            vx: random(-4, 4), vy: random(-4, 4), vz: random(-4, 4),
            life: 255, decay: 12, size: random(4, 9),
            color: inf ? [200, 50, 50] : [60, 180, 240]
          });
        }
      }
    }
  }

  // Bullet-tree: only infected trees absorb bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    for (let t of trees) {
      let ty = getAltitude(t.x, t.z);
      if ((b.x - t.x) ** 2 + (b.z - t.z) ** 2 < 3600 && b.y > ty - t.trunkH - 30 * t.canopyScale - 10 && b.y < ty + 10) {
        let tx = toTile(t.x), tz = toTile(t.z);
        if (infectedTiles[tileKey(tx, tz)]) {
          clearInfectionRadius(tx, tz);
          p.score += 200;
          p.bullets.splice(i, 1);
          break;
        }
      }
    }
  }
}

function shipDisplay(s, tintColor) {
  applyTerrainShader();
  noStroke();

  let cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
  let cx = Math.cos(s.pitch), sx = Math.sin(s.pitch);

  let transform = (pt) => {
    let x = pt[0], y = pt[1], z = pt[2];
    let y1 = y * cx - z * sx;
    let z1 = y * sx + z * cx;
    let x2 = x * cy + z1 * sy;
    let z2 = -x * sy + z1 * cy;
    return [x2 + s.x, y1 + s.y, z2 + s.z];
  };

  // Tint the ship slightly per-player
  let r = tintColor[0], g = tintColor[1], b = tintColor[2];
  let faces = [
    [lerp(200, r, 0.3), lerp(200, g, 0.3), lerp(200, b, 0.3),
    [-15, 10, 15], [15, 10, 15], [0, 10, -25]],
    [lerp(170, r, 0.2), lerp(170, g, 0.2), lerp(170, b, 0.2),
    [0, -10, 5], [-15, 10, 15], [0, 10, -25]],
    [lerp(150, r, 0.2), lerp(150, g, 0.2), lerp(150, b, 0.2),
    [0, -10, 5], [15, 10, 15], [0, 10, -25]],
    [lerp(130, r, 0.15), lerp(130, g, 0.15), lerp(130, b, 0.15),
    [0, -10, 5], [-15, 10, 15], [15, 10, 15]]
  ];
  for (let [cr, cg, cb, a, bf, d] of faces) {
    fill(cr, cg, cb); beginShape(); vertex(...transform(a)); vertex(...transform(bf)); vertex(...transform(d)); endShape(CLOSE);
  }

  resetShader();
  setSceneLighting();

  let gy = getAltitude(s.x, s.z);
  drawShipShadow(s.x, gy, s.z, s.yaw, s.y);
}
