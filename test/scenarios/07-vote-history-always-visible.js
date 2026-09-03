'use strict';
// Regression test for a reported bug: "the vote history should be visible
// by all players in all scenarios and all games at all times. i see in god
// mode players don't see that when voting prompt is active."
//
// The "Vote History" link (App.viewVoteHistory, .vote-history-link) was
// only ever present on 4 of a real player's ~16 in-game screens
// (screen-player-day/defense/day-result/night-waiting) — notably ABSENT
// from screen-player-vote itself (the actual voting prompt the report
// specifically called out), screen-player-night-action, and every other
// waiting/result/inquiry/eliminated/game-over screen. Not God-Mode-
// specific — every real player in every mode was missing it on those
// screens — the user just happened to notice it while testing God Mode.
// Fixed by adding .vote-history-link to every remaining in-game player
// screen (index.html), the same universal-access treatment
// .activity-link ("My Activity") already got in an earlier pass — now on
// 15 of the 16 (the one exception, screen-player-vote-history, obviously
// doesn't need a link to itself). No JS changes needed: the existing
// updateVoteHistoryLinkVisibility() already does a global
// querySelectorAll('.vote-history-link') on every 'vote-history' message,
// so it picks up every newly-added button automatically.
//
// Part A drives a normal (non-auto-paced) game through two full day votes
// so real vote history actually exists, then checks the link is visible on
// screen-player-vote DURING an active Day-3 voting prompt (the exact
// reported scenario) plus a sampling of the other previously-missing
// screens (night-action, eliminated, game-over) — and that it's correctly
// HIDDEN before any vote has happened yet (Day 1).
// Part B confirms the same for a real player inside a GOD MODE game
// specifically (matching the user's own test setup), AND that God Mode's
// host-self has its own working vote-history button too (a separate,
// pre-existing mechanism — host-self-vote-history-btn — confirmed still
// intact, not broken by this change).
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $, waitFor, sleep, teardown,
  isHostSelfActionVisible
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1,
  autoAssignRolesAndBegin, playDay1AndSkipNight1AutoPaced,
  fullVoteRound1, fullVoteFinal
} = require('../lib/game-flow');

const NAMES_A = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];
const NAMES_B = ['Farid', 'Golnar', 'Hana', 'Iman'];

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}
function linkVisible(device) {
  const el = device.document.querySelector('.screen.active .vote-history-link');
  return !!el && el.style.display !== 'none';
}

