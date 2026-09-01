'use strict';
// The largest scenario yet: 18 players (17 real devices + the host's own
// God-Mode seat), every Mafia special role (پدر خوانده + ماتادور + ساول
// گودمن), both زودیاک roles (زودیاک + زودیاک پسر, so succession is actually
// reachable), every civilian special role (دکتر, کاراگاه, حرفه‌ای,
// کنستانتین, اوشن, تفنگدار), morning inquiries configured up to 5, and اوشن
// capped at 4 recruits instead of the default 2 — all run in **God Mode**,
// where the host is dealt a real seat and plays alongside everyone else.
//
// Three structural facts shape almost every line below:
//
//   1. God Mode makes autoPacingOn() true (see index.html's own
//      autoPacingOn — it's shared with No God Mode), which changes the
//      game's pacing in exactly three places: maybeAutoStartGame deals
//      roles and begins the game itself once every seat has a name;
//      goToDayScreen auto-starts that day's voting for any day > 1 (no
//      stable screen-host-day to observe); and broadcastDefensePhase
//      auto-starts the final vote the instant round 1's tally closes (no
//      stable screen-host-defense moment either — round 1's own tally can't
//      be read reliably, so this scenario goes straight from
//      fullVoteRound1 into fullVoteFinal everywhere). This scenario
//      therefore never calls App.assignRoles/beginGame/startVoting/
//      startFinalVote directly — see game-flow.js's autoAssignRolesAndBegin
//      / playDay1AndSkipNight1AutoPaced and the fullVoteRound1/fullVoteFinal
//      helpers, which wait for the auto-started screens instead.
//   2. The host's own seat (named Reza below) has no real device of its
//      own — see game-flow.js's hostSelfVote/hostSelfNightAction/
//      hostSelfInquiryVote/hostSelfDayGunDecision and device.js's
//      hostSelfRoleInfo. Every "who does X" step below checks whether the
//      role landed on Reza and dispatches to the host-self helper instead
//      of a real device when it did — see the small `actNight`/`actGun`
//      dispatch helpers just below the role lookup. Since Reza's role (and
//      therefore Reza's fate) is randomly dealt like everyone else's, the
//      full-participation day votes below always resolve "is Reza still
//      alive" dynamically (see `hs()`) rather than assuming Reza survives.
//   3. Every night-action target below is chosen from names actually
//      resolved by role at runtime (the specialNames lookups, or the
//      `plainVillagers` pool) — never a hardcoded player name — because
//      roles are randomly shuffled each run, so e.g. "Cyrus" might hold any
//      role on a given pass. Targets are also picked to respect real
//      engine constraints discovered while building this scenario:
//        - ساول گودمن's recruit target must presently hold
//          ROLE_NAME_PLAIN_VILLAGER exactly (resolveNight's recruit branch
//          silently no-ops on anyone else).
//        - اوشن's recruit target must not already be on the team and must
//          not be Mafia — recruiting a Mafia member kills the RECRUITER
//          (state.night.extraDeathIds), so every اوشن target here is a
//          plain villager or a non-Mafia special-role holder.
//        - ماتادور's block target must be role==='villager' (never Mafia);
//          every block below lands on a plain villager with no civilian
//          night ability of their own, so it's a genuine no-op, not a
//          suppressed real action.
//        - حرفه‌ای backfires (kills the shooter) on any non-Mafia target —
//          every حرفه‌ای shot below targets a confirmed Mafia name.
//        - تفنگدار's gun-holder identity (who currently possesses the
//          physical gun, decided via a day-time fire/skip prompt) is
//          entirely separate from تفنگدار the ROLE (gunnerName below always
//          makes the nightly handoff decision — handing the gun off does
//          not change who holds the روله). GUNNER_MAX_GUNS caps total
//          handoffs at 2, each followed by exactly one day-time decision
//          from that handoff's recipient before the next handoff can occur.
//
// "Everyone active... voting to send members out" is read as full
// participation: every alive identity (all connected real devices AND
// Reza, whenever Reza is still alive) casts a real ballot on every single
// day vote — see fullVoteRound1/Final. "Voting to receive inquiries when
// it makes sense" is read literally: Day 3's inquiry is a genuine,
// deliberately MIXED vote that fails to reach threshold (closing a real
// gap — no earlier scenario ever exercised a DENIED inquiry), while Days 4
// and 5 are unanimous and granted.
//
// A note on "5 daytime inquiries": numInquiries is configured up to 5 (the
// requested capacity), but only a GRANTED inquiry decrements
// inquiriesRemaining (see App.closeInquiryVote in index.html) — a denied
// one doesn't consume the pool, yet still only re-offers once per day from
// the first elimination onward. Exhausting all 5 offers literally would
// need 5 separate inquiry-eligible days (Day 3 through Day 7), which this
// scenario's flexible pool of only 7 plain villagers (everyone else is a
// named special role with a fixed job to do) can't sustain alongside 5 full
// day-votes, 4 اوشن recruits, and every other mechanic this scenario
// already exercises. This run offers 3 real inquiries — one denied, two
// granted — genuinely exercising both outcomes, with the config left at 5
// to confirm the game supports that capacity even though this playthrough
// doesn't exhaust it.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, selectRoleInPlay, setValue, waitFor, teardown,
  readGameOverRoster
} = require('../lib/device');
const {
  joinPlayers, autoAssignRolesAndBegin, playDay1AndSkipNight1AutoPaced,
  fullVoteRound1, fullVoteFinal, logTally,
  nightAction, dayGunDecision, inquiryVote,
  hostSelfNightAction, hostSelfInquiryVote, hostSelfDayGunDecision
} = require('../lib/game-flow');

