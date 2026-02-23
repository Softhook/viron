// Particles, projectiles, and explosions
function updateParticlePhysics() {
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i];
    p.x += p.vx; p.y += p.vy; p.z += p.vz; p.life -= (p.decay || 10);
    p.vx *= 0.98; p.vy *= 0.98; p.vz *= 0.98; // Add drag to particles
    if (p.life <= 0) {
      let last = particles.pop();
      if (i < particles.length) particles[i] = last;
    }
  }
  for (let i = bombs.length - 1; i >= 0; i--) {
    let b = bombs[i];
    b.y += 8;
    let gy = getAltitude(b.x, b.z);
    if (b.y > gy) {
      if (b.type === 'mega') {
        let tx = toTile(b.x), tz = toTile(b.z);
        let hitLP = false;
        for (let r = -4; r <= 4; r++) {
          for (let c = -4; c <= 4; c++) {
            if (r * r + c * c <= 16) {
              let nx = tx + r, nz = tz + c;
              if (aboveSea(getAltitude(nx * TILE, nz * TILE))) continue;
              let nk = tileKey(nx, nz);
              if (!infectedTiles[nk]) {
                infectedTiles[nk] = { tick: frameCount };
                if (isLaunchpad(nx * TILE, nz * TILE)) hitLP = true;
              }
            }
          }
        }
        if (hitLP && millis() - lastAlarmTime > 1000) {
          if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
          lastAlarmTime = millis();
        }
      } else {
        if (!infectedTiles[b.k]) {
          infectedTiles[b.k] = { tick: frameCount };
          if (isLaunchpad(b.x, b.z)) {
            if (millis() - lastAlarmTime > 1000) {
              if (typeof gameSFX !== 'undefined') gameSFX.playAlarm();
              lastAlarmTime = millis();
            }
          }
        }
      }
      addPulse(b.x, b.z, 0.0);
      if (typeof gameSFX !== 'undefined') gameSFX.playExplosion(b.type === 'mega', b.type === 'mega' ? 'bomber' : 'normal', b.x, b.y, b.z);
      bombs.splice(i, 1);
    }
  }
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    let b = enemyBullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    if (b.life <= 0 || b.y > getAltitude(b.x, b.z) || b.y > SEA) {
      enemyBullets.splice(i, 1);
    }
  }
}

function updateProjectilePhysics(p) {
  // Bullets
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];
    b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    if (b.life <= 0) {
      p.bullets.splice(i, 1);
    } else if (b.y > getAltitude(b.x, b.z)) {
      clearInfectionAt(b.x, b.z, p);
      p.bullets.splice(i, 1);
    }
  }

  // Homing missiles
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i];
    const maxSpd = 10;

    let target = findNearest(enemies, m.x, m.y, m.z);
    if (target) {
      let dx = target.x - m.x, dy = target.y - m.y, dz = target.z - m.z;
      let mg = Math.hypot(dx, dy, dz);
      if (mg > 0) {
        let bl = 0.12;
        m.vx = lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = lerp(m.vz, (dz / mg) * maxSpd, bl);
      }
    }

    let sp = Math.hypot(m.vx, m.vy, m.vz);
    if (sp > 0) {
      m.vx = (m.vx / sp) * maxSpd;
      m.vy = (m.vy / sp) * maxSpd;
      m.vz = (m.vz / sp) * maxSpd;
    }

    m.x += m.vx; m.y += m.vy; m.z += m.vz; m.life--;

    if (frameCount % 2 === 0) {
      particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5),
        life: 120,
        decay: 5,
        seed: random(1.0),
        size: random(2, 5)
      });
    }

    let gnd = getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        explosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, p);
      }
      p.homingMissiles.splice(i, 1);
    }
  }
}

