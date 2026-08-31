'use strict';
// A larger, longer-running game: 12 players, exactly 2 Mafia and 1 زودیاک
// (an independent role — see index.html's HARDCODED_ROLES). Exercises
// mechanics none of the smaller scenarios reach: a majority threshold that
// actually matters at scale, the two Mafia sharing a single randomly-picked
// kill-decider each night, زودیاک's own independent night kill running
// alongside Mafia's, and the "زودیاک wins" outcome — distinct from a plain
// village win — that fires when Mafia is wiped out while زودیاک is still
// alive (see checkWinner in index.html).
//
// A note on "vote every night": this app only ever puts a group VOTE in
// front of the whole table during the DAY — night phases are single-
// decider ACTIONS (Mafia's kill choice, زودیاک's own shot), not something
// everyone votes on (see index.html's NIGHT_STEP_ORDER). This scenario
// honors the spirit of the request on both halves of the day/night cycle:
// every DAY vote has at least half of the currently-alive players actually
// casting a ballot (never just a couple of accusers deciding it), and every
// NIGHT past the first (Night 1 is always a no-op by design — see
// playDay1AndSkipNight1) has a real decision from BOTH night-acting roles.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, pickNightTarget, selectRoleInPlay, waitFor, teardown
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes, logTally
} = require('../lib/game-flow');

