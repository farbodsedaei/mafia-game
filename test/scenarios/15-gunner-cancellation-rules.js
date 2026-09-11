'use strict';
// Regression test for a reported gunner (تفنگدار) rule question: "if the gun
// receiver shoots a civilian and ends up dead, the gun feature goes away
// from that point on... but if the gun is used against a civilian and for
// any reason the civilian doesn't die (blocked, shielded), the gunner
// should still be able to hand over guns the next night, if there are more
// bullets left. If the gun is used against Mafia or زودیاک, the gunner
// never loses the ability regardless of the result."
//
// The app was NOT built this way: resolveDayGunAction (index.html) used to
// set state.gunsCancelled = true for ANY non-Mafia target the instant the
// gun was fired at them — before even checking whether the shot actually
// killed anyone. A shielded civilian surviving the shot (shield absorbed
// it) or the immune زودیاک surviving it (never actually killable by the
// gun at all) both incorrectly burned the gunner's remaining uses anyway,
// identically to a real kill. Fixed to only cancel once outcome === 'died'
// AND the target wasn't Mafia — a shot that's blocked/shielded/survived,
// or lands on the immune زودیاک, now correctly leaves the gun's remaining
// uses untouched.
//
// This scenario drives تفنگدار's full two-handoff budget (GUNNER_MAX_GUNS)
// through exactly the two "should NOT cancel" cases the report described:
//   - Night 2 handoff, Day 3 shot at کنستانتین (shield: true) — shield
//     absorbs it, کنستانتین survives. Verifies state.gunsCancelled stays
//     false (via the debug panel) AND that a second handoff is still
//     actually offered the following night — the concrete, user-visible
//     symptom of the bug this fixes.
//   - Night 3 handoff (تفنگدار's second and LAST of the game), Day 4 shot
//     at زودیاک — immune, survives. Verifies gunsCancelled is still false
//     even now that gunsRemaining has separately reached 0 on its own (the
//     unrelated whole-game handoff cap, which was never buggy) — proving
//     the two mechanisms are independent and neither is being conflated
//     with the other.
// The complementary "an ACTUAL civilian kill really does cancel" case is
// already exercised by 02-fourteen-player-longer-village-win.js's Day 4
// (پv1 fires at پv3, an unshielded plain villager, a genuine kill) — this
// scenario adds an explicit gunsCancelled assertion there too, so both
// halves of the rule are pinned down by a real, dedicated check.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, selectRoleInPlay, waitFor, sleep, teardown, readDebugStateText
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, nightAction, dayGunDecision } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid'];
const ROLE_GUNNER = 'تفنگدار';
const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_CONSTANTINE = 'کنستانتین';
const ROLE_ZODIAC = 'زودیاک';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

// Every night here has the exact same shape: eyes-closed -> پدر خوانده skips
// (no kill, keeps the roster stable so both test shots land on someone
// actually alive) -> زودیاک skips its own shot -> تفنگدار hands the gun to
// recipientName -> morning -> night-result -> Day N+1. کنستانتین is dealt
// into this game (as the shield-carrying shot-1 target) but never actually
// gets a night-action PROMPT of their own at all: promptCivilianRole only
// sends one once it has at least one real candidate, and their own revive
// ability's candidate list is every currently-ELIMINATED player — since
// nobody ever dies in this whole scenario (that's deliberate: both test
// shots are designed to survive), that list stays empty every night, so
// there's nothing to skip here.
async function runGunHandoffNight(host, players, log, names, recipientName) {
  await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached eyes-closed' });
  host.App.continueAfterEyesClosed();
  await nightAction(byLabel(players, names.godfatherName), log); // skip — no kill tonight
  await nightAction(byLabel(players, names.zodiacName), log); // skip — no shot tonight
  await nightAction(byLabel(players, names.gunnerName), log, recipientName); // hand off the gun
  await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached morning-ready' });
  host.App.announceMorning();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached night result' });
  host.App.proceedAfterNight();
}

// Abstain-everyone Day round — no majority ever forms, so this always
// closes straight to a (nobody-eliminated) result with no defense phase to
// handle, exactly like 11's own Day 2. Just enough day structure for
// App.startVoting() to also open that day's pending gun decision (see
// App.startVoting in index.html) alongside it.
async function abstainDayRound(host, players, log) {
  for (const p of players) await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
  for (const p of players) p.App.submitVote();
  await sleep(150);
  host.App.closeVoting();
  await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'day round never reached its result' });
  host.App.dismissAckBanner();
  for (const p of players) p.App.dismissAckBanner();
  host.App.proceedAfterResult();
}

