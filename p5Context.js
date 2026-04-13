// =============================================================================
// p5Context.js — Shared p5 instance for ES-module consumers
//
// p5 is loaded as a regular <script> (UMD global) in index.html.
// sketch.js creates a p5 instance in INSTANCE MODE and calls initP5().
// Every module that needs p5 drawing / utility functions imports `p` from here
// and uses it as: p.push(), p.fill(255), p.noise(x, z), etc.
//
// @exports  initP5(pInst)    — called once by sketch.js after instance creation
// @exports  p                — direct reference to the live instance (no Proxy)
// =============================================================================

/** Live p5 instance reference set by initP5(); null until sketch setup starts. */
export let p = null;

/**
 * Register the live p5 instance.  Must be called before any rendering begins.
 * @param {object} pInst  The p5 instance created by `new p5(sketchFn)`.
 */
export function initP5(pInst) {
  p = pInst;
}
