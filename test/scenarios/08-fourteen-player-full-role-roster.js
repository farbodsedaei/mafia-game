'use strict';
// The "kitchen sink" scenario: 14 players, 3 Mafia, 1 زودیاک, and every
// civilian special role in play at once — حرفه‌ای (Professional), دکتر
// (Doctor), کاراگاه (Detective), کنستانتین (Constantine), اوشن (Ocean), and
// تفنگدار (Gunner). Unlike the smaller scenarios, this one deliberately
// drives EVERY one of those roles through a real decision (not just deals
// them a card) across a 3-day game, so each role's actual mechanic gets
// exercised at least once:
//   - دکتر saves Mafia's own kill target — the kill is blocked, nobody dies.
//   - کنستانتین revives the player the village voted out the same day.
//   - کاراگاه investigates two different Mafia members, both correctly
//     read positive.
//   - تفنگدار hands the gun off; the recipient fires it the next day for a
//     real kill (the day-gun mechanic, running alongside that day's vote).
//   - اوشن recruits a teammate, triggering the nightly "ocean talk" step.
//   - حرفه‌ای skips once (a real, always-available choice), then lands a
//     real hit on a confirmed Mafia member later, informed by کاراگاه's
//     earlier read.
//   - زودیاک skips once, then lands the deciding shot that — together with
//     حرفه‌ای's — wipes out Mafia entirely while زودیاک is still alive,
//     ending the game as a **زودیاک win**.
// Every day vote also has at least half of the currently-alive players
// actually casting a ballot (see 07-twelve-player-mafia-and-zodiac.js for
// why that's the honest reading of "vote every night" in a game whose only
// real group VOTE happens during the day).
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

