'use strict';

// =============================================================================
// benchmark-throttling.js — Simulates dynamic quality scaling under several
// realistic display / device scenarios and compares old vs new controller
// behaviour (distance stability + number of quality steps).
//
// Scenarios tested:
//   1. Desktop 75 Hz  — startup near 75 fps, steady ~60 fps + mild jitter
//   2. Desktop 60 Hz  — steady 60 fps + mild jitter (no high-fps startup)
//   3. Mobile thermal — startup near 60 fps, then thermal throttle to ~30 fps
//                       with heavy GC / driver spikes
//
// Run: node benchmark-throttling.js
// =============================================================================

const SIM_SECONDS = 180;
const DT_CAP = 100;

// ── View limits — local copies of DESKTOP_VIEW_LIMITS / MOBILE_VIEW_LIMITS
// from constants.js.  This benchmark runs in plain Node.js and cannot import
// the browser-only game constants, so the values are duplicated here.
// Keep these in sync with constants.js whenever the game limits change:
//   constants.js: DESKTOP_VIEW_LIMITS = { far: 80, near: 60, cull: 10000 }
//   constants.js: MOBILE_VIEW_LIMITS  = { far: 30, near: 20, cull: 3500  }
const DESKTOP_VIEW_LIMITS = { far: 80, near: 60, cull: 10000 };
const MOBILE_VIEW_LIMITS  = { far: 30, near: 20, cull: 3500  };

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Pre-allocated sort buffer, mirroring the game's perf.sortedBuf approach in
// gameRenderer.js to avoid per-evaluation heap allocation.  Both arrays hold
// exactly 60 samples matching the game's circular buffer size.
const _sortBuf60 = new Float32Array(60);

/**
 * Returns the 90th-percentile frame time from a 60-element Float32Array.
 * Uses the same pre-allocated copy+sort approach as gameRenderer.js
 * updatePerformanceScaling() so allocation pressure is near-zero.
 *
 * For N=60 samples the nearest-rank 90th percentile is element at index
 * ceil(0.9 × 60) − 1 = 53 (0-based).
 */
function percentile90(arr) {
  _sortBuf60.set(arr);
  _sortBuf60.sort();
  return _sortBuf60[53]; // 90th percentile of 60 samples
}

/**
 * Snaps the observed median frame time to the nearest standard display-rate
 * tier and returns the corresponding budget in ms.
 *
 * Tiers (ms):  144 Hz→6.94  120 Hz→8.33  90 Hz→11.11  75 Hz→13.33
 *              60 Hz→16.67  30 Hz→33.33
 *
 * Uses a pre-allocated copy+sort to match the game's zero-allocation path.
 */
function detectBudgetMs(buffer, isMobile, useDesktopFloor) {
  _sortBuf60.set(buffer);
  _sortBuf60.sort();
  const medMs = (_sortBuf60[29] + _sortBuf60[30]) / 2;
  const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
  let budget = tierMs.reduce((b, c) => Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b);
  if (useDesktopFloor && !isMobile) budget = Math.max(budget, 1000 / 60);
  return budget;
}

// =============================================================================
// Frame-time generators
// =============================================================================

/**
 * Desktop 75 Hz scenario:
 *   Phase 1 (0–2 s)  — menu near 75 fps (13.3 ms), very low jitter.
 *   Phase 2 (2 s+)   — gameplay near 60 fps (16.5 ms) with periodic
 *                       GC/driver stutter bursts (+4–6 ms spikes).
 */
function generateDesktop75HzFrameTimes() {
  const frames = [];
  let tMs = 0;
  while (tMs < SIM_SECONDS * 1000) {
    let dt;
    if (tMs < 2000) {
      dt = 13.3 + Math.sin(tMs * 0.002) * 0.2;
    } else {
      dt = 16.5 + Math.sin(tMs * 0.0018) * 0.7;
      if ((Math.floor(tMs / 1700) % 2) === 1 && (tMs % 1700) < 120) dt += 6.0;
      if ((Math.floor(tMs / 5100) % 2) === 1 && (tMs % 5100) < 180) dt += 4.0;
    }
    dt = clamp(dt, 8, 33);
    frames.push(dt);
    tMs += dt;
  }
  return frames;
}

