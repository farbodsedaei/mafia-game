'use strict';
// Regression test for a reported bug: "the time for defence should be
// default time per player (i.e. 5 mins) to talk."
//
// Under auto-pacing (No God Mode / God Mode), broadcastDefensePhase used
// to call App.startFinalVote() immediately — folding the defense
// statement into the exact same window as final voting itself, so the
// accused got literally zero dedicated time to actually talk before
// voting could reopen. Fixed by arming the SAME per-player-alive deadline
// formula voting itself already uses (armVoteDeadline —
// voteDeadlineMinutes x however many are alive) for the defense phase
// specifically, before opening the final vote. A no-op in a normally-
// hosted game, same as every other armVoteDeadline call — the God still
// taps "Start Final Vote" whenever they judge it's done.
//
// Uses the test-only 'mafia-deadline-ms-override' localStorage key (read
// live by armAutoDeadlineMs on every arm) to force every auto-deadline in
// this run down to a few hundred ms instead of real minutes, so the
// eventual auto-advance can actually be observed within a fast test.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, waitFor, sleep, teardown } = require('../lib/device');
const { joinPlayers, autoAssignRolesAndBegin, playDay1AndSkipNight1AutoPaced, castVotes } = require('../lib/game-flow');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];
const OVERRIDE_MS = '400';

runScenario('09-defense-gets-its-own-deadline', async (log) => {
  log.banner('PART A — No God Mode: the defense phase gets its own dedicated deadline');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let players = [];
    try {
      host.window.localStorage.setItem('mafia-deadline-ms-override', OVERRIDE_MS);
      host.App.goLanding('host');
      host.App.setNoGodMode(true);
      host.App.stepPlayers(NAMES.length - 6);
      host.App.stepInquiries(-1);
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));
      await autoAssignRolesAndBegin(host, players, log);
      await playDay1AndSkipNight1AutoPaced(host, players, log);

      log.step('Day 2: majority-voting a target into the defense phase...');
      const target = players[0];
      const choices = {};
      players.filter((p) => p !== target).forEach((p) => { choices[p.label] = [target.label]; });
      await castVotes(players, choices, log, 'round 1');

      await waitFor(() => activeScreenId(host) === 'screen-host-defense',
        { timeout: 3000, message: 'never reached the defense screen at all' });
      log.assert(activeScreenId(host) === 'screen-host-defense',
        'landed on the defense screen — did NOT fold straight into final voting the instant round 1 closed');

      // Give it a beat, well short of the override, and confirm it's
      // genuinely still sitting there (not just caught mid-transition).
      await sleep(150);
      log.assert(activeScreenId(host) === 'screen-host-defense',
        'still on the defense screen a moment later — this is real dedicated time, not an instant pass-through');

      log.step('Waiting past the (overridden, ~' + OVERRIDE_MS + 'ms) defense deadline...');
      await waitFor(() => activeScreenId(host) === 'screen-host-voting',
        { timeout: 3000, message: 'the defense deadline never actually fired and opened the final vote on its own' });
      log.pass('The defense deadline expired on its own and correctly opened the final vote — no manual click needed.');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }

  log.banner('PART B — a normally-hosted game: no deadline, the God controls it manually (regression check)');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host-normal' });
    let players = [];
    try {
      // Deliberately still set — proves this game path ignores it
      // entirely rather than happening to work because no override was
      // present (armAutoDeadlineMs itself no-ops without autoPacingOn()).
      host.window.localStorage.setItem('mafia-deadline-ms-override', OVERRIDE_MS);
      host.App.goLanding('host');
      host.App.stepPlayers(NAMES.length - 6);
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));

      host.App.assignRoles();
      for (const p of players) {
        await waitFor(() => activeScreenId(p) === 'screen-player-role', { message: p.label + ' never received a role' });
      }
      host.App.beginGame();
      await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 1' });
      host.App.continueToNight();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 1' });
      host.App.continueAfterEyesClosed();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached morning-ready' });
      host.App.announceMorning();
      await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached night result' });
      host.App.proceedAfterNight();

      host.App.startVoting();
      const target = players[0];
      const choices = {};
      players.filter((p) => p !== target).forEach((p) => { choices[p.label] = [target.label]; });
      await castVotes(players, choices, log, 'round 1');
      await waitFor(() => activeScreenId(host) === 'screen-host-defense', { message: 'never reached the defense screen' });

      await sleep(700); // well past the same override — must NOT auto-advance here
      log.assert(activeScreenId(host) === 'screen-host-defense',
        'a normally-hosted game never auto-advances past defense, even with the same override set — the God decides manually');

      host.App.startFinalVote();
      await waitFor(() => activeScreenId(host) === 'screen-host-voting', { message: 'manual Start Final Vote did not work' });
      log.pass('The God\'s own manual "Start Final Vote" tap still works exactly as before.');

      await teardown(server, [host, ...players]);
    } catch (err) {
      await teardown(server, [host, ...players]);
      throw err;
    }
  }
});
