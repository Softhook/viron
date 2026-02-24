// =============================================================================
// constants.js — Global constants, tuning values, key bindings and pure helpers
// =============================================================================

// --- World geometry ---
const TILE = 120;              // World-space size of one terrain tile (pixels)
const SEA = 200;              // Y value above which terrain is below sea (sea surface)
const LAUNCH_ALT = 100;        // Fixed Y altitude of the flat launchpad surface
const GRAV = 0.09;             // Per-frame gravitational acceleration applied to ships
const LAUNCH_MIN = 0;          // Launchpad world-space minimum X and Z coordinate
const LAUNCH_MAX = 840;        // Launchpad world-space maximum X and Z coordinate

// --- Rendering distances (can be adjusted dynamically for performance) ---
let VIEW_NEAR = 35;            // Inner tile radius — always rendered, no frustum test
let VIEW_FAR = 50;            // Outer tile radius — rendered with frustum culling
let CULL_DIST = 6000;          // Max world distance for rendering enemies / particles

// --- Sky / fog colour components (matched to gl.clearColor in renderPlayerView) ---
const SKY_R = 30, SKY_G = 60, SKY_B = 120;

// --- Infection spread parameters ---
const MAX_INF = 2000;   // Total infected tile count that triggers game over
const INF_RATE = 0.01;   // Per-tile per-update probability of spreading to a neighbour
const CLEAR_R = 3;      // Radius (in tiles) cleared by a single bullet/missile impact

// --- Infection spread direction vectors (4-connected grid) ---
const ORTHO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// --- Terrain chunking ---
const CHUNK_SIZE = 16;   // Each chunk is CHUNK_SIZE × CHUNK_SIZE tiles; cached as p5 geometry

// --- Mountain peaks — Gaussian altitude bumps placed at fixed world positions ---
// Each entry lowers the terrain Y value (raises the peak height) by `strength` at the centre.
// `sigma`    — optional per-peak Gaussian spread radius (world units); falls back to SENTINEL_PEAK_SIGMA.
// `strength` — how many units the peak is pushed upward at its centre.
/* const MOUNTAIN_PEAKS = [
  { x: -2200, z: -1600, strength: 450, sigma: 1100 },
  { x:  2800, z:   900, strength: 400, sigma: 1100 },
  { x: -1200, z:  3200, strength: 380, sigma: 1100 },
  { x:  3000, z: -2600, strength: 420, sigma: 1100 },
  { x: -2800, z:  2000, strength: 390, sigma: 1100 }
]; */
const MOUNTAIN_PEAKS = [
  { x: -2200, z: -1600, strength: 450, sigma: 400 },
  { x: 2800, z: 900, strength: 400, sigma: 1100 },
];


const SENTINEL_PEAK_SIGMA = 400;  // Default Gaussian spread radius — used when a peak has no sigma field
const SENTINEL_PULSE_INTERVAL = 300;  // Frames between each sentinel pulse (~5 s at 60 fps)
// Infection parameters for an infected sentinel (much faster than normal INF_RATE)
const SENTINEL_INFECTION_RADIUS = 5;     // Tile radius of accelerated spread around an infected sentinel
const SENTINEL_INFECTION_PROBABILITY = 0.35;  // Per-tile per-update spread chance near an infected sentinel

// --- Sky colour palette (used by fog blending in Terrain.getFogColor) ---

// --- Tree visual variants (healthy colour, infected colour, cone geometry) ---
// Each variant is used to draw one of three distinct tree silhouettes.
const TREE_VARIANTS = [
  // Variant 0: Single-tier small round tree
  { infected: [180, 30, 20], healthy: [25, 130, 20], cones: [[12, 45, 20]] },
  // Variant 1: Two-tier layered tree
  {
    infected: [190, 35, 25], healthy: [30, 145, 25], cones: [[22, 28, 10]],
    infected2: [150, 20, 15], healthy2: [25, 120, 20], cones2: [[15, 22, 28]]
  },
  // Variant 2: Tall conifer / pine
  { infected: [170, 30, 22], healthy: [35, 135, 28], cones: [[9, 60, 28]] }
];

// --- Ship steering rates (radians per frame) ---
const YAW_RATE = 0.04;   // Keyboard left/right turn speed
const PITCH_RATE = 0.04;   // Keyboard pitch up/down speed

// --- Mouse steering ---
const MOUSE_SENSITIVITY = 0.003;  // Mouse pixels → radians conversion factor
const MOUSE_SMOOTHING = 0.25;   // Lerp blend factor for smoothed mouse delta (lower = smoother)

// --- Key bindings — Player 1 (WASD + Q / E / R / F) ---
const P1_KEYS = {
  thrust: 87,   // W
  left: 65,   // A
  right: 68,   // D
  brake: 83,   // S
  pitchUp: 82,   // R
  pitchDown: 70,   // F
  shoot: 81,   // Q
  missile: 69    // E
};

// --- Key bindings — Player 2 (Arrow keys + punctuation row) ---
const P2_KEYS = {
  thrust: 38,    // UP_ARROW
  left: 37,    // LEFT_ARROW
  right: 39,    // RIGHT_ARROW
  brake: 40,    // DOWN_ARROW
  pitchUp: 186,   // ; (semicolon)
  pitchDown: 222,   // ' (quote)
  shoot: 190,   // . (period)
  missile: 191    // / (slash)
};

// =============================================================================
// Pure helper functions — no side-effects, no p5 calls
// =============================================================================

/** Returns a Map key string for a tile coordinate pair. */
const tileKey = (tx, tz) => tx + ',' + tz;

/** Converts a world-space coordinate to its containing tile index. */
const toTile = v => Math.floor(v / TILE);

/** Returns true if world-space (x, z) falls inside the flat launchpad area. */
const isLaunchpad = (x, z) => x >= LAUNCH_MIN && x <= LAUNCH_MAX && z >= LAUNCH_MIN && z <= LAUNCH_MAX;

/** Returns true if a terrain Y value is at or above sea level (i.e. the tile is under water). */
const aboveSea = y => y >= SEA - 1;
