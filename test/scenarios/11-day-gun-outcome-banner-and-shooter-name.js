'use strict';
// Regression test for two reported requests about the day-gun outcome
// announcement:
//
//   1. "if someone gets killed we get a pop up message and we should click
//      ok before it disappears, but if the shoot doesn't kill anybody
//      there is a disappearing message... We need to change all those
//      pop-up messages to stay on screen till we make sure player saw
//      that and clicks ok."
//   2. "when gun holder shoots someone (successfully or unsuccessfully)
//      the message should say who was the gun holder that made the
//      shot."
//
// A genuine KILL already got the deliberate, dismiss-or-timeout
// #day-gun-outcome-banner treatment from an earlier pass (see
// 02-fourteen-player-longer-village-win.js, which already checks the
// banner names the target). What was missing: a shot that DOESN'T kill
// (a shielded/immune target — a real "the shoot doesn't kill anybody"
// case, not to be confused with nobody firing at all) still just used a
// 5s toast, easy to miss exactly like the original kill bug was. Fixed
// (index.html) by having announceDayGunOutcome take a `requiresAck` flag
// — true for BOTH 'died' and 'no-effect' (an actual shot happened either
// way), false only for 'not-fired' (nobody chose to shoot at all, a
// genuine non-event that correctly stays a plain toast, unchanged). Both
// the death and no-effect STRINGS also gained a {shooter} placeholder
// naming who actually pulled the trigger.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $, text, selectRoleInPlay, waitFor, sleep, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, nightAction, dayGunDecision } = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid'];
const ROLE_GUNNER = 'تفنگدار';
const ROLE_GODFATHER = 'پدر خوانده';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}
function bannerVisible(device) {
  const el = $(device, 'ack-banner');
  return !!el && el.style.display === 'flex';
}

// پدر خوانده is Mafia's deterministic kill-decider whenever alive (no
// random pick needed — see startMafiaPhaseStep) — their own night-action
// prompt (a skip, keeping everyone alive so the test's later day-gun
// targets stay available) has to be answered before تفنگدار's own
// civilian-phase handoff prompt even appears.
//
// No اوشن role is ever in play in this scenario, so once تفنگدار's handoff
// is the only pending civilian-phase decision, checkCivilianPhaseComplete
// advances straight through 'ocean-talk' (0 team members, see
// startOceanTalkStep) to the morning-ready screen entirely on its own —
// deliberately NOT calling App.continueAfterOceanTalk() here to force it:
// that call is unconditional (advanceNight() regardless of
// state.gamePhase), and nightAction() above only waits for the SUBMIT to
// go out, not for the host to have actually processed it yet (a real,
// async data-channel message) — calling it immediately after would risk
// racing ahead of that message and silently dropping the handoff (the
// state.gamePhase !== expectedPhase guard in handleNightAction eats a
// decision that arrives after the phase has already moved on). Just
// waiting for morning-ready lets the real submission land first, however
// long that actually takes.
async function runNightWithGunHandoff(host, players, log, godfatherName, gunnerName, recipient) {
  await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached eyes-closed' });
  host.App.continueAfterEyesClosed();
  await nightAction(byLabel(players, godfatherName), log); // skip — no kill tonight
  await nightAction(byLabel(players, gunnerName), log, recipient);
  await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached morning-ready' });
  host.App.announceMorning();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached night result' });
  host.App.proceedAfterNight();
}

runScenario('11-day-gun-outcome-banner-and-shooter-name', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];
  try {
    host.App.goLanding('host');
    selectRoleInPlay(host, ROLE_GUNNER);
    selectRoleInPlay(host, ROLE_GODFATHER); // carries a shield — one hit absorbs it (survives), a real "shot that doesn't kill"
    host.App.createLobby();
    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    const gunnerName = Object.keys(roles).find((label) => roles[label].title === ROLE_GUNNER);
    const godfatherName = Object.keys(roles).find((label) => roles[label].title === ROLE_GODFATHER);
    log.assert(!!gunnerName, 'تفنگدار was dealt');
    log.assert(!!godfatherName && mafiaNames.includes(godfatherName), 'پدر خوانده was dealt and is Mafia, as expected');
    const bystanders = PLAYER_NAMES.filter((n) => n !== gunnerName && n !== godfatherName && !mafiaNames.includes(n));
    const [recipient1, recipient2] = bystanders;
    log.info('تفنگدار: ' + gunnerName + ' | پدر خوانده: ' + godfatherName + ' | recipients: ' + recipient1 + ', ' + recipient2);

    await playDay1AndSkipNight1(host, players, log);

    log.banner('DAY 2 — nothing relevant here, skip straight through with no majority');
    host.App.startVoting();
    for (const p of players) await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the Day 2 vote screen' });
    for (const p of players) p.App.submitVote(); // everyone abstains -> no majority
    await sleep(150);
    host.App.closeVoting();
    await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 2 never reached its result' });
    host.App.proceedAfterResult();

    log.banner('NIGHT 2 — hand off the gun (1st of 2)');
    await runNightWithGunHandoff(host, players, log, godfatherName, gunnerName, recipient1);

    log.banner('DAY 3 — a real shot that does NOT kill (shield absorbs it)');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, recipient1), log, godfatherName);
    await sleep(150);

    log.assert(bannerVisible(host), 'the host sees the deliberate outcome banner (not a toast) for a shot that didn\'t kill');
    const bannerText1 = text(host, 'ack-banner-text') || '';
    log.info('banner text: "' + bannerText1 + '"');
    log.assert(bannerText1.indexOf(godfatherName) !== -1, 'the banner names the target, ' + godfatherName);
    log.assert(bannerText1.indexOf(recipient1) !== -1, 'the banner ALSO names the shooter, ' + recipient1);
    log.assert(bannerVisible(byLabel(players, recipient1)), 'the shooter themselves sees the same banner');
    log.assert(bannerVisible(byLabel(players, godfatherName)), 'the target (survived, still alive) sees it too');

    host.App.dismissAckBanner();
    log.assert(!bannerVisible(host), 'dismissing hides it');
    for (const p of players) { if (bannerVisible(p)) p.App.dismissAckBanner(); }

    log.assert(activeScreenId(byLabel(players, godfatherName)) !== 'screen-player-eliminated',
      'پدر خوانده is confirmed still alive — this really was a no-effect outcome, not a kill');

    for (const p of players) { if (activeScreenId(p) === 'screen-player-vote') p.App.submitVote(); }
    await sleep(150);
    host.App.closeVoting();
    await waitFor(() => activeScreenId(host) === 'screen-host-result' || activeScreenId(host) === 'screen-host-defense',
      { message: 'Day 3 voting never closed' });
    if (activeScreenId(host) === 'screen-host-defense') {
      host.App.startFinalVote();
      for (const p of players) { if (activeScreenId(p) === 'screen-player-vote') p.App.submitVote(); }
      await sleep(150);
      host.App.closeVoting();
    }
    await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 3 never settled on a result' });
    host.App.proceedAfterResult();

    log.banner('NIGHT 3 — hand off the gun again (2nd of 2)');
    await runNightWithGunHandoff(host, players, log, godfatherName, gunnerName, recipient2);

    log.banner('DAY 4 — the holder chooses NOT to fire at all (a genuine non-event)');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, recipient2), log, null);
    await sleep(150);

    log.assert(!bannerVisible(host), '"nobody fired today" correctly stays a plain toast — no banner, unchanged from before');
    const toastText = (host.document.getElementById('toast-host').textContent || '').trim();
    log.info('toast text: "' + toastText + '"');
    log.assert(toastText.length > 0, 'a toast still announces it, just not as a modal');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