/**
 * Desktop 60 Hz scenario:
 *   Steady 60 fps (16.67 ms) with the same GC/driver stutter pattern.
 *   No high-fps startup phase — device never runs above 60 Hz.
 */
function generateDesktop60HzFrameTimes() {
  const frames = [];
  let tMs = 0;
  while (tMs < SIM_SECONDS * 1000) {
    let dt = 16.67 + Math.sin(tMs * 0.0018) * 0.6;
    if ((Math.floor(tMs / 1700) % 2) === 1 && (tMs % 1700) < 120) dt += 5.0;
    if ((Math.floor(tMs / 5100) % 2) === 1 && (tMs % 5100) < 180) dt += 3.5;
    dt = clamp(dt, 10, 33);
    frames.push(dt);
    tMs += dt;
  }
  return frames;
}

/**
 * Mobile thermal throttle scenario:
 *   Phase 1 (0–3 s)   — menu near 60 fps (16.7 ms), device is cool.
 *   Phase 2 (3–15 s)  — gameplay ramps from 60 fps → 30 fps as GPU heats up.
 *   Phase 3 (15 s+)   — sustained ~30 fps (33 ms) with larger GC spikes
 *                        and occasional 50–70 ms hitches (JS GC, OS scheduler).
 *
 * Mobile devices are often vsync-capped at 60 Hz but thermal throttling causes
 * the GPU to drop rendered fps well below that cap.  GC pauses on mobile JS
 * engines are also larger and more frequent than on desktop V8.
 */
function generateMobileFrameTimes() {
  const frames = [];
  let tMs = 0;
  while (tMs < SIM_SECONDS * 1000) {
    let dt;
    if (tMs < 3000) {
      // Cool start: near 60 fps
      dt = 16.7 + Math.sin(tMs * 0.003) * 0.5;
    } else if (tMs < 15000) {
      // Linear ramp: 16.7 ms → 33.3 ms over 12 s
      const t = (tMs - 3000) / 12000;
      dt = 16.7 + t * 16.6 + Math.sin(tMs * 0.002) * 1.0;
    } else {
      // Thermally throttled: sustained ~30 fps with heavier jitter
      dt = 33.3 + Math.sin(tMs * 0.0015) * 2.0;
      // Frequent small GC spikes (~every 1.4 s)
      if ((Math.floor(tMs / 1400) % 2) === 1 && (tMs % 1400) < 100) dt += 8.0;
      // Occasional large hitches (~every 7 s): JS GC / OS scheduler
      if ((Math.floor(tMs / 7000) % 3) === 2 && (tMs % 7000) < 80)  dt += 25.0;
    }
    dt = clamp(dt, 10, 80);
    frames.push(dt);
    tMs += dt;
  }
  return frames;
}

// =============================================================================
// Controllers
// =============================================================================

/**
 * Old (pre-refactor) adaptive quality controller.
 * Evaluates every 2 s, reduces aggressively on a single over-budget eval,
 * and restores on a single under-budget eval with no confirmation streak.
 *
 * @param {number[]} frames  Synthetic frame-time array (ms).
 * @param {object}   limits  { near, far, cull } upper limits (desktop or mobile).
 * @param {boolean}  isMobile  Whether to apply the mobile budget floor.
 * @returns {object} Summary result.
 */
