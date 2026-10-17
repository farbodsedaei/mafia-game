'use strict';
// Regression coverage for three related night-phase features added in the
// same pass: پدر خوانده's سلاخی (Slaughter) option, حرفه‌ای getting that
// same option, and the new mafia-team role دکتر لکتر (a Doctor's save,
// restricted to Mafia-team targets only). All three interact with each
// other, so this drives one game through every combination rather than
// three separate smaller ones:
//
//   - حرفه‌ای's Slaughter SUCCEEDS on زودیاک — a correct guess is the one
//     way to kill the otherwise gun/shot-immune زودیاک without a day vote.
//     Same night, دکتر لکتر's save genuinely protects a Mafia-aligned
//     target (مافیای ساده) from a real, non-guaranteed death (زودیاک's own
//     shot) — proving the save mechanic itself works before anything tries
//     to bypass it.
//   - حرفه‌ای's Slaughter FAILS on a plain villager — a complete non-event,
//     and the option is permanently gone afterward (one mistake, ever).
//   - پدر خوانده's Slaughter SUCCEEDS on the same مافیای ساده دکتر لکتر just
//     saved — this time دکتر لکتر's save does NOT help: a correct guess
//     bypasses it exactly like it bypasses a shield or the regular دکتر's
//     own save.
//   - پدر خوانده's Slaughter FAILS on a plain villager — same permanent
//     one-mistake rule, confirmed afterward by a completely ordinary kill
//     still working normally.
//
// Also confirms, once at دکتر لکتر's first real prompt, that their
// candidate list is restricted to ALIVE MAFIA-TEAM members only — never a
// civilian, حرفه‌ای, or زودیاک.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $, text, selectRoleInPlay, isSlaughterToggleVisible,
  readDebugStateText, waitFor, sleep, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, nightAction } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid', 'Gina', 'Hana', 'Iman', 'Jina'];
const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_LECTER = 'دکتر لکتر';
const ROLE_PROFESSIONAL = 'حرفه‌ای';
const ROLE_ZODIAC = 'زودیاک';
const ROLE_PLAIN_MAFIA = 'مافیا ساده';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

// Abstain-everyone Day round, same shape as 15-gunner-cancellation-rules'
// own local helper — nobody is ever actually on trial here, every death in
// this scenario comes from a night action, not a vote. Filters to whoever
// is still alive, since deaths accumulate across the game.
async function abstainDayRound(host, players, log) {
  const alive = players.filter((p) => activeScreenId(p) !== 'screen-player-eliminated');
  for (const p of alive) await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
  for (const p of alive) p.App.submitVote();
  await sleep(150);
  host.App.closeVoting();
  await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'day round never reached its result' });
  host.App.dismissAckBanner();
  for (const p of alive) p.App.dismissAckBanner();
  host.App.proceedAfterResult();
}

