/**
 * Small seedable PRNG (mulberry32) so simulations/tests can be made
 * deterministic. With no seed it simply returns Math.random, i.e. the
 * default behavior of every consumer is unchanged.
 */

'use strict';

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  // string seeds (or anything else) -> 32-bit FNV-1a hash
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @returns {() => number} a function yielding floats in [0, 1) */
function createRng(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let a = hashSeed(seed);
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { createRng };
