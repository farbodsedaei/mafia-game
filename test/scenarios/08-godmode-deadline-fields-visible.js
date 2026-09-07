'use strict';
// Regression test for a reported bug: "in god as player mode (host mode),
// we should still be able to adjust the number of minutes for actions and
// talking during day."
//
// #no-god-deadline-fields (the act-deadline/vote-deadline minute steppers)
// was shown/hidden purely on state.noGodMode — but God Mode drives itself
// off these exact same two numbers (state.actDeadlineMinutes/
// voteDeadlineMinutes), via the same shared autoPacingOn() engine (see
// armActDeadline/armVoteDeadline in index.html) — so a host who enabled
// ONLY God Mode (not No God Mode) had no way to see or adjust them at all,
// even though their own game was actively timing every decision and every
// day's discussion+voting window against those defaults. Fixed by gating
// the fields' visibility on autoPacingOn() instead of state.noGodMode
// directly — a one-line change, since App.stepActDeadline/stepVoteDeadline
// themselves were never mode-gated to begin with.
//
// This is a pure setup-screen check — no lobby/game needed. Confirms the
// fields are hidden by default, become visible under God Mode alone, STAY
// visible if No God Mode is also turned on, and that adjusting them
// actually updates the underlying values (not just cosmetic visibility).
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, $, text, teardown } = require('../lib/device');

function fieldsVisible(device) {
  const el = $(device, 'no-god-deadline-fields');
  return !!el && el.style.display !== 'none';
}

runScenario('08-godmode-deadline-fields-visible', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  try {
    host.App.goLanding('host');

    log.assert(!fieldsVisible(host), 'neither mode is on yet — the deadline fields are correctly hidden');

    log.step('Enabling God Mode alone (No God Mode stays off)...');
    host.App.setGodMode(true);
    log.assert(fieldsVisible(host), 'God Mode alone is enough to reveal the deadline fields — this is the exact reported bug');
    log.assert(text(host, 'val-act-deadline') === '2', 'act-deadline starts at its default (2)');
    log.assert(text(host, 'val-vote-deadline') === '5', 'vote-deadline starts at its default (5)');

    log.step('Adjusting both deadlines while in God Mode...');
    host.App.stepActDeadline(3);
    host.App.stepVoteDeadline(-2);
    log.assert(text(host, 'val-act-deadline') === '5', 'act-deadline actually changed (2 -> 5), not just cosmetically visible');
    log.assert(text(host, 'val-vote-deadline') === '3', 'vote-deadline actually changed (5 -> 3)');

    log.step('Turning God Mode back off...');
    host.App.setGodMode(false);
    log.assert(!fieldsVisible(host), 'fields hide again once neither mode is on');

    log.step('Turning No God Mode on instead — the original, already-working path must still work...');
    host.App.setNoGodMode(true);
    log.assert(fieldsVisible(host), 'No God Mode alone still reveals the fields (regression check — not broken by this fix)');
    log.assert(text(host, 'val-act-deadline') === '5', 'the adjusted values from before persisted across the mode switch (deliberate — see App.newGame\'s own comment on this)');

    log.step('Both modes on at once — still visible...');
    host.App.setGodMode(true);
    log.assert(fieldsVisible(host), 'both modes on together: still visible');

    await teardown(server, [host]);
  } catch (err) {
    await teardown(server, [host]);
    throw err;
  }
});
