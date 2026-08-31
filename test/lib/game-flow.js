'use strict';
// Shared multi-device sequences every scenario needs (join the lobby, get
// through role assignment) so each scenario script can read as "the story
// of one game" instead of repeating this wiring. Everything here drives the
// REAL App.* entry points / real DOM inputs — see device.js for the
// low-level mechanics.
const {
  createDevice, activeScreenId, setValue, roomCode, connectedNamedCount, waitFor, roleInfo,
  checkVoteCandidate
} = require('./device');

// Host device is assumed already created by the scenario (so it can tweak
// App.stepPlayers/App.stepMafia before createLobby() if it wants a
// non-default headcount). This just drives everyone else through joining.
async function joinPlayers(baseURL, host, names, log) {
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

  await waitFor(() => connectedNamedCount(host) === names.length,
    { message: 'host lobby never showed all ' + names.length + ' players as connected' });
  log.pass('All ' + names.length + ' players connected and named in the lobby.');

  return { code, players };
}

// Assigns roles then begins the game (the two manual host taps every
// normally-hosted — non-God-Mode, non-No-God-Mode — game requires), waits
// for every player to actually receive their role card, and returns which
// players landed on Mafia (captured before beginGame() moves everyone off
// the role screen) so the scenario can script who should do what.
async function assignRolesAndBegin(host, players, log) {
  log.step('Host assigns roles...');
  host.App.assignRoles();
  const mafiaNames = [];
  for (const p of players) {
    await waitFor(() => activeScreenId(p) === 'screen-player-role',
      { message: p.label + ' never received a role' });
    const info = roleInfo(p);
    log.info(p.label + ' -> ' + (info.isMafia ? 'MAFIA' : 'villager') + ' ("' + info.title + '")');
    if (info.isMafia) mafiaNames.push(p.label);
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
  return { mafiaNames };
}

// Day 1 never has voting (Mafia haven't met yet) — the only way forward is
// App.continueToNight(), and Night 1 itself skips straight through every
// step except the "eyes closed" announcement (see runNightStep's day===1
// guard in index.html) — one manual continue and Night 1 is over.
async function playDay1AndSkipNight1(host, players, log) {
  log.step('Day 1: no voting is possible — host continues straight to Night 1.');
  host.App.continueToNight();
  await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed',
    { message: 'host never reached the Night 1 eyes-closed screen' });

  log.step('Night 1: host continues past "eyes closed" (Mafia\'s only introduction to each other)...');
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

module.exports = { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, castVotes };
