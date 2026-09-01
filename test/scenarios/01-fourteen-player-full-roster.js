'use strict';
// The full requested roster: 14 players — 2 Mafia (پدر خوانده + ماتادور,
// not plain مافیا ساده), زودیاک, دکتر, حرفه‌ای, تفنگدار, کاراگاه,
// کنستانتین, اوشن, and 5 plain villagers. Two explicit requirements shape
// every choice below:
//
//   1. "At least more than half of players should vote every night" — read
//      as: every completed DAY vote (the only real group vote this game
//      has — see index.html's NIGHT_STEP_ORDER for why "night" itself is
//      single-decider ACTIONS, not a group vote) has a real majority
//      (strictly > half) of the currently-alive players actually casting a
//      ballot. Day 2 uses 8 of 14 (57%), Day 3 uses 7 of 11 (64%).
//   2. "All roles with no limit in count should use their capabilities" —
//      پدر خوانده (mandatory anyway), ماتادور, زودیاک, دکتر (saving OTHERS
//      is unlimited — only the SELF-save is once-per-game), حرفه‌ای, and
//      کاراگاه never skip a single night they're prompted. کنستانتین
//      (once-per-game revive) and تفنگدار (2 handovers) and اوشن (capped at
//      numOceanSlots=2) DO have real limits — this scenario deliberately
//      drives every one of them all the way to that limit instead of using
//      it once and stopping.
//
// Along the way this exercises several mechanics no earlier scenario did:
//   - پدر خوانده's detective immunity (کاراگاه investigating the actual
//     Godfather still reads negative — see handleNightAction's
//     isRealMafiaHit check excluding ROLE_NAME_GODFATHER).
//   - حرفه‌ای's BACKFIRE (shooting a non-Mafia target kills the shooter
//     instead) — deliberately triggered once, closing a documented gap.
//   - دکتر's once-per-game SELF-save, distinct from an ordinary other-
//     directed save.
//   - تفنگدار's gun RETURNING to them when the current holder dies
//     overnight before deciding (see startGunReturnedStep) — the second
//     handoff target is deliberately also Mafia's own kill target that
//     same night, so the holder dies before ever getting to decide.
// It ends in a زودیاک win once تفنگدار (now holding the returned gun
// themselves) finishes off the last Mafia member.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, selectRoleInPlay, waitFor, teardown, readGameOverRoster
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes, logTally,
  nightAction, dayGunDecision
} = require('../lib/game-flow');

const PLAYER_NAMES = [
  'Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid', 'Golnar',
  'Hana', 'Iman', 'Jina', 'Kian', 'Laleh', 'Mona', 'Nima'
];