function renderParticles(camX, camZ) {
  let cullSq = (CULL_DIST * 0.6) * (CULL_DIST * 0.6);
  if (particles.length > 0) {
    noStroke();
    for (let p of particles) {
      if ((p.x - camX) ** 2 + (p.z - camZ) ** 2 > cullSq) continue;

      let seed = p.seed || 1.0;
      let lifeNorm = p.life / 255.0;
      let t = 1.0 - lifeNorm;

      let kr = (5 + seed * 6) % 6;
      let kg = (3 + seed * 6) % 6;
      let kb = (1 + seed * 6) % 6;
      let vr = 255 * (1 - Math.max(Math.min(kr, 4 - kr, 1), 0));
      let vg = 255 * (1 - Math.max(Math.min(kg, 4 - kg, 1), 0));
      let vb = 255 * (1 - Math.max(Math.min(kb, 4 - kb, 1), 0));

      let r, g, b;
      let alpha = (lifeNorm < 0.4) ? (lifeNorm / 0.4) * 255 : 255;
      if (p.isFog) alpha = alpha * 0.9;

      if (p.isExplosion) {
        let d = Math.hypot(p.x - p.cx, p.y - p.cy, p.z - p.cz);
        let wave = 1400.0 * Math.pow(t, 0.6); // Expanding shockwave logic
        let diff = wave - d; // Negative if in front of wave, positive if behind

        if (diff < -50) {
          // In front of shockwave -> transparent
          alpha = 0;
          r = 0; g = 0; b = 0;
        } else if (diff < 40) {
          // Leading edge -> white/yellow hot
          let f = (diff + 50) / 90;
          r = lerp(255, p.br, f);
          g = lerp(255, p.bg, f);
          b = lerp(255, p.bb, f);
        } else if (diff < 150) {
          // Fire band -> main color
          let f = (diff - 40) / 110;
          r = lerp(p.br, p.er, f);
          g = lerp(p.bg, p.eg, f);
          b = lerp(p.bb, p.eb, f);
        } else if (diff < 350) {
          // Trailing band -> dark color/smoke
          let f = (diff - 150) / 200;
          r = lerp(p.er, p.sr, f);
          g = lerp(p.eg, p.sg, f);
          b = lerp(p.eb, p.sb, f);
        } else {
          // Lingering smoke in core
          r = p.sr; g = p.sg; b = p.sb;
        }
      } else if (p.color) {
        let f = Math.min(t * 1.5, 1.0);
        r = lerp(p.color[0], 30, f);
        g = lerp(p.color[1], 30, f);
        b = lerp(p.color[2], 30, f);
      } else {
        if (t < 0.15) {
          let f = t / 0.15;
          r = lerp(255, vr, f); g = lerp(255, vg, f); b = lerp(255, vb, f);
        } else if (t < 0.6) {
          let f = (t - 0.15) / 0.45;
          r = lerp(vr, vr * 0.4, f); g = lerp(vg, vg * 0.4, f); b = lerp(vb, vb * 0.4, f);
        } else {
          let f = (t - 0.6) / 0.4;
          r = lerp(vr * 0.4, 15, f); g = lerp(vg * 0.4, 15, f); b = lerp(vb * 0.4, 15, f);
        }
      }


      push(); translate(p.x, p.y, p.z);
      fill(r, g, b, alpha);
      box(p.size || 8);
      pop();
    }
  }

  for (let b of bombs) {
    push(); translate(b.x, b.y, b.z); noStroke(); fill(200, 50, 50); box(8, 20, 8); pop();
  }
  for (let b of enemyBullets) {
    push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 80, 80); box(6); pop();
  }
}

function renderProjectiles(p, camX, camZ) {
  let cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  // Bullets
  for (let b of p.bullets) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); noStroke();
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2]);
    box(6); pop();
  }

  // Homing missiles
  for (let m of p.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;
    push(); translate(m.x, m.y, m.z); noStroke(); fill(0, 200, 255); box(10); pop();
  }
}

function explosion(x, y, z, baseColor, type) {
  if (typeof gameSFX !== 'undefined') {
    if (type) gameSFX.playExplosion(type === 'bomber' || type === 'mega', type, x, y, z);
    else gameSFX.playExplosion(baseColor === undefined || baseColor === null, '', x, y, z);
  }
  let isCustom = baseColor !== undefined && baseColor !== null;
  // Increase particle count significantly, adjust size, speed, and decay for massive blasts
  for (let i = 0; i < 350; i++) {
    let speed = random(5.0, 45.0);
    let a1 = random(TWO_PI);
    let a2 = random(TWO_PI);

    let br = 255, bg = 200, bb = 50;
    let er = 200, eg = 30, eb = 10;
    let sr = 40, sg = 20, sb = 20;

    if (isCustom) {
      // Base variation stays close to pure enemy color to prevent grey muddying
      let rV = baseColor[0] + random(-15, 15);
      let gV = baseColor[1] + random(-15, 15);
      let bV = baseColor[2] + random(-15, 15);

      if (random() > 0.6) {
        // High core heat: Add intense white/core color
        rV = lerp(rV, 255, 0.8);
        gV = lerp(gV, 255, 0.8);
        bV = lerp(bV, 255, 0.4);
      }

      br = constrain(rV, 0, 255); bg = constrain(gV, 0, 255); bb = constrain(bV, 0, 255);

      // Keep fire band deeply saturated (only dim a bit, not 50%)
      er = br * 0.8; eg = bg * 0.8; eb = bb * 0.8;

      // Transition to a tinted dark shadow instead of grey smoke
      sr = br * 0.3 + 10; sg = bg * 0.3 + 10; sb = bb * 0.3 + 10;
    }

    particles.push({
      x, y, z,
      cx: x, cy: y, cz: z,
      isExplosion: true,
      hasExpColor: isCustom,
      br, bg, bb,
      er, eg, eb,
      sr, sg, sb,
      vx: speed * sin(a1) * cos(a2),
      vy: speed * sin(a1) * sin(a2),
      vz: speed * cos(a1),
      life: 255,
      decay: random(2.0, 6.0),
      size: random(8, 26)
    });
  }
}
