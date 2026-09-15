/**
 * twin_core/stateStore.js
 * -----------------------------------------------------------------------
 * In-memory live-state cache keyed by engineId — stand-in for the master
 * plan's Redis "latest state" layer. A real deployment would swap this
 * module's internals for a Redis client without changing its API.
 * -----------------------------------------------------------------------
 */

'use strict';

const states = new Map();

function set(engineId, state) {
  states.set(engineId, state);
}

function get(engineId) {
  return states.get(engineId) || null;
}

function getAll() {
  return Object.fromEntries(states);
}

module.exports = { set, get, getAll };
