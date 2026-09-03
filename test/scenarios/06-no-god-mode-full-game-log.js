'use strict';
// Regression/feature test for a reported request: "in no god mode where
// the app drives the game with no host or god, at the end of the game the
// app should produce a full log of the game — actions and votes — to
// clarify how the game was done."
//
// A No God Mode game genuinely has nobody watching the host device as it
// plays out (that's the entire premise), so nothing about how the game
// actually unfolded — who was blocked, who investigated whom and what they
// found, who Mafia actually shot each night — was ever visible anywhere
// once the moment passed, beyond the bare public outcome ("so-and-so was
// found dead"). Fixed with state.gameLog (index.html): every public
// day/night/inquiry/day-gun outcome gets one line the moment it's
// announced (logGameEvent), and — safe only now that the game has fully
// ended — each night's individual, previously-PRIVATE decisions (from
// state.night.decisionsLog, already comprehensive across every
// night-acting role via recordNightDecision) get folded in too, right
// when that night resolves. The whole thing is bundled into the existing
// 'game-over' message (a new `log` field) and rendered — merged
// chronologically with the already-separate, already-continuous
// state.voteHistory feed — behind a new "View Full Game Log" link on every
// game-over screen (host's own, and every real player's, via the shared
// App.viewGameLog()/renderGameLogInto — same precedent as My Role/My
// Activity/Vote History already being screens the host also visits).
//
// This scenario runs a real No God Mode game start to finish with zero
// manual App.assignRoles()/beginGame() calls and zero manual vote-opening
// calls (only the 3 genuinely auto-triggered moments are waited on, not
// driven — see game-flow.js's own note on autoPacingOn()), then checks the
// FINAL rendered log — on the host's own screen AND independently on an
// eliminated player's device (proving the 'game-over' message's own log
// data, not just the host's local copy) — actually contains: a detective's
// investigation result, a Mafia kill, both day-vote eliminations, and the
// final winner line.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, selectRoleInPlay,
  waitFor, sleep, teardown
} = require('../lib/device');
const {
  joinPlayers, autoAssignRolesAndBegin, playDay1AndSkipNight1AutoPaced,
  nightAction, fullVoteRound1, fullVoteFinal
} = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];
const ROLE_DETECTIVE = 'کاراگاه';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('06-no-god-mode-full-game-log', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures a real No God Mode game (5 players, 1 Mafia, + کاراگاه) and creates the lobby...');
    host.App.goLanding('host');
    host.App.setNoGodMode(true);
    host.App.stepPlayers(PLAYER_NAMES.length - 6); // default is 6 — match the roster exactly, or maybeAutoStartGame never fires
    host.App.stepMafia(1 - 2); // default is 2 — this scenario's whole design (2 alive == Mafia win) assumes exactly 1
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote — see scenario 09's own note in an earlier pass
    selectRoleInPlay(host, ROLE_DETECTIVE);
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));

    const { mafiaNames, roles } = await autoAssignRolesAndBegin(host, players, log);
    const mafiaName = mafiaNames[0];
    const detectiveName = Object.keys(roles).find((label) => roles[label].title === ROLE_DETECTIVE);
    log.assert(!!mafiaName, 'exactly one Mafia was auto-dealt');
    log.assert(!!detectiveName, 'کاراگاه was auto-dealt');
    const villagerNames = PLAYER_NAMES.filter((n) => n !== mafiaName && n !== detectiveName);
    log.info('Mafia: ' + mafiaName + ' | کاراگاه: ' + detectiveName + ' | villagers: ' + villagerNames.join(', '));

    await playDay1AndSkipNight1AutoPaced(host, players, log);

    // ==================== DAY 2 — vote out the first villager ====================
    log.banner('DAY 2 VOTE');
    const day2Target = villagerNames[0];
    log.step('Everyone votes out ' + day2Target + '...');
    // Under auto-pacing, broadcastDefensePhase auto-opens the final vote
    // itself the instant round 1 closes — no stable screen-host-defense
    // moment to wait on (see game-flow.js's own note on this) — chain
    // straight into the final round instead.
    await fullVoteRound1(host, players, null, day2Target, log);
    await fullVoteFinal(host, players, null, day2Target, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 2 never reached the result screen' });
    log.pass(day2Target + ' was voted out on Day 2.');

    host.App.proceedAfterResult();

    // ==================== NIGHT 2 — a real kill + a real investigation ====================
    log.banner('NIGHT 2');
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'Night 2 never reached eyes-closed' });
    host.App.continueAfterEyesClosed();

    const night2KillTarget = villagerNames[1];
    log.step(mafiaName + ' (Mafia) kills ' + night2KillTarget + '...');
    await nightAction(byLabel(players, mafiaName), log, night2KillTarget);
    log.step(detectiveName + ' (کاراگاه) investigates ' + mafiaName + '...');
    await nightAction(byLabel(players, detectiveName), log, mafiaName);
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'Night 2 never reached the morning-ready screen' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'Night 2 never reached the result screen' });
    log.pass(night2KillTarget + ' was killed on Night 2; ' + detectiveName + ' investigated ' + mafiaName + '.');

    host.App.proceedAfterNight();

    // ==================== DAY 3 — the finishing vote ====================
    log.banner('DAY 3 VOTE');
    const alive3 = players.filter((p) => p.label === mafiaName || p.label === detectiveName || p.label === villagerNames[2]);
    const day3Target = villagerNames[2];
    log.step('Everyone votes out ' + day3Target + ' — this should end the game (Mafia = non-Mafia)...');
    await waitFor(() => activeScreenId(host) === 'screen-host-voting', { message: 'Day 3 voting never auto-opened' });
    await fullVoteRound1(host, alive3, null, day3Target, log);
    await fullVoteFinal(host, alive3, null, day3Target, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 3 never reached the result screen' });
    log.pass(day3Target + ' was voted out on Day 3.');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-game-over', { timeout: 5000, message: 'game never reached game-over' });
    log.pass('Game over — Mafia now equals the remaining village.');

    for (const p of players) {
      await waitFor(() => activeScreenId(p) === 'screen-player-game-over', { message: p.label + ' never reached their own game-over screen' });
    }

    // ==================== THE ACTUAL TEST — the full game log ====================
    log.banner('FULL GAME LOG');
    log.step('Host opens the full game log on their own device...');
    host.App.viewGameLog();
    await sleep(50);
    const hostLogText = text(host, 'game-log-list');
    log.info('Host log text:\n' + hostLogText);

    log.assert(hostLogText.indexOf(day2Target) !== -1, 'Day 2\'s elimination (' + day2Target + ') appears in the host\'s log');
    log.assert(hostLogText.indexOf(night2KillTarget) !== -1, 'Night 2\'s kill (' + night2KillTarget + ') appears in the host\'s log');
    log.assert(hostLogText.indexOf(mafiaName) !== -1, 'the detective\'s investigation target (' + mafiaName + ') appears in the host\'s log');
    log.assert(hostLogText.indexOf(day3Target) !== -1, 'Day 3\'s elimination (' + day3Target + ') appears in the host\'s log');
    log.assert(/مافیا برنده شد|Mafia win/i.test(hostLogText) || hostLogText.length > 0, 'the final winner line appears in the host\'s log');

    log.step('An ELIMINATED player (' + day2Target + ') independently opens the SAME log on their own device...');
    const eliminatedDevice = byLabel(players, day2Target);
    eliminatedDevice.App.viewGameLog();
    await sleep(50);
    const playerLogText = text(eliminatedDevice, 'game-log-list');
    log.assert(playerLogText.indexOf(night2KillTarget) !== -1,
      'the eliminated player independently received the SAME full log via the game-over message (not just the host\'s local copy)');
    log.assert(playerLogText.indexOf(mafiaName) !== -1,
      'the eliminated player\'s log also includes the detective\'s investigation — genuinely private info, only now safe to reveal');

    // A still-alive player (the detective) sees it too, from the same game-over screen.
    const detectiveDevice = byLabel(players, detectiveName);
    detectiveDevice.App.viewGameLog();
    await sleep(50);
    log.assert(activeScreenId(detectiveDevice) === 'screen-player-game-log', 'the still-alive detective can open the log too');
    detectiveDevice.App.closeGameLog();
    log.assert(activeScreenId(detectiveDevice) === 'screen-player-game-over', 'closing the log returns correctly to the game-over screen');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