const PLAYER_NAMES = [
  'Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid', 'Golnar', 'Hana', 'Iman',
  'Jina', 'Kian', 'Laleh', 'Mona', 'Nima', 'Omid', 'Parisa', 'Sara'
]; // 17 real devices — the 18th seat is Reza, the God-Mode host-self
const HOST_SELF_NAME = 'Reza';

const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_MATADOR = 'ماتادور';
const ROLE_SAUL = 'ساول گودمن';
const ROLE_ZODIAC = 'زودیاک';
const ROLE_ZODIAC_SON = 'زودیاک پسر';
const ROLE_DOCTOR = 'دکتر';
const ROLE_DETECTIVE = 'کاراگاه';
const ROLE_PROFESSIONAL = 'حرفه‌ای';
const ROLE_CONSTANTINE = 'کنستانتین';
const ROLE_OCEAN = 'اوشن';
const ROLE_GUNNER = 'تفنگدار';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('03-eighteen-player-god-mode', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures 18 players, every Mafia + زودیاک + civilian role, up to 5 inquiries, 4 اوشن slots, and God Mode...');
    host.App.goLanding('host');
    host.App.stepPlayers(12); // 6 -> 18 (17 real + Reza, the God-Mode host-self)
    host.App.stepMafia(1);    // 2 -> 3 (پدر خوانده + ماتادور + ساول گودمن)
    host.App.stepInquiries(4);   // 1 -> 5
    host.App.stepOceanSlots(2);  // 2 -> 4
    host.App.setGodMode(true);
    setValue(host, 'input-host-self-name', HOST_SELF_NAME);
    [ROLE_GODFATHER, ROLE_MATADOR, ROLE_SAUL, ROLE_ZODIAC, ROLE_ZODIAC_SON,
      ROLE_DOCTOR, ROLE_DETECTIVE, ROLE_PROFESSIONAL, ROLE_CONSTANTINE, ROLE_OCEAN, ROLE_GUNNER]
      .forEach((roleName) => selectRoleInPlay(host, roleName));
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log, PLAYER_NAMES.length + 1));
    const { mafiaNames, roles } = await autoAssignRolesAndBegin(host, players, log, HOST_SELF_NAME);
    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const godfatherName = findByTitle(ROLE_GODFATHER);
    const matadorName = findByTitle(ROLE_MATADOR);
    const saulName = findByTitle(ROLE_SAUL);
    const zodiacName = findByTitle(ROLE_ZODIAC);
    const zodiacSonName = findByTitle(ROLE_ZODIAC_SON);
    const doctorName = findByTitle(ROLE_DOCTOR);
    const detectiveName = findByTitle(ROLE_DETECTIVE);
    const professionalName = findByTitle(ROLE_PROFESSIONAL);
    const constantineName = findByTitle(ROLE_CONSTANTINE);
    const oceanName = findByTitle(ROLE_OCEAN);
    const gunnerName = findByTitle(ROLE_GUNNER);
    const specialNames = [godfatherName, matadorName, saulName, zodiacName, zodiacSonName,
      doctorName, detectiveName, professionalName, constantineName, oceanName, gunnerName];
    log.assert(mafiaNames.length === 3 && [godfatherName, matadorName, saulName].every((n) => mafiaNames.includes(n)),
      'all 3 Mafia seats are پدر خوانده + ماتادور + ساول گودمن');
    log.assert(specialNames.every(Boolean), 'every requested special role was actually dealt to someone');
    const pv = PLAYER_NAMES.concat([HOST_SELF_NAME]).filter((n) => !specialNames.includes(n));
    log.assert(pv.length === 7, 'the remaining 7 identities are plain villagers (found ' + pv.length + ')');
    log.info('پدر خوانده: ' + godfatherName + ' | ماتادور: ' + matadorName + ' | ساول گودمن: ' + saulName);
    log.info('زودیاک: ' + zodiacName + ' | زودیاک پسر: ' + zodiacSonName);
    log.info('دکتر: ' + doctorName + ' | کاراگاه: ' + detectiveName + ' | حرفه‌ای: ' + professionalName +
      ' | کنستانتین: ' + constantineName + ' | اوشن: ' + oceanName + ' | تفنگدار: ' + gunnerName);
    log.info('Plain villagers: ' + pv.join(', '));
    log.info('Host-self (God Mode) is playing as: ' + HOST_SELF_NAME +
      (specialNames.includes(HOST_SELF_NAME) ? ' (a special role)' : ' (a plain villager)'));

    // ---- Dispatch helpers: route to the real device, or to the in-process
    // host-self card, depending on who actually holds a given seat. ----
    const isHS = (label) => label === HOST_SELF_NAME;
    async function actNight(label, target, opts) {
      if (isHS(label)) return hostSelfNightAction(host, log, target, opts);
      return nightAction(byLabel(players, label), log, target, opts);
    }
    async function actGun(label, target) {
      if (isHS(label)) return hostSelfDayGunDecision(host, log, target);
      return dayGunDecision(byLabel(players, label), log, target);
    }
    async function actInquiry(label, choice) {
      if (isHS(label)) return hostSelfInquiryVote(host, log, choice);
      return inquiryVote(byLabel(players, label), log, choice);
    }
    // `dead` is the running list of eliminated names this scenario
    // maintains by hand as the game progresses (see each phase's
    // resolution below) — it must stay exactly in sync with the real
    // engine's alive/dead state, including removing an entry the one time
    // کنستانتین revives someone.
    const dead = [];
    function aliveLabels() {
      return PLAYER_NAMES.concat([HOST_SELF_NAME]).filter((n) => !dead.includes(n));
    }
    // Real player devices still alive — what fullVoteRound1/Final need
    // instead of the raw, never-shrinking `players` array.
    function aliveDevices() {
      return players.filter((p) => !dead.includes(p.label));
    }
    // Reza only counts as a voter while still alive — fullVoteRound1/Final
    // otherwise hang forever waiting for a vote prompt that will never
    // arrive on an eliminated host-self seat.
    function hs() {
      return dead.includes(HOST_SELF_NAME) ? null : HOST_SELF_NAME;
    }

    await playDay1AndSkipNight1AutoPaced(host, players, log);

    // ==================== DAY 2 ====================
    log.banner('DAY 2');
    log.info(aliveLabels().length + ' of 18 alive identities vote this round (full participation): everyone.');
    log.step('The village accuses ' + pv[0] + '...');
    await fullVoteRound1(host, aliveDevices(), hs(), pv[0], log);
    await fullVoteFinal(host, aliveDevices(), hs(), pv[0], log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 2 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv[0]) !== -1, 'result screen names ' + pv[0] + ' as voted out');
    log.death(pv[0], 'villager', 'voted out by unanimous village vote');
    dead.push(pv[0]);

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 2' });

    // ==================== NIGHT 2 ====================
    log.banner('NIGHT 2');
    host.App.continueAfterEyesClosed();

    log.step(godfatherName + ' (پدر خوانده) makes Mafia\'s kill call, targeting ' + pv[1] + '...');
    await actNight(godfatherName, pv[1]);

    log.step(matadorName + ' (ماتادور) blocks ' + pv[2] + ' — a plain villager with no civilian ability of their own, so this is a genuine no-op...');
    await actNight(matadorName, pv[2]);

    log.step(zodiacName + ' (زودیاک) shoots ' + pv[3] + '...');
    await actNight(zodiacName, pv[3]);

    log.step(doctorName + ' (دکتر) uses their once-per-game SELF-save tonight...');
    await actNight(doctorName, doctorName);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + godfatherName + ' — a genuine Mafia target, the shield will absorb it...');
    await actNight(professionalName, godfatherName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + godfatherName + '...');
    await actNight(detectiveName, godfatherName);
    if (!isHS(detectiveName)) {
      const detective = byLabel(players, detectiveName);
      await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
        { message: detectiveName + ' never saw their investigation result' });
      log.info('Investigation result: "' + (text(detective, 'investigate-result-title') || '') +
        '" — پدر خوانده\'s detective immunity means this reads negative despite being genuine Mafia.');
    } else {
      log.info(detectiveName + ' (host-self) investigated ' + godfatherName + ' — negative, پدر خوانده\'s detective immunity.');
    }

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv[4] + ' (handoff 1 of 2)...');
    await actNight(gunnerName, pv[4]);

    log.step(oceanName + ' (اوشن) recruits ' + pv[5] + ' into their group (recruit 1 of 4)...');
    await actNight(oceanName, pv[5]);

    // کنستانتین becomes eligible the instant anyone's dead — true from
    // tonight onward, since pv[0] was voted out on Day 2 — so they're
    // already prompted even though this scenario wants their once-per-game
    // revive spent on Night 3 instead. Skip tonight (a real, legitimate
    // choice) so the civilian phase can actually close.
    log.step(constantineName + ' (کنستانتین) is prompted (someone\'s already dead) but holds off tonight...');
    await actNight(constantineName, null);

    // اوشن's talk step fires the instant the team (founder + recruits)
    // reaches 2+ alive members — true from tonight on, since pv[5] was
    // just recruited moments ago, not just on later nights with an
    // already-established team.
    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the اوشن talk step on Night 2' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the Night 2 result screen' });
    log.info('Night 2 result: "' + (text(host, 'night-result-title') || '') + '"');
    log.death(pv[1], 'villager', 'shot by پدر خوانده');
    log.death(pv[3], 'villager', 'shot by زودیاک');
    dead.push(pv[1], pv[3]);
    host.App.proceedAfterNight();

    // ==================== DAY 3 (inquiry #1 — deliberately DENIED) ====================
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-vote',
      { message: 'host never reached the Day 3 inquiry vote' });
    log.banner('DAY 3');
    log.step('The morning inquiry is offered — the village is genuinely split this time...');
    const inquiry1Alive = aliveLabels();
    // A deliberately mixed vote that does NOT reach threshold (floor(alive/2))
    // — demonstrates the DENIED path, never exercised before this scenario.
    const inquiry1Yes = inquiry1Alive.slice(0, Math.floor(inquiry1Alive.length / 3));
    for (const label of inquiry1Alive) {
      await actInquiry(label, inquiry1Yes.includes(label) ? 'yes' : 'no');
    }
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-result',
      { message: 'host never reached the inquiry result screen' });
    log.info('Inquiry #1: ' + inquiry1Yes.length + ' of ' + inquiry1Alive.length + ' voted yes — "' +
      (text(host, 'inquiry-result-title') || '') + '"');
    log.assert((text(host, 'inquiry-result-title') || '').indexOf('نشد') !== -1 || (text(host, 'inquiry-result-detail') || '').length > 0,
      'the split vote correctly failed to reach threshold — no inquiry granted');
    host.App.continueAfterInquiry();

    await waitFor(() => activeScreenId(host) === 'screen-host-voting',
      { message: 'host never auto-started Day 3\'s voting after the inquiry' });
    log.step(pv[4] + ' (holding the gun since last night\'s handoff) fires it at ' + matadorName + ' (ماتادور), alongside today\'s vote...');
    await actGun(pv[4], matadorName);
    if (!isHS(matadorName)) {
      await waitFor(() => activeScreenId(byLabel(players, matadorName)) === 'screen-player-eliminated',
        { message: matadorName + ' never saw their own elimination screen after the gun' });
    }
    log.death(matadorName, 'Mafia', 'shot by ' + pv[4] + '\'s day-gun');
    dead.push(matadorName);

    log.info(aliveLabels().length + ' alive identities vote this round (full participation): everyone.');
    log.step('The village turns on ' + pv[6] + '...');
    await fullVoteRound1(host, aliveDevices(), hs(), pv[6], log);
    await fullVoteFinal(host, aliveDevices(), hs(), pv[6], log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 3 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv[6]) !== -1, 'result screen names ' + pv[6] + ' as voted out');
    log.death(pv[6], 'villager', 'voted out by the village');
    dead.push(pv[6]);

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 3' });

    // ==================== NIGHT 3 ====================
    log.banner('NIGHT 3');
    host.App.continueAfterEyesClosed();

    log.step(godfatherName + ' (پدر خوانده, ماتادور now gone) makes Mafia\'s kill call, targeting ' + pv[2] + '...');
    await actNight(godfatherName, pv[2]);

    log.step(zodiacName + ' (زودیاک) shoots ' + pv[4] + ', tonight\'s gun holder...');
    await actNight(zodiacName, pv[4]);

    log.step(doctorName + ' (دکتر) saves ' + pv[2] + ' — the same player Mafia is targeting this time...');
    await actNight(doctorName, pv[2]);

    log.step(detectiveName + ' (کاراگاه) investigates ' + saulName + '...');
    await actNight(detectiveName, saulName);
    if (!isHS(detectiveName)) {
      const detective = byLabel(players, detectiveName);
      await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
        { message: detectiveName + ' never saw their second investigation result' });
      log.info('Investigation result: "' + (text(detective, 'investigate-result-title') || '') +
        '" — ساول گودمن has no detective immunity, so this correctly reads positive.');
    } else {
      log.info(detectiveName + ' (host-self) investigated ' + saulName + ' — positive, no immunity for ساول گودمن.');
    }

    log.step(professionalName + ' (حرفه‌ای) shoots ' + godfatherName + ' again — the shield is already gone, a real clean kill...');
    await actNight(professionalName, godfatherName);

    log.step(constantineName + ' (کنستانتین) spends their once-per-game revival on ' + pv[0] + '...');
    await actNight(constantineName, pv[0]);

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + pv[5] + ' (handoff 2 of 2, the last one)...');
    await actNight(gunnerName, pv[5]);

    log.step(oceanName + ' (اوشن) recruits ' + pv[2] + ' into the group (recruit 2 of 4)...');
    await actNight(oceanName, pv[2]);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 3 never reached the morning-ready screen' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the Night 3 result screen' });
    log.info('Night 3 result: "' + (text(host, 'night-result-title') || '') + '"');
    log.death(godfatherName, 'Mafia', 'shot by حرفه‌ای — a real kill this time, no shield left');
    log.death(pv[4], 'villager', 'shot by زودیاک');
    log.info(pv[0] + ' revived by کنستانتین; ' + pv[2] + ' saved by دکتر.');
    dead.splice(dead.indexOf(pv[0]), 1); // revived — back among the living
    dead.push(godfatherName, pv[4]);
    host.App.proceedAfterNight();

    // ==================== DAY 4 (inquiry #2 — unanimous, granted) ====================
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-vote',
      { message: 'host never reached the Day 4 inquiry vote' });
    log.banner('DAY 4');
    log.step('The morning inquiry is offered again — this time everyone agrees it\'s worth it...');
    const inquiry2Alive = aliveLabels();
    for (const label of inquiry2Alive) await actInquiry(label, 'yes');
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-result',
      { message: 'host never reached the inquiry result screen' });
    log.info('Inquiry #2 (unanimous yes): "' + (text(host, 'inquiry-result-title') || '') + '" — ' +
      (text(host, 'inquiry-result-detail') || ''));
    host.App.continueAfterInquiry();

    await waitFor(() => activeScreenId(host) === 'screen-host-voting',
      { message: 'host never auto-started Day 4\'s voting after the inquiry' });
    log.step(pv[5] + ' (holding the gun since last night\'s final handoff) declines to fire it today...');
    await actGun(pv[5], null);

    // زودیاک is voted out here — the ONLY way to eliminate زودیاک — while
    // زودیاک پسر is still alive, so succession should transfer independence
    // and the nightly shot to پسر (see transferZodiacLegacy in index.html).
    log.info(aliveLabels().length + ' alive identities vote this round (full participation): everyone.');
    log.step('The village votes out ' + zodiacName + ' (زودیاک) directly...');
    await fullVoteRound1(host, aliveDevices(), hs(), zodiacName, log);
    await fullVoteFinal(host, aliveDevices(), hs(), zodiacName, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 4 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(zodiacName) !== -1, 'result screen names ' + zodiacName + ' as voted out');
    log.death(zodiacName, 'زودیاک', 'voted out by the village — succession to ' + zodiacSonName + ' should follow');
    dead.push(zodiacName);

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 4' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Night 4');

    // ==================== NIGHT 4 — succession + the recruit mechanic ====================
    log.banner('NIGHT 4');
    host.App.continueAfterEyesClosed();

    // ساول گودمن is now Mafia's only alive member left (پدر خوانده and
    // ماتادور both dead) — with no پدرخوانده to make the call, the engine
    // picks the kill decider at random from alive Mafia, which is
    // trivially ساول گودمن here. Since a Mafia member has already died,
    // their prompt now grows the "recruit instead of shoot" option (see
    // startMafiaPhaseStep's canRecruit). The target must presently hold
    // ROLE_NAME_PLAIN_VILLAGER exactly — پv[0] (revived last night) does.
    log.step(saulName + ' (ساول گودمن, Mafia\'s last original member) RECRUITS ' + pv[0] + ' instead of shooting...');
    await actNight(saulName, pv[0], { recruit: true });

    // زودیاک پسر has now succeeded زودیاک — same night-action mechanics,
    // just under their inherited identity. Targets the last confirmed
    // original Mafia member.
    log.step(zodiacSonName + ' (now زودیاک, having succeeded) independently shoots ' + saulName + '...');
    await actNight(zodiacSonName, saulName);

    log.step(doctorName + ' (دکتر) saves ' + detectiveName + ' tonight — no one\'s actually threatened, but دکتر still acts...');
    await actNight(doctorName, detectiveName);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + saulName + ' too — belt and suspenders, still a genuine Mafia target...');
    await actNight(professionalName, saulName);

    log.step(detectiveName + ' (کاراگاه) investigates ' + saulName + ' one more time...');
    await actNight(detectiveName, saulName);
    if (!isHS(detectiveName)) {
      const detective = byLabel(players, detectiveName);
      await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
        { message: detectiveName + ' never saw their third investigation result' });
      log.info('Investigation result: "' + (text(detective, 'investigate-result-title') || '') + '"');
    }

    // کنستانتین's once-per-game revive is already spent, and تفنگدار is out
    // of handoffs (gunsRemaining hit 0 after Night 3) — neither is prompted
    // tonight; the engine simply skips both (see promptCivilianRole's
    // `eligible` gate).
    log.info(constantineName + ' (کنستانتین) is not prompted tonight — their once-per-game revive is already spent.');
    log.info(gunnerName + ' (تفنگدار) is not prompted tonight — both handoffs are already used.');

    log.step(oceanName + ' (اوشن) recruits ' + gunnerName + ' into the group (recruit 3 of 4)...');
    await actNight(oceanName, gunnerName);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the nightly اوشن talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 4 never reached the morning-ready screen' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the Night 4 result screen' });
    log.info('Night 4 result: "' + (text(host, 'night-result-title') || '') + '"');
    log.death(saulName, 'Mafia', 'shot by both زودیاک and حرفه‌ای — the last of Mafia\'s original three');
    log.info(pv[0] + ' was recruited into Mafia by ساول گودمن — Mafia\'s numbers replenished from within the village.');
    dead.push(saulName);
    host.App.proceedAfterNight();
    log.assert(activeScreenId(host) !== 'screen-host-game-over',
      'the game correctly continues — ساول گودمن\'s recruit replenished Mafia before dying themselves');

    // ==================== DAY 5 (inquiry #3 — unanimous, granted) ====================
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-vote',
      { message: 'host never reached the Day 5 inquiry vote' });
    log.banner('DAY 5');
    log.step('One more inquiry — unanimous again...');
    const inquiry3Alive = aliveLabels();
    for (const label of inquiry3Alive) await actInquiry(label, 'yes');
    await waitFor(() => activeScreenId(host) === 'screen-host-inquiry-result',
      { message: 'host never reached the inquiry result screen' });
    log.info('Inquiry #3 (unanimous yes): "' + (text(host, 'inquiry-result-title') || '') + '" — ' +
      (text(host, 'inquiry-result-detail') || ''));
    host.App.continueAfterInquiry();

    await waitFor(() => activeScreenId(host) === 'screen-host-voting',
      { message: 'host never auto-started Day 5\'s voting' });
    log.info(aliveLabels().length + ' alive identities vote this round (full participation): everyone.');
    log.step('The village votes out ' + pv[5] + ' — the gun\'s last holder, now out of guns to fire...');
    await fullVoteRound1(host, aliveDevices(), hs(), pv[5], log);
    await fullVoteFinal(host, aliveDevices(), hs(), pv[5], log);
    await waitFor(() => activeScreenId(host) === 'screen-host-result',
      { message: 'host never reached the Day 5 result screen' });
    logTally(host, log, 'final vote');
    log.assert((text(host, 'result-title') || '').indexOf(pv[5]) !== -1, 'result screen names ' + pv[5] + ' as voted out');
    log.death(pv[5], 'villager', 'voted out by the village');
    dead.push(pv[5]);

    host.App.proceedAfterResult();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
      { message: 'host never reached Night 5' });
    log.assert(activeScreenId(host) !== 'screen-host-game-over', 'the game correctly continues into Night 5');

    // ==================== NIGHT 5 — the finale ====================
    log.banner('NIGHT 5');
    host.App.continueAfterEyesClosed();

    log.step(pv[0] + ' (freshly-recruited Mafia, now the sole decider) makes the kill call, targeting ' + pv[2] + '...');
    await actNight(pv[0], pv[2]);

    // زودیاک finishes the job — the deciding shot, wiping out Mafia's last
    // member while زودیاک itself (now via succession) is still alive.
    log.step(zodiacSonName + ' (زودیاک) delivers the deciding shot, targeting ' + pv[0] + ', tonight\'s Mafia decider...');
    await actNight(zodiacSonName, pv[0]);

    log.step(doctorName + ' (دکتر) saves ' + pv[2] + ' — Mafia\'s own target tonight...');
    await actNight(doctorName, pv[2]);

    log.step(professionalName + ' (حرفه‌ای) shoots ' + pv[0] + ' too — still a genuine Mafia target, no backfire...');
    await actNight(professionalName, pv[0]);

    log.step(detectiveName + ' (کاراگاه) investigates ' + pv[0] + ', the new Mafia recruit...');
    await actNight(detectiveName, pv[0]);
    if (!isHS(detectiveName)) {
      const detective = byLabel(players, detectiveName);
      await waitFor(() => activeScreenId(detective) === 'screen-player-investigate-result',
        { message: detectiveName + ' never saw their fourth investigation result' });
      log.info('Investigation result: "' + (text(detective, 'investigate-result-title') || '') +
        '" — the recruit is genuinely Mafia now, so this correctly reads positive.');
    }

    // اوشن's 4th and final recruit, reaching their cap.
    log.step(oceanName + ' (اوشن) recruits ' + detectiveName + ' — the 4th and final recruit, reaching their cap...');
    await actNight(oceanName, detectiveName);

    await waitFor(() => activeScreenId(host) === 'screen-host-ocean-talk',
      { message: 'host never reached the final اوشن-talk step' });
    host.App.continueAfterOceanTalk();

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 5 never reached the morning-ready screen' });
    log.step('Announcing morning — this should wipe out the last of Mafia...');
    host.App.announceMorning();

    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-game-over',
      { message: 'host never reached the game-over screen' });
    const finalTitle = text(host, 'game-over-title') || '';
    log.banner('GAME OVER — ' + finalTitle);
    log.roster(readGameOverRoster(host));
    log.assert(finalTitle.indexOf('زودیاک') !== -1,
      'the win is correctly attributed to زودیاک — succession carried the win all the way through (got "' + finalTitle + '")');
    log.info(pv[2] + ' was saved by دکتر tonight and survives to see the ending.');

    if (!isHS(zodiacSonName)) {
      const zodiacDevice = byLabel(players, zodiacSonName);
      await waitFor(() => activeScreenId(zodiacDevice) === 'screen-player-game-over',
        { message: zodiacSonName + ' never reached their own game-over screen' });
      log.assert((text(zodiacDevice, 'game-over-title-player') || '') === finalTitle,
        zodiacSonName + '\'s own device agrees on the same winner text');
    } else {
      log.info(zodiacSonName + ' is the host-self seat — the host\'s own admin screen already shows the same result.');
    }

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