function runOldController(frames, limits, isMobile) {
  let VIEW_NEAR = limits.near;
  let VIEW_FAR  = limits.far;
  let CULL_DIST = limits.cull;

  const perf = {
    buf: new Float32Array(60),
    idx: 0,
    full: false,
    budgetMs: 1000 / 60,
    budgetSet: false,
    nextEval: 0,
    cooldown: 0,
  };

  let now = 0;
  let qualitySteps = 0;
  const farTrace = [];

  for (const rawDt of frames) {
    const dt = Math.min(rawDt, DT_CAP);
    now += rawDt;

    perf.buf[perf.idx] = dt;
    perf.idx = (perf.idx + 1) % 60;
    if (perf.idx === 0) perf.full = true;

    if (!perf.budgetSet && perf.full) {
      perf.budgetMs = detectBudgetMs(perf.buf, isMobile, false);
      perf.budgetSet = true;
    }

    if (perf.full && now >= perf.nextEval) {
      perf.nextEval = now + 2000;
      const p90ms = percentile90(perf.buf);
      const minNear = Math.floor(limits.near / 2);
      const minFar  = Math.floor(limits.far  / 2);
      const minCull = Math.floor(limits.cull / 2);
      if (p90ms > perf.budgetMs * 1.4) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.max(minNear, VIEW_NEAR - 2);
        VIEW_FAR  = Math.max(minFar,  VIEW_FAR  - 2);
        CULL_DIST = Math.max(minCull, CULL_DIST - 400);
        if (VIEW_FAR !== oldFar) qualitySteps++;
        perf.cooldown = now + 4000;
      } else if (p90ms < perf.budgetMs * 1.15 && now >= perf.cooldown) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.min(limits.near, VIEW_NEAR + 1);
        VIEW_FAR  = Math.min(limits.far,  VIEW_FAR  + 1);
        CULL_DIST = Math.min(limits.cull, CULL_DIST + 200);
        if (VIEW_FAR !== oldFar) qualitySteps++;
      }
    }

    farTrace.push(VIEW_FAR);
  }

  return summarize('old', farTrace, qualitySteps, VIEW_NEAR, VIEW_FAR, CULL_DIST);
}

/**
 * New adaptive quality controller — mirrors gameRenderer.js
 * updatePerformanceScaling() + _PERF_PROFILE_DESKTOP / _PERF_PROFILE_MOBILE.
 *
 * Key improvements over old:
 *   - Requires 2 consecutive over-budget evals before reducing (avoids jitter spikes).
 *   - Requires 3 consecutive under-budget evals before restoring (stable hysteresis).
 *   - Desktop uses wider reduce/restore margins to tolerate mild frame variation.
 *   - Mobile uses tighter reduce margin (1.40×) to respond faster to thermal throttle.
 *   - Desktop enforces a 60 Hz budget floor; mobile allows 30 Hz budget detection.
 *
 * @param {number[]} frames   Synthetic frame-time array (ms).
 * @param {object}   limits   { near, far, cull } upper limits.
 * @param {boolean}  isMobile Whether to apply mobile-specific thresholds.
 * @returns {object} Summary result.
 */
function runNewController(frames, limits, isMobile) {
  let VIEW_NEAR = limits.near;
  let VIEW_FAR  = limits.far;
  let CULL_DIST = limits.cull;

  // Thresholds match _PERF_PROFILE_DESKTOP / _PERF_PROFILE_MOBILE in gameRenderer.js.
  const reduceRatio  = isMobile ? 1.40 : 1.55;
  const restoreRatio = isMobile ? 1.15 : 1.08;

  const perf = {
    buf: new Float32Array(60),
    idx: 0,
    full: false,
    budgetMs: 1000 / 60,
    budgetSet: false,
    nextEval: 0,
    cooldown: 0,
    overBudgetEvals: 0,
    underBudgetEvals: 0,
  };

  let now = 0;
  let qualitySteps = 0;
  const farTrace = [];

  for (const rawDt of frames) {
    const dt = Math.min(rawDt, DT_CAP);
    now += rawDt;

    perf.buf[perf.idx] = dt;
    perf.idx = (perf.idx + 1) % 60;
    if (perf.idx === 0) perf.full = true;

    if (!perf.budgetSet && perf.full) {
      // Desktop floor: never allow budget below 16.67 ms (60 Hz) so mild
      // high-fps startup frames don't set an unreachably tight budget.
      perf.budgetMs = detectBudgetMs(perf.buf, isMobile, /* useDesktopFloor */ !isMobile);
      perf.budgetSet = true;
    }

    if (perf.full && now >= perf.nextEval) {
      perf.nextEval = now + 2000;
      const p90ms = percentile90(perf.buf);
      const canRestore = now >= perf.cooldown;

      if (p90ms > perf.budgetMs * reduceRatio) {
        perf.overBudgetEvals++;
        perf.underBudgetEvals = 0;
      } else if (p90ms < perf.budgetMs * restoreRatio && canRestore) {
        perf.underBudgetEvals++;
        perf.overBudgetEvals = 0;
      } else {
        perf.overBudgetEvals = 0;
        perf.underBudgetEvals = 0;
      }

      const minNear = Math.floor(limits.near / 2);
      const minFar  = Math.floor(limits.far  / 2);
      const minCull = Math.floor(limits.cull / 2);

      if (perf.overBudgetEvals >= 2) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.max(minNear, VIEW_NEAR - 1);
        VIEW_FAR  = Math.max(minFar,  VIEW_FAR  - 1);
        CULL_DIST = Math.max(minCull, CULL_DIST - 250);
        if (VIEW_FAR !== oldFar) qualitySteps++;
        perf.cooldown = now + 6000;
        perf.overBudgetEvals = 0;
        perf.underBudgetEvals = 0;
      } else if (perf.underBudgetEvals >= 3) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.min(limits.near, VIEW_NEAR + 1);
        VIEW_FAR  = Math.min(limits.far,  VIEW_FAR  + 1);
        CULL_DIST = Math.min(limits.cull, CULL_DIST + 150);
        if (VIEW_FAR !== oldFar) qualitySteps++;
        perf.cooldown = now + 4000;
        perf.overBudgetEvals = 0;
        perf.underBudgetEvals = 0;
      }
    }

    farTrace.push(VIEW_FAR);
  }

  return summarize('new', farTrace, qualitySteps, VIEW_NEAR, VIEW_FAR, CULL_DIST);
}

