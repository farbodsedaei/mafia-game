'use strict';
// Spawns the REAL, unmodified server.js as a child process on an ephemeral
// port, for a scenario to point its simulated devices at. Nothing about
// server.js is mocked — this is the same file that runs on Render.
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForHttpUp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server.js never came up on port ' + port));
        else setTimeout(tryOnce, 100);
      });
      req.on('timeout', () => req.destroy());
    };
    tryOnce();
  });
}

// opts: { hostGraceMs } — mirrors server.js's own HOST_GRACE_MS_OVERRIDE test
// hook, for reconnect scenarios that don't want to wait the real 90s.
async function startServer(opts) {
  opts = opts || {};
  const port = await findFreePort();
  const env = Object.assign({}, process.env, { PORT: String(port) });
  if (opts.hostGraceMs) env.HOST_GRACE_MS_OVERRIDE = String(opts.hostGraceMs);

  const child = spawn(process.execPath, [SERVER_PATH], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  const exitedEarly = new Promise((_, reject) => {
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error('server.js exited early (code ' + code + '): ' + stderrBuf));
    });
  });

  await Promise.race([
    waitForHttpUp(port, 8000),
    exitedEarly
  ]);

  return {
    port,
    baseURL: 'http://127.0.0.1:' + port + '/',
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        child.kill();
      });
    }
  };
}

module.exports = { startServer };
