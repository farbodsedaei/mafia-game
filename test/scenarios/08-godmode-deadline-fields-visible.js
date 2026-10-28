'use strict';
// Regression test for a reported bug: "in god as player mode (host mode),
// we should still be able to adjust the number of minutes for actions and
// talking during day."
//
// #auto-deadline-fields (the act-deadline/vote-deadline minute steppers)
// used to be shown/hidden purely on a since-removed "No God Mode" flag —
// but God Mode drives itself off these exact same two numbers
// (state.actDeadlineMinutes/voteDeadlineMinutes), via the same
// autoPacingOn() engine (see armActDeadline/armVoteDeadline in
// index.html) — so a host in God Mode had no way to see or adjust them at
// all, even though their own game was actively timing every decision and
// every day's discussion+voting window against those defaults. Fixed by
// gating the fields' visibility on autoPacingOn() — a one-line change,
// since App.stepActDeadline/stepVoteDeadline themselves were never
// mode-gated to begin with.
//
// This is a pure setup-screen check — no lobby/game needed. Confirms the
// fields are hidden by default, become visible under God Mode, hide again
// once it's turned off, and that adjusting them actually updates the
// underlying values (not just cosmetic visibility).
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, $, text, teardown } = require('../lib/device');

function fieldsVisible(device) {
  const el = $(device, 'auto-deadline-fields');
  return !!el && el.style.display !== 'none';
}

runScenario('08-godmode-deadline-fields-visible', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  try {
    host.App.goLanding('host');

    log.assert(!fieldsVisible(host), 'God Mode is off — the deadline fields are correctly hidden');

    log.step('Enabling God Mode...');
    host.App.setGodMode(true);
    log.assert(fieldsVisible(host), 'God Mode reveals the deadline fields — this is the exact reported bug');
    log.assert(text(host, 'val-act-deadline') === '2', 'act-deadline starts at its default (2)');
    log.assert(text(host, 'val-vote-deadline') === '5', 'vote-deadline starts at its default (5)');

    log.step('Adjusting both deadlines while in God Mode...');
    host.App.stepActDeadline(3);
    host.App.stepVoteDeadline(-2);
    log.assert(text(host, 'val-act-deadline') === '5', 'act-deadline actually changed (2 -> 5), not just cosmetically visible');
    log.assert(text(host, 'val-vote-deadline') === '3', 'vote-deadline actually changed (5 -> 3)');

    log.step('Turning God Mode back off...');
    host.App.setGodMode(false);
    log.assert(!fieldsVisible(host), 'fields hide again once God Mode is off');

    await teardown(server, [host]);
  } catch (err) {
    await teardown(server, [host]);
    throw err;
  }
});
