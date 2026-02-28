// =============================================================================
// constants.js — Global constants, tuning values, key bindings and pure helpers
// =============================================================================

// --- World geometry ---
const TILE = 120;              // World-space size of one terrain tile (pixels)
const SEA = 200;              // Y value above which terrain is below sea (sea surface)
const LAUNCH_ALT = 100;        // Fixed Y altitude of the flat launchpad surface
const GRAV = 0.07;             // Per-frame gravitational acceleration applied to ships
const LAUNCH_MIN = 0;          // Launchpad world-space minimum X and Z coordinate
const LAUNCH_MAX = 840;        // Launchpad world-space maximum X and Z coordinate
const LIFT_FACTOR = 0.008;     // Per-frame lift acceleration coefficient (scales with forward velocity)
const DRAG = 0.992;            // Global air resistance (higher = thinner air, more gliding)
const INDUCED_DRAG = 0.002;    // Extra drag proportional to how much lift is being generated

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
  { x: -2200, z: -1600, strength: 450, sigma: 1100 },
];


const SENTINEL_PEAK_SIGMA = 400;  // Default Gaussian spread radius — used when a peak has no sigma field
const SENTINEL_PULSE_INTERVAL = 300;  // Frames between each sentinel pulse (~5 s at 60 fps)
// Pre-compute the Gaussian denominator (2σ²) and the early-exit distance threshold
// for each peak — these are constant across the lifetime of the page.
for (let peak of MOUNTAIN_PEAKS) {
  const sig = peak.sigma !== undefined ? peak.sigma : SENTINEL_PEAK_SIGMA;
  peak._s2 = 2 * sig * sig;
  // Guard: if strength <= 0.5 the peak is negligible everywhere, so encode "always skip"
  // by setting a negative sentinel that makes the render-side dSq > _skipDistSq test always true.
  peak._skipDistSq = peak.strength > 0.5 ? peak._s2 * Math.log(peak.strength / 0.5) : -1;
}
// Infection parameters for an infected sentinel (much faster than normal INF_RATE)
const SENTINEL_INFECTION_RADIUS = 5;     // Tile radius of accelerated spread around an infected sentinel
const SENTINEL_INFECTION_PROBABILITY = 0.35;  // Per-tile per-update spread chance near an infected sentinel

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

// --- Weapon modes (index into WEAPON_MODES array) ---
const WEAPON_MODES = ['NORMAL', 'MISSILE', 'BARRIER'];

// --- Key bindings — Player 1 (WASD + Q / E / R / F) ---
const P1_KEYS = {
  thrust: 87,      // W
  left: 65,        // A
  right: 68,       // D
  brake: 83,       // S
  pitchUp: 82,     // R
  pitchDown: 70,   // F
  shoot: 81,       // Q
  weaponCycle: 69  // E — cycles NORMAL → MISSILE → BARRIER
};

// --- Key bindings — Player 2 (Arrow keys + punctuation row) ---
const P2_KEYS = {
  thrust: 38,        // UP_ARROW
  left: 37,          // LEFT_ARROW
  right: 39,         // RIGHT_ARROW
  brake: 40,         // DOWN_ARROW
  pitchUp: 186,      // ; (semicolon)
  pitchDown: 222,    // ' (quote)
  shoot: 190,        // . (period)
  weaponCycle: 191   // / (slash) — cycles NORMAL → MISSILE → BARRIER
};

// =============================================================================
// Pure helper functions — no side-effects, no p5 calls
// =============================================================================

/** Returns a numeric Map key string for a tile coordinate pair.
 * Encodes X and Z into a single positive integer: (X+10000)*20001 + (Z+10000).
 * Safe for coordinates from -10000 to 10000.
 */
const tileKey = (tx, tz) => (tx + 10000) * 20001 + (tz + 10000);

/** Converts a world-space coordinate to its containing tile index. */
const toTile = v => Math.floor(v / TILE);

/** Returns true if world-space (x, z) falls inside the flat launchpad area. */
const isLaunchpad = (x, z) => x >= LAUNCH_MIN && x <= LAUNCH_MAX && z >= LAUNCH_MIN && z <= LAUNCH_MAX;

/** Returns true when terrain depth y indicates a submerged tile (y ≥ SEA means underwater; WEBGL Y axis is inverted, larger values are deeper). */
const aboveSea = y => y >= SEA - 1;

/**
 * Fast magnitude helpers used in per-frame AI/physics paths.
 * Skip Math.hypot's overflow/underflow guards (world coords are bounded),
 * trimming a bit of overhead in hot loops.
 */
