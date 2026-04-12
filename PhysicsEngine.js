/**
 * PhysicsEngine - Manages fixed-timestep simulation and tick accumulation.
 * Ensures game logic (bullets, enemies, infection) runs at a steady rate
 * regardless of the display refresh rate.
 *
 * @exports   PhysicsEngine   — class definition
 * @exports   physicsEngine   — singleton (used by sketch.js, gameLoop.js, gameState.js)
 */
class PhysicsEngine {
  constructor(tickRate = 60) {
    this.simDt = 1000 / tickRate;
    this.maxStepMs = 100; // Cap raw delta to avoid spiral-of-death
    this.accum = 0;
    this.tickCount = 0;
    this.isPaused = false;
  }

  /**
   * Advances the simulation by 'dt' milliseconds.
   * Runs the provided 'tickCallback' for each completed simulation step.
   * @param {number} dt elapsed wall-clock time
   * @param {Function} tickCallback physics update function
   */
  update(dt, tickCallback) {
    if (this.isPaused) {
      this.accum = 0;
      return;
    }

    const rawDt = Math.min(dt, this.maxStepMs);
    this.accum += rawDt;

    while (this.accum >= this.simDt) {
      this.accum -= this.simDt;
      this.tickCount++;
      tickCallback(this.tickCount);
    }
  }

  /**
   * Resets the accumulator to prevent "jumps" after a resume or restart.
   */
  reset(resetTickCount = false) {
    this.accum = 0;
    if (resetTickCount) this.tickCount = 0;
  }

  setPaused(paused) {
    this.isPaused = paused;
    if (paused) this.accum = 0;
  }
}

const physicsEngine = new PhysicsEngine(60);
