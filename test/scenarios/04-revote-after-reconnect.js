'use strict';
// Regression test for a reported bug: "during day voting if someone casts
// their vote and then disconnects or refreshes their browser, they're
// asked to vote again. If they vote again their new vote would also apply
// on top of the previous one."
//
// handlePlayerVote in index.html has always kept exactly one entry per
// voter (state.votesRound1/2 is a Map keyed by voterId, .set() overwrites),
// so a genuine re-submission from the SAME identity was never actually
// double-counted at the data layer — confirmed here via the automatic
// same-token reconnect a dropped connection triggers on its own. What WAS
// real: being resynced back onto a totally BLANK vote screen with no sign
// an earlier vote was on record — confusing on its own, and risky in a
// multi-select (accuse-several-people) UI, since blindly checking one more
// box on top of an unnoticed stale selection would genuinely, correctly
// count both. Fixed with a 'vote-already-submitted' follow-up message
// (resyncPlayer) that tells the reconnecting client what's already on
// record — surfaced as a plain-text notice (#vote-already-voted-hint),
// deliberately WITHOUT pre-checking any boxes, so resubmitting stays a
// clean replacement.
//
// (This used to also cover the reclaim-a-disconnected-seat-by-name path —
// that whole mechanism has since been removed entirely, see
// 05-no-seat-reclaim-by-name.js, so only the same-token path applies now.)
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $,
  waitFor, checkVoteCandidate, readVoteTally, dropConnection, sleep, teardown
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1 } = require('../lib/game-flow');
const { runScenario } = require('../lib/scenario');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid'];

function anyCandidateChecked(device) {
  return Array.from(device.document.querySelectorAll('#vote-candidate-list input[type=checkbox]')).some((i) => i.checked);
}

runScenario('04-revote-after-reconnect', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];
  try {
    host.App.goLanding('host');
    host.App.createLobby();
    ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));
    await assignRolesAndBegin(host, players, log);
    await playDay1AndSkipNight1(host, players, log);

    log.step('Opening Day 2 voting...');
    host.App.startVoting();
    for (const p of players) {
      await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
    }
    log.pass('Voting is open and every player is on the vote screen.');

    const [p1, p2, p3] = players;
    log.step(p1.label + ' votes for ' + p2.label + '...');
    checkVoteCandidate(p1, p2.label);
    p1.App.submitVote();
    await sleep(150);
    log.tally(readVoteTally(host), 'after first vote');

    log.step(p1.label + '\'s connection drops (simulated WiFi blip) and auto-reconnects...');
    dropConnection(p1);
    await waitFor(() => activeScreenId(p1) === 'screen-player-vote',
      { timeout: 8000, message: p1.label + ' never came back to the vote screen after reconnecting' });
    log.pass(p1.label + ' is back on the vote screen on their own, no manual rejoin needed.');

    const hint = $(p1, 'vote-already-voted-hint');
    log.assert(hint.style.display !== 'none', 'the "already voted" notice is showing');
    log.assert(hint.textContent.indexOf(p2.label) !== -1, 'the notice names who they already voted for (' + p2.label + ')');
    log.assert(!anyCandidateChecked(p1), 'no candidate is pre-checked — resubmitting stays a clean replacement, not a stack-on-top');

    log.step(p1.label + ' changes their mind and votes for ' + p3.label + ' instead...');
    checkVoteCandidate(p1, p3.label);
    p1.App.submitVote();
    await sleep(150);

    const tally = readVoteTally(host);
    log.tally(tally, 'final');
    const p2Row = tally.find((r) => r.name === p2.label);
    const p3Row = tally.find((r) => r.name === p3.label);
    log.assert((p2Row ? p2Row.count : 0) === 0, p2.label + ' no longer has any votes — the old vote was replaced, not kept alongside the new one');
    log.assert((p3Row ? p3Row.count : 0) === 1, p3.label + ' has exactly the one (new) vote');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
