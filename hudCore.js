// =============================================================================
// hudCore.js — HUD core constants, state, and transition management
//
// @exports   HUD_Manager          — singleton (update(), drawHUD())
// @exports   HUD_WEAPON_LABELS    — display labels for weapon modes
// @exports   HUD_WEAPON_ACTIVE_COLS — colour per weapon mode
// @exports   HUD_LABEL_CACHE      — static label graphics cache
// @exports   HUD_RADAR_BUFFERS    — per-player radar graphics buffers
// @exports   HUD_WEAPON_BUFFERS   — cached weapon-selector graphics
// @exports   RADAR_SCALE          — world-to-radar-pixel scale factor
// =============================================================================

const HUD_WEAPON_LABELS = ['NORMAL', 'MISSILE', 'BARRIER'];
const HUD_WEAPON_ACTIVE_COLS = [[255, 255, 255], [0, 220, 255], [255, 160, 20]];
const HUD_LABEL_CACHE = Object.create(null); // Static labels graphic per viewport size
const HUD_RADAR_BUFFERS = Object.create(null); // Graphics buffers for radar (one per player)
const HUD_WEAPON_BUFFERS = Object.create(null); // Cached weapon-selector graphic per player id

const RADAR_SCALE = 0.012;
const RADAR_HALF = 68;
const RADAR_TILE_RADIUS_SQ = 4200;

// Transition Settings
const HUD_DIM_MAX = 180;
const HUD_DIM_SPEED = 0.15; // Lerp speed for transitions

const HUD_STATS = [
  { label: 'SCORE', color: [255, 255, 255], size: 20, py: 8, getVal: p => p.score },
  { label: 'ALT', color: [0, 255, 0], size: 16, py: 32, getVal: (p, s) => Math.max(0, Math.floor(SEA - s.y)) },
  { label: 'VIRON', color: [255, 60, 60], size: 14, py: 54, getVal: () => infection?.count ?? 0 },
  { label: 'ENEMIES', color: [255, 100, 100], size: 14, py: 72, getVal: () => enemyManager?.enemies.length ?? 0 },
  { label: 'MISSILES', color: [0, 200, 255], size: 14, py: 90, getVal: p => p.missilesRemaining },
  { label: 'SHOT', color: [220, 220, 220], size: 14, py: 108, getVal: p => (NORMAL_SHOT_MODE_LABELS[p.normalShotMode] || 'SINGLE') }
];

// Standardized UI Typography and Layout
const UI_TYPE_TITLE = 84;
const UI_TYPE_HEADER = 36;
const UI_TYPE_BODY = 20;
const UI_TYPE_HINT = 14;
const UI_TYPE_PROMPT = 26;

const UI_LAYOUT_TITLE_Y = -0.32;
const UI_LAYOUT_HEADER_Y = -0.18;
const UI_LAYOUT_BODY_Y = 0.05; // Base Y for body text
const UI_LAYOUT_PROMPT_Y = 0.40;

const HUD_STATS_BY_SIZE = (() => {
  const groups = new Map();
  for (const s of HUD_STATS) {
    if (!groups.has(s.size)) groups.set(s.size, []);
    groups.get(s.size).push(s);
  }
  return groups;
})();

/**
 * HUD_Manager: Orchestrates HUD rendering, transitions, and state.
 */
const HUD_Manager = {
  dimAlpha: 0,
  targetDim: 0,

  update() {
    // Determine target dimming based on mode
    const needsDim = ['mission', 'instructions', 'paused', 'gameover'].includes(gameState.mode);
    this.targetDim = needsDim ? HUD_DIM_MAX : 0;

    // Smoothly interpolate dimAlpha
    if (Math.abs(this.dimAlpha - this.targetDim) > 0.1) {
      this.dimAlpha = lerp(this.dimAlpha, this.targetDim, HUD_DIM_SPEED);
    } else {
      this.dimAlpha = this.targetDim;
    }
  },

  /** Draws a full-screen dimming overlay based on current dimAlpha. */
  drawDimOverlay() {
    if (this.dimAlpha <= 0) return;
    setup2DViewport();
    fill(0, 0, 0, this.dimAlpha);
    noStroke();
    rect(-width / 2, -height / 2, width, height);
    pop();
  }
};


/**
 * Creates or retrieves a static graphics buffer containing the text labels.
 */
function _getHUDLabelGraphic(hw, h) {
  const key = `${hw}|${h}`;
  if (HUD_LABEL_CACHE[key]) return HUD_LABEL_CACHE[key];

  const g = createGraphics(hw, h);
  g.pixelDensity(1);
  g.clear();
  g.noStroke();
  g.textAlign(LEFT, TOP);
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

/**
 * Ensures a player has a dedicated graphics buffer for the radar.
 */
function _getRadarBuffer(pId, size) {
  if (HUD_RADAR_BUFFERS[pId]) return HUD_RADAR_BUFFERS[pId];
  const g = createGraphics(size, size);
  g.pixelDensity(1);
  HUD_RADAR_BUFFERS[pId] = g;
  return g;
}

