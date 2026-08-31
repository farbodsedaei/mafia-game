'use strict';
// Focused on the night engine specifically: a Day 2 vote that reaches no
// majority (nobody eliminated), followed by a real Night 2 where Mafia
// actually submits a kill. Confirms handleNightAction/resolveNight take a
// genuine 'night-action' message all the way through to a death that's
// correctly announced (deadName on every survivor's screen, the
// elimination screen on the victim) — kept deliberately short of a win
// condition (4 players / 1 Mafia — one kill isn't enough to end it) so this
// stays a clean test of the mechanic alone; see 05-full-game-mafia-win.js
// for the win-condition itself.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, text, pickNightTarget, waitFor, teardown } = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara'];

runScenario('03-night-mafia-kill', async (log) => {
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

    await playDay1AndSkipNight1(host, players, log);

    log.step('Day 2: everyone abstains, so no majority is reached...');
    host.App.startVoting();
    await castVotes(players, {}, log, 'round 1');
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the result screen after an all-abstain vote' });
    log.assert(activeScreenId(host) === 'screen-host-result', 'a unanimous abstain skipped straight to "no one eliminated" (no defense round)');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2' });
    host.App.continueAfterEyesClosed();

    await waitFor(() => activeScreenId(mafiaPlayer) === 'screen-player-night-action',
      { message: mafiaPlayer.label + ' (Mafia) never got the kill prompt' });
    const victim = players.find((p) => p !== mafiaPlayer);
    log.step(mafiaPlayer.label + ' (Mafia) shoots ' + victim.label + '...');
    pickNightTarget(mafiaPlayer, victim.label);
    mafiaPlayer.App.submitNightAction();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'night never reached the morning-ready screen after the kill decision' });
    host.App.announceMorning();

    await waitFor(() => activeScreenId(victim) === 'screen-player-eliminated',
      { message: victim.label + ' never saw their own elimination screen' });
    log.pass(victim.label + ' was correctly eliminated by the night kill.');

    const survivors = players.filter((p) => p !== victim && p !== mafiaPlayer);
    for (const p of survivors) {
      await waitFor(() => activeScreenId(p) === 'screen-player-night-waiting',
        { message: p.label + ' never saw the night result' });
      const note = text(p, 'night-waiting-note') || '';
      log.assert(note.indexOf(victim.label) !== -1,
        p.label + '\'s night result names ' + victim.label + ' as dead (got "' + note + '")');
    }

    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'one villager death (of three) must not yet end a 4-player game');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