const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_MATADOR = 'ماتادور';
const ROLE_ZODIAC = 'زودیاک';
const ROLE_DOCTOR = 'دکتر';
const ROLE_PROFESSIONAL = 'حرفه‌ای';
const ROLE_GUNNER = 'تفنگدار';
const ROLE_DETECTIVE = 'کاراگاه';
const ROLE_CONSTANTINE = 'کنستانتین';
const ROLE_OCEAN = 'اوشن';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('01-fourteen-player-full-roster', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures the full 14-player roster: پدر خوانده + ماتادور, زودیاک, دکتر, حرفه‌ای, تفنگدار, کاراگاه, کنستانتین, اوشن, and 5 villagers...');
    host.App.goLanding('host');
    host.App.stepPlayers(8); // 6 -> 14 (numMafia stays at its default of 2 — پدر خوانده + ماتادور)
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote — see earlier scenarios
    [ROLE_GODFATHER, ROLE_MATADOR, ROLE_ZODIAC, ROLE_DOCTOR, ROLE_PROFESSIONAL, ROLE_GUNNER, ROLE_DETECTIVE, ROLE_CONSTANTINE, ROLE_OCEAN]
      .forEach((roleName) => selectRoleInPlay(host, roleName));
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const godfatherName = findByTitle(ROLE_GODFATHER);
    const matadorName = findByTitle(ROLE_MATADOR);
    const zodiacName = findByTitle(ROLE_ZODIAC);
    const doctorName = findByTitle(ROLE_DOCTOR);
    const professionalName = findByTitle(ROLE_PROFESSIONAL);
    const gunnerName = findByTitle(ROLE_GUNNER);
    const detectiveName = findByTitle(ROLE_DETECTIVE);
    const constantineName = findByTitle(ROLE_CONSTANTINE);
    const oceanName = findByTitle(ROLE_OCEAN);
    const specialNames = [godfatherName, matadorName, zodiacName, doctorName, professionalName, gunnerName, detectiveName, constantineName, oceanName];
    log.assert(mafiaNames.length === 2 && mafiaNames.includes(godfatherName) && mafiaNames.includes(matadorName),
      'both Mafia seats are exactly پدر خوانده and ماتادور');
    log.assert(specialNames.every(Boolean), 'every requested special role was actually dealt to someone');
    const plainVillagers = PLAYER_NAMES.filter((n) => !specialNames.includes(n));
    log.assert(plainVillagers.length === 5, 'the remaining 5 players are plain villagers (found ' + plainVillagers.length + ')');
    const [pv1, pv2, pv3, pv4, pv5] = plainVillagers;
    log.info('پدر خوانده: ' + godfatherName + ' | ماتادور: ' + matadorName + ' | زودیاک: ' + zodiacName);
    log.info('دکتر: ' + doctorName + ' | حرفه‌ای: ' + professionalName + ' | تفنگدار: ' + gunnerName +
      ' | کاراگاه: ' + detectiveName + ' | کنستانتین: ' + constantineName + ' | اوشن: ' + oceanName);
    log.info('Villagers: ' + plainVillagers.join(', '));

    const godfather = byLabel(players, godfatherName);
    const matador = byLabel(players, matadorName);
    const zodiac = byLabel(players, zodiacName);
    const doctor = byLabel(players, doctorName);
    const professional = byLabel(players, professionalName);
    const gunner = byLabel(players, gunnerName);
    const detective = byLabel(players, detectiveName);
    const constantine = byLabel(players, constantineName);

    await playDay1AndSkipNight1(host, players, log);

    // ==================== DAY 2 ====================
    log.banner('DAY 2');
    const day2Voters = specialNames.filter((n) => n !== oceanName); // 8 of 14 — every Mafia/special role but اوشن
    log.info(day2Voters.length + ' of 14 alive players vote this round (> half): ' + day2Voters.join(', '));
    log.step('The village accuses ' + pv1 + '...');
    host.App.startVoting();
    const day2Round1 = {};
    day2Voters.forEach((n) => { day2Round1[n] = [pv1]; });
    await castVotes(players, day2Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 2 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day2AliveMinusTarget = players.filter((p) => p.label !== pv1);
    const day2Final = {};
    day2Voters.forEach((n) => { day2Final[n] = [pv1]; });
    await castVotes(day2AliveMinusTarget, day2Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 2 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv1) !== -1, 'result screen names ' + pv1 + ' as voted out');
    log.death(pv1, 'villager', 'voted out by the village');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2' });

    // ==================== NIGHT 2 ====================
    log.banner('NIGHT 2');
    host.App.continueAfterEyesClosed();

    log.step(godfatherName + ' (پدر خوانده) makes Mafia\'s kill call, targeting ' + pv2 + '...');
    await nightAction(godfather, log, pv2);

    log.step(matadorName + ' (ماتادور) blocks ' + pv3 + ' — harmless, پv3 has no ability of its own...');
    await nightAction(matador, log, pv3);

    log.step(zodiacName + ' (زودیاک) independently shoots ' + pv4 + '...');
    await nightAction(zodiac, log, pv4);

    log.step(doctorName + ' (دکتر) saves ' + pv2 + ' — the same player Mafia is targeting...');
    await nightAction(doctor, log, pv2);

    log.step(constantineName + ' (کنستانتین) spends their once-per-game revival on ' + pv1 + '...');
    await nightAction(constantine, log, pv1);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + pv5 + ' — NOT Mafia, so this backfires on ' + professionalName + ' themselves...');
    await nightAction(professional, log, pv5);

    log.step(detectiveName + ' (کاراگاه) investigates ' + godfatherName + ' (the actual پدر خوانده)...');
    await nightAction(detective, log, godfatherName);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their investigation result' });
    const invResult2 = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult2 + '" — پدر خوانده\'s detective immunity means this reads negative despite being genuine Mafia.');
    log.assert(invResult2.indexOf(godfatherName) !== -1, 'investigation names the right target');

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv5 + ' (handoff 1 of 2)...');
    await nightAction(gunner, log, pv5);

    log.step(oceanName + ' (اوشن) recruits ' + pv3 + ' into their group (recruit 1 of 2)...');
    await nightAction(byLabel(players, oceanName), log, pv3);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the اوشن talk step after a recruit' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen' });
    host.App.announceMorning();

    await waitFor(() => activeScreenId(professional) === 'screen-player-eliminated',
      { message: professionalName + ' never saw their own elimination screen after the backfire' });
    log.death(professionalName, 'حرفه‌ای', 'backfired on their own wrong-target shot');
    await waitFor(() => activeScreenId(byLabel(players, pv4)) === 'screen-player-eliminated',
      { message: pv4 + ' never saw their own elimination screen' });
    log.death(pv4, 'villager', 'shot by زودیاک during the night');
    await waitFor(() => activeScreenId(byLabel(players, pv1)) === 'screen-player-night-waiting',
      { message: pv1 + ' never came back from elimination' });
    log.info(pv1 + ' is back in the game — کنستانتین spent their once-per-game revival reviving today\'s vote-out.');
    log.assert(activeScreenId(byLabel(players, pv2)) !== 'screen-player-eliminated',
      pv2 + ' correctly survived — دکتر\'s save blocked Mafia\'s kill');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 3 after Night 2' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Day 3');

    // ==================== DAY 3 ====================
    log.banner('DAY 3');
    log.step(pv5 + ' (holding the gun) fires at ' + matadorName + ' (ماتادور), alongside today\'s vote...');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, pv5), log, matadorName);
    await waitFor(() => activeScreenId(matador) === 'screen-player-eliminated',
      { message: matadorName + ' never saw their own elimination screen after the gun' });
    log.death(matadorName, 'Mafia', 'shot by ' + pv5 + '\'s day-gun');

    const deadSoFarDay3 = [professionalName, pv4, matadorName]; // حرفه‌ای's backfire + زودیاک's kill (Night 2) + the day-gun (just now)
    const aliveDay3 = players.filter((p) => !deadSoFarDay3.includes(p.label));
    const day3Voters = [godfatherName, zodiacName, doctorName, gunnerName, detectiveName, constantineName, oceanName]; // 7 of 11
    log.info(day3Voters.length + ' of ' + aliveDay3.length + ' alive players vote this round (> half): ' + day3Voters.join(', '));
    log.step('The village turns on ' + pv2 + ' — no revival left this time...');
    const day3Round1 = {};
    day3Voters.forEach((n) => { day3Round1[n] = [pv2]; });
    await castVotes(aliveDay3, day3Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 3 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day3AliveMinusTarget = aliveDay3.filter((p) => p.label !== pv2);
    const day3Final = {};
    day3Voters.forEach((n) => { day3Final[n] = [pv2]; });
    await castVotes(day3AliveMinusTarget, day3Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 3 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv2) !== -1, 'result screen names ' + pv2 + ' as voted out');
    log.death(pv2, 'villager', 'voted out by the village — for good this time');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 3' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Night 3');

    // ==================== NIGHT 3 ====================
    log.banner('NIGHT 3');
    host.App.continueAfterEyesClosed();

    log.step(godfatherName + ' (پدر خوانده, ماتادور now gone) makes the kill call alone, targeting ' + pv1 + '...');
    await nightAction(godfather, log, pv1);

    // پدر خوانده carries a SHIELD (HARDCODED_ROLES: role-godfather has
    // shield:true) — one hit just strips it (survives, no death); only a
    // SECOND hit afterward actually kills them. Targeting them here with
    // زودیاک's shot strips that shield now, so the returned-gun shot on Day
    // 4 below can actually finish them off.
    log.step(zodiacName + ' (زودیاک) shoots ' + godfatherName + ' — پدر خوانده\'s shield should absorb this one hit...');
    await nightAction(zodiac, log, godfatherName);

    log.step(doctorName + ' (دکتر) uses their once-per-game SELF-save tonight...');
    await nightAction(doctor, log, doctorName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + godfatherName + ' again — still the only Mafia standing...');
    await nightAction(detective, log, godfatherName);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their second investigation result' });
    const invResult3 = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult3 + '" — consistent with the same immunity.');

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv1 + ' (handoff 2 of 2) — the SAME player Mafia is killing tonight...');
    await nightAction(gunner, log, pv1);

    log.step(oceanName + ' (اوشن) recruits ' + detectiveName + ' into the group (recruit 2 of 2, reaching their cap)...');
    await nightAction(byLabel(players, oceanName), log, detectiveName);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the nightly اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 3 never reached the morning-ready screen' });
    host.App.announceMorning();

    await waitFor(() => activeScreenId(byLabel(players, pv1)) === 'screen-player-eliminated',
      { message: pv1 + ' never saw their own elimination screen' });
    log.death(pv1, 'villager', 'shot by the Mafia during the night — no save this time, and now holding the gun nobody got to use');
    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-waiting',
      { message: godfatherName + ' should have survived زودیاک\'s shot — their shield should have absorbed it' });
    log.info(godfatherName + ' survived زودیاک\'s shot — پدر خوانده\'s shield absorbed the hit and is now gone.');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 4 after Night 3' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Day 4');

    // ==================== DAY 4 — the finale ====================
    log.banner('DAY 4');
    log.step(pv1 + ' died overnight still holding the gun — it should return to ' + gunnerName + ' (تفنگدار) themselves to decide...');
    host.App.startVoting();
    await dayGunDecision(gunner, log, godfatherName);
    log.death(godfatherName, 'Mafia', 'shot by ' + gunnerName + ' with the gun that returned to them');

    // This shot also happens to be the last Mafia member — it ends the game
    // outright (see announceDayGunOutcome's own App.showGameOver() call), so
    // godfatherName's own device gets 'eliminated' immediately followed by
    // 'game-over' and lands on the LATTER, never visibly settling on
    // screen-player-eliminated — check for game-over directly instead of
    // that intermediate screen.
    log.step('Every Mafia member is now gone while زودیاک is still alive — this should be a زودیاک win...');
    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen' });
    const finalTitle = text(host, 'game-over-title') || '';
    log.banner('GAME OVER — ' + finalTitle);
    log.roster(readGameOverRoster(host));
    log.assert(finalTitle.indexOf('زودیاک') !== -1,
      'the win is correctly attributed to زودیاک, not a plain village win (got "' + finalTitle + '")');

    await waitFor(() => activeScreenId(zodiac) === 'screen-player-game-over',
      { message: zodiacName + ' never reached their own game-over screen' });
    log.assert((text(zodiac, 'game-over-title-player') || '') === finalTitle,
      'زودیاک\'s own device agrees on the same winner text');
    await waitFor(() => activeScreenId(godfather) === 'screen-player-game-over',
      { message: godfatherName + ' (the deciding kill) never reached the game-over screen' });
    log.pass(godfatherName + '\'s own device (the very last Mafia member) also reached game-over.');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
