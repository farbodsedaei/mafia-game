'use strict';
// Runs every scenario in test/scenarios/ as its own `node` child process
// (so a crash in one can't take down the rest, and mocks.js's process-global
// SDP registry never bleeds between games) and prints a combined summary.
// Each scenario also writes its own full narrative log under test/logs/ —
// see test/README.md.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const scenarioFiles = fs.readdirSync(SCENARIOS_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

function runOne(file) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(SCENARIOS_DIR, file)], { stdio: 'inherit' });
    child.on('exit', (code) => {
      resolve({ file, code, ms: Date.now() - start });
    });
  });
}

(async () => {
  console.log('Running ' + scenarioFiles.length + ' scenario(s)...\n');
  const results = [];
  for (const file of scenarioFiles) {
    results.push(await runOne(file));
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  let failed = 0;
  for (const r of results) {
    const status = r.code === 0 ? 'PASS' : 'FAIL';
    if (r.code !== 0) failed++;
    console.log(
      (status === 'PASS' ? '✓' : '✗') + ' ' + status.padEnd(4) + '  ' +
      r.file + '  (' + (r.ms / 1000).toFixed(2) + 's)'
    );
  }
  console.log('='.repeat(60));
  console.log(results.length - failed + '/' + results.length + ' scenarios passed.');
  console.log('Full narrative logs: ' + path.join(__dirname, 'logs'));
  process.exit(failed ? 1 : 0);
})();