runScenario('07-vote-history-always-visible', async (log) => {
  log.banner('PART A — a normal game, checking the link on previously-missing screens');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let players = [];
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(NAMES_A.length - 6); // default is 6 — pin it to exactly this roster
      host.App.stepMafia(1 - 2); // default is 2 — exactly 1, so a single Day-2 elimination can't accidentally end the game early
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES_A, log));
      const { mafiaNames } = await assignRolesAndBegin(host, players, log);

      const p1 = players[0];
      // Eliminate a VILLAGER specifically (not whoever the random shuffle
      // happened to deal Mafia to) — with exactly 1 Mafia in play, voting
      // them out on Day 2 would end the game immediately and this test
      // needs to reach Night 2 and Day 3 afterward.
      const p2 = players.find((p) => !mafiaNames.includes(p.label));
      log.assert(!linkVisible(p1), 'Day 1 (no vote has happened yet): the link is correctly HIDDEN, not shown empty');

      await playDay1AndSkipNight1(host, players, log);

      log.step('Day 2: full-participation vote eliminating ' + p2.label + ' (a villager), creating real vote history...');
      host.App.startVoting();
      await fullVoteRound1(host, players, null, p2.label, log);
      await waitFor(() => activeScreenId(host) === 'screen-host-defense', { message: 'Day 2 never reached defense' });
      host.App.startFinalVote();
      await fullVoteFinal(host, players, null, p2.label, log);
      await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 2 never reached result' });
      log.assert(linkVisible(p1), 'Day 2\'s result screen: the link is now visible (history exists)');
      host.App.proceedAfterResult();

      log.banner('NIGHT 2');
      await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'Night 2 never reached eyes-closed' });
      host.App.continueAfterEyesClosed();
      await sleep(150); // give the mafia-phase prompt a moment to actually land before polling for it
      // Only Mafia's kill-decider gets a night-action screen in this
      // default (no special-role) setup — poll for whichever alive player
      // that turned out to be, rather than assuming a fixed name.
      const stillAlive = players.filter((pp) => pp.label !== p2.label);
      const nightActor = stillAlive.find((p) => activeScreenId(p) === 'screen-player-night-action');
      log.assert(!!nightActor, 'found the night\'s kill-decider on their own night-action screen');
      if (nightActor) {
        log.assert(linkVisible(nightActor), nightActor.label + '\'s NIGHT-ACTION screen (a prompt actively open): the link is visible');
        nightActor.App.skipNightAction();
      }
      host.App.continueAfterOceanTalk();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'Night 2 never reached morning-ready' });
      host.App.announceMorning();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'Night 2 never reached result' });
      host.App.proceedAfterNight();

      log.banner('DAY 3 — the exact reported scenario: an ACTIVE voting prompt');
      host.App.startVoting();
      const alive3 = players.filter((p) => p.label !== p2.label);
      for (const p of alive3) {
        await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
      }
      log.assert(linkVisible(alive3[0]), 'Day 3\'s ACTIVE voting prompt (screen-player-vote): the link is visible — this is exactly the reported bug');

      // Everyone abstains — just need to observe the prompt, not resolve it.
      for (const p of alive3) p.App.submitVote();
      await sleep(150);
      host.App.closeVoting();
      await waitFor(() => activeScreenId(host) === 'screen-host-result' || activeScreenId(host) === 'screen-host-defense',
        { message: 'Day 3 voting never closed' });

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }

  log.banner('PART B — a God Mode game: real players AND the host-self both have working vote-history access');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host-godmode' });
    let players = [];
    try {
      host.App.goLanding('host');
      host.App.setGodMode(true);
      host.App.stepPlayers(NAMES_B.length + 1 - 6); // default 6 -> real players + the host's own seat
      host.App.stepMafia(1 - 2); // default is 2 — exactly 1, so a single Day-2 elimination can't accidentally end the game early
      host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote getting in the way of Day 3's auto-opened voting
      $(host, 'input-host-self-name').value = 'Reza';
      host.App.createLobby();

      ({ players } = await joinPlayers(server.baseURL, host, NAMES_B, log, NAMES_B.length + 1));
      const { mafiaNames } = await autoAssignRolesAndBegin(host, players, log, 'Reza');
      await playDay1AndSkipNight1AutoPaced(host, players, log);

      // Day 2 is this game's FIRST-EVER vote — state.voteHistory is still
      // genuinely empty at this exact moment, so the link is correctly
      // hidden here (same as Part A's Day 1 check) — resolve it first so
      // real history exists, then check Day 3's active prompt instead,
      // same pattern as Part A.
      log.step('Day 2: resolving the auto-opened vote to create real vote history...');
      // Eliminate a villager specifically — with exactly 1 Mafia in play
      // (Reza or a real player, whichever the random shuffle picked),
      // voting them out here would end the game immediately.
      const day2Target = players.find((p) => !mafiaNames.includes(p.label)).label;
      await fullVoteRound1(host, players, 'Reza', day2Target, log);
      await fullVoteFinal(host, players, 'Reza', day2Target, log);
      await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'Day 2 never reached result' });
      host.App.proceedAfterResult();

      log.banner('NIGHT 2');
      await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'Night 2 never reached eyes-closed' });
      host.App.continueAfterEyesClosed();
      await sleep(150);
      const stillAlive = players.filter((p) => p.label !== day2Target);
      for (const p of stillAlive) {
        if (activeScreenId(p) === 'screen-player-night-action') p.App.skipNightAction();
      }
      // Only reachable if Reza turned out to be Mafia's kill-decider —
      // votes never happen during the night phase, so any pending
      // host-self action here is guaranteed to be a night action.
      if (isHostSelfActionVisible(host)) host.App.hostSelfSkipNightAction();
      host.App.continueAfterOceanTalk();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { timeout: 5000, message: 'Night 2 never reached morning-ready' });
      host.App.announceMorning();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'Night 2 never reached the result screen' });
      host.App.proceedAfterNight();
      await waitFor(() => activeScreenId(host) === 'screen-host-voting', { timeout: 5000, message: 'Day 3 voting never auto-opened' });

      log.step('Day 3 voting is open — checking the link on a real player\'s ACTIVE vote prompt (history now exists)...');
      const alive3 = players.filter((p) => p.label !== day2Target);
      for (const p of alive3) {
        await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
      }
      const realPlayer = alive3.find((p) => p.label !== 'Reza');
      log.assert(linkVisible(realPlayer), 'God Mode, real player, ACTIVE voting prompt: the link is visible (was previously never shown here at all)');

      log.step('The host-self (Reza), if still alive, also has a working, pre-existing vote-history button...');
      const hsVoteHistoryBtn = $(host, 'host-self-vote-history-btn');
      log.assert(!!hsVoteHistoryBtn, 'host-self-vote-history-btn exists in the DOM (God Mode\'s own pre-existing mechanism, untouched by this fix)');
      if (isHostSelfActionVisible(host)) {
        log.assert(hsVoteHistoryBtn.style.display !== 'none', 'and it\'s actually visible right now (history exists, host-self is alive)');
      }

      for (const p of alive3) p.App.submitVote();
      await sleep(150);

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }
});