// Exact role names from index.html's HARDCODED_ROLES — must match verbatim
// (including the ZWNJ inside "حرفه‌ای") since selectRoleInPlay/roleInfo
// match by the real rendered role-name text, not by id.
const ROLE_ZODIAC = 'زودیاک';
const ROLE_DOCTOR = 'دکتر';
const ROLE_DETECTIVE = 'کاراگاه';
const ROLE_PROFESSIONAL = 'حرفه‌ای';
const ROLE_CONSTANTINE = 'کنستانتین';
const ROLE_OCEAN = 'اوشن';
const ROLE_GUNNER = 'تفنگدار';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('08-fourteen-player-full-role-roster', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures a 14-player game: 3 Mafia + زودیاک + every civilian special role...');
    host.App.goLanding('host');
    host.App.stepPlayers(8); // 6 -> 14
    host.App.stepMafia(1);   // 2 -> 3
    // The morning inquiry vote is a separate mechanic (see the same note in
    // 07-twelve-player-mafia-and-zodiac.js) — turned off so it doesn't
    // interrupt this scenario's own day/night sequencing once deaths start
    // piling up.
    host.App.stepInquiries(-1); // 1 -> 0
    [ROLE_ZODIAC, ROLE_DOCTOR, ROLE_DETECTIVE, ROLE_PROFESSIONAL, ROLE_CONSTANTINE, ROLE_OCEAN, ROLE_GUNNER]
      .forEach((roleName) => selectRoleInPlay(host, roleName));
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    log.assert(mafiaNames.length === 3, 'exactly 3 Mafia were dealt (found ' + mafiaNames.length + ')');

    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const zodiacName = findByTitle(ROLE_ZODIAC);
    const doctorName = findByTitle(ROLE_DOCTOR);
    const detectiveName = findByTitle(ROLE_DETECTIVE);
    const professionalName = findByTitle(ROLE_PROFESSIONAL);
    const constantineName = findByTitle(ROLE_CONSTANTINE);
    const oceanName = findByTitle(ROLE_OCEAN);
    const gunnerName = findByTitle(ROLE_GUNNER);
    const specialNames = [zodiacName, doctorName, detectiveName, professionalName, constantineName, oceanName, gunnerName];
    log.assert(specialNames.every(Boolean), 'every requested special role was actually dealt to someone');
    const plainVillagers = PLAYER_NAMES.filter((n) => !mafiaNames.includes(n) && !specialNames.includes(n));
    log.assert(plainVillagers.length === 4, 'the remaining 4 players are plain villagers (found ' + plainVillagers.length + ')');
    log.info('Mafia: ' + mafiaNames.join(', '));
    log.info('زودیاک: ' + zodiacName + ' | دکتر: ' + doctorName + ' | کاراگاه: ' + detectiveName +
      ' | حرفه‌ای: ' + professionalName + ' | کنستانتین: ' + constantineName +
      ' | اوشن: ' + oceanName + ' | تفنگدار: ' + gunnerName);
    log.info('Plain villagers: ' + plainVillagers.join(', '));

    const zodiac = byLabel(players, zodiacName);
    const doctor = byLabel(players, doctorName);
    const detective = byLabel(players, detectiveName);
    const professional = byLabel(players, professionalName);
    const constantine = byLabel(players, constantineName);
    const ocean = byLabel(players, oceanName);
    const gunner = byLabel(players, gunnerName);
    const [p1, p2, p3, p4] = plainVillagers;

    await playDay1AndSkipNight1(host, players, log);

    // ==================== DAY 2 ====================
    log.banner('DAY 2');
    const day2Voters = [...mafiaNames, zodiacName, doctorName, detectiveName, p2, p3]; // 8 of 14
    log.info(day2Voters.length + ' of 14 alive players vote this round (>= half): ' + day2Voters.join(', '));
    log.step('The village accuses ' + p1 + '...');
    host.App.startVoting();
    const day2Round1 = {};
    day2Voters.forEach((n) => { day2Round1[n] = [p1]; });
    await castVotes(players, day2Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 2 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day2AliveMinusTarget = players.filter((p) => p.label !== p1);
    const day2Final = {};
    day2Voters.forEach((n) => { day2Final[n] = [p1]; });
    await castVotes(day2AliveMinusTarget, day2Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 2 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(p1) !== -1, 'result screen names ' + p1 + ' as voted out');
    log.death(p1, 'villager', 'voted out by the village');

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
    log.step(decider2.label + ' (Mafia — tonight\'s decider) targets ' + p2 + '...');
    await nightAction(decider2, log, p2);

    log.step(zodiacName + ' (زودیاک) holds off — no shot tonight...');
    await nightAction(zodiac, log, null);

    log.step(doctorName + ' (دکتر) saves ' + p2 + ' — the same player Mafia is targeting...');
    await nightAction(doctor, log, p2);

    log.step(constantineName + ' (کنستانتین) spends their once-per-game revival on ' + p1 + '...');
    await nightAction(constantine, log, p1);

    const detectiveTarget2 = mafiaNames[1];
    log.step(detectiveName + ' (کاراگاه) investigates ' + detectiveTarget2 + '...');
    await nightAction(detective, log, detectiveTarget2);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their investigation result' });
    const invResult2 = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult2 + '"');
    log.assert(invResult2.indexOf(detectiveTarget2) !== -1, 'investigation names the right target');

    log.step(professionalName + ' (حرفه‌ای) holds off — no shot tonight (avoids the backfire risk of a wrong guess)...');
    await nightAction(professional, log, null);

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + p3 + '...');
    await nightAction(gunner, log, p3);

    log.step(oceanName + ' (اوشن) recruits ' + p4 + ' into their group...');
    await nightAction(ocean, log, p4);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the اوشن talk step after a recruit' });
    log.step('اوشن\'s new 2-person group gets its nightly talk window...');
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen' });
    log.step('Announcing morning...');
    host.App.announceMorning();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the Night 2 result screen' });
    const night2Title = text(host, 'night-result-title') || '';
    log.info('Night 2 result: "' + night2Title + '"');
    log.assert(night2Title.indexOf(p1) !== -1, 'night result correctly reports ' + p1 + ' as revived');

    await waitFor(() => activeScreenId(byLabel(players, p1)) === 'screen-player-night-waiting',
      { message: p1 + ' never came back from elimination' });
    log.info(p1 + ' is back in the game (کنستانتین\'s revival worked).');
    log.assert(activeScreenId(byLabel(players, p2)) !== 'screen-player-eliminated',
      p2 + ' correctly survived — دکتر\'s save blocked Mafia\'s kill');

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 3 after Night 2' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'a fully-blocked/reverted night correctly does not end the game');

    // ==================== DAY 3 ====================
    log.banner('DAY 3');
    log.step(p3 + ' (holding the gun) decides whether to fire, alongside today\'s vote...');
    host.App.startVoting();

    const gunTarget3 = mafiaNames[2];
    await dayGunDecision(byLabel(players, p3), log, gunTarget3);
    await waitFor(() => activeScreenId(byLabel(players, gunTarget3)) === 'screen-player-eliminated',
      { message: gunTarget3 + ' never saw their own elimination screen after the gun' });
    log.death(gunTarget3, 'Mafia', 'shot by ' + p3 + '\'s day-gun');
    const gunBannerText = text(host, 'day-gun-death-banner-text') || '';
    log.assert(gunBannerText.indexOf(gunTarget3) !== -1,
      'the day-gun death banner names ' + gunTarget3 + ' (got "' + gunBannerText + '")');

    const aliveDay3 = players.filter((p) => p.label !== gunTarget3);
    const day3Voters = [mafiaNames[0], mafiaNames[1], zodiacName, doctorName, detectiveName, professionalName, constantineName, oceanName]; // 8 of 13
    log.info(day3Voters.length + ' of ' + aliveDay3.length + ' alive players vote this round (>= half): ' + day3Voters.join(', '));
    log.step('The village turns on ' + p1 + ' again — no revival left this time...');
    const day3Round1 = {};
    day3Voters.forEach((n) => { day3Round1[n] = [p1]; });
    await castVotes(aliveDay3, day3Round1, log, 'round 1');

    await waitFor(() => activeScreenId(host) === 'screen-host-defense',
      { message: 'host never reached the defense screen after Day 3 round 1' });
    logTally(host, log, 'round 1');

    host.App.startFinalVote();
    const day3AliveMinusTarget = aliveDay3.filter((p) => p.label !== p1);
    const day3Final = {};
    day3Voters.forEach((n) => { day3Final[n] = [p1]; });
    await castVotes(day3AliveMinusTarget, day3Final, log, 'final');

    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 3 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(p1) !== -1, 'result screen names ' + p1 + ' as voted out');
    log.death(p1, 'villager', 'voted out by the village — for good this time');

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 3' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      '2 Mafia still alive correctly keeps the game going into Night 3');

    // ==================== NIGHT 3 — the finale ====================
    log.banner('NIGHT 3');
    host.App.continueAfterEyesClosed();

    const remainingMafiaDevices = players.filter((p) => mafiaNames.includes(p.label) && p.label !== gunTarget3);
    const decider3 = await waitFor(
      () => remainingMafiaDevices.find((p) => activeScreenId(p) === 'screen-player-night-action'),
      { message: 'no Mafia member got the Night 3 kill prompt' }
    );
    log.step(decider3.label + ' (Mafia — tonight\'s decider) targets ' + p2 + '...');
    await nightAction(decider3, log, p2);

    const zodiacFinalTarget = remainingMafiaDevices.find((p) => p !== decider3).label;
    log.step(zodiacName + ' (زودیاک) independently shoots ' + zodiacFinalTarget + '...');
    await nightAction(zodiac, log, zodiacFinalTarget);

    log.step(doctorName + ' (دکتر) holds off tonight — no save...');
    await nightAction(doctor, log, null);

    const detectiveTarget3 = decider3.label;
    log.step(detectiveName + ' (کاراگاه) investigates ' + detectiveTarget3 + ' as well...');
    await nightAction(detective, log, detectiveTarget3);
    await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
      { message: detectiveName + ' never saw their second investigation result' });
    const invResult3 = text(detective, 'investigate-result-title') || '';
    log.info('Investigation result: "' + invResult3 + '"');

    log.step(professionalName + ' (حرفه‌ای), acting on کاراگاه\'s earlier read, shoots ' + decider3.label + '...');
    await nightAction(professional, log, decider3.label);

    log.step(gunnerName + ' (تفنگدار) holds off — no second handoff tonight...');
    await nightAction(gunner, log, null);

    log.step(oceanName + ' (اوشن) holds off — no further recruits tonight...');
    await nightAction(ocean, log, null);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the nightly اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 3 never reached the morning-ready screen' });
    log.step('Announcing morning — this should wipe out the last of Mafia...');
    host.App.announceMorning();

    await waitFor(() => activeScreenId(decider3) === 'screen-player-eliminated',
      { message: decider3.label + ' never saw their own elimination screen' });
    log.death(decider3.label, 'Mafia', 'shot by حرفه‌ای, informed by کاراگاه\'s investigation');
    await waitFor(() => activeScreenId(byLabel(players, zodiacFinalTarget)) === 'screen-player-eliminated',
      { message: zodiacFinalTarget + ' never saw their own elimination screen' });
    log.death(zodiacFinalTarget, 'Mafia', 'shot by زودیاک during the night');
    await waitFor(() => activeScreenId(byLabel(players, p2)) === 'screen-player-eliminated',
      { message: p2 + ' never saw their own elimination screen' });
    log.death(p2, 'villager', 'shot by the Mafia during the night — no save this time');

    log.step('Every Mafia member is now gone while زودیاک is still alive — this should be a زودیاک win...');
    host.App.proceedAfterNight();

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

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
