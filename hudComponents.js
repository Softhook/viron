// =============================================================================
// hudComponents.js — Reusable HUD elements and player-view components
//
// @exports   drawHUD()           — main per-player HUD overlay
// @exports   _projectToRadar()   — world-to-radar coordinate helper
// =============================================================================

import { p } from './p5Context.js';
import {
  HUD_WEAPON_LABELS, HUD_WEAPON_ACTIVE_COLS, HUD_WEAPON_BUFFERS,
  HUD_RADAR_BUFFERS, RADAR_SCALE, RADAR_HALF, RADAR_TILE_RADIUS_SQ, HUD_LABEL_CACHE
} from './hudCore.js';
import { gameState } from './gameState.js';
import { enemyManager } from './enemies.js';
import { infection, SEA, NORMAL_SHOT_MODE_LABELS, CHUNK_SIZE, TILE, chunkKey, toTile } from './constants.js';
import { terrain } from './terrain.js';

const HUD_STATS = [
  { label: 'SCORE', color: [255, 255, 255], size: 20, py: 8, getVal: player => player.score },
  { label: 'ALT', color: [0, 255, 0], size: 16, py: 32, getVal: (player, ship) => Math.max(0, Math.floor(SEA - ship.y)) },
  { label: 'VIRON', color: [255, 60, 60], size: 14, py: 54, getVal: () => infection?.count ?? 0 },
  { label: 'ENEMIES', color: [255, 100, 100], size: 14, py: 72, getVal: () => enemyManager?.enemies.length ?? 0 },
  { label: 'MISSILES', color: [0, 200, 255], size: 14, py: 90, getVal: player => player.missilesRemaining },
  { label: 'SHOT', color: [220, 220, 220], size: 14, py: 108, getVal: player => (NORMAL_SHOT_MODE_LABELS[player.normalShotMode] || 'SINGLE') }
];

const HUD_STATS_BY_SIZE = (() => {
  const groups = new Map();
  for (const stat of HUD_STATS) {
    if (!groups.has(stat.size)) groups.set(stat.size, []);
    groups.get(stat.size).push(stat);
  }
  return groups;
})();

function _getHUDLabelGraphic(hw, h) {
  const key = `${hw}|${h}`;
  if (HUD_LABEL_CACHE[key]) return HUD_LABEL_CACHE[key];

  const g = p.createGraphics(hw, h);
  g.pixelDensity(1);
  g.clear();
  g.noStroke();
  g.textAlign(p.LEFT, p.TOP);
  if (gameState.gameFont) g.textFont(gameState.gameFont);

  const lx = 14;
  for (const stat of HUD_STATS) {
    g.fill(...stat.color);
    g.textSize(stat.size);
    g.text(stat.label, lx, stat.py);
  }

  HUD_LABEL_CACHE[key] = g;
  return g;
}

function _getRadarBuffer(playerId, size) {
  if (HUD_RADAR_BUFFERS[playerId]) return HUD_RADAR_BUFFERS[playerId];
  const g = p.createGraphics(size, size);
  g.pixelDensity(1);
  HUD_RADAR_BUFFERS[playerId] = g;
  return g;
}

/**
 * Transforms world coordinates to radar-local coordinates relative to the ship.
 * @private
 */
