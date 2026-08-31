'use strict';
// Simulates a real "WiFi drop" mid-lobby (before roles are even assigned):
// one player's data channel dies outright, the host should immediately see
// them go from connected to disconnected, and the player's OWN device
// should notice and automatically retry (attemptPlayerReconnect, on the
// SAME persisted token/name — no user action) and land back in a connected
// state with no manual "rejoin" needed. Finishes by assigning roles and
// beginning the game, confirming the reconnected player is treated exactly
// like everyone else afterward — nothing about them stayed "special."
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, connectedNamedCount, dropConnection, waitFor, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara'];

runScenario('06-disconnect-reconnect-lobby', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    host.App.goLanding('host');
    host.App.stepPlayers(-2); // 6 -> 4
    host.App.stepMafia(-1);   // 2 -> 1
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const bita = players.find((p) => p.label === 'Bita');

    log.step('Simulating a dropped connection for Bita (WiFi loss, backgrounded tab, etc.)...');
    dropConnection(bita);

    await waitFor(() => connectedNamedCount(host) === PLAYER_NAMES.length - 1,
      { message: 'host lobby never showed Bita as disconnected' });
    log.pass('Host immediately saw Bita drop to disconnected (3 of 4 shown connected).');

    log.step('Waiting for Bita\'s device to notice and automatically reconnect (no user action)...');
    await waitFor(() => connectedNamedCount(host) === PLAYER_NAMES.length,
      { timeout: 8000, message: 'host lobby never showed all 4 players connected again after the drop' });
    log.pass('Host lobby shows all 4 players connected again — Bita self-healed.');

    const screenAfterReconnect = activeScreenId(bita);
    log.assert(screenAfterReconnect !== 'screen-player-join' && screenAfterReconnect !== 'screen-player-connecting',
      'Bita\'s own device is past the join/connecting screens (currently "' + screenAfterReconnect + '")');

    log.step('Confirming the game still works normally after the reconnect (assign roles + begin)...');
    const { mafiaNames } = await assignRolesAndBegin(host, players, log);
    log.assert(mafiaNames.length === 1, 'role assignment still worked normally after Bita\'s reconnect');
    await waitFor(() => activeScreenId(bita) === 'screen-player-day',
      { message: 'Bita never made it to Day 1 like everyone else after reconnecting' });
    log.pass('Bita is playing normally post-reconnect — no lingering effects from the drop.');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
