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
// (This file used to also cover a "Test Mode" setup checkbox — a
// per-tab-sessionStorage workaround for simulating several players from one
// browser, needed because the reclaim removal above meant several tabs on
// one device would otherwise all share and clobber the same localStorage
// session. Test Mode itself was removed once the lobby's own phantom-seat
// recycling — see App.removeStuckPlayer/expirePhantomSeats — made that
// workaround unnecessary; this scenario was renamed from
// 05-no-seat-reclaim-plus-test-mode accordingly.)
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, roomCode, $,
  waitFor, roleInfo, dropConnection, sleep, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin } = require('../lib/game-flow');
const { runScenario } = require('../lib/scenario');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];

runScenario('05-no-seat-reclaim', async (log) => {
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
});
