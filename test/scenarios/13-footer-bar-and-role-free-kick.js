'use strict';
// Feature test for two related UI requests:
//
//   1. "the three options: 'view my role' 'view my activity' 'history of
//      votes' should be changed to buttons at the bottom of the page."
//      Each of ~17 in-game player screens used to carry its OWN copy of
//      these as plain text links (.link-btn) scattered inside the screen's
//      own content. Consolidated into one persistent, real-button row
//      (#player-footer-bar) that lives as a normal sibling of every
//      .screen — not position:fixed — so it naturally sits pinned to the
//      bottom of whatever screen is active (every .screen is flex:1, only
//      one is ever display:flex at a time). updatePlayerFooterBar (called
//      from showScreen, plus every place that changes
//      state.hasActivityLog/state.voteHistory) decides which of the three
//      buttons apply on the CURRENT screen — always My Role except on
//      screen-player-role itself, My Activity gated on hasActivityLog
//      (and hidden on screen-player-activity-log itself), Vote History
//      gated on any completed round existing (and hidden on
//      screen-player-vote-history itself).
//
//   2. "Even host (playing god) should be able to kick a player out of
//      game if needed -- still should not see their role." Kicking used
//      to live ONLY inside the full debug panel (roles, teams, shields,
//      night status) — which is deliberately HIDDEN for as long as a
//      God-Mode host's own seat is alive, to avoid spoiling their own
//      game. That made kicking unreachable exactly when a God-Mode host
//      most needs it. Added a separate, always-available "Manage Players"
//      panel (#manage-players-panel, App.toggleManagePlayersPanel) that
//      shows ONLY names + alive/connected status — never a role, team, or
//      shield — with the same Kick/Revive buttons (App.kickPlayer/
//      revivePlayer, unchanged) reused as-is.
//
// Part A drives a normal (non-God-Mode) game and confirms the footer bar
// shows the right buttons (and only those) across My Role/My
// Activity/Vote History's own screens plus an ACTIVE night-action prompt
// (the shape of the originally-reported vote-history bug), and that the
// OLD per-screen copies are genuinely gone — exactly one of each button
// exists in the whole document now, not one per screen.
// Part B drives a God Mode game with the host-self seat alive and confirms
// the full debug panel is (still, as before) hidden, but Manage Players is
// NOT; opening it shows no role/team text anywhere for a roster whose real
// roles ARE known to the test (so a leak would be detectable); and kicking
// a real player through it actually eliminates them.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $, text, setValue, waitFor, sleep, teardown
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, fullVoteRound1, fullVoteFinal
} = require('../lib/game-flow');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];

function footerButtonShown(device, id) {
  const bar = $(device, 'player-footer-bar');
  const el = $(device, id);
  return !!bar && bar.style.display !== 'none' && !!el && el.style.display !== 'none';
}

