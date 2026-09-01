'use strict';
// One "device" = one isolated jsdom window loading the REAL, unmodified
// public/index.html — exactly the same file served in production, with
// mocks.js's browser-API shims installed BEFORE the app's own script runs
// (see createDevice below for why that ordering matters). A test scenario
// spins up one device for the host and one per simulated player, all in the
// same Node process, talking to each other only through a real spawned
// server.js (WebSocket) and mocked-but-faithful WebRTC data channels — never
// through any shortcut into each other's JS state.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { installMocks } = require('./mocks');

const INDEX_HTML_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

function createDevice(baseURL, opts) {
  opts = opts || {};
  const url = opts.join ? baseURL + '?join=' + encodeURIComponent(opts.join) : baseURL;
  // 'outside-only' parses the document (every #id the app needs is right
  // there) WITHOUT auto-running the inline <script> — that runs a beat later
  // below, manually, once installMocks() has replaced window.WebSocket /
  // window.RTCPeerConnection / window.fetch. Running it any earlier would
  // have the app's own top-of-file connectWS()/fetch() calls hit jsdom's
  // real (WebRTC-less, and in older jsdom WebSocket-less) globals instead.
  const dom = new JSDOM(INDEX_HTML, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  installMocks(dom.window);
  const scripts = dom.window.document.querySelectorAll('script');
  scripts.forEach((s) => { if (!s.src) dom.window.eval(s.textContent); });

  const win = dom.window;
  return {
    label: opts.label || opts.join || 'host',
    window: win,
    document: win.document,
    get App() { return win.App; },
    close() {
      try { win.close(); } catch (e) { /* ignore */ }
    }
  };
}

// ---------------- DOM helpers ----------------
function $(device, id) { return device.document.getElementById(id); }
function text(device, id) {
  const el = $(device, id);
  return el ? el.textContent : null;
}
function setValue(device, id, value) {
  const el = $(device, id);
  if (!el) throw new Error('setValue: no element #' + id);
  el.value = value;
}
function activeScreenId(device) {
  const el = device.document.querySelector('.screen.active');
  return el ? el.id : null;
}

// Finds a candidate row (vote list / night-action list) by the player's
// visible name and drives its checkbox/radio the same way a real tap would
// — via the exact onXXX handler the app itself assigned to that input, not
// by reaching into app state.
function pickCandidateRow(device, listId, name) {
  const list = $(device, listId);
  if (!list) throw new Error('pickCandidateRow: no list #' + listId);
  const rows = Array.from(list.querySelectorAll('label'));
  const row = rows.find((r) => {
    const nameEl = r.querySelector('.role-name');
    return nameEl && nameEl.textContent === name;
  });
  if (!row) throw new Error('pickCandidateRow: no candidate named "' + name + '" in #' + listId);
  return row.querySelector('input');
}
function checkVoteCandidate(device, name) {
  const input = pickCandidateRow(device, 'vote-candidate-list', name);
  input.checked = true;
  if (typeof input.onchange === 'function') input.onchange({ target: input });
}
function pickNightTarget(device, name) {
  const input = pickCandidateRow(device, 'night-action-candidate-list', name);
  input.checked = true;
  if (typeof input.onchange === 'function') input.onchange();
}
// ساول گودمن: the kill-decider's own night-action prompt grows a "recruit
// instead of shoot" checkbox once Saul is alive and Mafia has already lost
// someone (see startMafiaPhaseStep's canRecruit). Check it BEFORE submitting
// (sendNightAction reads it live at submit time).
function setRecruitCheckbox(device, checked) {
  const el = $(device, 'night-action-recruit-checkbox');
  if (!el) throw new Error('setRecruitCheckbox: #night-action-recruit-checkbox not present');
  el.checked = !!checked;
}

// The day-gun decision (تفنگدار's handoff recipient deciding whether to
// fire) renders its candidates into #gun-decision-section-body — nested
// under a wrapper div, but querySelectorAll in pickCandidateRow searches the
// whole subtree, so this is otherwise identical to pickNightTarget.
function pickDayGunTarget(device, name) {
  const input = pickCandidateRow(device, 'gun-decision-section-body', name);
  input.checked = true;
  if (typeof input.onchange === 'function') input.onchange();
}
// True once a pending day-gun decision has actually been rendered onto this
// device's screen (attachGunDecisionSection sets #gun-decision-section's
// display directly — see index.html) — the section can be pending before
// the day's voting phase even arrives, or attached to whatever screen was
// already showing, so this is the reliable thing to wait on rather than any
// particular screen id.
function isGunDecisionVisible(device) {
  const el = $(device, 'gun-decision-section');
  return !!(el && el.style.display === 'block');
}

// Opts an optional role (e.g. "زودیاک", "دکتر") into this game's role pool
// by checking its box in the host setup screen's #role-checklist — the same
// checkbox a real host taps before creating the lobby. Must be called
// before App.createLobby() (role assignment reads state.selectedRoleIds at
// App.assignRoles() time, but the pool is meant to be locked in during
// setup either way).
function selectRoleInPlay(device, roleName) {
  const input = pickCandidateRow(device, 'role-checklist', roleName);
  input.checked = true;
  if (typeof input.onchange === 'function') input.onchange({ target: input });
}
// Opposite of selectRoleInPlay — unchecks an already-selected optional
// role's box, same real onchange path (e.g. undoing a earlier
// selectRoleInPlay, or exercising a dependency the checklist enforces
// between two roles, like زودیاک/زودیاک پسر).
function deselectRoleInPlay(device, roleName) {
  const input = pickCandidateRow(device, 'role-checklist', roleName);
  input.checked = false;
  if (typeof input.onchange === 'function') input.onchange({ target: input });
}
// Reads whether a role is CURRENTLY checked in #role-checklist without
// touching it — renderRoleChecklist() fully rebuilds the list's DOM on
// certain changes (see index.html's enforceZodiacSonDependency), so this
// re-queries live rather than caching an old input reference.
function isRoleInPlay(device, roleName) {
  return !!pickCandidateRow(device, 'role-checklist', roleName).checked;
}

function roleInfo(device) {
  const front = $(device, 'role-front');
  return {
    isMafia: !!(front && front.classList.contains('is-mafia')),
    title: text(device, 'role-title'),
    desc: text(device, 'role-desc')
  };
}

// ---------------- God Mode: driving the host-self card ----------------
// God Mode's host-self (the host playing as one of the seats — see
// HOST_SELF_ID in index.html) has no real data channel at all:
// sendToPlayer's isHostSelf branch calls receiveAsHostSelf(obj) directly,
// SYNCHRONOUSLY, in-process — so unlike every real player device above,
// there's no async message delivery to wait out. The host-self card
// (#host-self-section, built by updateHostSelfActionCard) renders whatever
// the current pending action is into #host-self-card-body (vote/night-
// action) or #host-self-gun-body (the day-gun decision, independent of the
// main action) with the exact same row markup pickCandidateRow expects, so
// selecting a candidate there works identically to a real player's screen.
function isHostSelfActionVisible(host) {
  const el = $(host, 'host-self-main-action');
  return !!(el && el.style.display === 'block');
}
function isHostSelfGunActionVisible(host) {
  const el = $(host, 'host-self-gun-action');
  return !!(el && el.style.display === 'block');
}
// Generic across the host-self card's vote checkboxes AND night-action
// radios: both onchange handlers either read e.target.checked or ignore
// their argument entirely, so always passing {target: input} is safe for
// either kind (same reasoning as pickNightTarget's real-player counterpart).
function pickHostSelfCandidate(host, listId, name) {
  const input = pickCandidateRow(host, listId, name);
  input.checked = true;
  if (typeof input.onchange === 'function') input.onchange({ target: input });
}
function setHostSelfRecruitCheckbox(host, checked) {
  const el = $(host, 'host-self-recruit-checkbox');
  if (!el) throw new Error('setHostSelfRecruitCheckbox: #host-self-recruit-checkbox not present');
  el.checked = !!checked;
}
// Peeks at the God-Mode host's OWN role via the same App.viewMyRole()/
// closeMyRole() "peek and return" a real player's "My Role" link uses —
// index.html's attachHostSelfSection already no-ops for non-host-admin
// screens (see its own comment), so this safely returns the host to
// whichever host-admin screen it found them on. Only valid once
// state.myRole is actually set (i.e. after role assignment has reached the
// host-self entry, which — being synchronous — is true immediately after
// App.assignRoles() returns).
function hostSelfRoleInfo(host) {
  host.App.viewMyRole();
  const info = roleInfo(host);
  host.App.closeMyRole();
  return info;
}

function roomCode(device) {
  const raw = text(device, 'room-code-display') || '';
  const code = raw.replace(/\s+/g, '');
  return /^—+$/.test(code) ? null : code;
}

// Reads the host's OWN live vote tally straight out of the rendered
// #voting-tally box (renderVotingTally's output) — real counts the app
// itself computed, not the test's own bookkeeping. The count is embedded in
// a translated string ("3 رأی" / "3 votes"), so it's pulled out with a
// digit regex rather than parsed by language.
function readVoteTally(device) {
  const box = $(device, 'voting-tally');
  if (!box) return [];
  return Array.from(box.children).map((row) => {
    const name = row.querySelector('.name').textContent;
    const statusText = row.querySelector('.status').textContent;
    const match = /(\d+)/.exec(statusText);
    return { name, count: match ? parseInt(match[1], 10) : 0 };
  });
}

// Reads the host's final #game-over-roster — one row per player, each
// showing their real name, revealed role, and alive/out status exactly as
// every device's own screen renders it (App.showGameOver appends the same
// "(out)" hint to a dead player's name and uses a `.slot.connected` class
// only for the living — see index.html's App.showGameOver).
function readGameOverRoster(device) {
  const box = $(device, 'game-over-roster');
  if (!box) return [];
  return Array.from(box.children).map((row) => {
    const nameEl = row.querySelector('.name');
    const firstNode = nameEl.childNodes[0];
    const name = (firstNode ? firstNode.textContent : nameEl.textContent).trim();
    const role = row.querySelector('.tag').textContent;
    const alive = row.classList.contains('connected');
    return { name, role, alive };
  });
}

function connectedNamedCount(device) {
  const list = $(device, 'slot-list');
  if (!list) return 0;
  return list.querySelectorAll('.slot.connected').length;
}

// ---------------- Async waiting ----------------
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 5000;
  const interval = opts.interval || 25;
  const deadline = Date.now() + timeout;
  for (;;) {
    let result;
    try { result = predicate(); } catch (e) { result = false; }
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out after ' + timeout + 'ms' + (opts.message ? ': ' + opts.message : ''));
    }
    await sleep(interval);
  }
}

