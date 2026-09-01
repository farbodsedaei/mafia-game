'use strict';
// Same roster and rules as 01-fourteen-player-full-roster.js (14 players,
// پدر خوانده + ماتادور Mafia, زودیاک, دکتر, حرفه‌ای, تفنگدار, کاراگاه,
// کنستانتین, اوشن, 5 villagers; every day vote a strict majority; every
// no-limit role acts every night it's prompted; every limited role driven
// to its actual cap) — but three things are deliberately different this
// time:
//
//   1. The game runs LONGER: 4 full nights (Night 1-4) across 4 days,
//      instead of scenario 01's 3.
//   2. حرفه‌ای never makes a mistake shot — every one of their three shots
//      this game lands on a genuine Mafia member (پدر خوانده twice — the
//      first strips their shield, the second finishes them; ماتادور once,
//      a clean kill). Zero backfires.
//   3. زودیاک dies BEFORE either Mafia member does — voted out on Day 3
//      while both پدر خوانده and ماتادور are still alive — so the ending
//      this time is a plain **village win**, not a زودیاک win: by the time
//      the last Mafia member falls, independentAlive is already false.
//
// Two mechanics get exercised here that 01 never touched:
//   - The DEFERRED ماتادور prompt (Night 4): once پدر خوانده is dead,
//     ماتادور becomes Mafia's only kill-decider AND still has their own
//     block ability — startMafiaPhaseStep holds their block prompt back
//     until right after their kill decision lands, so the SAME device gets
//     two separate night-action prompts in a row. A short sleep between the
//     two nightAction() calls gives the second (async, server-sent) prompt
//     time to actually arrive before we act on it.
//   - A genuine WRONG-TARGET gun kill (Day 4): unlike a shielded/independent
//     target, firing at a perfectly ordinary villager is NOT a "no-effect"
//     dud — it's a real, unavoidable death (see resolveDayGunAction), on
//     top of permanently cancelling any remaining handovers. تفنگدار's
//     Day-3 recipient deliberately SKIPS first (a clean, no-cost choice),
//     then a later recipient deliberately fires wrong on Day 4 — a genuine
//     mistake, in contrast to حرفه‌ای's flawless record this game.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, selectRoleInPlay, waitFor, sleep, teardown, readGameOverRoster
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