runScenario('15-gunner-cancellation-rules', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];
  try {
    host.App.goLanding('host');
    [ROLE_GUNNER, ROLE_GODFATHER, ROLE_CONSTANTINE, ROLE_ZODIAC].forEach((roleName) => selectRoleInPlay(host, roleName));
    host.App.createLobby();
    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const names = {
      gunnerName: findByTitle(ROLE_GUNNER),
      godfatherName: findByTitle(ROLE_GODFATHER),
      constantineName: findByTitle(ROLE_CONSTANTINE),
      zodiacName: findByTitle(ROLE_ZODIAC)
    };
    log.assert(names.gunnerName && names.godfatherName && names.constantineName && names.zodiacName,
      'all four requested roles were actually dealt (' + JSON.stringify(names) + ')');
    log.assert(mafiaNames.includes(names.godfatherName), 'پدر خوانده is confirmed Mafia');
    const special = Object.values(names);
    const bystander = PLAYER_NAMES.find((n) => !special.includes(n) && !mafiaNames.includes(n));
    log.assert(!!bystander, 'found a plain villager to act as the gun\'s recipient/shooter (' + bystander + ')');
    log.info('تفنگدار: ' + names.gunnerName + ' | پدر خوانده: ' + names.godfatherName +
      ' | کنستانتین: ' + names.constantineName + ' | زودیاک: ' + names.zodiacName + ' | bystander: ' + bystander);

    await playDay1AndSkipNight1(host, players, log);

    log.banner('DAY 2 — nothing relevant here, abstain straight through');
    host.App.startVoting();
    await abstainDayRound(host, players, log);

    log.banner('NIGHT 2 — hand off the gun (1st of 2) to the bystander');
    await runGunHandoffNight(host, players, log, names, bystander);

    const beforeShot1 = readDebugStateText(host);
    log.info('debug panel right after handoff 1 (before any shot is fired): "' + beforeShot1 + '"');
    log.assert(beforeShot1.indexOf('لغو شده: خیر') !== -1, 'gunsCancelled correctly starts false — got "' + beforeShot1 + '"');
    log.assert(beforeShot1.indexOf('باقی‌مانده: 1') !== -1, '1 of 2 handoffs spent so far (this one) — got "' + beforeShot1 + '"');

    log.banner('DAY 3 — the bystander shoots کنستانتین (shield: true) — should survive, NOT cancel the gun');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, bystander), log, names.constantineName);
    await sleep(150);

    log.assert(activeScreenId(byLabel(players, names.constantineName)) !== 'screen-player-eliminated',
      'کنستانتین survived the shot — their shield absorbed it, exactly as expected');

    const afterShot1 = readDebugStateText(host);
    log.info('debug panel after shot 1 (shielded civilian, survived): "' + afterShot1 + '"');
    log.assert(afterShot1.indexOf('لغو شده: خیر') !== -1,
      'BUG CHECK: a shielded civilian surviving the shot must NOT cancel the gun — got "' + afterShot1 + '"');
    log.assert(afterShot1.indexOf('باقی‌مانده: 1') !== -1,
      'exactly 1 of 2 handoffs spent so far (this one) — got "' + afterShot1 + '"');

    await abstainDayRound(host, players, log);

    log.banner('NIGHT 3 — hand off the gun again (2nd and LAST of 2) to the bystander');
    await runGunHandoffNight(host, players, log, names, bystander);

    log.banner('DAY 4 — the bystander shoots زودیاک — immune by design, should survive, NOT cancel the gun');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, bystander), log, names.zodiacName);
    await sleep(150);

    log.assert(activeScreenId(byLabel(players, names.zodiacName)) !== 'screen-player-eliminated',
      'زودیاک survived the shot — immune to the gun by design, exactly as expected');

    const afterShot2 = readDebugStateText(host);
    log.info('debug panel after shot 2 (زودیاک, immune): "' + afterShot2 + '"');
    log.assert(afterShot2.indexOf('لغو شده: خیر') !== -1,
      'BUG CHECK: firing at زودیاک must NOT cancel the gun, regardless of the (always no-effect) outcome — got "' + afterShot2 + '"');
    log.assert(afterShot2.indexOf('باقی‌مانده: 0') !== -1,
      'both handoffs are now spent — gunsRemaining correctly hit 0 on its own (the separate, always-worked whole-game cap), got "' + afterShot2 + '"');

    await abstainDayRound(host, players, log);

    log.banner('NIGHT 4 — no more gun to give: تفنگدار should get no handoff prompt at all this time');
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 4 eyes-closed' });
    host.App.continueAfterEyesClosed();
    await nightAction(byLabel(players, names.godfatherName), log);
    await nightAction(byLabel(players, names.zodiacName), log);
    await sleep(200);
    log.assert(activeScreenId(byLabel(players, names.gunnerName)) !== 'screen-player-night-action',
      'تفنگدار correctly gets no further prompt — both handoffs are spent, with or without gunsCancelled');
    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'Night 4 never reached morning-ready' });

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
