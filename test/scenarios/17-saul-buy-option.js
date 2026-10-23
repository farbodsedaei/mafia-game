'use strict';
// Regression coverage for پدر خوانده's new Shoot/Buy either-or (ساول گودمن's
// recruit mechanic, restructured into its own top-level choice instead of a
// checkbox alongside the shoot candidate list):
//
//   - Before Mafia has lost anyone, the Shoot/Buy choice isn't even offered
//     yet — a completely ordinary kill still works exactly as it always
//     has, and ساول گودمن never gets any prompt at all that night.
//   - Once Mafia loses a member, the choice appears (Shoot still the
//     default). Choosing Buy: پدر خوانده's own shoot candidate list
//     disappears, he submits with no target, EVERY alive player (including
//     a plain civilian with no stake in it) gets the public "Mafia tried to
//     buy someone instead of shooting" banner with no name revealed, and
//     ساول گودمن then gets his OWN separate prompt to actually pick who —
//     a successful recruit is a team switch (the target survives, now
//     reading as Mafia), not a kill.
//   - With پدر خوانده gone entirely, ساول گودمن himself steps up as the
//     night's kill/buy decider (replacing the old random-fallback pick).
//     Choosing Buy now means two SEQUENTIAL prompts to the same person —
//     the choice, then his own follow-up recruit-target pick — not a
//     stall. Targeting someone who's already Mafia (not a plain villager)
//     fails the recruit quietly: no new team switch, and still no shot.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, $, text, selectRoleInPlay, roleInfo,
  chooseBuyInsteadOfShoot, isMafiaBuyChoiceVisible, isShootCandidateListVisible,
  waitFor, sleep, teardown
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, nightAction,
  fullVoteRound1, fullVoteFinal
} = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid', 'Gina', 'Hana', 'Iman', 'Jina'];
const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_SAUL = 'ساول گودمن';
const ROLE_PLAIN_MAFIA = 'مافیا ساده';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}
function aliveOf(players) {
  return players.filter((p) => activeScreenId(p) !== 'screen-player-eliminated');
}

// Abstain-everyone Day round — nobody's actually on trial here, every death
// in this scenario comes from either a night action or a dedicated
// eliminateByVote call below. Same shape as 16-slaughter-and-lecter's own
// local helper.
async function abstainDayRound(host, players, log) {
  const alive = aliveOf(players);
  for (const p of alive) await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
  for (const p of alive) p.App.submitVote();
  await sleep(150);
  host.App.closeVoting();
  await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'abstained day round never reached its result' });
  host.App.dismissAckBanner();
  for (const p of alive) p.App.dismissAckBanner();
  host.App.proceedAfterResult();
}

// Full-participation day vote that actually eliminates `target` — round 1
// then straight into the final round, same shape every other scenario here
// uses (see e.g. 03-eighteen-player-god-mode's own fullVoteRound1/Final
// calls). No God-Mode host-self seat in this scenario, so hostSelfName is
// always null.
async function eliminateByVote(host, players, target, log) {
  const alive = aliveOf(players);
  await fullVoteRound1(host, alive, null, target, log);
  await fullVoteFinal(host, alive, null, target, log);
  await waitFor(() => activeScreenId(host) === 'screen-host-result', { message: 'vote against ' + target + ' never reached a result' });
  await waitFor(() => activeScreenId(byLabel(players, target)) === 'screen-player-eliminated', { message: target + ' was never actually voted out' });
  host.App.dismissAckBanner();
  aliveOf(players).forEach((p) => p.App.dismissAckBanner());
  host.App.proceedAfterResult();
}