runScenario('02-fourteen-player-longer-village-win', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures the same 14-player full roster as scenario 01...');
    host.App.goLanding('host');
    host.App.stepPlayers(8); // 6 -> 14 (numMafia stays at its default of 2 — پدر خوانده + ماتادور)
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote
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
    const ocean = byLabel(players, oceanName);

    await playDay1AndSkipNight1(host, players, log);

    // ==================== DAY 2 ====================
    log.banner('DAY 2');
    const day2Voters = [godfatherName, matadorName, zodiacName, doctorName, professionalName, gunnerName, detectiveName, constantineName]; // 8 of 14
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

    log.step(matadorName + ' (ماتادور) blocks ' + pv3 + ' — harmless, ' + pv3 + ' has no ability of its own...');
    await nightAction(matador, log, pv3);

    log.step(zodiacName + ' (زودیاک) shoots ' + pv4 + '...');
    await nightAction(zodiac, log, pv4);

    log.step(doctorName + ' (دکتر) uses their once-per-game SELF-save tonight (no one\'s actually threatening them yet)...');
    await nightAction(doctor, log, doctorName);

    log.step(constantineName + ' (کنستانتین) spends their once-per-game revival on ' + pv1 + '...');
    await nightAction(constantine, log, pv1);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + godfatherName + ' — a genuine Mafia target; the shield will just absorb this one...');
    await nightAction(professional, log, godfatherName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + godfatherName + '...');
    await nightAction(detective, log, godfatherName);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their investigation result' });
    let invResult = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult + '" — پدر خوانده\'s detective immunity means this reads negative despite being genuine Mafia.');

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv5 + ' (handoff 1 of 2)...');
    await nightAction(gunner, log, pv5);

    log.step(oceanName + ' (اوشن) recruits ' + pv3 + ' into their group (recruit 1 of 2)...');
    await nightAction(ocean, log, pv3);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the اوشن talk step after a recruit' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen' });
    host.App.announceMorning();

    await waitFor(() => activeScreenId(byLabel(players, pv2)) === 'screen-player-eliminated',
      { message: pv2 + ' never saw their own elimination screen' });
    log.death(pv2, 'villager', 'shot by the Mafia during the night — دکتر saved themselves instead');
    await waitFor(() => activeScreenId(byLabel(players, pv4)) === 'screen-player-eliminated',
      { message: pv4 + ' never saw their own elimination screen' });
    log.death(pv4, 'villager', 'shot by زودیاک during the night');
    await waitFor(() => activeScreenId(byLabel(players, pv1)) === 'screen-player-night-waiting',
      { message: pv1 + ' never came back from elimination' });
    log.info(pv1 + ' is back in the game — کنستانتین spent their once-per-game revival reviving today\'s vote-out.');
    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-waiting',
      { message: godfatherName + ' should have survived حرفه‌ای\'s shot — their shield should have absorbed it' });
    log.info(godfatherName + ' survived — پدر خوانده\'s shield absorbed حرفه‌ای\'s shot (not a mistake — a genuine Mafia target) and is now gone.');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 3 after Night 2' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Day 3');

    // ==================== DAY 3 ====================
    log.banner('DAY 3');
    log.step(pv5 + ' (holding the gun) skips today — a clean, no-cost choice...');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, pv5), log, null);

    const deadSoFarDay3 = [pv2, pv4]; // Night 2's real deaths (پv1 was revived)
    const aliveDay3 = players.filter((p) => !deadSoFarDay3.includes(p.label));
    const day3Voters = [godfatherName, matadorName, doctorName, professionalName, gunnerName, detectiveName, constantineName]; // 7 of 12
    log.info(day3Voters.length + ' of ' + aliveDay3.length + ' alive players vote this round (> half): ' + day3Voters.join(', '));
    log.step('The village turns on ' + zodiacName + ' (زودیاک) directly — voted out while BOTH Mafia are still alive...');
    const day3Round1 = {};
    day3Voters.forEach((n) => { day3Round1[n] = [zodiacName]; });
    await castVotes(aliveDay3, day3Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 3 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day3AliveMinusTarget = aliveDay3.filter((p) => p.label !== zodiacName);
    const day3Final = {};
    day3Voters.forEach((n) => { day3Final[n] = [zodiacName]; });
    await castVotes(day3AliveMinusTarget, day3Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 3 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(zodiacName) !== -1, 'result screen names ' + zodiacName + ' as voted out');
    log.death(zodiacName, 'زودیاک', 'voted out by the village — the ONLY way to kill زودیاک, and both Mafia members are still alive to see it');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 3' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Night 3');

    // ==================== NIGHT 3 ====================
    log.banner('NIGHT 3');
    host.App.continueAfterEyesClosed();

    log.step(godfatherName + ' (پدر خوانده) makes Mafia\'s kill call, targeting ' + pv3 + '...');
    await nightAction(godfather, log, pv3);

    log.step(matadorName + ' (ماتادور) blocks ' + pv5 + ' — harmless again...');
    await nightAction(matador, log, pv5);

    log.step(doctorName + ' (دکتر) saves ' + pv3 + ' — the same player Mafia is targeting this time...');
    await nightAction(doctor, log, pv3);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + godfatherName + ' AGAIN — the shield is already gone, so this is a real, clean kill...');
    await nightAction(professional, log, godfatherName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + matadorName + ' this time...');
    await nightAction(detective, log, matadorName);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their second investigation result' });
    invResult = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult + '" — ماتادور has no detective immunity, so this correctly reads positive (unlike پدر خوانده\'s).');
    log.assert(invResult.indexOf(matadorName) !== -1, 'investigation names the right target');

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv1 + ' (handoff 2 of 2)...');
    await nightAction(gunner, log, pv1);

    log.step(oceanName + ' (اوشن) recruits ' + pv5 + ' into the group (recruit 2 of 2, reaching their cap)...');
    await nightAction(ocean, log, pv5);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the nightly اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 3 never reached the morning-ready screen' });
    host.App.announceMorning();

    await waitFor(() => activeScreenId(godfather) === 'screen-player-eliminated',
      { message: godfatherName + ' never saw their own elimination screen — حرفه‌ای\'s second shot should have finished them' });
    log.death(godfatherName, 'Mafia', 'shot by حرفه‌ای — a real kill this time, no shield left to absorb it');
    log.assert(activeScreenId(byLabel(players, pv3)) !== 'screen-player-eliminated',
      pv3 + ' correctly survived — دکتر\'s save blocked Mafia\'s kill');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 4 after Night 3' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'the game correctly continues into Day 4 — one Mafia member (ماتادور) is still alive');

    // ==================== DAY 4 ====================
    log.banner('DAY 4');
    log.step(pv1 + ' (holding the gun) fires at ' + pv3 + ' — an ordinary villager, NOT Mafia. Unlike a shielded/independent target, this is a genuine, unavoidable kill, and cancels any further handovers...');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, pv1), log, pv3);
    await waitFor(() => activeScreenId(byLabel(players, pv3)) === 'screen-player-eliminated',
      { message: pv3 + ' never saw their own elimination screen after the wrong-target gun shot' });
    log.death(pv3, 'villager', 'shot by ' + pv1 + '\'s gun by mistake — a real death, unlike a shielded/independent miss');
    const gunBanner = text(host, 'day-gun-death-banner-text') || '';
    log.assert(gunBanner.indexOf(pv3) !== -1, 'the gun-death banner names ' + pv3 + ' (got "' + gunBanner + '")');

    const deadSoFarDay4 = [pv2, pv4, zodiacName, godfatherName, pv3];
    const aliveDay4 = players.filter((p) => !deadSoFarDay4.includes(p.label));
    const day4Voters = [matadorName, doctorName, professionalName, gunnerName, detectiveName, constantineName]; // 6 of 9
    log.info(day4Voters.length + ' of ' + aliveDay4.length + ' alive players vote this round (> half): ' + day4Voters.join(', '));
    log.step('The village turns on ' + pv1 + ' for that costly mistake with the gun...');
    const day4Round1 = {};
    day4Voters.forEach((n) => { day4Round1[n] = [pv1]; });
    await castVotes(aliveDay4, day4Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 4 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day4AliveMinusTarget = aliveDay4.filter((p) => p.label !== pv1);
    const day4Final = {};
    day4Voters.forEach((n) => { day4Final[n] = [pv1]; });
    await castVotes(day4AliveMinusTarget, day4Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 4 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv1) !== -1, 'result screen names ' + pv1 + ' as voted out');
    log.death(pv1, 'villager', 'voted out by the village — for good this time');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 4' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'the game correctly continues into Night 4 — ماتادور is still the last Mafia standing');

    // ==================== NIGHT 4 — the finale ====================
    log.banner('NIGHT 4');
    host.App.continueAfterEyesClosed();

    // پدر خوانده is dead, so ماتادور becomes Mafia's sole (fallback) kill-
    // decider — AND still has their own block ability. Since it's the SAME
    // person, startMafiaPhaseStep DEFERS the block prompt until right after
    // the kill decision lands (see the file header comment) — a short sleep
    // gives that second, separately-sent prompt time to actually arrive.
    log.step(matadorName + ' (ماتادور, the last Mafia member) makes the kill call alone, targeting ' + pv5 + '...');
    await nightAction(matador, log, pv5);
    await sleep(150);
    log.step(matadorName + ' also still has their OWN block to make — blocking ' + gunnerName + ' (harmless, تفنگدار has no more guns to give)...');
    await nightAction(matador, log, gunnerName);

    // دکتر's self-save is a WHOLE-GAME limit (once ever, same as کنستانتین's
    // revive) — already spent on Night 2, so their own id no longer appears
    // in their own candidate list. Save an uninvolved bystander instead
    // (deliberately not پv5, who Mafia is actually targeting tonight — the
    // kill should go through unblocked this time).
    log.step(doctorName + ' (دکتر) saves ' + detectiveName + ' tonight — their self-save is already spent...');
    await nightAction(doctor, log, detectiveName);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + matadorName + ' — the last Mafia member, no shield, a real clean kill...');
    await nightAction(professional, log, matadorName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + matadorName + ' one last time...');
    await nightAction(detective, log, matadorName);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their final investigation result' });
    invResult = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult + '" — consistent with the earlier positive read.');

    // اوشن's own team still has 2+ ALIVE members tonight (even though اوشن
    // itself is capped out and isn't recruiting again) — the ocean-talk step
    // recurs every night the team stays that size, not just on a fresh
    // recruit (see startOceanTalkStep).
    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the nightly اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 4 never reached the morning-ready screen' });
    log.step('Announcing morning — this should wipe out the last of Mafia, with زودیاک already long gone...');
    host.App.announceMorning();

    await waitFor(() => activeScreenId(byLabel(players, pv5)) === 'screen-player-eliminated',
      { message: pv5 + ' never saw their own elimination screen' });
    log.death(pv5, 'villager', 'shot by the Mafia during the night — no save this time');
    await waitFor(() => activeScreenId(matador) === 'screen-player-eliminated',
      { message: matadorName + ' never saw their own elimination screen — حرفه‌ای\'s shot should have finished them' });
    log.death(matadorName, 'Mafia', 'shot by حرفه‌ای — the last Mafia member, and حرفه‌ای\'s third flawless shot this game');

    host.App.proceedAfterNight();

    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen' });
    const finalTitle = text(host, 'game-over-title') || '';
    log.banner('GAME OVER — ' + finalTitle);
    log.roster(readGameOverRoster(host));
    // زودیاک died back on Day 3, well before either Mafia member — so this
    // must be a plain village win, NOT a زودیاک win (contrast with scenario 01).
    log.assert(finalTitle.indexOf('زودیاک') === -1,
      'the win is correctly a plain village win, not attributed to زودیاک — who was already dead (got "' + finalTitle + '")');

    await waitFor(() => activeScreenId(doctor) === 'screen-player-game-over',
      { message: doctorName + ' never reached their own game-over screen' });
    log.assert((text(doctor, 'game-over-title-player') || '') === finalTitle,
      'دکتر\'s own device agrees on the same winner text');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
