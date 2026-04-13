// =============================================================================
// p5Context.js — Shared p5 instance for ES-module consumers
//
// p5 is loaded as a regular <script> (UMD global) in index.html.
// sketch.js creates a p5 instance in INSTANCE MODE and calls initP5().
// Every module that needs p5 drawing / utility functions imports `p` from here
// and uses it as: p.push(), p.fill(255), p.noise(x, z), etc.
//
// @exports  initP5(pInst)    — called once by sketch.js after instance creation
// @exports  p                — Proxy that delegates every property/method to the live instance
// =============================================================================

let _inst = null;

/**
 * Register the live p5 instance.  Must be called before any rendering begins.
 * @param {object} pInst  The p5 instance created by `new p5(sketchFn)`.
 */
export function initP5(pInst) {
  _inst = pInst;
}

/**
 * Proxy that transparently forwards all property accesses and method calls
 * to the registered p5 instance.  Functions are auto-bound to the instance
 * so they work correctly as standalone calls: `p.push()` rather than `_inst.push()`.
 *
 * Throws a clear error at the call site if the instance has not been registered
 * yet, which makes initialization-order bugs easy to diagnose.
 */
export const p = new Proxy(
  {},
  {
    get(_, key) {
      if (_inst === null) {
        throw new Error(
          `p5Context: p5 instance not initialized. ` +
          `Accessed "${String(key)}" before initP5() was called.`
        );
      }
      const val = _inst[key];
      return typeof val === 'function' ? val.bind(_inst) : val;
    },
    set(_, key, value) {
      if (_inst === null) {
        throw new Error(`p5Context: cannot set "${String(key)}" — p5 instance not initialized.`);
      }
      _inst[key] = value;
      return true;
    },
  }
);