runScenario('13-footer-bar-and-role-free-kick', async (log) => {
  log.banner('PART A — the persistent footer bar replaces every per-screen copy');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let players = [];
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(NAMES.length - 6);
      host.App.stepMafia(1 - 2); // exactly 1 Mafia, so a Day-2 villager elimination can't end the game early
      host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote getting in the way of reaching Day 3
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));
      const { mafiaNames } = await assignRolesAndBegin(host, players, log);
      const p1 = players.find((p) => !mafiaNames.includes(p.label)); // a plain villager specifically — Mafia has an activity log from turn one

      log.assert(footerButtonShown(p1, 'footer-role-btn'), 'Day 1: My Role shows (a role has been dealt)');
      log.assert(!footerButtonShown(p1, 'footer-activity-btn'), 'Day 1: My Activity correctly hidden — no activity log yet for a plain villager');
      log.assert(!footerButtonShown(p1, 'footer-vote-history-btn'), 'Day 1: Vote History correctly hidden — no vote has happened yet');

      await playDay1AndSkipNight1(host, players, log);

      log.step('Day 2: eliminating a villager (not the sole Mafia) so the game continues...');
      const target = players.find((p) => !mafiaNames.includes(p.label)).label;
      host.App.startVoting();
      await fullVoteRound1(host, players, null, target, log);
      await fullVoteFinal(host, players, null, target, log);
      await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 2 never reached a result' });

      const survivors = players.filter((p) => p.label !== target);
      const p2 = survivors[0];
      log.assert(footerButtonShown(p2, 'footer-vote-history-btn'), 'after Day 2\'s vote resolves: Vote History now shows (real history exists)');
      log.assert(footerButtonShown(p2, 'footer-role-btn'), 'My Role still shows alongside it');

      host.App.proceedAfterResult();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 2 eyes-closed' });
      host.App.continueAfterEyesClosed();
      await sleep(150);
      const nightActor = survivors.find((p) => activeScreenId(p) === 'screen-player-night-action');
      log.assert(!!nightActor, 'found the night\'s kill-decider on their own night-action screen');
      log.assert(footerButtonShown(nightActor, 'footer-vote-history-btn'), 'the night-action screen (an ACTIVE prompt) also shows Vote History — the originally-reported bug\'s exact shape, still fixed');
      log.assert(footerButtonShown(nightActor, 'footer-activity-btn'), 'My Activity now shows for the kill-decider too (they have a real activity-log entry: tonight\'s decision)');
      nightActor.App.skipNightAction();
      host.App.continueAfterOceanTalk();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached morning-ready' });
      host.App.announceMorning();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached night result' });
      host.App.proceedAfterNight();
      await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 3' });
      for (const p of survivors) await waitFor(() => activeScreenId(p) === 'screen-player-day', { message: p.label + ' never reached Day 3' });

      log.step('Tapping My Activity, then My Role from inside that screen, then back...');
      nightActor.App.viewMyActivity();
      await waitFor(() => activeScreenId(nightActor) === 'screen-player-activity-log', { message: 'never reached the activity-log screen' });
      log.assert(!footerButtonShown(nightActor, 'footer-activity-btn'), 'on the activity-log screen itself, My Activity is correctly hidden (no link to itself)');
      log.assert(footerButtonShown(nightActor, 'footer-role-btn'), 'but My Role still shows from there');
      nightActor.App.viewMyRole();
      await waitFor(() => activeScreenId(nightActor) === 'screen-player-role', { message: 'never reached the role screen' });
      log.assert(!footerButtonShown(nightActor, 'footer-role-btn'), 'on the role screen itself, My Role is correctly hidden');
      nightActor.App.closeMyRole();
      await waitFor(() => activeScreenId(nightActor) === 'screen-player-activity-log', { message: 'closing My Role never returned to the activity-log screen it was opened from' });
      nightActor.App.closeMyActivity();

      log.step('Confirming the OLD per-screen copies are genuinely gone — exactly one of each button in the whole document...');
      log.assert(nightActor.document.querySelectorAll('.vote-history-link').length === 1,
        'exactly one .vote-history-link element exists document-wide (the shared footer\'s), not one per screen');
      log.assert(nightActor.document.querySelectorAll('.activity-link').length === 1,
        'exactly one .activity-link element exists document-wide');
      log.assert(nightActor.document.querySelectorAll('#footer-role-btn').length === 1,
        'exactly one My Role footer button exists');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }

  log.banner('PART B — God Mode: kicking stays available without ever showing a role');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host-godmode' });
    let players = [];
    try {
      host.App.goLanding('host');
      host.App.setGodMode(true);
      host.App.stepPlayers(NAMES.length + 1 - 6); // real players + the host's own seat
      setValue(host, 'input-host-self-name', 'Reza');
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log, NAMES.length + 1));
      const { roles } = await assignRolesAndBegin(host, players, log, 'Reza');

      log.step('With the God-Mode host-self seat alive, the full debug panel stays hidden (unchanged, pre-existing behavior)...');
      log.assert($(host, 'debug-toggle-btn').style.display === 'none', 'debug-toggle-btn is hidden while host-self is alive');

      log.step('...but Manage Players is NOT hidden — it must stay reachable regardless...');
      log.assert($(host, 'manage-players-btn').style.display !== 'none', 'manage-players-btn IS visible even though the debug toggle is not');

      const target = players[0];
      const targetRealRole = roles[target.label].title;
      log.info(target.label + '\'s real role: ' + targetRealRole + ' (known to the test, to prove it never leaks below)');

      host.App.toggleManagePlayersPanel();
      const panel = $(host, 'manage-players-panel');
      log.assert(panel.classList.contains('open'), 'the panel actually opened');
      const panelText = panel.textContent;
      log.assert(panelText.indexOf(target.label) !== -1, 'the panel lists the target player by name');
      // Every role this roster could possibly hold is checked — not just
      // the target's — since a leak could show up as ANY player's role,
      // not necessarily the one about to be kicked.
      const allRoleTitles = Object.values(roles).map((r) => r.title);
      const leaked = allRoleTitles.filter((title) => panelText.indexOf(title) !== -1);
      log.assert(leaked.length === 0, 'no role title at all (any player\'s) appears in the panel — found: ' + JSON.stringify(leaked));
      log.assert(panelText.indexOf('مافیا') === -1 && panelText.toLowerCase().indexOf('mafia') === -1,
        'no team label ("Mafia") appears anywhere in the panel either');

      log.step('Kicking ' + target.label + ' through THIS panel...');
      const rows = Array.from(panel.querySelectorAll('.debug-row'));
      const targetRow = rows.find((r) => r.textContent.indexOf(target.label) !== -1);
      log.assert(!!targetRow, 'found the target\'s own row in the panel');
      const btn = targetRow ? targetRow.querySelector('button') : null;
      log.assert(!!btn, 'that row has a Kick button (target is alive)');
      host.window.confirm = () => true; // the real confirm() dialog — auto-accept, same as every other kick test
      btn.onclick();

      await waitFor(() => activeScreenId(target) === 'screen-player-eliminated',
        { message: target.label + ' was never actually eliminated by the panel\'s kick' });
      log.pass(target.label + ' was genuinely eliminated — Manage Players\' kick reuses the real App.kickPlayer, unchanged.');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }
});