runScenario('16-slaughter-and-lecter', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];
  try {
    host.App.goLanding('host');
    host.App.stepPlayers(4); // default numPlayers (6) -> 10, matching PLAYER_NAMES.length
    host.App.stepMafia(1);   // default numMafia (2) -> 3, so a THIRD, shieldless مافیای ساده exists for دکتر لکتر to save
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote once real deaths start
    [ROLE_GODFATHER, ROLE_LECTER, ROLE_PROFESSIONAL, ROLE_ZODIAC].forEach((r) => selectRoleInPlay(host, r));
    host.App.createLobby();
    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { roles } = await assignRolesAndBegin(host, players, log);

    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const godfatherName = findByTitle(ROLE_GODFATHER);
    const lecterName = findByTitle(ROLE_LECTER);
    const professionalName = findByTitle(ROLE_PROFESSIONAL);
    const zodiacName = findByTitle(ROLE_ZODIAC);
    const plainMafiaName = findByTitle(ROLE_PLAIN_MAFIA);
    log.assert(godfatherName && lecterName && professionalName && zodiacName && plainMafiaName,
      'all 5 requested roles were actually dealt (' + JSON.stringify({ godfatherName, lecterName, professionalName, zodiacName, plainMafiaName }) + ')');
    const special = [godfatherName, lecterName, professionalName, zodiacName, plainMafiaName];
    const civilians = PLAYER_NAMES.filter((n) => !special.includes(n));
    log.assert(civilians.length >= 3, 'at least 3 plain villagers available as throwaway targets (' + civilians.join(', ') + ')');
    const [villager1, villager2, villager3] = civilians;
    log.info('پدر خوانده=' + godfatherName + ' دکتر لکتر=' + lecterName + ' حرفه‌ای=' + professionalName +
      ' زودیاک=' + zodiacName + ' مافیا ساده=' + plainMafiaName);
    log.info('throwaway villagers: ' + villager1 + ', ' + villager2 + ', ' + villager3);

    const godfather = byLabel(players, godfatherName);
    const lecter = byLabel(players, lecterName);
    const professional = byLabel(players, professionalName);
    const zodiac = byLabel(players, zodiacName);
    const plainMafia = byLabel(players, plainMafiaName);

    await playDay1AndSkipNight1(host, players, log);

    log.banner('NIGHT 2 — حرفه‌ای Slaughter SUCCEEDS on زودیاک; دکتر لکتر\'s save genuinely protects مافیا ساده from زودیاک\'s own shot');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 2 eyes-closed' });
    host.App.continueAfterEyesClosed();

    await nightAction(godfather, log); // skip — no kill yet

    await waitFor(() => activeScreenId(lecter) === 'screen-player-night-action', { message: 'دکتر لکتر never got its own prompt (N2)' });
    const lecterCandidates = Array.from($(lecter, 'night-action-candidate-list').querySelectorAll('.role-name')).map((el) => el.textContent);
    log.info('  دکتر لکتر candidates (N2): ' + lecterCandidates.join(', '));
    log.assert(JSON.stringify(lecterCandidates.slice().sort()) === JSON.stringify([godfatherName, lecterName, plainMafiaName].sort()),
      'دکتر لکتر\'s candidate list is EXACTLY the 3 Mafia-team members — no civilian, حرفه‌ای, or زودیاک leaked in');
    await nightAction(lecter, log, plainMafiaName); // save مافیا ساده

    await nightAction(zodiac, log, plainMafiaName); // a real, non-guaranteed raw-death shot at the same target

    await waitFor(() => activeScreenId(professional) === 'screen-player-night-action', { message: 'حرفه‌ای never got its own prompt (N2)' });
    log.assert(isSlaughterToggleVisible(professional), 'حرفه‌ای has the Slaughter option on Night 2');
    await nightAction(professional, log, zodiacName, { slaughterGuessRole: ROLE_ZODIAC }); // CORRECT guess

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 2 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 2 result' });
    await waitFor(() => activeScreenId(zodiac) === 'screen-player-eliminated' || activeScreenId(zodiac) === 'screen-player-game-over',
      { message: 'زودیاک never saw its own elimination — a correct سلاخی guess should be unavoidable, bypassing its own immunity' });
    log.assert(true, 'زودیاک died to حرفه‌ای\'s correct سلاخی guess — immunity bypassed');
    log.assert((text(host, 'night-result-title') || '').indexOf('سلاخی') !== -1,
      'public reveal uses the distinct "slaughtered" wording: "' + text(host, 'night-result-title') + '"');
    await sleep(150);
    log.assert(activeScreenId(plainMafia) !== 'screen-player-eliminated', 'مافیا ساده survived زودیاک\'s real shot — دکتر لکتر\'s save genuinely worked');
    let debugState = readDebugStateText(host);
    log.info('  debug (N2): "' + debugState + '"');
    log.assert(debugState.indexOf('شلیک‌های باقی‌ماندهٔ حرفه‌ای: 1') !== -1, 'حرفه‌ای has 1 of 2 shots left after the correct guess');
    log.assert(debugState.indexOf('سلاخی حرفه‌ای: در دسترس') !== -1, 'حرفه‌ای\'s Slaughter is still available after a correct guess');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 3' });

    log.banner('NIGHT 3 — حرفه‌ای Slaughter FAILS on a plain villager — permanently disabled afterward');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 3 eyes-closed' });
    host.App.continueAfterEyesClosed();

    await nightAction(godfather, log); // skip
    await nightAction(lecter, log); // skip
    await waitFor(() => activeScreenId(professional) === 'screen-player-night-action', { message: 'حرفه‌ای never got its own prompt (N3)' });
    await nightAction(professional, log, villager1, { slaughterGuessRole: ROLE_LECTER }); // WRONG guess

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 3 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 3 result' });
    await sleep(150);
    log.assert(activeScreenId(byLabel(players, villager1)) !== 'screen-player-eliminated', villager1 + ' survived the wrong guess — complete non-event');
    debugState = readDebugStateText(host);
    log.info('  debug (N3): "' + debugState + '"');
    log.assert(debugState.indexOf('شلیک‌های باقی‌ماندهٔ حرفه‌ای: 0') !== -1, 'حرفه‌ای has 0 of 2 shots left');
    log.assert(debugState.indexOf('سلاخی حرفه‌ای: برای همیشه غیرفعال') !== -1, 'حرفه‌ای\'s Slaughter is now permanently disabled');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 4' });

    log.banner('NIGHT 4 — پدر خوانده Slaughter SUCCEEDS on مافیا ساده — دکتر لکتر\'s save does NOT help this time');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 4 eyes-closed' });
    host.App.continueAfterEyesClosed();

    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-action', { message: 'پدر خوانده never got the kill prompt (N4)' });
    log.assert(isSlaughterToggleVisible(godfather), 'پدر خوانده still has the Slaughter option on Night 4');
    await nightAction(godfather, log, plainMafiaName, { slaughterGuessRole: ROLE_PLAIN_MAFIA }); // CORRECT guess, against his own teammate
    await nightAction(lecter, log, plainMafiaName); // tries to save the exact same target — should NOT help

    // حرفه‌ای is fully out of shots — no prompt should arrive for them at all this night.
    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 4 morning-ready' });
    log.assert(activeScreenId(professional) !== 'screen-player-night-action', 'حرفه‌ای correctly got no prompt at all tonight — fully out of shots');
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 4 result' });
    await waitFor(() => activeScreenId(plainMafia) === 'screen-player-eliminated' || activeScreenId(plainMafia) === 'screen-player-game-over',
      { message: 'مافیا ساده never saw its own elimination — a correct سلاخی guess must be unavoidable even with دکتر لکتر trying to save them' });
    log.assert(true, 'مافیا ساده died despite دکتر لکتر\'s save — guaranteedDeaths bypasses it exactly like a shield or the regular دکتر\'s own save');
    debugState = readDebugStateText(host);
    log.info('  debug (N4): "' + debugState + '"');
    log.assert(debugState.indexOf('سلاخی پدر خوانده: در دسترس') !== -1, 'پدر خوانده\'s Slaughter is still available after a correct guess');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 5' });

    log.banner('NIGHT 5 — پدر خوانده Slaughter FAILS on a plain villager — permanently disabled afterward');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 5 eyes-closed' });
    host.App.continueAfterEyesClosed();

    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-action', { message: 'پدر خوانده never got the kill prompt (N5)' });
    await nightAction(godfather, log, villager2, { slaughterGuessRole: ROLE_LECTER }); // WRONG guess
    // مافیا ساده is dead now, but دکتر لکتر still has Godfather + themselves
    // as valid save candidates — still gets prompted every night both stay alive.
    await nightAction(lecter, log);

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 5 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 5 result' });
    await sleep(150);
    log.assert(activeScreenId(byLabel(players, villager2)) !== 'screen-player-eliminated', villager2 + ' survived the wrong guess — complete non-event');
    debugState = readDebugStateText(host);
    log.info('  debug (N5): "' + debugState + '"');
    log.assert(debugState.indexOf('سلاخی پدر خوانده: برای همیشه غیرفعال') !== -1, 'پدر خوانده\'s Slaughter is now permanently disabled');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 6' });

    log.banner('NIGHT 6 — پدر خوانده\'s Slaughter checkbox is gone; a completely normal kill still works fine');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 6 eyes-closed' });
    host.App.continueAfterEyesClosed();

    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-action', { message: 'پدر خوانده never got the kill prompt (N6)' });
    log.assert(!isSlaughterToggleVisible(godfather), 'پدر خوانده\'s Slaughter checkbox is gone after the one wrong guess');
    await nightAction(godfather, log, villager3); // a perfectly normal kill, no Slaughter involved
    await nightAction(lecter, log);

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 6 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 6 result' });
    await waitFor(() => activeScreenId(byLabel(players, villager3)) === 'screen-player-eliminated' || activeScreenId(byLabel(players, villager3)) === 'screen-player-game-over',
      { message: villager3 + ' never saw its own elimination — پدر خوانده\'s normal kill should still work fine without Slaughter' });
    log.assert(true, villager3 + ' died to a perfectly ordinary Mafia kill — the base ability still works after losing Slaughter');
    host.App.proceedAfterNight();

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
