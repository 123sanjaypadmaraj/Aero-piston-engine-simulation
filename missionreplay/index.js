/**
 * missionreplay/index.js - barrel export
 *
 * Surfaces the mission replay + artificial CAN systems as one module:
 *   const mr = require('./missionreplay');
 *   mr.profiles           phase tables + parameter models
 *   mr.faultLib           fault taxonomy, injection + detection rules
 *   mr.can                artificial J1939-flavoured CAN bus
 *   mr.generator          synthetic mission log writer (deterministic)
 *   mr.loader             log reader (idx-based seek)
 *   mr.replay             stateful replay engine + anomaly overlay
 */

'use strict';

module.exports = {
  profiles: require('./profiles'),
  faultLib: require('./faultLib'),
  can: require('./can'),
  generator: require('./generator'),
  loader: require('./loader'),
  replay: require('./replay'),
};