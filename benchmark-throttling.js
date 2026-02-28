'use strict';

// =============================================================================
// benchmark-throttling.js — Simulates dynamic quality scaling under a 75 Hz
// display with realistic jitter/spikes, and compares old vs new controller
// behaviour (distance stability + number of quality steps).
//
// Run: node benchmark-throttling.js
// =============================================================================

const SIM_SECONDS = 180;
const DT_CAP = 100;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function percentile90(arr) {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  return sorted[53]; // 90th percentile of 60 samples
}

function detectBudgetMs(buffer, isMobile, useDesktopFloor) {
  const sorted = Array.from(buffer).sort((a, b) => a - b);
  const medMs = (sorted[29] + sorted[30]) / 2;
  const tierMs = [6.94, 8.33, 11.11, 13.33, 16.67, 33.33];
  let budget = tierMs.reduce((b, c) => Math.abs(c - medMs) < Math.abs(b - medMs) ? c : b);
  if (useDesktopFloor && !isMobile) budget = Math.max(budget, 1000 / 60);
  return budget;
}

// Synthetic frame-times:
// 1) first 2 seconds near 75 Hz (menu / low load)
// 2) gameplay near 60 fps with occasional stutter spikes
function generateFrameTimes() {
  const frames = [];
  let tMs = 0;
  while (tMs < SIM_SECONDS * 1000) {
    let dt;
    if (tMs < 2000) {
      dt = 13.3 + Math.sin(tMs * 0.002) * 0.2;
    } else {
      dt = 16.5 + Math.sin(tMs * 0.0018) * 0.7;
      // Periodic stutter bursts to mimic GC / driver hiccups.
      if ((Math.floor(tMs / 1700) % 2) === 1 && (tMs % 1700) < 120) dt += 6.0;
      if ((Math.floor(tMs / 5100) % 2) === 1 && (tMs % 5100) < 180) dt += 4.0;
    }
    dt = clamp(dt, 8, 33);
    frames.push(dt);
    tMs += dt;
  }
  return frames;
}

function runOldController(frames) {
  let VIEW_NEAR = 35;
  let VIEW_FAR = 50;
  let CULL_DIST = 6000;

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
      perf.budgetMs = detectBudgetMs(perf.buf, false, false);
      perf.budgetSet = true;
    }

    if (perf.full && now >= perf.nextEval) {
      perf.nextEval = now + 2000;
      const p90ms = percentile90(perf.buf);
      if (p90ms > perf.budgetMs * 1.4) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.max(15, VIEW_NEAR - 2);
        VIEW_FAR = Math.max(20, VIEW_FAR - 2);
        CULL_DIST = Math.max(2000, CULL_DIST - 400);
        if (VIEW_FAR !== oldFar) qualitySteps++;
        perf.cooldown = now + 4000;
      } else if (p90ms < perf.budgetMs * 1.15 && now >= perf.cooldown) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.min(35, VIEW_NEAR + 1);
        VIEW_FAR = Math.min(50, VIEW_FAR + 1);
        CULL_DIST = Math.min(6000, CULL_DIST + 200);
        if (VIEW_FAR !== oldFar) qualitySteps++;
      }
    }

    farTrace.push(VIEW_FAR);
  }

  return summarize('old', farTrace, qualitySteps, VIEW_NEAR, VIEW_FAR, CULL_DIST);
}

function runNewController(frames) {
  let VIEW_NEAR = 35;
  let VIEW_FAR = 50;
  let CULL_DIST = 6000;

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
      perf.budgetMs = detectBudgetMs(perf.buf, false, true);
      perf.budgetSet = true;
    }

    if (perf.full && now >= perf.nextEval) {
      perf.nextEval = now + 2000;
      const p90ms = percentile90(perf.buf);

      const reduceRatio = 1.55;
      const restoreRatio = 1.08;
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

      if (perf.overBudgetEvals >= 2) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.max(24, VIEW_NEAR - 1);
        VIEW_FAR = Math.max(34, VIEW_FAR - 1);
        CULL_DIST = Math.max(4200, CULL_DIST - 250);
        if (VIEW_FAR !== oldFar) qualitySteps++;
        perf.cooldown = now + 6000;
        perf.overBudgetEvals = 0;
        perf.underBudgetEvals = 0;
      } else if (perf.underBudgetEvals >= 3) {
        const oldFar = VIEW_FAR;
        VIEW_NEAR = Math.min(35, VIEW_NEAR + 1);
        VIEW_FAR = Math.min(50, VIEW_FAR + 1);
        CULL_DIST = Math.min(6000, CULL_DIST + 150);
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

(function main() {
  const frames = generateFrameTimes();
  const oldRes = runOldController(frames);
  const newRes = runNewController(frames);

  console.log('\n━━━ Dynamic Throttle Stability Benchmark (75 Hz scenario) ━━━━━━━━━━━━━━━━━━━');
  console.log(`  Simulated duration: ${SIM_SECONDS}s (${frames.length} frames)`);
  console.log('  Scenario: startup near 75 fps, gameplay near 60 fps with periodic stutter bursts.\n');

  printResult(oldRes);
  console.log('');
  printResult(newRes);

  const stepDelta = oldRes.steps - newRes.steps;
  const stdDelta = +(oldRes.stdFar - newRes.stdFar).toFixed(2);
  console.log('\n  Delta (old - new):');
  console.log(`    fewer quality changes: ${stepDelta}`);
  console.log(`    lower VIEW_FAR variance: ${stdDelta}`);
  console.log('');
})();
