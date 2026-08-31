'use strict';
// Smoke test: a host creates a lobby, six players join by room code and pick
// names, and the host deals roles out. Confirms the most basic path through
// the app works end to end (real WebSocket signaling, real spawned
// server.js, mocked-but-faithful WebRTC) before any of the other scenarios
// build on it, and that role assignment hands out exactly the configured
// number of Mafia (the default setup: 6 players / 2 Mafia).
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, $, activeScreenId, roleInfo, waitFor, teardown } = require('../lib/device');
const { joinPlayers } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid'];

runScenario('01-lobby-join-and-role-assignment', async (log) => {
  const server = await startServer();
  log.info('Spawned real server.js on ' + server.baseURL);
  const host = createDevice(server.baseURL, { label: 'host' });

  try {
    log.step('Host opens the app and creates a lobby (default 6 players / 2 Mafia)...');
    host.App.goLanding('host');
    host.App.createLobby();

    const { players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log);

    log.step('Host assigns roles...');
    host.App.assignRoles();

    for (const p of players) {
      await waitFor(() => activeScreenId(p) === 'screen-player-role',
        { message: p.label + ' never received a role card' });
    }

    const dossierRows = $(host, 'dossier-table').querySelectorAll('tr').length;
    log.assert(dossierRows === PLAYER_NAMES.length,
      'host dossier lists all ' + PLAYER_NAMES.length + ' players (found ' + dossierRows + ')');

    let mafiaCount = 0;
    for (const p of players) {
      const info = roleInfo(p);
      log.info(p.label + ' -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
      if (!info.title) log.fail(p.label + ' role card has no title');
      if (!info.desc) log.fail(p.label + ' role card has no description');
      if (info.isMafia) mafiaCount++;
    }
    log.assert(mafiaCount === 2, 'exactly 2 players were dealt Mafia (found ' + mafiaCount + ')');
    log.assert(PLAYER_NAMES.length - mafiaCount === 4, 'the other 4 players were dealt villager roles');

    log.assert(activeScreenId(host) === 'screen-host-summary',
      'host landed on the role-summary screen after assigning roles');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host]);
    throw err;
  }
});
