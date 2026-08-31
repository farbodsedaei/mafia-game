'use strict';
// Plays a complete game to a MAFIA win: a minimal 3-player / 1-Mafia game
// where Day 2 reaches no majority (nobody eliminated) and Night 2's Mafia
// kill takes the villager count down to equal the Mafia count — exactly the
// checkWinner() condition for a Mafia win (aliveVillagers <= aliveMafia,
// with no independent role alive to block it). Confirms the win condition
// actually fires off a single night kill, and that the game-over screen
// correctly shows Mafia as the winner (the mirror image of
// 04-full-game-village-win.js).
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, text, pickNightTarget, waitFor, teardown, readGameOverRoster } = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus'];

runScenario('05-full-game-mafia-win', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    host.App.goLanding('host');
    host.App.stepPlayers(-3); // 6 -> 3
    host.App.stepMafia(-1);   // 2 -> 1
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames } = await assignRolesAndBegin(host, players, log);
    log.assert(mafiaNames.length === 1, 'exactly 1 Mafia was dealt in this 3-player game');
    const mafiaPlayer = players.find((p) => mafiaNames.includes(p.label));
    const victim = players.find((p) => p !== mafiaPlayer);

    await playDay1AndSkipNight1(host, players, log);

    log.banner('DAY 2');
    log.step('Everyone abstains again, so nobody is voted out...');
    host.App.startVoting();
    await castVotes(players, {}, log, 'round 1');
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the result screen' });

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2' });
    log.banner('NIGHT 2');
    host.App.continueAfterEyesClosed();

    await waitFor(() => activeScreenId(mafiaPlayer) === 'screen-player-night-action',
      { message: mafiaPlayer.label + ' (Mafia) never got the kill prompt' });
    log.step(mafiaPlayer.label + ' (Mafia) shoots ' + victim.label + ' — the last villager...');
    pickNightTarget(mafiaPlayer, victim.label);
    mafiaPlayer.App.submitNightAction();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'night never reached the morning-ready screen' });
    log.step('Announcing morning — this kill should equalize Mafia and villagers and end the game...');
    host.App.announceMorning();

    await waitFor(() => activeScreenId(victim) === 'screen-player-eliminated',
      { message: victim.label + ' never saw their own elimination screen' });
    log.death(victim.label, 'villager', 'shot by the Mafia during the night');

    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the night-result screen' });
    host.App.proceedAfterNight();

    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen after the deciding kill' });
    const hostTitle = text(host, 'game-over-title') || '';
    log.banner('GAME OVER — ' + hostTitle);
    log.roster(readGameOverRoster(host));

    await waitFor(() => activeScreenId(victim) === 'screen-player-game-over',
      { message: victim.label + ' never reached their own game-over screen' });
    await waitFor(() => activeScreenId(mafiaPlayer) === 'screen-player-game-over',
      { message: mafiaPlayer.label + ' never reached their own game-over screen' });
    const mafiaTitle = text(mafiaPlayer, 'game-over-title-player') || '';
    const victimTitle = text(victim, 'game-over-title-player') || '';
    log.assert(mafiaTitle === hostTitle && victimTitle === hostTitle,
      'every device agrees Mafia won ("' + hostTitle + '")');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
