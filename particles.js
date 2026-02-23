// === PARTICLE SYSTEM ===
class ParticleSystem {
  constructor() {
    this.particles = [];
    this.bombs = [];
    this.enemyBullets = [];
  }

  clear() {
    this.particles = [];
    this.bombs = [];
    this.enemyBullets = [];
  }

  addExplosion(x, y, z, baseColor, type) {
    if (typeof gameSFX !== 'undefined') {
      if (type) gameSFX.playExplosion(type === 'bomber' || type === 'mega', type, x, y, z);
      else gameSFX.playExplosion(baseColor === undefined || baseColor === null, '', x, y, z);
    }
    let isCustom = baseColor !== undefined && baseColor !== null;
    for (let i = 0; i < 350; i++) {
      let speed = random(5.0, 45.0);
      let a1 = random(TWO_PI);
      let a2 = random(TWO_PI);

      let br = 255, bg = 200, bb = 50;
      let er = 200, eg = 30, eb = 10;
      let sr = 40, sg = 20, sb = 20;

      if (isCustom) {
        let rV = baseColor[0] + random(-15, 15);
        let gV = baseColor[1] + random(-15, 15);
        let bV = baseColor[2] + random(-15, 15);

        if (random() > 0.6) {
          rV = lerp(rV, 255, 0.8);
          gV = lerp(gV, 255, 0.8);
          bV = lerp(bV, 255, 0.4);
        }

        br = constrain(rV, 0, 255); bg = constrain(gV, 0, 255); bb = constrain(bV, 0, 255);
        er = br * 0.8; eg = bg * 0.8; eb = bb * 0.8;
        sr = br * 0.3 + 10; sg = bg * 0.3 + 10; sb = bb * 0.3 + 10;
      }

      this.particles.push({
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

  updatePhysics() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      let p = this.particles[i];
      p.x += p.vx; p.y += p.vy; p.z += p.vz; p.life -= (p.decay || 10);
      p.vx *= 0.98; p.vy *= 0.98; p.vz *= 0.98;
      if (p.life <= 0) {
        let last = this.particles.pop();
        if (i < this.particles.length) this.particles[i] = last;
      }
    }
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      let b = this.bombs[i];
      b.y += 8;
      let gy = terrain.getAltitude(b.x, b.z);
      if (b.y > gy) {
        if (b.type === 'mega') {
          let tx = toTile(b.x), tz = toTile(b.z);
          let hitLP = false;
          for (let r = -4; r <= 4; r++) {
            for (let c = -4; c <= 4; c++) {
              if (r * r + c * c <= 16) {
                let nx = tx + r, nz = tz + c;
                if (aboveSea(terrain.getAltitude(nx * TILE, nz * TILE))) continue;
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
        terrain.addPulse(b.x, b.z, 0.0);
        if (typeof gameSFX !== 'undefined') gameSFX.playExplosion(b.type === 'mega', b.type === 'mega' ? 'bomber' : 'normal', b.x, b.y, b.z);
        this.bombs.splice(i, 1);
      }
    }
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      let b = this.enemyBullets[i];
      b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
      if (b.life <= 0 || b.y > terrain.getAltitude(b.x, b.z) || b.y > SEA) {
        this.enemyBullets.splice(i, 1);
      }
    }
  }

  render(camX, camZ) {
    let cullSq = (CULL_DIST * 0.6) * (CULL_DIST * 0.6);
    if (this.particles.length > 0) {
      noStroke();
      for (let p of this.particles) {
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
          let wave = 1400.0 * Math.pow(t, 0.6);
          let diff = wave - d;

          if (diff < -50) {
            alpha = 0;
            r = 0; g = 0; b = 0;
          } else if (diff < 40) {
            let f = (diff + 50) / 90;
            r = lerp(255, p.br, f);
            g = lerp(255, p.bg, f);
            b = lerp(255, p.bb, f);
          } else if (diff < 150) {
            let f = (diff - 40) / 110;
            r = lerp(p.br, p.er, f);
            g = lerp(p.bg, p.eg, f);
            b = lerp(p.bb, p.eb, f);
          } else if (diff < 350) {
            let f = (diff - 150) / 200;
            r = lerp(p.er, p.sr, f);
            g = lerp(p.eg, p.sg, f);
            b = lerp(p.eb, p.sb, f);
          } else {
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

    for (let b of this.bombs) {
      push(); translate(b.x, b.y, b.z); noStroke(); fill(200, 50, 50); box(8, 20, 8); pop();
    }
    for (let b of this.enemyBullets) {
      push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 80, 80); box(6); pop();
    }
  }
}

const particleSystem = new ParticleSystem();
