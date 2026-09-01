'use strict';
// Shared multi-device sequences every scenario needs (join the lobby, get
// through role assignment, play out a day/night) so each scenario script
// can read as "the story of one game" instead of repeating this wiring.
// Everything here drives the REAL App.* entry points / real DOM inputs —
// see device.js for the low-level mechanics.
const {
  createDevice, activeScreenId, setValue, roomCode, connectedNamedCount, waitFor, roleInfo,
  checkVoteCandidate, readVoteTally, pickNightTarget, pickDayGunTarget, isGunDecisionVisible,
  setRecruitCheckbox, isHostSelfActionVisible, isHostSelfGunActionVisible, pickHostSelfCandidate,
  setHostSelfRecruitCheckbox, hostSelfRoleInfo
} = require('./device');

// Host device is assumed already created by the scenario (so it can tweak
// App.stepPlayers/App.stepMafia before createLobby() if it wants a
// non-default headcount). This just drives everyone else through joining.
// expectedTotal defaults to names.length, but a God Mode game needs it set
// to names.length + 1 — the host's own God-Mode seat (see App.createLobby)
// is already counted as "connected" from the moment the lobby is created,
// before any of these real players even join.
async function joinPlayers(baseURL, host, names, log, expectedTotal) {
  expectedTotal = expectedTotal || names.length;
  log.step('Waiting for the room code to be issued...');
  const code = await waitFor(() => roomCode(host), { message: 'room code never appeared on the host screen' });
  log.info('Room code: ' + code);

  const players = names.map((name) => createDevice(baseURL, { join: code, label: name }));

  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-name',
      { message: p.label + ' never reached the name-entry screen' });
    setValue(p, 'input-player-name', p.label);
    p.App.playerSubmitName();
    log.info(p.label + ' joined and submitted their name.');
  }

  await waitFor(() => connectedNamedCount(host) === expectedTotal,
    { message: 'host lobby never showed all ' + expectedTotal + ' players as connected' });
  log.pass('All ' + expectedTotal + ' players connected and named in the lobby' +
    (expectedTotal !== names.length ? ' (including the God-Mode host-self seat)' : '') + '.');

  return { code, players };
}

// Assigns roles then begins the game (the two manual host taps every
// normally-hosted — non-God-Mode, non-No-God-Mode — game requires), waits
// for every player to actually receive their role card, and returns a
// {label -> {isMafia, title}} map (captured before beginGame() moves
// everyone off the role screen) plus the flat list of Mafia names, so the
// scenario can script who should do what and narrate roles by name later.
// Pass hostSelfName for a God Mode game — role delivery to the host-self
// seat is synchronous (see hostSelfRoleInfo's own comment), so it's folded
// into the same map/list via a quick "My Role" peek, no extra waiting.
async function assignRolesAndBegin(host, players, log, hostSelfName) {
  log.step('Host assigns roles...');
  host.App.assignRoles();
  const roles = {};
  const mafiaNames = [];
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-role',
      { message: p.label + ' never received a role' });
    const info = roleInfo(p);
    roles[p.label] = { isMafia: info.isMafia, title: info.title };
    log.info(p.label + ' -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
    if (info.isMafia) mafiaNames.push(p.label);
  }
  if (hostSelfName) {
    const info = hostSelfRoleInfo(host);
    roles[hostSelfName] = { isMafia: info.isMafia, title: info.title };
    log.info(hostSelfName + ' (host-self) -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
    if (info.isMafia) mafiaNames.push(hostSelfName);
  }
  log.pass('Every player received a role card.');

  log.step('Host begins the game...');
  host.App.beginGame();
  await waitFor(() => activeScreenId(host) === 'screen-host-day',
    { message: 'host never reached the Day 1 screen after beginGame()' });
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-day',
      { message: p.label + ' never reached the Day 1 screen' });
  }
  log.pass('Game began — everyone is on Day 1.');
  return { mafiaNames, roles };
}

