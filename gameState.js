// =============================================================================
// gameState.js — Centralized game state management & initialization
//
// Encapsulates all global game state into a single state object with clear
// getter/setter patterns. This replaces 40+ scattered global variables and
// provides a single source of truth for test fixtures and debugging.
// =============================================================================

class GameState {
  constructor() {
    // --- Level & Progression ---
    this.level = 1;
    this.currentMaxEnemies = 2;
    this.colossusSpawnCount = 0;
    this.levelComplete = false;
    this.levelEndTime = 0;
    this.infectionStarted = false;
    this.levelClearArmed = false;
    this.ignitionStartTime = 0;

    // --- Game State Machine ---
    this.mode = 'menu'; // 'menu' | 'instructions' | 'shipselect' | 'playing' | 'gameover'
    this.gameOverReason = '';
    this.gameStartTime = 0;

    // --- World Objects ---
    this.trees = [];
    this.buildings = [];
    this.sentinelBuildings = [];
    this.barrierTiles = new TileManager(true);
    this.inFlightBarriers = [];

    // --- Players ---
    this.players = [];
    this.numPlayers = 1;
    this.firstPersonView = false;

    // --- Audio/Timing ---
    this.lastAlarmTime = 0;
    this.menuCam = { x: 1500, z: 1500, yaw: 0 };

    // --- Input State ---
    this.mouseReleasedSinceStart = true;
    this.leftMouseDown = false;
    this.rightMouseDown = false;
    this.smoothedMX = 0;
    this.smoothedMY = 0;

    // --- Platform Detection ---
    this.isMobile = false;
    this.isAndroid = false;

    // --- Rendering ---
    this.sceneFBO = null;
    this.gameFont = null;
    this.worldSeed = 0;
  }

  _createPlayers(np) {
    if (np === 1) {
      return [createPlayer(0, P1_KEYS, 420, [80, 180, 255])];
    }

    return [
      createPlayer(0, P1_KEYS, 300, [80, 180, 255]),
      createPlayer(1, P2_KEYS, 500, [255, 180, 80])
    ];
  }

  _resetPlayerForLevel(p, lvl) {
    if (lvl === 1) resetShip(p, getSpawnX(p));

    p.homingMissiles = [];
    if (lvl > 1) p.missilesRemaining = p.missilesRemaining + 1;
    p.dead = false;
    p.respawnTimer = 0;
    p.lpDeaths = 0;
  }

  _resetLevelOneWorldState() {
    this.barrierTiles.reset();
    this.inFlightBarriers = [];
    infection.reset();
    this.infectionStarted = false;
    this._seedInitialInfection();
  }

  _spawnLevelWave(lvl) {
    // Every 3rd level guarantees a Colossus boss.
    const hasColossus = (lvl >= 3 && lvl % 3 === 0);
    for (let i = 0; i < this.currentMaxEnemies; i++) {
      const forceSeeder = (i === 0);
      const forceColossus = (!forceSeeder && hasColossus && i === 1);
      enemyManager.spawn(forceSeeder, forceColossus);
    }
  }

  _ensureInfectionSeededForLevel() {
    if (infection.count > 0) return;
    this._seedInitialInfection();
  }

  /**
   * Initializes platform detection (mobile/desktop, Android/iOS).
   * Called once during setup().
   */
  detectPlatform() {
    const ua = navigator.userAgent;
    this.isAndroid = /Android/i.test(ua);

    // Explicit UA check
    this.isMobile = this.isAndroid || /iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);

    // Modern iPads with MacBook-like UA but touch-enabled
    if (!this.isMobile && /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) {
      this.isMobile = true;
    }

    // Generic mobile/tablet indicators in Desktop View
    if (!this.isMobile && /Mobile|Tablet/i.test(ua)) {
      this.isMobile = true;
    }

    // Fallback: any touch device that doesn't look like desktop OS
    if (!this.isMobile && 'ontouchstart' in window) {
      const isDesktopOS = /Windows NT|Macintosh|Linux/i.test(ua);
      if (!isDesktopOS) this.isMobile = true;
    }