/** @param {number} dx @param {number} dz @returns {number} */
const mag2 = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
/** @param {number} dx @param {number} dy @param {number} dz @returns {number} */
const mag3 = (dx, dy, dz) => Math.sqrt(dx * dx + dy * dy + dz * dz);

// =============================================================================
// TileManager — generic container for keyed world tiles (Infection or Barriers)
//
// Centralises every read and write so the running count is always in sync
// with the tile map.  Uses numeric keys for O(1) Map lookups and a packed
// Array with a swap-with-last removal technique for O(1) removal while 
// maintaining a fast iteration list (no iterator overhead).
// =============================================================================
class TileManager {
  /**
   * @param {boolean} [withBuckets=false]  When true, tiles are also indexed into
   *   a per-chunk bucket map (keyed by "cx,cz") so the renderer can iterate only
   *   tiles in visible chunks instead of the entire global list.
   */
  constructor(withBuckets = false) {
    /** @type {Map<number,object>} Tile-key → {k, tx, tz, verts, _idx} map. */
    this.tiles = new Map();
    /** @type {number} Running count — always in sync with this.tiles. */
    this.count = 0;
    /** @type {object[]} Persistent array of tile objects for fast iteration. */
    this.keyList = [];
    /**
     * Optional chunk-bucket index.  null when withBuckets=false (infection).
     * When present, keyed by "cx,cz" (CHUNK_SIZE=16 grid); value is a
     * tile-object array using the same swap-with-last O(1) removal trick.
     * @type {Map<string,object[]>|null}
     */
    this.buckets = withBuckets ? new Map() : null;
  }

  /** Clears all tile state. */
  reset() {
    this.tiles.clear();
    this.count = 0;
    this.keyList.length = 0;
    if (this.buckets !== null) this.buckets.clear();
  }

  /**
   * Adds a tile.
   * @param {number} k  Numeric tile key from tileKey().
   * @returns {object|null} the newly added tile object, or null if it already existed.
   */
  add(k) {
    if (this.tiles.has(k)) return null;
    const tx = Math.floor(k / 20001) - 10000;
    const tz = (k % 20001) - 10000;
    const obj = { k, tx, tz, verts: null, _idx: this.keyList.length };
    this.tiles.set(k, obj);
    this.count++;
    this.keyList.push(obj);
    if (this.buckets !== null) {
      // tx >> 4 === Math.floor(tx / 16) for all integers (arithmetic shift).
      const bk = `${tx >> 4},${tz >> 4}`;
      obj._bk = bk;
      let arr = this.buckets.get(bk);
      if (!arr) { arr = []; this.buckets.set(bk, arr); }
      obj._bidx = arr.length;
      arr.push(obj);
    }
    return obj;
  }

  /**
   * Removes a tile by key k.
   * @param {number} k  Numeric tile key from tileKey().
   * @returns {boolean} true if the tile existed and was removed.
   */
  remove(k) {
    const obj = this.tiles.get(k);
    if (!obj) return false;

    const idx = obj._idx;
    const last = this.keyList[this.keyList.length - 1];

    this.keyList[idx] = last;
    last._idx = idx;
    this.keyList.pop();

    if (this.buckets !== null && obj._bk !== undefined) {
      const arr = this.buckets.get(obj._bk);
      if (arr) {
        const bidx = obj._bidx;
        const blast = arr[arr.length - 1];
        arr[bidx] = blast;
        blast._bidx = bidx;
        arr.pop();
        if (arr.length === 0) this.buckets.delete(obj._bk);
      }
    }

    this.tiles.delete(k);
    this.count--;
    return true;
  }

  /** Returns true if tile key k is present. */
  has(k) { return this.tiles.has(k); }

  /** Returns the tile object for key k, or undefined. */
  get(k) { return this.tiles.get(k); }

  /** Returns the persistent array of all tile objects. */
  keys() { return this.keyList; }

  /** Compatibility with existing Map.values() usage (returns the array). */
  values() { return this.keyList; }

  /** Compatibility with existing Map.set() usage. */
  set(k, v) { return this.add(k); }

  /** Compatibility with existing Map.clear() usage. */
  clear() { this.reset(); }

  /** Compatibility with internal Map usage. */
  get size() { return this.count; }
}

/** Singleton infection state shared across all modules. */
// withBuckets=true: renderer iterates only tiles in visible chunks, not the
// entire world list — same optimisation applied to barrierTiles.
const infection = new TileManager(true);