// Day 1 never has voting (Mafia haven't met yet) — the only way forward is
// App.continueToNight(), and Night 1 itself skips straight through every
// step except the "eyes closed" announcement (see runNightStep's day===1
// guard in index.html) — one manual continue and Night 1 is over.
async function playDay1AndSkipNight1(host, players, log) {
  log.banner('DAY 1');
  log.step('No voting is possible yet (Mafia haven\'t met each other) — host continues straight to Night 1.');
  host.App.continueToNight();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
    { message: 'host never reached the Night 1 eyes-closed screen' });

  log.banner('NIGHT 1');
  log.step('Host continues past "eyes closed" (Mafia\'s only introduction to each other)...');
  host.App.continueAfterEyesClosed();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
    { message: 'Night 1 did not skip straight to the morning-ready screen' });

  log.step('Announcing morning (Night 1 has nothing to resolve)...');
  host.App.announceMorning();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
    { message: 'host never reached the Night 1 result screen' });

  host.App.proceedAfterNight();
  await waitFor(() => activeScreenId(host) === 'screen-host-day',
    { message: 'host never reached Day 2 after Night 1' });
  for (const p of players.filter((pl) => !pl.__eliminated)) {
    await waitFor(() => activeScreenId(p) === 'screen-player-day',
      { message: p.label + ' never reached Day 2' });
  }
  log.pass('Night 1 resolved with nothing to report — Day 2 has begun.');
}

// Waits for every still-in-the-round voter to land on the vote screen, then
// submits each one's ballot: choicesByLabel[voter.label] is an array of
// target player names to vote for (an empty array, or an omitted entry,
// means abstain — same as a real player submitting with nothing checked).
async function castVotes(voters, choicesByLabel, log, roundLabel) {
  for (const p of voters) {
    await waitFor(() => activeScreenId(p) === 'screen-player-vote',
      { message: p.label + ' never reached the ' + roundLabel + ' vote screen' });
  }
  for (const p of voters) {
    const targets = (choicesByLabel && choicesByLabel[p.label]) || [];
    targets.forEach((name) => checkVoteCandidate(p, name));
    p.App.submitVote();
    log.info(p.label + ' (' + roundLabel + ') voted for: ' + (targets.length ? targets.join(', ') : '(abstain)'));
  }
}

// Logs the host's REAL, currently-rendered vote tally (see
// device.js#readVoteTally) — call this once the round has visibly closed
// (the host has moved off the voting screen), so every vote has definitely
// been counted. Sorted highest-first, matching how the host's own tally UI
// displays it.
function logTally(host, log, roundLabel) {
  const rows = readVoteTally(host).sort((a, b) => b.count - a.count);
  log.tally(rows, roundLabel);
  return rows;
}

// Every night-acting role (Mafia, زودیاک, and each of the civilian-phase
// roles — دکتر/کاراگاه/حرفه‌ای/کنستانتین/تفنگدار/اوشن) renders through the
// exact same generic 'screen-player-night-action' + #night-action-candidate-list
// screen regardless of which role it actually is (see renderNightActionScreen
// in index.html) — so one helper drives all of them. Pass a target name to
// act, or omit it to skip (a real, always-available choice for every one of
// these roles). opts.recruit checks the "recruit instead of shoot" box that
// only appears on the Mafia kill-decider's own prompt once ساول گودمن is
// alive and Mafia has already lost someone (see setRecruitCheckbox).
async function nightAction(device, log, target, opts) {
  await waitFor(() => activeScreenId(device) === 'screen-player-night-action',
    { message: device.label + ' never got their night-action prompt' });
  if (opts && opts.recruit) setRecruitCheckbox(device, true);
  if (target) {
    pickNightTarget(device, target);
    device.App.submitNightAction();
  } else {
    device.App.skipNightAction();
  }
}

// Real player's morning inquiry vote — a direct 'yes'/'no' button tap, no
// candidate list involved.
async function inquiryVote(device, log, choice) {
  await waitFor(() => activeScreenId(device) === 'screen-player-inquiry-vote',
    { message: device.label + ' never got the inquiry-vote prompt' });
  device.App.submitInquiryVote(choice);
}

