// Terrain generation and rendering
// Multi-sine terrain: irrational frequency ratios ensure non-repetition
function getGridAltitude(tx, tz) {
  let key = tileKey(tx, tz);
  let cached = altCache.get(key);
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

  altCache.set(key, alt);
  return alt;
}

function getAltitude(x, z) {
  if (isLaunchpad(x, z)) return LAUNCH_ALT;

  let tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  let fx = (x - tx * TILE) / TILE, fz = (z - tz * TILE) / TILE;

  if (fx === 0 && fz === 0) return getGridAltitude(tx, tz);

  let y00 = getGridAltitude(tx, tz);
  let y10 = getGridAltitude(tx + 1, tz);
  let y01 = getGridAltitude(tx, tz + 1);
  let y11 = getGridAltitude(tx + 1, tz + 1);

  if (fx + fz <= 1) return y00 + (y10 - y00) * fx + (y01 - y00) * fz;
  return y11 + (y01 - y11) * (1 - fx) + (y10 - y11) * (1 - fz);
}

function getChunkGeometry(cx, cz) {
  let key = cx + ',' + cz;
  let cached = chunkCache.get(key);
  if (cached !== undefined) return cached;

  let geom = buildGeometry(() => {
    let startX = cx * CHUNK_SIZE;
    let startZ = cz * CHUNK_SIZE;

    beginShape(TRIANGLES);

    for (let tz = startZ; tz < startZ + CHUNK_SIZE; tz++) {
      for (let tx = startX; tx < startX + CHUNK_SIZE; tx++) {
        let xP = tx * TILE, zP = tz * TILE;
        let xP1 = xP + TILE, zP1 = zP + TILE;
        let y00 = getAltitude(xP, zP), y10 = getAltitude(xP1, zP);
        let y01 = getAltitude(xP, zP1), y11 = getAltitude(xP1, zP1);
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

  chunkCache.set(key, geom);
  return geom;
}

function getFogColor(col, depth) {
  let fogEnd = VIEW_FAR * TILE + 400; // right at the edge
  let fogStart = VIEW_FAR * TILE - 800;
  let f = constrain(map(depth, fogStart, fogEnd, 0, 1), 0, 1);
  return [
    lerp(col[0], SKY_R, f),
    lerp(col[1], SKY_G, f),
    lerp(col[2], SKY_B, f)
  ];
}

function applyTerrainShader() {
  shader(terrainShader);
  terrainShader.setUniform('uTime', millis() / 1000.0);
  terrainShader.setUniform('uFogDist', [VIEW_FAR * TILE - 800, VIEW_FAR * TILE + 400]);

  let pulseArr = [];
  for (let i = 0; i < 5; i++) {
    if (i < activePulses.length) {
      pulseArr.push(activePulses[i].x, activePulses[i].z, activePulses[i].start, activePulses[i].type || 0.0);
    } else {
      pulseArr.push(0.0, 0.0, -9999.0, 0.0);
    }
  }
  terrainShader.setUniform('uPulses', pulseArr);
}

function drawLandscape(s) {
  let gx = toTile(s.x), gz = toTile(s.z);
  noStroke();

  let infected = [];
  let cam = getCameraParams(s);

  // Disable p5 lighting because it silently overrides custom shaders that don't declare lighting uniforms
  noLights();

  applyTerrainShader();

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
      // Frustum culling at chunk level roughly
      if (fwdDist < -CHUNK_SIZE * TILE * 1.5) continue;

      let geom = getChunkGeometry(cx, cz);
      model(geom);

      // Collect infected tiles (these update dynamically and pulse per frame)
      for (let tx = cx * CHUNK_SIZE; tx < (cx + 1) * CHUNK_SIZE; tx++) {
        for (let tz = cz * CHUNK_SIZE; tz < (cz + 1) * CHUNK_SIZE; tz++) {
          if (infectedTiles[tileKey(tx, tz)]) {
            let xP = tx * TILE, zP = tz * TILE;
            let cxTile = xP + TILE * 0.5, czTile = zP + TILE * 0.5;
            let dSq = (cam.x - cxTile) * (cam.x - cxTile) + (cam.z - czTile) * (cam.z - czTile);
            let d = Math.sqrt(dSq);

            let xP1 = xP + TILE, zP1 = zP + TILE;
            let y00 = getAltitude(xP, zP) - 0.5, y10 = getAltitude(xP1, zP) - 0.5;
            let y01 = getAltitude(xP, zP1) - 0.5, y11 = getAltitude(xP1, zP1) - 0.5;

            let avgY = (getAltitude(xP, zP) + getAltitude(xP1, zP) + getAltitude(xP, zP1) + getAltitude(xP1, zP1)) * 0.25;
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

  // Draw infected tiles
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
  let seaGeom = getSeaGeometry(seaSize, seaC, s.x, s.z);
  model(seaGeom);

  // Restore lighting for standard objects
  resetShader();
  setSceneLighting();

  // Draw Zarch missiles lined up on the right side of the launchpad
  push();
  let mX = LAUNCH_MAX - 100;
  for (let mZ = LAUNCH_MIN + 200; mZ <= LAUNCH_MAX - 200; mZ += 120) {
    let mDepth = (mX - cam.x) * cam.fwdX + (mZ - cam.z) * cam.fwdZ;
    let bCol = getFogColor([60, 60, 60], mDepth);
    let mCol = getFogColor([255, 140, 20], mDepth);
    push();
    translate(mX, LAUNCH_ALT, mZ);
    // Base/stand
    fill(bCol[0], bCol[1], bCol[2]);
    push(); translate(0, -10, 0); box(30, 20, 30); pop();
    // Missile body
    fill(mCol[0], mCol[1], mCol[2]);
    push(); translate(0, -70, 0); rotateX(Math.PI); cone(18, 100, 4, 1); pop();
    pop();
  }
  pop();
}

function getSeaGeometry(seaSize, seaC, sx, sz) {
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

function drawTrees(s) {
  let treeCullDist = VIEW_FAR * TILE;
  let cullSq = treeCullDist * treeCullDist;
  let cam = getCameraParams(s);

  for (let t of trees) {
    let dSq = (s.x - t.x) ** 2 + (s.z - t.z) ** 2;
    if (dSq >= cullSq || !inFrustum(cam, t.x, t.z)) continue;
    let y = getAltitude(t.x, t.z);
    if (aboveSea(y) || isLaunchpad(t.x, t.z)) continue;

    push(); translate(t.x, y, t.z); noStroke();
    let { trunkH: h, canopyScale: sc, variant: vi } = t;
    let inf = !!infectedTiles[tileKey(toTile(t.x), toTile(t.z))];

    // Trunk
    let depth = (t.x - cam.x) * cam.fwdX + (t.z - cam.z) * cam.fwdZ;
    let trCol = getFogColor([inf ? 80 : 100, inf ? 40 : 65, inf ? 20 : 25], depth);
    fill(trCol[0], trCol[1], trCol[2]);
    push(); translate(0, -h / 2, 0); box(5, h, 5); pop();

    // Canopy
    let tv = TREE_VARIANTS[vi];
    let c1Orig = inf ? tv.infected : tv.healthy;
    let c1Col = getFogColor(c1Orig, depth);
    fill(c1Col[0], c1Col[1], c1Col[2]);

    if (vi === 2) {
      push(); translate(0, -h, 0); cone(35 * sc, 15 * sc, 6, 1); pop();
    } else {
      let cn = tv.cones[0];
      push(); translate(0, -h - cn[2] * sc, 0); cone(cn[0] * sc, cn[1] * sc, 4, 1); pop();

      if (tv.cones2) {
        let c2Orig = inf ? tv.infected2 : tv.healthy2;
        let c2Col = getFogColor(c2Orig, depth);
        fill(c2Col[0], c2Col[1], c2Col[2]);
        let cn2 = tv.cones2[0];
        push(); translate(0, -h - cn2[2] * sc, 0); cone(cn2[0] * sc, cn2[1] * sc, 4, 1); pop();
      }
    }

    // Shadow (only close trees)
    if (dSq < 2250000) {
      push(); translate(0, -0.5, 8); rotateX(PI / 2); fill(0, 0, 0, 40); ellipse(0, 0, 20 * sc, 12 * sc); pop();
    }
    pop();
  }
}

function drawBuildings(s) {
  let cullSq = VIEW_FAR * TILE * VIEW_FAR * TILE;
  let cam = getCameraParams(s);

  for (let b of buildings) {
    let dSq = (s.x - b.x) ** 2 + (s.z - b.z) ** 2;
    if (dSq >= cullSq || !inFrustum(cam, b.x, b.z)) continue;
    let y = getAltitude(b.x, b.z);
    if (aboveSea(y) || isLaunchpad(b.x, b.z)) continue;

    let inf = !!infectedTiles[tileKey(toTile(b.x), toTile(b.z))];

    let depth = (b.x - cam.x) * cam.fwdX + (b.z - cam.z) * cam.fwdZ;
    push(); translate(b.x, y, b.z); noStroke();

    if (b.type === 0) {
      let bCol = inf ? [200, 50, 50] : [220, 220, 220];
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 2, 0); box(b.w, b.h, b.d); pop();

      let rCol = inf ? [150, 30, 30] : [220, 50, 50];
      let rc = getFogColor(rCol, depth);
      fill(rc[0], rc[1], rc[2]);
      push(); translate(0, -b.h - b.w / 3, 0); rotateY(PI / 4); cone(b.w * 0.8, b.w / 1.5, 4, 1); pop();

    } else if (b.type === 1) {
      let bCol = inf ? [200, 50, 50] : [150, 160, 170];
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 2, 0); cylinder(b.w / 2, b.h, 8, 1); pop();

      let topCol = inf ? [150, 30, 30] : [80, 180, 220];
      let tc = getFogColor(topCol, depth);
      fill(tc[0], tc[1], tc[2]);
      push(); translate(0, -b.h, 0); sphere(b.w / 2, 8, 8); pop();

    } else if (b.type === 2) {
      let bCol = inf ? [200, 50, 50] : b.col;
      let bc = getFogColor(bCol, depth);
      fill(bc[0], bc[1], bc[2]);
      push(); translate(0, -b.h / 4, 0); box(b.w * 1.5, b.h / 2, b.d * 1.5); pop();
      push(); translate(b.w * 0.3, -b.h / 2 - b.h / 8, -b.d * 0.2); box(b.w / 2, b.h / 4, b.d / 2); pop();

      let sCol = inf ? [120, 20, 20] : [80, 80, 80];
      let sc = getFogColor(sCol, depth);
      fill(sc[0], sc[1], sc[2]);
      push(); translate(-b.w * 0.4, -b.h, b.d * 0.4); cylinder(b.w * 0.15, b.h, 8, 1); pop();
    } else {
      let bCol = inf ? [200, 50, 50] : [60, 180, 240];
      let bc = getFogColor(bCol, depth);
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

function drawShadow(x, groundY, z, w, h) {
  if (aboveSea(groundY)) return;
  push();
  translate(x, groundY - 0.5, z);
  rotateX(PI / 2);
  fill(0, 0, 0, 50);
  ellipse(0, 0, w, h);
  pop();
}

function drawShipShadow(x, groundY, z, yaw, alt) {
  if (aboveSea(groundY)) return;
  let spread = max(1, (groundY - alt) * 0.012);
  let alpha = map(groundY - alt, 0, 600, 60, 15, true);
  push();
  translate(x, groundY - 0.3, z);
  rotateY(yaw);
  noStroke();
  fill(0, 0, 0, alpha);
  beginShape();
  vertex(-15 * spread, 0, 15 * spread);
  vertex(15 * spread, 0, 15 * spread);
  vertex(0, 0, -25 * spread);
  endShape(CLOSE);
  pop();
}