// =============================================================================
// Lightweight opt-in profiler (no overhead unless window.VIRON_PROFILE is set)
// =============================================================================
function createVironProfiler(cfg) {
  if (typeof performance === 'undefined') return null;
  const sampleFrames = cfg.sampleFrames || 180;
  const label = cfg.label || 'default';
  const totals = {
    frame: 0,
    spread: 0,
    shader: 0,
    overlayInfection: 0,
    overlayBarrier: 0,
    overlayInfectionTiles: 0,
    overlayBarrierTiles: 0,
    spreadSteps: 0,
    frames: 0,
  };
  let active = true;

  function logSummaryAndReset() {
    const frames = Math.max(totals.frames, 1);
    const summary = {
      frames,
      frameMs: +(totals.frame / frames).toFixed(2),
      spreadMsPerFrame: +(totals.spread / frames).toFixed(3),
      spreadMsPerUpdate: totals.spreadSteps ? +(totals.spread / totals.spreadSteps).toFixed(3) : 0,
      shaderMs: +(totals.shader / frames).toFixed(3),
      vironOverlayMs: +(totals.overlayInfection / frames).toFixed(3),
      vironTiles: Math.round(totals.overlayInfectionTiles / frames),
      barrierOverlayMs: +(totals.overlayBarrier / frames).toFixed(3),
      barrierTiles: Math.round(totals.overlayBarrierTiles / frames),
    };
    const prefix = label ? `VIRON_PROFILE[${label}]` : 'VIRON_PROFILE';
    console.log(`${prefix}:${JSON.stringify(summary)}`);
    if (typeof window !== 'undefined') {
      window.__profilingDone = true;
      window.__profilingSummary = summary;
    }

    totals.frame = totals.spread = totals.shader = 0;
    totals.overlayInfection = totals.overlayBarrier = totals.spreadSteps = 0;
    totals.overlayInfectionTiles = totals.overlayBarrierTiles = 0;
    totals.frames = 0;
    if (cfg.once) active = false;
  }

  return {
    config: cfg,
    now: () => performance.now(),
    record(name, delta) {
      if (!active) return;
      if (name === 'spread') totals.spread += delta;
      else if (name === 'shader') totals.shader += delta;
    },
    recordSpread(delta) {
      if (!active) return;
      totals.spread += delta;
      totals.spreadSteps++;
    },
    recordOverlay(tag, tiles, delta) {
      if (!active) return;
      if (tag === 'infection') {
        totals.overlayInfection += delta;
        totals.overlayInfectionTiles += tiles;
      } else {
        totals.overlayBarrier += delta;
        totals.overlayBarrierTiles += tiles;
      }
    },
    snapshot() {
      return {
        frames: totals.frames,
        frame: totals.frame,
        spread: totals.spread,
        shader: totals.shader,
        overlayInfection: totals.overlayInfection,
        overlayBarrier: totals.overlayBarrier,
        overlayInfectionTiles: totals.overlayInfectionTiles,
        overlayBarrierTiles: totals.overlayBarrierTiles,
        spreadSteps: totals.spreadSteps,
      };
    },
    flush() {
      if (!active || totals.frames === 0) return false;
      logSummaryAndReset();
      return true;
    },
    frameEnd(frameDelta) {
      if (!active) return;
      totals.frame += frameDelta;
      totals.frames++;
      if (totals.frames >= sampleFrames) logSummaryAndReset();
    }
  };
}

function initVironProfiler() {
  if (typeof window === 'undefined') return null;
  const cfg = (typeof window.VIRON_PROFILE === 'object' && window.VIRON_PROFILE.enabled === true)
    ? window.VIRON_PROFILE
    : null;
  window.__vironProfiler = cfg ? createVironProfiler(cfg) : null;
  return window.__vironProfiler;
}

function getVironProfiler() {
  if (typeof window === 'undefined') return null;
  const cfg = (typeof window.VIRON_PROFILE === 'object' && window.VIRON_PROFILE.enabled === true)
    ? window.VIRON_PROFILE
    : null;
  if (!window.__vironProfiler && cfg) initVironProfiler();
  else if (window.__vironProfiler && window.__vironProfiler.config !== cfg) initVironProfiler();
  return window.__vironProfiler;
}

initVironProfiler();

if (typeof window !== 'undefined') {
  window.initVironProfiler = initVironProfiler;
  window.getVironProfiler = getVironProfiler;
}