runScenario('17-saul-buy-option', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];
  try {
    host.App.goLanding('host');
    host.App.stepPlayers(4); // default numPlayers (6) -> 10 — enough village headroom that a recruit (a team switch, not a kill) can't flip checkWinner mid-scenario
    host.App.stepMafia(1);   // default numMafia (2) -> 3: پدر خوانده + ساول گودمن + one throwaway plain مافیا ساده
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote once real deaths start
    [ROLE_GODFATHER, ROLE_SAUL].forEach((r) => selectRoleInPlay(host, r));
    host.App.createLobby();
    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { roles, mafiaNames } = await assignRolesAndBegin(host, players, log);

    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const godfatherName = findByTitle(ROLE_GODFATHER);
    const saulName = findByTitle(ROLE_SAUL);
    const plainMafiaName = mafiaNames.find((n) => n !== godfatherName && n !== saulName);
    log.assert(godfatherName && saulName && plainMafiaName,
      'all 3 Mafia seats were dealt as expected (' + JSON.stringify({ godfatherName, saulName, plainMafiaName }) + ')');
    const civilians = PLAYER_NAMES.filter((n) => !mafiaNames.includes(n));
    log.assert(civilians.length >= 3, 'at least 3 civilians available (' + civilians.join(', ') + ')');
    const [civX, civY, civZ] = civilians;
    log.info('پدر خوانده=' + godfatherName + ' ساول گودمن=' + saulName + ' throwaway مافیا ساده=' + plainMafiaName);
    log.info('civilians in use: X (Night 2 shot target)=' + civX + ' Y (recruit target)=' + civY + ' Z (public-banner bystander)=' + civZ);

    const godfather = byLabel(players, godfatherName);
    const saul = byLabel(players, saulName);

    await playDay1AndSkipNight1(host, players, log);

    log.banner('NIGHT 2 — پدر خوانده explicitly stays on Shoot (the default) — Mafia hasn\'t lost anyone yet, so Buy isn\'t even offered');
    host.App.startVoting();
    await abstainDayRound(host, players, log);
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 2 eyes-closed' });
    host.App.continueAfterEyesClosed();
    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-action', { message: 'پدر خوانده never got the kill prompt (N2)' });
    log.assert(!isMafiaBuyChoiceVisible(godfather), 'no Shoot/Buy choice is rendered at all yet — canRecruit is false');
    await nightAction(godfather, log, civX);
    await sleep(150);
    log.assert(activeScreenId(saul) !== 'screen-player-night-action', 'ساول گودمن never got any prompt tonight — a plain shot never involves him');

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 2 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 2 result' });
    await waitFor(() => activeScreenId(byLabel(players, civX)) === 'screen-player-eliminated', { message: civX + ' never actually died to the plain shot' });
    log.assert(true, civX + ' died to a completely ordinary kill');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 3' });

    log.banner('DAY 3 — eliminate the throwaway plain مافیا ساده, unlocking the Buy option');
    host.App.startVoting();
    await eliminateByVote(host, players, plainMafiaName, log);
    log.pass(plainMafiaName + ' was voted out — Mafia has now lost a member');
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 3' });

    log.banner('NIGHT 3 — پدر خوانده chooses BUY instead of shooting');
    host.App.continueAfterEyesClosed();
    await waitFor(() => activeScreenId(godfather) === 'screen-player-night-action', { message: 'پدر خوانده never got the kill prompt (N3)' });
    log.assert(isMafiaBuyChoiceVisible(godfather), 'the Shoot/Buy choice is now offered — Mafia has lost a member');
    log.assert(isShootCandidateListVisible(godfather), 'the shoot candidate list is still showing by default (Shoot pre-selected)');
    await nightAction(godfather, log, null, { chooseBuy: true });
    await sleep(150);
    log.assert(!isShootCandidateListVisible(godfather), 'پدر خوانده\'s own shoot candidate list disappeared the instant Buy was chosen');

    const bystander = byLabel(players, civZ);
    await waitFor(() => $(bystander, 'ack-banner') && $(bystander, 'ack-banner').style.display === 'flex',
      { message: 'bystander civilian ' + civZ + ' never received the public "Mafia tried to buy" banner' });
    const bannerText = text(bystander, 'ack-banner-text') || '';
    log.info('  banner text seen by ' + civZ + ' (a plain civilian with no stake in this): "' + bannerText + '"');
    log.assert(bannerText.length > 0 && bannerText.indexOf(civY) === -1 && bannerText.indexOf(godfatherName) === -1,
      'every alive player — even an uninvolved civilian — is told Mafia tried to buy, with no name revealed');
    bystander.App.dismissAckBanner();

    await waitFor(() => activeScreenId(saul) === 'screen-player-night-action', { message: 'ساول گودمن never got his own separate recruit-target prompt' });
    await nightAction(saul, log, civY);

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 3 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 3 result' });
    await sleep(150);
    const civYDevice = byLabel(players, civY);
    log.assert(activeScreenId(civYDevice) !== 'screen-player-eliminated', civY + ' is still ALIVE — a successful recruit is a team switch, not a kill');
    log.assert(roleInfo(civYDevice).isMafia, civY + ' now reads as MAFIA on their own role screen — the recruit actually succeeded');
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day', { message: 'never reached Day 4' });

    log.banner('DAY 4 — eliminate پدر خوانده himself, leaving no پدر خوانده at all');
    host.App.startVoting();
    await eliminateByVote(host, players, godfatherName, log);
    log.pass(godfatherName + ' was voted out');
    await waitFor(() => activeScreenId(host) === 'screen-host-night-eyes-closed', { message: 'never reached Night 4' });

    log.banner('NIGHT 4 — no پدر خوانده left: ساول گودمن himself gets the Shoot/Buy choice; buying an already-Mafia target fails quietly');
    host.App.continueAfterEyesClosed();
    await waitFor(() => activeScreenId(saul) === 'screen-player-night-action', { message: 'ساول گودمن never got the kill-decider prompt with no پدر خوانده left' });
    log.assert(isMafiaBuyChoiceVisible(saul), 'ساول گودمن himself now sees the Shoot/Buy choice — he\'s stepped into the decider role');
    chooseBuyInsteadOfShoot(saul);
    await waitFor(() => activeScreenId(saul) === 'screen-player-night-action', { message: 'ساول گودمن never got his OWN sequential follow-up recruit-target prompt' });
    log.assert(true, 'ساول گودمن correctly gets a SECOND, sequential prompt to pick who to buy — not stuck after his own choice submission');
    await nightAction(saul, log, civY); // civY is already Mafia now — this attempt should fail quietly

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning', { message: 'never reached Night 4 morning-ready' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result', { message: 'never reached Night 4 result' });
    await sleep(150);
    log.assert(activeScreenId(byLabel(players, civZ)) !== 'screen-player-eliminated', civZ + ' is unaffected — no shot happened this night either, buy or no buy');
    log.info('Night 4 resolved cleanly — a recruit attempt on an already-Mafia target failed quietly, with no shot and no stall.');
    host.App.proceedAfterNight();

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