export function _projectToRadar(wx, wz, ship, sinYaw, cosYaw) {
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
function _getWeaponSelectorGraphic(player) {
  const W = 220, H = 50;
  const key = `${player.id}`;
  let entry = HUD_WEAPON_BUFFERS[key];

  if (!entry || entry.weaponMode !== player.weaponMode) {
    if (!entry) {
      const g = p.createGraphics(W, H);
      g.pixelDensity(1);
      entry = { g, weaponMode: -1 };
      HUD_WEAPON_BUFFERS[key] = entry;
    }
    entry.weaponMode = player.weaponMode;

    const wId = player.weaponMode;
    const wName = HUD_WEAPON_LABELS[wId];
    const wCol = HUD_WEAPON_ACTIVE_COLS[wId];
    const g = entry.g;

    g.clear();
    g.noStroke();
    if (gameState.gameFont) g.textFont(gameState.gameFont);

    g.textAlign(p.CENTER, p.TOP);
    g.textSize(18);
    g.fill(wCol[0], wCol[1], wCol[2], 230);
    g.text(wName, W / 2, 10);

    const bw = 60, bh = 6, pad = 8;
    const totalW = (bw + pad) * 3 - pad;
    const sx = (W - totalW) / 2;
    g.rectMode(p.CORNER);
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
function _drawWeaponSelector(player, h) {
  const g = _getWeaponSelectorGraphic(player);
  p.image(g, -110, -h / 2);
}

/**
 * Renders the 2D HUD overlay for one player within their viewport slice.
 */
export function drawPlayerHUD(player, pi, viewW, viewH) {
  if (viewW <= 0 || viewH <= 0) return;
  let hw = viewW, h = viewH;
  let ship = player.ship;

  void pi;
  void terrain;

  p.push();
  if (gameState.gameFont) p.textFont(gameState.gameFont);
  p.ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  p.resetMatrix();
  p.imageMode(p.CORNER);

  // 1. Draw cached static labels for stat names
  p.image(_getHUDLabelGraphic(hw, h), -hw / 2, -h / 2);

  // 2. Draw dynamic stat values
  const vx = -hw / 2 + 14 + 80;
  const vy = -h / 2;
  p.textAlign(p.LEFT, p.TOP);
  for (const [sz, stats] of HUD_STATS_BY_SIZE) {
    p.textSize(sz);
    for (const stat of stats) {
      p.fill(...stat.color);
      p.text(stat.getVal(player, ship), vx, vy + stat.py);
    }
  }

  // --- Crosshair ---
  if (gameState.firstPersonView) {
    p.stroke(0, 255, 0, 150);
    p.strokeWeight(2);
    p.noFill();
    p.ellipse(0, 0, 30, 30);
    p.line(-20, 0, 20, 0);
    p.line(0, -20, 0, 20);
  }

  // --- Respawn Indicator ---
  if (player.dead && !player.gameOver) {
    p.push();
    p.textAlign(p.CENTER);
    p.fill(255, 255, 0, 200);
    p.textSize(32);
    p.text('Respawning...', 0, 30);
    p.pop();
  }

  drawRadarForPlayer(player, hw, h);
  if (!gameState.isMobile) {
    _drawWeaponSelector(player, h);
  }

  p.pop();
}

/**
 * Renders a circular mini-map radar.
 */
function drawRadarForPlayer(player, hw, h) {
  let ship = player.ship;
  let radarSize = 150;
  let gb = _getRadarBuffer(player.id, radarSize);

  const shouldUpdate = !gameState.isMobile || (p.frameCount + player.id) % 2 === 0;

  if (shouldUpdate) {
    gb.clear();
    gb.push();
    gb.translate(radarSize / 2, radarSize / 2);

    gb.fill(0, 180); gb.stroke(0, 255, 0, 150); gb.strokeWeight(1.5);
    gb.rectMode(p.CENTER);
    gb.rect(0, 0, radarSize, radarSize);

    let yawSin = Math.sin(ship.yaw), yawCos = Math.cos(ship.yaw);

    let shipTX = toTile(ship.x), shipTZ = toTile(ship.z);
    let shipCX = Math.floor(shipTX / CHUNK_SIZE), shipCZ = Math.floor(shipTZ / CHUNK_SIZE);

    gb.stroke(255, 50, 50, 235);
    gb.strokeWeight(3);
    gb.beginShape(p.POINTS);
    for (let dcz = -3; dcz <= 3; dcz++) {
      for (let dcx = -3; dcx <= 3; dcx++) {
        let bucket = infection.buckets.get(chunkKey(shipCX + dcx, shipCZ + dcz));
        if (!bucket) continue;
        for (let t of bucket) {
          const [rrx, rrz] = _projectToRadar(t.tx * TILE, t.tz * TILE, ship, yawSin, yawCos);
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
        const [rrx, rrz] = _projectToRadar(e.x, e.z, ship, yawSin, yawCos);
        const crx = p.constrain(rrx, -RADAR_HALF, RADAR_HALF);
        const crz = p.constrain(rrz, -RADAR_HALF, RADAR_HALF);
        gb.strokeWeight(e.type === 'colossus' ? 8 : 4);
        gb.point(crx, crz);
      }
    }

    const [rlx, rlz] = _projectToRadar(420, 420, ship, yawSin, yawCos);
    const clx = p.constrain(rlx, -RADAR_HALF, RADAR_HALF);
    const clz = p.constrain(rlz, -RADAR_HALF, RADAR_HALF);
    gb.stroke(0, 150, 255, 220); gb.strokeWeight(5);
    gb.point(clx, clz);

    let other = gameState.players[1 - player.id];
    if (other && !other.dead) {
      const [rox, roz] = _projectToRadar(other.ship.x, other.ship.z, ship, yawSin, yawCos);
      const crox = p.constrain(rox, -RADAR_HALF, RADAR_HALF);
      const croz = p.constrain(roz, -RADAR_HALF, RADAR_HALF);
      gb.stroke(other.labelColor[0], other.labelColor[1], other.labelColor[2], 200);
      gb.strokeWeight(5);
      gb.point(crox, croz);
    }

    gb.stroke(255); gb.strokeWeight(5);
    gb.point(0, 0);

    gb.pop();
  }

  p.push();
  p.ortho(-hw / 2, hw / 2, -h / 2, h / 2, 0, 1000);
  p.resetMatrix();
  p.imageMode(p.CENTER);
  p.translate(Math.floor(hw / 2 - radarSize / 2 - 4), Math.floor(-h / 2 + radarSize / 2 + 4));
  p.image(gb, 0, 0);
  p.pop();
}

export function drawHUD(player, playerIndex, viewW, viewH) {
  drawPlayerHUD(player, playerIndex, viewW, viewH);
}