// ---------------- God Mode: host-self action driving ----------------
// Mirrors nightAction/dayGunDecision/inquiryVote above, but for the host's
// own in-process seat — see device.js's host-self helpers for why no
// message-arrival waiting is actually needed (synchronous delivery), and
// isHostSelfActionVisible/isHostSelfGunActionVisible for what's polled
// instead of a screen id (the host-admin screen underneath never changes
// for any of these).
async function hostSelfVote(host, log, targets) {
  await waitFor(() => isHostSelfActionVisible(host), { message: 'host-self never got a vote prompt' });
  (targets || []).forEach((name) => pickHostSelfCandidate(host, 'host-self-card-body', name));
  host.App.hostSelfSubmitVote();
}
async function hostSelfNightAction(host, log, target, opts) {
  await waitFor(() => isHostSelfActionVisible(host), { message: 'host-self never got a night-action prompt' });
  if (opts && opts.recruit) setHostSelfRecruitCheckbox(host, true);
  if (target) {
    pickHostSelfCandidate(host, 'host-self-card-body', target);
    host.App.hostSelfSubmitNightAction();
  } else {
    host.App.hostSelfSkipNightAction();
  }
}
async function hostSelfInquiryVote(host, log, choice) {
  await waitFor(() => isHostSelfActionVisible(host), { message: 'host-self never got an inquiry-vote prompt' });
  host.App.hostSelfSubmitInquiryVote(choice);
}
async function hostSelfDayGunDecision(host, log, target) {
  await waitFor(() => isHostSelfGunActionVisible(host), { message: 'host-self never got the day-gun decision prompt' });
  if (target) {
    pickHostSelfCandidate(host, 'host-self-gun-body', target);
    host.App.hostSelfSubmitDayGunAction();
  } else {
    host.App.hostSelfSkipDayGunAction();
  }
}

// ---------------- God Mode / No God Mode: auto-paced flow ----------------
// state.godMode (and state.noGodMode) make autoPacingOn() true, which
// changes the game's OWN pacing in exactly three places (grep
// "autoPacingOn()" in index.html to confirm there are no others):
//   - maybeAutoStartGame(): the instant every declared seat has a name,
//     deals roles and begins the game itself — no manual
//     App.assignRoles()/App.beginGame() needed (calling them anyway is
//     harmless — both are idempotent-guarded — but pointless to wait on;
//     this fires after two chained ~8s reveal pauses in real time, so wait
//     generously rather than calling it).
//   - goToDayScreen(): for any day > 1, calls App.startVoting() itself the
//     moment the day screen would otherwise show — there is no stable
//     screen-host-day to observe first.
//   - broadcastDefensePhase(): calls App.startFinalVote() itself once
//     round 1 closes — no manual call needed there either.
// Every OTHER transition (continueToNight, continueAfterEyesClosed,
// announceMorning, proceedAfterNight, proceedAfterResult,
// continueAfterInquiry, continueAfterOceanTalk, forceContinueNight) is only
// ever armed as a real (multi-second-to-multi-minute) timer now instead of
// a no-op — calling these manually and promptly, exactly like a normal
// non-auto-paced game, still works and is what these helpers do; the real
// timer simply never gets a chance to fire first.

// Waits out the natural auto-start instead of calling
// App.assignRoles()/beginGame() directly. Same return shape as
// assignRolesAndBegin.
async function autoAssignRolesAndBegin(host, players, log, hostSelfName) {
  log.step('Waiting for auto-pacing to deal roles and begin the game on its own...');
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-role',
      { timeout: 20000, message: p.label + ' never received a role' });
  }
  const roles = {};
  const mafiaNames = [];
  for (const p of players) {
    const info = roleInfo(p);
    roles[p.label] = { isMafia: info.isMafia, title: info.title };
    log.info(p.label + ' -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
    if (info.isMafia) mafiaNames.push(p.label);
  }
  if (hostSelfName) {
    const info = hostSelfRoleInfo(host);
    roles[hostSelfName] = { isMafia: info.isMafia, title: info.title };
    log.info(hostSelfName + ' (host-self) -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
    if (info.isMafia) mafiaNames.push(hostSelfName);
  }
  log.pass('Every player received a role card (auto-assigned).');

  await waitFor(() => activeScreenId(host) === 'screen-host-day',
    { timeout: 20000, message: 'host never auto-began the game' });
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-day',
      { timeout: 5000, message: p.label + ' never reached Day 1 after auto-begin' });
  }
  log.pass('Game auto-began — everyone is on Day 1.');
  return { mafiaNames, roles };
}