// =============================================================================
// Reporting helpers
// =============================================================================

function summarize(name, farTrace, qualitySteps, near, far, cull) {
  let minFar = Infinity;
  let maxFar = -Infinity;
  let sumFar = 0;
  for (const v of farTrace) {
    minFar = Math.min(minFar, v);
    maxFar = Math.max(maxFar, v);
    sumFar += v;
  }
  const avgFar = sumFar / farTrace.length;
  let varFar = 0;
  for (const v of farTrace) varFar += (v - avgFar) ** 2;
  const stdFar = Math.sqrt(varFar / farTrace.length);

  return {
    name,
    steps: qualitySteps,
    minFar,
    maxFar,
    avgFar: +avgFar.toFixed(2),
    stdFar: +stdFar.toFixed(2),
    finalNear: near,
    finalFar: far,
    finalCull: cull,
  };
}

function printResult(r) {
  console.log(`  ${r.name.toUpperCase()} controller`);
  console.log(`    quality steps: ${r.steps}`);
  console.log(`    VIEW_FAR: min ${r.minFar}, max ${r.maxFar}, avg ${r.avgFar}, stddev ${r.stdFar}`);
  console.log(`    final quality: VIEW_NEAR=${r.finalNear}, VIEW_FAR=${r.finalFar}, CULL_DIST=${r.finalCull}`);
}

function printScenario(title, frames, limits, isMobile) {
  const oldRes = runOldController(frames, limits, isMobile);
  const newRes = runNewController(frames, limits, isMobile);
  const stepDelta = oldRes.steps - newRes.steps;
  const stdDelta  = +(oldRes.stdFar - newRes.stdFar).toFixed(2);

  console.log(`\n━━━ ${title} ━━━`);
  console.log(`  Simulated duration: ${SIM_SECONDS}s (${frames.length} frames)`);
  console.log(`  Limits: VIEW_NEAR=${limits.near}, VIEW_FAR=${limits.far}, CULL_DIST=${limits.cull}`);
  console.log('');
  printResult(oldRes);
  console.log('');
  printResult(newRes);
  console.log('\n  Delta (old - new):');
  console.log(`    fewer quality changes : ${stepDelta}`);
  console.log(`    lower VIEW_FAR stddev : ${stdDelta}`);
}

(function main() {
  // ── Scenario 1: Desktop 75 Hz startup → 60 fps steady ─────────────────────
  printScenario(
    'Desktop 75 Hz (startup near 75 fps, gameplay near 60 fps)',
    generateDesktop75HzFrameTimes(),
    DESKTOP_VIEW_LIMITS,
    false
  );

  // ── Scenario 2: Desktop 60 Hz (no high-fps startup phase) ─────────────────
  printScenario(
    'Desktop 60 Hz (steady 60 fps throughout)',
    generateDesktop60HzFrameTimes(),
    DESKTOP_VIEW_LIMITS,
    false
  );

  // ── Scenario 3: Mobile thermal throttle ───────────────────────────────────
  printScenario(
    'Mobile thermal throttle (60 fps → 30 fps, heavy GC spikes)',
    generateMobileFrameTimes(),
    MOBILE_VIEW_LIMITS,
    true
  );

  console.log('');
})();
