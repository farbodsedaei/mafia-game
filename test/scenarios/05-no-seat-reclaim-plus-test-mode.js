'use strict';
// Regression test for a reported security issue: "if someone is
// disconnected, whoever reconnects to the game gets to pick ANY name from a
// list of disconnected players and see their role after connecting."
//
// The whole "claim a disconnected seat by name" mechanism (handleClaimSeat,
// the 'reclaimable-seats'/'claim-seat'/'claim-accepted'/'claim-failed'
// messages, screen-player-reclaim-seat) has been removed entirely, by
// deliberate decision: a device can now ONLY ever rejoin as whichever
// identity its own persisted session (see savePlayerSession) actually
// proves it is. A fresh connection with no matching session is always
// treated as a genuinely new, separate player — even if it types the exact
// same display name as someone else, it gets its own freshly-dealt role and
// its own entry, never access to anyone else's game state.
//
// That removal has a real side effect worth covering here too: with no more
// self-serve reclaim, testing with multiple simulated players from one
// browser needs its OWN mechanism, since every tab on one device normally
// shares the SAME localStorage session (the second tab to save would
// silently clobber the first's). Part 2 covers the new Test Mode setup
// checkbox that fixes that for real testing use, by keeping a session in
// per-TAB sessionStorage instead — verified directly against each device's
// own storage rather than by attempting to fake real cross-tab sharing in
// jsdom (which, unlike a real browser, never shares storage between
// independently-created windows in the first place).
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, roomCode, $, connectedNamedCount,
  waitFor, roleInfo, dropConnection, sleep, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin } = require('../lib/game-flow');
const { runScenario } = require('../lib/scenario');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];

function sessionRaw(device, storage) {
  try { return device.window[storage].getItem('mafia-player-session'); } catch (e) { return null; }
}

runScenario('05-no-seat-reclaim-plus-test-mode', async (log) => {
  log.banner('PART 1 — a disconnected seat can no longer be reclaimed by name');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let players = [];
    let impersonator = null;
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(1); // 6 -> 7, so one declared seat stays genuinely open for part of this test
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));
      const { roles } = await assignRolesAndBegin(host, players, log);
      const amir = players.find((p) => p.label === 'Amir');
      const amirRoleBefore = roles.Amir.title;
      log.info('Amir\'s real role: ' + amirRoleBefore);

      log.step('Amir\'s connection drops...');
      dropConnection(amir);
      await sleep(150);

      log.step('A brand-new device (no persisted session) opens the invite link...');
      const code = roomCode(host);
      impersonator = createDevice(server.baseURL, { join: code, label: 'impersonator' });
      await waitFor(() => activeScreenId(impersonator) === 'screen-player-name',
        { message: 'fresh device should land directly on plain name-entry, not any reclaim/picker screen' });
      log.assert(activeScreenId(impersonator) === 'screen-player-name',
        'fresh device is offered ONLY the plain name-entry screen (no seat picker exists anymore)');
      log.assert(!impersonator.document.getElementById('screen-player-reclaim-seat'),
        'the reclaim-seat screen no longer exists in the DOM at all');

      log.step('It types "Amir" — the exact name of the disconnected real player...');
      $(impersonator, 'input-player-name').value = 'Amir';
      impersonator.App.playerSubmitName();
      // Their role card + the CURRENT phase (Day 1, already under way) both
      // arrive back to back — the phase message lands last and takes over
      // the active screen (screen-player-day), same as any fresh joiner
      // mid-game folding straight into what's happening. The role itself
      // is still dealt and rendered into the DOM regardless of which
      // screen ends up active — read it via roleInfo(), not a screen id.
      // #role-title's own HTML default is the literal placeholder "???"
      // (before any real role ever arrives), so wait for anything ELSE.
      await waitFor(() => { const title = roleInfo(impersonator).title; return !!title && title !== '???'; },
        { timeout: 5000, message: 'impersonator device never got dealt its own role' });

      const impersonatorRole = roleInfo(impersonator);
      log.info('Impersonator\'s dealt role: ' + impersonatorRole.title);
      log.pass('Typing an existing player\'s name got a FRESH role dealt, not access to their game state.');

      const dossierRows = $(host, 'dossier-table').querySelectorAll('tr').length;
      log.assert(dossierRows === NAMES.length + 1,
        'host dossier now shows ' + (NAMES.length + 1) + ' distinct entries (the impersonator became a genuinely separate seat, not a takeover) — found ' + dossierRows);

      log.step('The REAL Amir reconnects on their own...');
      await waitFor(() => activeScreenId(amir) === 'screen-player-role' || activeScreenId(amir) === 'screen-player-day',
        { timeout: 8000, message: 'the real Amir never reconnected on their own' });
      const amirRoleAfter = roleInfo(amir).title;
      log.assert(amirRoleAfter === amirRoleBefore,
        'the real Amir\'s own role is completely untouched by the impersonator\'s actions (' + amirRoleAfter + ')');

      await teardown(server, [host, ...players, impersonator].filter(Boolean));
    } catch (err) {
      await teardown(server, [host, ...players, impersonator].filter(Boolean));
      throw err;
    }
  }

  log.banner('PART 2 — Test Mode keeps each simulated player\'s session in its own tab');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host-testmode' });
    let players = [];
    try {
      host.App.goLanding('host');
      log.step('Host enables Test Mode before creating the lobby...');
      host.App.setTestMode(true);
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, ['Golnar'], log));
      const p1 = players[0];

      await waitFor(() => sessionRaw(p1, 'sessionStorage') !== null,
        { message: 'player never saved a session at all' });
      log.assert(sessionRaw(p1, 'sessionStorage') !== null, 'the session lives in sessionStorage (private to this tab)');
      log.assert(sessionRaw(p1, 'localStorage') === null, 'the shared localStorage copy was pruned once Test Mode was confirmed — no cross-tab collision risk');
      log.assert(JSON.parse(sessionRaw(p1, 'sessionStorage')).testMode === true, 'the stored session itself remembers it\'s a Test Mode session (survives this tab refreshing later)');

      log.step('That same player\'s connection still recovers normally on a drop (Test Mode doesn\'t break real reconnects)...');
      dropConnection(p1);
      // This is still pre-game (lobby only, no roles dealt yet) — a
      // reconnect here correctly just lands back on
      // screen-player-reconnecting and stays there (resyncPlayer has
      // nothing else to replay before the game actually starts — see
      // game-flow.js's own note on this), so the thing to actually check
      // is that the CONNECTION itself came back, not a screen change.
      await waitFor(() => connectedNamedCount(host) === 1,
        { timeout: 8000, message: p1.label + '\'s connection never recovered from the drop' });
      log.pass(p1.label + ' reconnected fine within its own tab under Test Mode.');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }

  log.banner('CONTROL — a normal (non-Test-Mode) game still uses localStorage as before');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host-normal' });
    let players = [];
    try {
      host.App.goLanding('host');
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, ['Hana'], log));
      const p1 = players[0];
      await waitFor(() => sessionRaw(p1, 'localStorage') !== null,
        { message: 'player never saved a session to localStorage in a normal (non-Test-Mode) game' });
      log.assert(sessionRaw(p1, 'localStorage') !== null, 'a normal game still persists the session in localStorage, unchanged from before');
      log.assert(JSON.parse(sessionRaw(p1, 'localStorage')).testMode === false, 'and it\'s correctly NOT flagged as a Test Mode session');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }
});