// Same shape as playDay1AndSkipNight1, but for an autoPacingOn() game: Day 2
// auto-starts its own voting the instant it's reached (goToDayScreen), so
// there's no stable screen-host-day to wait for at the end — wait for the
// Day 2 vote screen itself instead.
async function playDay1AndSkipNight1AutoPaced(host, players, log) {
  log.banner('DAY 1');
  log.step('No voting is possible yet (Mafia haven\'t met each other) — host continues straight to Night 1.');
  host.App.continueToNight();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
    { message: 'host never reached the Night 1 eyes-closed screen' });

  log.banner('NIGHT 1');
  log.step('Host continues past "eyes closed" (Mafia\'s only introduction to each other)...');
  host.App.continueAfterEyesClosed();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
    { message: 'Night 1 did not skip straight to the morning-ready screen' });

  log.step('Announcing morning (Night 1 has nothing to resolve)...');
  host.App.announceMorning();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
    { message: 'host never reached the Night 1 result screen' });

  host.App.proceedAfterNight();
  await waitFor(() => activeScreenId(host) === 'screen-host-voting',
    { message: 'host never auto-started Day 2\'s voting' });
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-vote',
      { message: p.label + ' never got the Day 2 vote screen' });
  }
  log.pass('Night 1 resolved with nothing to report — Day 2\'s voting has auto-started.');
}

// ---------------- Full-participation day votes ----------------
// Drives EVERY currently-alive identity (every real player device in
// `players`, plus the God-Mode host-self seat if hostSelfName is given) to
// vote for the same `target` — round 1 sends the vote screen to everyone
// including the eventual target (who submits an empty ballot, same as a
// real "I abstain"), matching eligibleVoterIdsForRound(1) in index.html;
// the final round excludes the sole defendant entirely, matching
// eligibleVoterIdsForRound(2). Full participation is what makes both
// rounds auto-close on their own (maybeAutoCloseVoting) with no need for
// the host to force it.
async function fullVoteRound1(host, players, hostSelfName, target, log) {
  const choices = {};
  players.forEach((p) => { if (p.label !== target) choices[p.label] = [target]; });
  await castVotes(players, choices, log, 'round 1');
  if (hostSelfName) await hostSelfVote(host, log, hostSelfName === target ? [] : [target]);
}
async function fullVoteFinal(host, players, hostSelfName, target, log) {
  const voters = players.filter((p) => p.label !== target);
  const choices = {};
  voters.forEach((p) => { choices[p.label] = [target]; });
  await castVotes(voters, choices, log, 'final');
  if (hostSelfName && hostSelfName !== target) await hostSelfVote(host, log, [target]);
}

// تفنگدار's handoff recipient deciding whether to fire, the day after —
// runs alongside that day's vote (see App.startVoting in index.html), so
// this waits on the gun-decision section specifically rather than any one
// screen id.
async function dayGunDecision(device, log, target) {
  await waitFor(() => isGunDecisionVisible(device),
    { message: device.label + ' never got the day-gun decision prompt' });
  if (target) {
    pickDayGunTarget(device, target);
    device.App.submitDayGunAction();
  } else {
    device.App.skipDayGunAction();
  }
}

module.exports = {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes, logTally,
  nightAction, dayGunDecision, inquiryVote,
  hostSelfVote, hostSelfNightAction, hostSelfInquiryVote, hostSelfDayGunDecision,
  fullVoteRound1, fullVoteFinal,
  autoAssignRolesAndBegin, playDay1AndSkipNight1AutoPaced
};
