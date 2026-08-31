'use strict';
// Plays a full Day 2 vote to completion (round 1 accusation -> defense ->
// round 2 final vote -> elimination) against a deliberately NON-Mafia
// target, confirming: the majority-threshold math actually eliminates the
// right person, the eliminated player's own screen reflects it, everyone
// else sees the correct day-result, vote history is recorded, and — since
// a villager died rather than the Mafia — the game correctly does NOT end,
// carrying on into Night 2.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, text, waitFor, teardown } = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes, logTally } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara'];

runScenario('02-day-voting-elimination', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures a small 4-player / 1-Mafia game...');
    host.App.goLanding('host');
    host.App.stepPlayers(-2); // 6 -> 4
    host.App.stepMafia(-1);   // 2 -> 1
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames } = await assignRolesAndBegin(host, players, log);
    log.assert(mafiaNames.length === 1, 'exactly 1 Mafia was dealt (found ' + mafiaNames.length + ')');

    await playDay1AndSkipNight1(host, players, log);

    const target = players.find((p) => !mafiaNames.includes(p.label));
    log.info('Day 2 target (a villager, deliberately NOT Mafia): ' + target.label);

    log.banner('DAY 2');
    log.step('Host starts voting...');
    host.App.startVoting();
    const unanimous = {};
    PLAYER_NAMES.filter((n) => n !== target.label).forEach((n) => { unanimous[n] = [target.label]; });
    await castVotes(players, unanimous, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after a unanimous round-1 vote' });
    logTally(host, log, 'round 1');
    log.pass('Round 1 vote made ' + target.label + ' the sole defendant.');

    log.step('Host opens the final vote...');
    host.App.startFinalVote();
    const finalVotes = {};
    PLAYER_NAMES.filter((n) => n !== target.label).forEach((n) => { finalVotes[n] = [target.label]; });
    await castVotes(players.filter((p) => p !== target), finalVotes, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the round-result screen' });
    logTally(host, log, 'final vote');
    const resultTitle = text(host, 'result-title') || '';
    log.assert(resultTitle.indexOf(target.label) !== -1,
      'result screen names ' + target.label + ' as voted out (got "' + resultTitle + '")');

    await waitFor(() => activeScreenId(target) === 'screen-player-eliminated',
      { message: target.label + ' never saw their own elimination screen' });
    log.death(target.label, 'villager', 'voted out by the village');
    log.pass(target.label + '\'s own device shows the elimination screen.');

    for (const p of players.filter((pl) => pl !== target)) {
      await waitFor(() => activeScreenId(p) === 'screen-player-day-result',
        { message: p.label + ' never saw the day result' });
    }
    log.pass('Every surviving player saw the day result.');

    log.step('Host proceeds — since Mafia is still alive, this should move to Night 2, not end the game...');
    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2 after the day-2 elimination' });
    log.banner('NIGHT 2');
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'game correctly continues (a villager\'s death alone must not end it)');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
