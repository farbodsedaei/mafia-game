'use strict';
// Plays a complete game to its end: Day 2's vote lands squarely on the
// Mafia player themselves, which should trip checkWinner() into a village
// win immediately (no Night 2 needed) and push everyone — including the
// just-eliminated Mafia player — onto the game-over screen with the right
// winner and a full roster.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, text, waitFor, teardown, $ } = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara'];

runScenario('04-full-game-village-win', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    host.App.goLanding('host');
    host.App.stepPlayers(-2); // 6 -> 4
    host.App.stepMafia(-1);   // 2 -> 1
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames } = await assignRolesAndBegin(host, players, log);
    const mafiaPlayer = players.find((p) => mafiaNames.includes(p.label));
    const villagers = players.filter((p) => p !== mafiaPlayer);

    await playDay1AndSkipNight1(host, players, log);

    log.step('Day 2: the village accuses ' + mafiaPlayer.label + ' (the actual Mafia) directly...');
    host.App.startVoting();
    const round1 = {};
    villagers.forEach((p) => { round1[p.label] = [mafiaPlayer.label]; });
    await castVotes(players, round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen' });

    host.App.startFinalVote();
    const finalVotes = {};
    villagers.forEach((p) => { finalVotes[p.label] = [mafiaPlayer.label]; });
    await castVotes(villagers, finalVotes, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the result screen' });
    const resultTitle = text(host, 'result-title') || '';
    log.assert(resultTitle.indexOf(mafiaPlayer.label) !== -1,
      'result screen names ' + mafiaPlayer.label + ' as voted out');

    log.step('Since Mafia is now eliminated, this should end the game as a village win...');
    host.App.proceedAfterResult();

    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen' });
    const hostTitle = text(host, 'game-over-title') || '';
    log.info('Host game-over title: "' + hostTitle + '"');
    const hostRosterRows = $(host, 'game-over-roster').children.length;
    log.assert(hostRosterRows === PLAYER_NAMES.length,
      'host game-over roster lists all ' + PLAYER_NAMES.length + ' players (found ' + hostRosterRows + ')');

    for (const p of players) {
      await waitFor(() => activeScreenId(p) === 'screen-player-game-over',
        { message: p.label + ' never reached their own game-over screen' });
    }
    log.pass('Every player (including the eliminated Mafia) reached the game-over screen.');

    const mafiaOverTitle = text(mafiaPlayer, 'game-over-title-player') || '';
    const villagerOverTitle = text(villagers[0], 'game-over-title-player') || '';
    log.assert(mafiaOverTitle === villagerOverTitle && mafiaOverTitle === hostTitle,
      'every device agrees on the same winner text ("' + hostTitle + '")');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
