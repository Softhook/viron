// =============================================================================
// hudComponents.js — Reusable HUD elements and player-view components
// =============================================================================

/**
 * Transforms world coordinates to radar-local coordinates relative to the ship.
 * @private
 */
function _projectToRadar(wx, wz, ship, sinYaw, cosYaw) {
  const dx = (wx - ship.x) * RADAR_SCALE;
  const dz = (wz - ship.z) * RADAR_SCALE;
  return [
    dx * cosYaw - dz * sinYaw,
    dx * sinYaw + dz * cosYaw
  ];
}

/**
 * Returns a cached p5.Graphics buffer for the weapon selector UI panel.
 * @private
 */
function _getWeaponSelectorGraphic(p) {
  const W = 220, H = 50;
  const key = `${p.id}`;
  let entry = HUD_WEAPON_BUFFERS[key];

  if (!entry || entry.weaponMode !== p.weaponMode) {
    if (!entry) {
      const g = createGraphics(W, H);
      g.pixelDensity(1);
      entry = { g, weaponMode: -1 };
      HUD_WEAPON_BUFFERS[key] = entry;
    }
    entry.weaponMode = p.weaponMode;

    const wId = p.weaponMode;
    const wName = HUD_WEAPON_LABELS[wId];
    const wCol = HUD_WEAPON_ACTIVE_COLS[wId];
    const g = entry.g;

    g.clear();
    g.noStroke();
    if (gameState.gameFont) g.textFont(gameState.gameFont);

    g.textAlign(CENTER, TOP);
    g.textSize(18);
    g.fill(wCol[0], wCol[1], wCol[2], 230);
    g.text(wName, W / 2, 10);

    const bw = 60, bh = 6, pad = 8;
    const totalW = (bw + pad) * 3 - pad;
    const sx = (W - totalW) / 2;
    g.rectMode(CORNER);
    for (let i = 0; i < 3; i++) {
        if (i === wId) g.fill(wCol[0], wCol[1], wCol[2], 255);
        else g.fill(50, 50, 50, 150);
        g.rect(sx + i * (bw + pad), 34, bw, bh);
    }
  }
  return entry.g;
}

/**
 * Renders the weapon mode indicator and selector boxes.
 * @private
 */
function _drawWeaponSelector(p, h) {
  const g = _getWeaponSelectorGraphic(p);
  image(g, -110, -h / 2);
}

/**
 * Renders the 2D HUD overlay for one player within their viewport slice.
 */
function drawPlayerHUD(p, pi, viewW, viewH) {
  if (viewW <= 0 || viewH <= 0) return;
  let hw = viewW, h = viewH;
  let s = p.ship;

  push();
  if (gameState.gameFont) textFont(gameState.gameFont);
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();
  imageMode(CORNER);

  // 1. Draw cached static labels for stat names
  image(_getHUDLabelGraphic(hw, h), -hw / 2, -h / 2);

  // 2. Draw dynamic stat values
  const vx = -hw / 2 + 14 + 80;
  const vy = -h / 2;
  textAlign(LEFT, TOP);
  for (const [sz, stats] of HUD_STATS_BY_SIZE) {
    textSize(sz);
    for (const stat of stats) {
      fill(...stat.color);
      text(stat.getVal(p, s), vx, vy + stat.py);
    }
  }

  // --- Crosshair ---
  if (gameState.firstPersonView) {
    stroke(0, 255, 0, 150);
    strokeWeight(2);
    noFill();
    ellipse(0, 0, 30, 30);
    line(-20, 0, 20, 0);
    line(0, -20, 0, 20);
  }

  // --- Respawn Indicator ---
  if (p.dead && !p.gameOver) {
    push();
    textAlign(CENTER);
    fill(255, 255, 0, 200);
    textSize(32);
    text('Respawning...', 0, 30);
    pop();
  }

  drawRadarForPlayer(p, hw, h);
  if (!gameState.isMobile) {
    _drawWeaponSelector(p, h);
  }

  pop();
}

/**
 * Renders a circular mini-map radar.
 */
function drawRadarForPlayer(p, hw, h) {
  let s = p.ship;
  let radarSize = 150;
  let gb = _getRadarBuffer(p.id, radarSize);

  const shouldUpdate = !gameState.isMobile || (frameCount + p.id) % 2 === 0;

  if (shouldUpdate) {
    gb.clear();
    gb.push();
    gb.translate(radarSize / 2, radarSize / 2);

    gb.fill(0, 180); gb.stroke(0, 255, 0, 150); gb.strokeWeight(1.5);
    gb.rectMode(CENTER);
    gb.rect(0, 0, radarSize, radarSize);

    let yawSin = sin(s.yaw), yawCos = cos(s.yaw);

    let shipTX = toTile(s.x), shipTZ = toTile(s.z);
    let shipCX = Math.floor(shipTX / CHUNK_SIZE), shipCZ = Math.floor(shipTZ / CHUNK_SIZE);

    gb.stroke(255, 50, 50, 235);
    gb.strokeWeight(3);
    gb.beginShape(POINTS);
    for (let dcz = -3; dcz <= 3; dcz++) {
      for (let dcx = -3; dcx <= 3; dcx++) {
        let bucket = infection.buckets.get(chunkKey(shipCX + dcx, shipCZ + dcz));
        if (!bucket) continue;
        for (let t of bucket) {
          const [rrx, rrz] = _projectToRadar(t.tx * TILE, t.tz * TILE, s, yawSin, yawCos);
          if (Math.abs(rrx) < RADAR_HALF && Math.abs(rrz) < RADAR_HALF) {
            gb.vertex(rrx, rrz);
          }
        }
      }
    }
    gb.endShape();

    if (enemyManager.enemies.length > 0) {
      gb.stroke(170, 255, 50);
      for (let e of enemyManager.enemies) {
        const [rrx, rrz] = _projectToRadar(e.x, e.z, s, yawSin, yawCos);
        const crx = constrain(rrx, -RADAR_HALF, RADAR_HALF);
        const crz = constrain(rrz, -RADAR_HALF, RADAR_HALF);
        gb.strokeWeight(e.type === 'colossus' ? 8 : 4);
        gb.point(crx, crz);
      }
    }

    const [rlx, rlz] = _projectToRadar(420, 420, s, yawSin, yawCos);
    const clx = constrain(rlx, -RADAR_HALF, RADAR_HALF);
    const clz = constrain(rlz, -RADAR_HALF, RADAR_HALF);
    gb.stroke(0, 150, 255, 220); gb.strokeWeight(5);
    gb.point(clx, clz);

    let other = gameState.players[1 - p.id];
    if (other && !other.dead) {
      const [rox, roz] = _projectToRadar(other.ship.x, other.ship.z, s, yawSin, yawCos);
      const crox = constrain(rox, -RADAR_HALF, RADAR_HALF);
      const croz = constrain(roz, -RADAR_HALF, RADAR_HALF);
      gb.stroke(other.labelColor[0], other.labelColor[1], other.labelColor[2], 200);
      gb.strokeWeight(5);
      gb.point(crox, croz);
    }

    gb.stroke(255); gb.strokeWeight(5);
    gb.point(0, 0);

    gb.pop();
  }

  push();
  ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  resetMatrix();
  imageMode(CENTER);
  translate(floor(hw / 2 - radarSize / 2 - 4), floor(-h / 2 + radarSize / 2 + 4));
  image(gb, 0, 0);
  pop();
}


/**
 * HUD_Components: Reusable HUD elements.
 */
const HUD_Components = {
  drawPlayerHUD,
  drawRadarForPlayer,
  drawWeaponSelector: _drawWeaponSelector
};
