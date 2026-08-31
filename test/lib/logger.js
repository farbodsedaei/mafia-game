'use strict';
// Narrative logger for a single scenario run. Writes a plain-English,
// timestamped play-by-play both to the console (as the scenario runs) and to
// a .log file under test/logs/ (gitignored — see .gitignore) so a full
// transcript survives after the process exits. Deliberately NOT structured
// JSON — the whole point (per the user's own request) is something easy for
// a human to skim after a run, not a machine-diffable trace.
const fs = require('fs');
const path = require('path');

class Logger {
  constructor(scenarioName) {
    this.scenarioName = scenarioName;
    this.lines = [];
    this.startedAt = Date.now();
    this.failures = [];
  }

  _stamp() {
    return ((Date.now() - this.startedAt) / 1000).toFixed(2).padStart(6, ' ') + 's';
  }

  _push(line) {
    this.lines.push(line);
    console.log(line);
  }

  header(title) {
    this._push('');
    this._push('=== ' + title + ' ===');
  }

  // A day/night phase change — the spine of the game recap. Deliberately
  // louder than a plain step() so skimming the log for "how did the game
  // progress" means just scanning for these lines.
  banner(title) {
    this._push('');
    this._push('───────── ' + title + ' ─────────');
  }

  // rows: [{name, count}], already sorted however the caller wants them
  // shown (typically desc by count, matching the host's own live tally UI).
  // Pulled from the REAL rendered #voting-tally DOM, not from what the test
  // script told each player to vote for — so this doubles as a check that
  // the app counted the same votes the test actually cast.
  tally(rows, label) {
    this.info('Tally' + (label ? ' (' + label + ')' : '') + ':');
    rows.forEach((r) => {
      this._push('[' + this._stamp() + ']     ' + r.name + ' — ' + r.count + ' vote' + (r.count === 1 ? '' : 's'));
    });
  }

  // A player leaving the game — by vote or by night action. `cause` is a
  // short phrase ("voted out by the village", "shot by the Mafia", ...).
  death(name, role, cause) {
    this._push('[' + this._stamp() + '] ☠ ' + name + (role ? ' (' + role + ')' : '') + ' is out — ' + cause + '.');
  }

  // rows: [{name, role, alive}] — the final game-over roster, one line per
  // player, read from the real DOM so it reflects what every device
  // actually displayed, not just what the test script tracked internally.
  roster(rows) {
    this.info('Final roster:');
    rows.forEach((r) => {
      this._push('[' + this._stamp() + ']     ' + r.name + ' — ' + r.role + ' — ' + (r.alive ? 'ALIVE' : 'OUT'));
    });
  }

  step(text) {
    this._push('[' + this._stamp() + '] ' + text);
  }

  info(text) {
    this._push('[' + this._stamp() + ']   ' + text);
  }

  pass(text) {
    this._push('[' + this._stamp() + '] ✓ PASS: ' + text);
  }

  fail(text) {
    this.failures.push(text);
    this._push('[' + this._stamp() + '] ✗ FAIL: ' + text);
  }

  assert(condition, description) {
    if (condition) this.pass(description);
    else this.fail(description);
    return !!condition;
  }

  get ok() {
    return this.failures.length === 0;
  }

  save(dir) {
    dir = dir || path.join(__dirname, '..', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = this.scenarioName.replace(/[^a-z0-9_-]+/gi, '-');
    const file = path.join(dir, safeName + '.log');
    const summary = this.ok
      ? 'RESULT: PASS'
      : 'RESULT: FAIL (' + this.failures.length + ' failure' + (this.failures.length === 1 ? '' : 's') + ')';
    fs.writeFileSync(file, this.lines.join('\n') + '\n\n' + summary + '\n', 'utf8');
    return file;
  }
}

module.exports = { Logger };
