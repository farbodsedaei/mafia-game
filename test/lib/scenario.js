'use strict';
const { Logger } = require('./logger');

// Common wrapper every scenario script uses: sets up the narrative log,
// catches anything the scenario throws (a thrown Error becomes one more
// logged failure rather than an unhandled rejection), always saves the log
// file, and always exits the process explicitly — the mock WebRTC layer and
// the real `ws` sockets can leave timers/handles alive that would otherwise
// keep a scenario's Node process hanging after it's done.
async function runScenario(name, fn) {
  const log = new Logger(name);
  log.header(name);
  try {
    await fn(log);
  } catch (err) {
    log.fail('Scenario threw: ' + (err && err.stack ? err.stack : err));
  }
  const file = log.save();
  log.header(log.ok ? 'PASS' : 'FAIL');
  console.log('Log saved to ' + file);
  process.exit(log.ok ? 0 : 1);
}

module.exports = { runScenario };