const PLAYER_NAMES = [
  'Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid',
  'Golnar', 'Hana', 'Iman', 'Jina', 'Kian', 'Laleh'
];

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('07-twelve-player-mafia-and-zodiac', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures a 12-player game with the default 2 Mafia, plus زودیاک...');
    host.App.goLanding('host');
    host.App.stepPlayers(6); // 6 -> 12 (numMafia stays at its default of 2 — exactly what we want)
    // The morning inquiry vote (a separate mechanic — see startInquiryVote in
    // index.html) fires on its own once anyone has died AND inquiries remain,
    // which would otherwise kick in on Day 3 here. Turned off so this
    // scenario stays focused on the voting/night mechanics actually asked
    // for, rather than incidentally pulling in a third feature.
    host.App.stepInquiries(-1); // 1 -> 0
    selectRoleInPlay(host, 'زودیاک');
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    log.assert(mafiaNames.length === 2, 'exactly 2 Mafia were dealt (found ' + mafiaNames.length + ')');
    const zodiacName = Object.keys(roles).find((label) => roles[label].title === 'زودیاک');
    log.assert(!!zodiacName, 'exactly 1 زودیاک was dealt');
    const villagerNames = PLAYER_NAMES.filter((n) => !mafiaNames.includes(n) && n !== zodiacName);
    log.assert(villagerNames.length === 9, 'the remaining 9 players are plain villagers (found ' + villagerNames.length + ')');
    log.info('Mafia: ' + mafiaNames.join(', ') + ' | زودیاک: ' + zodiacName);
    const zodiac = byLabel(players, zodiacName);

    await playDay1AndSkipNight1(host, players, log);

    // ==================== DAY 2 ====================
    log.banner('DAY 2');
    const day2Target = villagerNames[0];
    const day2Voters = [...mafiaNames, zodiacName, ...villagerNames.slice(1, 5)]; // 7 of 12
    log.info(day2Voters.length + ' of 12 alive players vote this round (>= half): ' + day2Voters.join(', '));
    host.App.startVoting();
    const day2Round1 = {};
    day2Voters.forEach((n) => { day2Round1[n] = [day2Target]; });
    await castVotes(players, day2Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 2 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day2AliveMinusTarget = players.filter((p) => p.label !== day2Target);
    const day2Final = {};
    day2Voters.forEach((n) => { day2Final[n] = [day2Target]; });
    await castVotes(day2AliveMinusTarget, day2Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 2 result screen' });
    logTally(host, log, 'final vote');
    const day2Result = text(host, 'result-title') || '';
    log.assert(day2Result.indexOf(day2Target) !== -1,
      'result screen names ' + day2Target + ' as voted out (got "' + day2Result + '")');
    log.death(day2Target, 'villager', 'voted out by the village');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2' });

    // ==================== NIGHT 2 ====================
    log.banner('NIGHT 2');
    host.App.continueAfterEyesClosed();

    const mafiaDevices = players.filter((p) => mafiaNames.includes(p.label));
    const decider2 = await waitFor(
      () => mafiaDevices.find((p) => activeScreenId(p) === 'screen-player-night-action'),
      { message: 'no Mafia member got the Night 2 kill prompt' }
    );
    const mafiaVictim2 = villagerNames[5];
    log.step(decider2.label + ' (Mafia — tonight\'s randomly-picked decider) shoots ' + mafiaVictim2 + '...');
    pickNightTarget(decider2, mafiaVictim2);
    decider2.App.submitNightAction();

    await waitFor(() => activeScreenId(zodiac) === 'screen-player-night-action',
      { message: zodiacName + ' (زودیاک) never got the Night 2 shot prompt' });
    const zodiacVictim2 = mafiaNames[0];
    log.step(zodiacName + ' (زودیاک — acting independently) shoots ' + zodiacVictim2 + '...');
    pickNightTarget(zodiac, zodiacVictim2);
    zodiac.App.submitNightAction();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen after both decisions' });
    log.step('Announcing morning — both Mafia\'s kill and زودیاک\'s independent shot should land...');
    host.App.announceMorning();

    await waitFor(() => activeScreenId(byLabel(players, mafiaVictim2)) === 'screen-player-eliminated',
      { message: mafiaVictim2 + ' never saw their own elimination screen' });
    log.death(mafiaVictim2, 'villager', 'shot by the Mafia during the night');
    await waitFor(() => activeScreenId(byLabel(players, zodiacVictim2)) === 'screen-player-eliminated',
      { message: zodiacVictim2 + ' never saw their own elimination screen' });
    log.death(zodiacVictim2, 'Mafia', 'shot by زودیاک during the night — its own kill is real, only زودیاک itself is immune');

    const survivingMafia = mafiaNames.find((n) => n !== zodiacVictim2);
    const bystander = byLabel(players, villagerNames[6]); // alive, uninvolved — a clean witness
    await waitFor(() => activeScreenId(bystander) === 'screen-player-night-waiting',
      { message: bystander.label + ' never saw the Night 2 result' });
    const night2Note = text(bystander, 'night-waiting-note') || '';
    log.assert(night2Note.indexOf(mafiaVictim2) !== -1 && night2Note.indexOf(zodiacVictim2) !== -1,
      'Night 2 result names BOTH ' + mafiaVictim2 + ' and ' + zodiacVictim2 + ' as dead (got "' + night2Note + '")');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 3 after Night 2' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      '1 Mafia + زودیاک still alive correctly blocks any win so far');

    // ==================== DAY 3 ====================
    log.banner('DAY 3');
    const eliminatedSoFar = [day2Target, mafiaVictim2, zodiacVictim2];
    const aliveDay3 = players.filter((p) => !eliminatedSoFar.includes(p.label));
    log.assert(aliveDay3.length === 9, '9 players remain alive going into Day 3 (found ' + aliveDay3.length + ')');
    const aliveVillagersDay3 = villagerNames.filter((n) => !eliminatedSoFar.includes(n));
    const day3Voters = [zodiacName, ...aliveVillagersDay3.slice(0, 5)]; // 6 of 9
    log.info(day3Voters.length + ' of 9 alive players vote this round (>= half): ' + day3Voters.join(', '));
    log.step('The village turns on ' + survivingMafia + ', the last known Mafia member...');
    host.App.startVoting();
    const day3Round1 = {};
    day3Voters.forEach((n) => { day3Round1[n] = [survivingMafia]; });
    await castVotes(aliveDay3, day3Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 3 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day3AliveMinusTarget = aliveDay3.filter((p) => p.label !== survivingMafia);
    const day3Final = {};
    day3Voters.forEach((n) => { day3Final[n] = [survivingMafia]; });
    await castVotes(day3AliveMinusTarget, day3Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 3 result screen' });
    logTally(host, log, 'final vote');
    const day3Result = text(host, 'result-title') || '';
    log.assert(day3Result.indexOf(survivingMafia) !== -1,
      'result screen names ' + survivingMafia + ' as voted out (got "' + day3Result + '")');
    log.death(survivingMafia, 'Mafia', 'voted out by the village — the last Mafia member');

    log.step('With every Mafia member gone and زودیاک still alive, this should be a زودیاک win (not a village win)...');
    host.App.proceedAfterResult();

    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen' });
    const finalTitle = text(host, 'game-over-title') || '';
    log.banner('GAME OVER — ' + finalTitle);
    log.assert(finalTitle.indexOf('زودیاک') !== -1,
      'the win is correctly attributed to زودیاک, not a plain village win (got "' + finalTitle + '")');

    await waitFor(() => activeScreenId(zodiac) === 'screen-player-game-over',
      { message: zodiacName + ' never reached their own game-over screen' });
    const zodiacTitle = text(zodiac, 'game-over-title-player') || '';
    log.assert(zodiacTitle === finalTitle, 'زودیاک\'s own device agrees on the same winner text');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
