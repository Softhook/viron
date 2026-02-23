// === TERRAIN SHADERS ===
const TERRAIN_VERT = `
precision highp float;
attribute vec3 aPosition;
attribute vec4 aVertexColor;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
varying vec4 vColor;
varying vec4 vWorldPos;

void main() {
  vec4 viewSpace = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * viewSpace;
  vWorldPos = vec4(aPosition, 1.0);
  vColor = aVertexColor;
}
`;

const TERRAIN_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
varying vec4 vWorldPos;
uniform float uTime;
uniform vec4 uPulses[5];
uniform vec2 uFogDist;

void main() {  
  vec3 cyberColor = vec3(0.0);
  
  // Bomb drop pulses
  for (int i = 0; i < 5; i++) {
    float age = uTime - uPulses[i].z;
    if (age >= 0.0 && age < 3.0) { // Lasts for 3 seconds
      float type = uPulses[i].w;
      // Scale differences by 0.01 before taking length to avoid fp16 overflow on mobile
      vec2 diff = (vWorldPos.xz - uPulses[i].xy) * 0.01;
      float distToPulse = length(diff) * 100.0;
      
      float radius = type == 1.0 ? age * 300.0 : (type == 2.0 ? age * 1200.0 : age * 800.0); // type 2 is ship explosion
      float ringThickness = type == 1.0 ? 30.0 : (type == 2.0 ? 150.0 : 80.0);
      float ring = smoothstep(radius - ringThickness, radius, distToPulse) * (1.0 - smoothstep(radius, radius + ringThickness, distToPulse));
      
      float fade = 1.0 - (age / 3.0);
      vec3 pulseColor = type == 1.0 ? vec3(0.2, 0.6, 1.0) : (type == 2.0 ? vec3(1.0, 0.8, 0.2) : vec3(1.0, 0.1, 0.1)); // Blue crab, yellow ship, red bomb
      cyberColor += pulseColor * ring * fade * 2.0; 
    }
  }
  
  vec3 outColor = vColor.rgb + cyberColor;
  
  // Apply fog to smoothly hide chunk loading edges
  float dist = gl_FragCoord.z / gl_FragCoord.w;
  float fogFactor = smoothstep(uFogDist.x, uFogDist.y, dist);
  vec3 fogColor = vec3(30.0 / 255.0, 60.0 / 255.0, 120.0 / 255.0);
  outColor = mix(outColor, fogColor, fogFactor);

  gl_FragColor = vec4(outColor, vColor.a);
}
`;

// === TERRAIN CLASS ===
class Terrain {
  constructor() {
    this.altCache = new Map();
    this.chunkCache = new Map();
    this.shader = null;
    this.activePulses = [];
  }

  init() {
    this.shader = createShader(TERRAIN_VERT, TERRAIN_FRAG);
  }

  addPulse(x, z, type = 0.0) {
    this.activePulses = [{ x, z, start: millis() / 1000.0, type }, ...this.activePulses].slice(0, 5);
  }

  clearCaches() {
    if (this.altCache.size > 10000) this.altCache.clear();
    if (this.chunkCache.size > 200) this.chunkCache.clear();
  }

  inFrustum(cam, tx, tz) {
    let dx = tx - cam.x, dz = tz - cam.z;
    let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
    if (fwdDist < -TILE * 5) return false;
    let rightDist = dx * -cam.fwdZ + dz * cam.fwdX;
    let aspect = (numPlayers === 1 ? width : width * 0.5) / height;
    let slope = 0.57735 * aspect + 0.3;
    let halfWidth = (fwdDist > 0 ? fwdDist : 0) * slope + TILE * 6;
    return Math.abs(rightDist) <= halfWidth;
  }

  getCameraParams(s) {
    let fwdX = -sin(s.yaw), fwdZ = -cos(s.yaw);
    return {
      x: s.x - fwdX * 550,
      z: s.z - fwdZ * 550,
      fwdX: fwdX,
      fwdZ: fwdZ
    };
  }

  getGridAltitude(tx, tz) {
    let key = tileKey(tx, tz);
    let cached = this.altCache.get(key);
    if (cached !== undefined) return cached;

    let x = tx * TILE, z = tz * TILE;
    let alt;
    if (isLaunchpad(x, z)) {
      alt = LAUNCH_ALT;
    } else {
      let xs = x * 0.0008, zs = z * 0.0008;
      let elevation = noise(xs, zs) + 0.5 * noise(xs * 2.5, zs * 2.5) + 0.25 * noise(xs * 5, zs * 5);
      alt = 300 - Math.pow(elevation / 1.75, 2.0) * 550;
    }

    this.altCache.set(key, alt);
    return alt;
  }

  getAltitude(x, z) {
    if (isLaunchpad(x, z)) return LAUNCH_ALT;

    let tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    let fx = (x - tx * TILE) / TILE, fz = (z - tz * TILE) / TILE;

    if (fx === 0 && fz === 0) return this.getGridAltitude(tx, tz);

    let y00 = this.getGridAltitude(tx, tz);
    let y10 = this.getGridAltitude(tx + 1, tz);
    let y01 = this.getGridAltitude(tx, tz + 1);
    let y11 = this.getGridAltitude(tx + 1, tz + 1);

    if (fx + fz <= 1) return y00 + (y10 - y00) * fx + (y01 - y00) * fz;
    return y11 + (y01 - y11) * (1 - fx) + (y10 - y11) * (1 - fz);
  }

  getChunkGeometry(cx, cz) {
    let key = cx + ',' + cz;
    let cached = this.chunkCache.get(key);
    if (cached !== undefined) return cached;

    let geom = buildGeometry(() => {
      let startX = cx * CHUNK_SIZE;
      let startZ = cz * CHUNK_SIZE;

      beginShape(TRIANGLES);

      for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
        for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
          let xP = tx * TILE, zP = tz * TILE;
          let xP1 = xP + TILE, zP1 = zP + TILE;
          let y00 = this.getAltitude(xP, zP), y10 = this.getAltitude(xP1, zP);
          let y01 = this.getAltitude(xP, zP1), y11 = this.getAltitude(xP1, zP1);
          let avgY = (y00 + y10 + y01 + y11) * 0.25;
          let minY = Math.min(y00, y10, y01, y11);
          if (aboveSea(minY)) continue;

          let chk = (tx + tz) % 2 === 0;

          let baseR, baseG, baseB;
          let isSkirt = isLaunchpad(xP, zP) || isLaunchpad(xP1, zP) || isLaunchpad(xP, zP1) || isLaunchpad(xP1, zP1);

          if (isSkirt) {
            baseR = 255; baseG = 255; baseB = 255;
          } else {
            let rand = Math.abs(Math.sin(tx * 12.9898 + tz * 78.233)) * 43758.5453 % 1;
            if (avgY > SEA - 15) {
              let colors = [[230, 210, 80], [200, 180, 60], [150, 180, 50]];
              let col = colors[Math.floor(rand * 3)];
              baseR = col[0]; baseG = col[1]; baseB = col[2];
            } else {
              let colors = [
                [60, 180, 60], [30, 120, 40], [180, 200, 50],
                [220, 200, 80], [210, 130, 140], [180, 140, 70]
              ];
              let patch = noise(tx * 0.15, tz * 0.15);
              let colIdx = Math.floor((patch * 2.0 + rand * 0.2) * 6) % 6;
              let col = colors[colIdx];
              baseR = col[0]; baseG = col[1]; baseB = col[2];
            }
          }

          let finalR = chk ? baseR : baseR * 0.85;
          let finalG = chk ? baseG : baseG * 0.85;
          let finalB = chk ? baseB : baseB * 0.85;

          fill(finalR, finalG, finalB);
          vertex(xP, y00, zP); vertex(xP1, y10, zP); vertex(xP, y01, zP1);
          vertex(xP1, y10, zP); vertex(xP1, y11, zP1); vertex(xP, y01, zP1);
        }
      }
      endShape();
    });

    this.chunkCache.set(key, geom);
    return geom;
  }

  getSeaGeometry(seaSize, seaC, sx, sz) {
    return buildGeometry(() => {
      fill(seaC[0], seaC[1], seaC[2]);
      beginShape(TRIANGLES);
      let y = SEA + 3;
      let cx = toTile(sx) * TILE, cz = toTile(sz) * TILE;
      vertex(cx - seaSize, y, cz - seaSize);
      vertex(cx + seaSize, y, cz - seaSize);
      vertex(cx - seaSize, y, cz + seaSize);
      vertex(cx + seaSize, y, cz - seaSize);
      vertex(cx + seaSize, y, cz + seaSize);
      vertex(cx - seaSize, y, cz + seaSize);
      endShape();
    });
  }

  getFogColor(col, depth) {
    let fogEnd = VIEW_FAR * TILE + 400;
    let fogStart = VIEW_FAR * TILE - 800;
    let f = constrain(map(depth, fogStart, fogEnd, 0, 1), 0, 1);
    return [
      lerp(col[0], SKY_R, f),
      lerp(col[1], SKY_G, f),
      lerp(col[2], SKY_B, f)
    ];
  }

  applyShader() {
    shader(this.shader);
    this.shader.setUniform('uTime', millis() / 1000.0);
    this.shader.setUniform('uFogDist', [VIEW_FAR * TILE - 800, VIEW_FAR * TILE + 400]);

    let pulseArr = [];
    for (let i = 0; i < 5; i++) {
      if (i < this.activePulses.length) {
        pulseArr.push(this.activePulses[i].x, this.activePulses[i].z, this.activePulses[i].start, this.activePulses[i].type || 0.0);
      } else {
        pulseArr.push(0.0, 0.0, -9999.0, 0.0);
      }
    }
    this.shader.setUniform('uPulses', pulseArr);
  }

  drawLandscape(s) {
    let gx = toTile(s.x), gz = toTile(s.z);
    noStroke();

    let infected = [];
    let cam = this.getCameraParams(s);

    // Disable p5 lighting because it silently overrides custom shaders
    noLights();

    this.applyShader();

    let minCx = Math.floor((gx - VIEW_FAR) / CHUNK_SIZE);
    let maxCx = Math.floor((gx + VIEW_FAR) / CHUNK_SIZE);
    let minCz = Math.floor((gz - VIEW_FAR) / CHUNK_SIZE);
    let maxCz = Math.floor((gz + VIEW_FAR) / CHUNK_SIZE);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        let chunkWorldX = (cx + 0.5) * CHUNK_SIZE * TILE;
        let chunkWorldZ = (cz + 0.5) * CHUNK_SIZE * TILE;

        let dx = chunkWorldX - cam.x, dz = chunkWorldZ - cam.z;
        let fwdDist = dx * cam.fwdX + dz * cam.fwdZ;
        if (fwdDist < -CHUNK_SIZE * TILE * 1.5) continue;

        let geom = this.getChunkGeometry(cx, cz);
        model(geom);

        for (let tx = cx * CHUNK_SIZE; tx < (cx + 1) * CHUNK_SIZE; tx++) {
          for (let tz = cz * CHUNK_SIZE; tz < (cz + 1) * CHUNK_SIZE; tz++) {
            if (infectedTiles[tileKey(tx, tz)]) {
              let xP = tx * TILE, zP = tz * TILE;

              let xP1 = xP + TILE, zP1 = zP + TILE;
              let y00 = this.getAltitude(xP, zP) - 0.5, y10 = this.getAltitude(xP1, zP) - 0.5;
              let y01 = this.getAltitude(xP, zP1) - 0.5, y11 = this.getAltitude(xP1, zP1) - 0.5;

              let avgY = (this.getAltitude(xP, zP) + this.getAltitude(xP1, zP) + this.getAltitude(xP, zP1) + this.getAltitude(xP1, zP1)) * 0.25;
              let v = [xP, y00, zP, xP1, y10, zP, xP, y01, zP1, xP1, y10, zP, xP1, y11, zP1, xP, y01, zP1];

              let chk = (tx + tz) % 2 === 0;
              let pulse = sin(frameCount * 0.08 + tx * 0.5 + tz * 0.3) * 0.5 + 0.5;
              let af = map(avgY, -100, SEA, 1.15, 0.65);
              let base = chk ? [160, 255, 10, 40, 10, 25] : [120, 200, 5, 25, 5, 15];
              let ir = lerp(base[0], base[1], pulse) * af;
              let ig = lerp(base[2], base[3], pulse) * af;
              let ib = lerp(base[4], base[5], pulse) * af;

              infected.push({ v, r: ir, g: ig, b: ib });
            }
          }
        }
      }
    }

    if (infected.length) {
      beginShape(TRIANGLES);
      for (let t of infected) {
        fill(t.r, t.g, t.b);
        let v = t.v;
        vertex(v[0], v[1], v[2]); vertex(v[3], v[4], v[5]); vertex(v[6], v[7], v[8]);
        vertex(v[9], v[10], v[11]); vertex(v[12], v[13], v[14]); vertex(v[15], v[16], v[17]);
      }
      endShape();
    }

    let p = sin(frameCount * 0.03) * 8;
    let seaC = [15, 45 + p, 150 + p];
    let seaSize = VIEW_FAR * TILE * 1.5;
    let seaGeom = this.getSeaGeometry(seaSize, seaC, s.x, s.z);
    model(seaGeom);

    resetShader();
    setSceneLighting();

    // Draw Zarch missiles lined up on the right side of the launchpad
    push();
    let mX = LAUNCH_MAX - 100;
    for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
      let mDepth = (mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ;
      let bCol = this.getFogColor([60, 60, 60], mDepth);
      let mCol = this.getFogColor([255, 140, 20], mDepth);
      push();
      translate(mX, LAUNCH_ALT, mZ);
      fill(bCol[0], bCol[1], bCol[2]);
      push(); translate(0, -10, 0); box(30, 20, 30); pop();
      fill(mCol[0], mCol[1], mCol[2]);
      push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();
      pop();
    }
    pop();
  }

  drawTrees(s) {
    let treeCullDist = VIEW_FAR * TILE;
    let cullSq = treeCullDist * treeCullDist;
    let cam = this.getCameraParams(s);

    for (let t of trees) {
      let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, t.x, t.z)) continue;
      let y = this.getAltitude(t.x, t.z);
      if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

      push(); translate(t.x, y, t.z); noStroke();
      let { trunkH: h, canopyScale: sc, variant: vi } = t;
      let inf = !!infectedTiles[tileKey(toTile(t.x), toTile(t.z))];

      let depth = (t.x - cam.x) * cam.fwdX + (t.z - cam.z) * cam.fwdZ;
      let trCol = this.getFogColor([inf ? 80 : 100, inf ? 40 : 65, inf ? 20 : 25], depth);
      fill(trCol[0], trCol[1], trCol[2]);
      push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

      let tv = TREE_VARIANTS[vi];
      let c1Orig = inf ? tv.infected : tv.healthy;
      let c1Col = this.getFogColor(c1Orig, depth);
      fill(c1Col[0], c1Col[1], c1Col[2]);

      if (vi === 2) {
        push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
      } else {
        let cn = tv.cones[0];
        push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();

        if (tv.cones2) {
          let c2Orig = inf ? tv.infected2 : tv.healthy2;
          let c2Col = this.getFogColor(c2Orig, depth);
          fill(c2Col[0], c2Col[1], c2Col[2]);
          let cn2 = tv.cones2[0];
          push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
        }
      }

      if (dSq < 2250000) {
        push(); translate(0, -0.5, 8); rotateX(PI / 2); fill(0, 0, 0, 40); ellipse(0, 0, 20 * sc, 12 * sc); pop();
      }
      pop();
    }
  }

  drawBuildings(s) {
    let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
    let cam = this.getCameraParams(s);

    for (let b of buildings) {
      let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
      if (dSq >= cullSq || !this.inFrustum(cam, b.x, b.z)) continue;
      let y = this.getAltitude(b.x, b.z);
      if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

      let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];

      let depth = (b.x - cam.x) * cam.fwdX + (b.z - cam.z) * cam.fwdZ;
      push(); translate(b.x, y, b.z); noStroke();

      if (b.type === 0) {
        let bCol = inf ? [200, 50, 50] : [220, 220, 220];
        let bc = this.getFogColor(bCol, depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();

        let rCol = inf ? [150, 30, 30] : [220, 50, 50];
        let rc = this.getFogColor(rCol, depth);
        fill(rc[0], rc[1], rc[2]);
        push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();

      } else if (b.type === 1) {
        let bCol = inf ? [200, 50, 50] : [150, 160, 170];
        let bc = this.getFogColor(bCol, depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();

        let topCol = inf ? [150, 30, 30] : [80, 180, 220];
        let tc = this.getFogColor(topCol, depth);
        fill(tc[0], tc[1], tc[2]);
        push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();

      } else if (b.type === 2) {
        let bCol = inf ? [200, 50, 50] : b.col;
        let bc = this.getFogColor(bCol, depth);
        fill(bc[0], bc[1], bc[2]);
        push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
        push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();

        let sCol = inf ? [120, 20, 20] : [80, 80, 80];
        let sc = this.getFogColor(sCol, depth);
        fill(sc[0], sc[1], sc[2]);
        push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();
      } else {
        let bCol = inf ? [200, 50, 50] : [60, 180, 240];
        let bc = this.getFogColor(bCol, depth);
        fill(bc[0], bc[1], bc[2]);
        push();
        let floatY = y - b.h - 100 - sin(frameCount * 0.02 + b.x) * 50;
        translate(0, floatY - y, 0);
        rotateY(frameCount * 0.01 + b.x);
        rotateZ(frameCount * 0.015 + b.z);
        cone(b.w, b.h / 2, 4, 1);
        rotateX(PI);
        cone(b.w, b.h / 2, 4, 1);
        pop();
      }
      pop();

      if (dSq < 2250000) {
        drawShadow(b.x, y, b.z, b.w * 1.5, b.d * 1.5);
      }
    }
  }
}

const terrain = new Terrain();