    console.log(`[Viron] Device: ${this.isMobile ? 'MOBILE' : 'DESKTOP'} (UA: ${ua.slice(0, 50)}..., touch: ${navigator.maxTouchPoints})`);
  }

  /**
   * Initializes a new game with the given number of players.
   * Sets up player objects and triggers level initialization.
   * @param {number} np  Number of players (1 or 2).
   */
  startNewGame(np) {
    this.numPlayers = np;
    this.gameStartTime = millis();
    this.colossusSpawnCount = 0;
    this.mouseReleasedSinceStart = !this.leftMouseDown;

    this.players = this._createPlayers(np);

    // Reset quality scaling penalty from previous session
    if (window._perf) window._perf.cooldown = 0;

    // Ensure we start with a clean world for the new game session
    this.worldSeed = floor(millis() + second() * 1000 + minute() * 60000);
    this.resetWorld();
    if (typeof initWorld === 'function') initWorld(this.worldSeed);

    this.startLevel(1);
    this.mode = 'mission';

    if (typeof gameSFX !== 'undefined') {
      gameSFX.spatialEnabled = (np === 1);
    }
  }

  /**
   * Initializes a specific level.
   * Respawns ships, clears enemies/particles, and spawns new waves.
   * Each level beyond level 1 grants one bonus missile per player.
   * @param {number} lvl  The level number to start (1-indexed).
   */
  startLevel(lvl) {
    if (typeof gameSFX !== 'undefined') gameSFX.playNewLevel();
    if (typeof updateTimeOfDay === 'function') updateTimeOfDay(lvl);

    this.level = lvl;
    this.levelComplete = false;
    this.infectionStarted = false;
    this.levelClearArmed = false;
    this.currentMaxEnemies = 1 + lvl; // Scale linearly with level

    for (const p of this.players) this._resetPlayerForLevel(p, lvl);

    if (lvl === 1) {
      this._resetLevelOneWorldState();
    }

    enemyManager.clear();
    particleSystem.clear();
    terrain.activePulses = [];

    this._spawnLevelWave(lvl);
    this._ensureInfectionSeededForLevel();
  }

  /**
   * Seeds initial infection ring at level start.
   * Places one guaranteed infected tile between MIN_DIST and MAX_DIST from launchpad.
   * @private
   */
  _seedInitialInfection() {
    const CENTER_X = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420
    const CENTER_Z = (LAUNCH_MIN + LAUNCH_MAX) / 2;  // ≈ 420
    const MIN_DIST = 500;
    const MAX_DIST = 1500;
    const MAX_TRIES = 50;

    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      let angle = random(TWO_PI);
      let dist = random(MIN_DIST, MAX_DIST);
      let wx = CENTER_X + cos(angle) * dist;
      let wz = CENTER_Z + sin(angle) * dist;

      if (aboveSea(terrain.getAltitude(wx, wz))) continue;
      if (isLaunchpad(wx, wz)) continue;

      let tk = tileKey(toTile(wx), toTile(wz));
      infection.add(tk);
      return;
    }
  }

  /**
   * Transitions game to game-over state with a reason message.
   * @param {string} reason  Human-readable reason (e.g., "INFECTION REACHED CRITICAL MASS").
   */
  setGameOver(reason) {
    if (this.mode === 'gameover') return;
    this.mode = 'gameover';
    this.gameOverReason = reason;
    this.levelEndTime = millis();
    if (typeof gameSFX !== 'undefined') {
      gameSFX.stopAll();
      gameSFX.playGameOver();
    }
  }

  /**
   * Marks the current level as complete.
   */
  completeLevelSequence() {
    if (!this.levelComplete) {
      this.levelComplete = true;
      this.levelEndTime = millis();
      if (typeof gameSFX !== 'undefined') gameSFX.playLevelComplete();
    }
  }

  /**
   * Updates respawn timers for dead players.
   * Respawns a player if their timer reaches zero.
   */
  updateRespawns() {
    for (let p of this.players) {
      if (p.dead) {
        p.respawnTimer--;
        if (p.respawnTimer <= 0) {
          p.dead = false;
          resetShip(p, getSpawnX(p));
        }
      }
    }
  }

  /**
   * Gets the first active (non-dead) player.
   * @returns {object|null} Player or null if all dead.
   */
  getActivePrimaryPlayer() {
    for (let p of this.players) {
      if (!p.dead) return p;
    }
    return null;
  }

  /**
   * Checks if level-clear conditions are met.
   * @returns {boolean} True if level should advance.
   */
  isLevelClearable() {
    let ic = infection.count;
    let enemyCount = enemyManager.enemies.length;

    // Ignore transient startup states where arrays/maps may still be empty.
    if (!this.levelClearArmed && (ic > 0 || enemyCount > 0)) {
      this.levelClearArmed = true;
    }
    if (!this.levelClearArmed) return false;

    if (ic > 0) this.infectionStarted = true;
    return (this.infectionStarted && ic === 0) || (enemyCount === 0);
  }

  /**
   * Resets all ephemeral world objects (buildings, trees, etc.)
   * to prepare for a fresh world generation pass.
   */
  resetWorld() {
    this.buildings = [];
    this.sentinelBuildings = [];
    this.trees = []; // Though trees are currently procedural, clearing this keeps it clean
    if (typeof terrain !== 'undefined' && terrain.reset) {
      terrain.reset();
    }
  }
}

// Single global state instance
const gameState = new GameState();