// ---------------- Connection sabotage (for reconnect scenarios) ----------------
// Simulates the player's (or host's per-player) data channel dying — a real
// WiFi drop, a backgrounded tab, etc. — the same "physical" event
// index.html's own dc.onclose/oniceconnectionstatechange handlers are
// written to notice and recover from. Reaches into the mock connection
// registry mocks.js attaches to the window (test-only, added by mocks.js —
// not a hook inside index.html itself), never into the app's own state.
function lastMockConnection(device) {
  const list = device.window.__mockRTCConnections || [];
  return list[list.length - 1] || null;
}
function dropConnection(device) {
  const pc = lastMockConnection(device);
  if (!pc || !pc._dc) throw new Error('dropConnection: no active mock connection on this device');
  pc._dc.close();
}

// Closing a jsdom window tears down its `document`/globals immediately, but
// a still-open real `ws` socket's own 'close' event fires asynchronously —
// if that lands AFTER the window is gone, index.html's ws.onclose handler
// (which touches the DOM) throws into an unhandled rejection/exception that
// kills the whole process. Stopping the server FIRST lets every socket's
// close handler run against still-alive windows; only then is it safe to
// tear the windows down.
async function teardown(server, devices) {
  if (server) await server.stop();
  await sleep(150);
  devices.forEach((d) => { try { d.close(); } catch (e) { /* ignore */ } });
}

module.exports = {
  createDevice,
  $, text, setValue, activeScreenId,
  checkVoteCandidate, pickNightTarget, selectRoleInPlay, deselectRoleInPlay, isRoleInPlay,
  pickDayGunTarget, isGunDecisionVisible, setRecruitCheckbox,
  roleInfo, roomCode, connectedNamedCount,
  readVoteTally, readGameOverRoster,
  isHostSelfActionVisible, isHostSelfGunActionVisible, pickHostSelfCandidate,
  setHostSelfRecruitCheckbox, hostSelfRoleInfo,
  sleep, waitFor,
  dropConnection,
  teardown
};
