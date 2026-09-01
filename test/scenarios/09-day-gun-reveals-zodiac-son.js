'use strict';
// Regression test for a reported bug: when the day-gun kills someone, the
// public announcement is supposed to reveal their team as Mafia, villager,
// or زودیاک — but زودیاک پسر (who is a normal, non-independent villager-team
// entry for as long as the main زودیاک is alive — see index.html's
// HARDCODED_ROLES and transferZodiacLegacy) used to fall through to the
// "civilian" wording instead of "زودیاک", because the old code keyed the
// reveal off entry.independent (only ever true for the CURRENT زودیاک, who
// is immune to the gun outright and can never actually reach this code
// path) rather than the role's actual identity. Fixed in resolveDayGunAction
// by checking roleName against ROLE_NAME_ZODIAC/ROLE_NAME_ZODIAC_SON
// instead. This scenario hands the gun to a bystander and has them shoot
// زودیاک پسر specifically (not the main زودیاک, which the gun can never
// kill at all — see resolveDayGunAction's own immunity guard) and asserts
// the announcement says زودیاک, everywhere it's shown.
//
// Mafia here is dealt as ماتادور + پدر خوانده specifically (not plain
// مافیا ساده) — a deliberate choice so this test also exercises Mafia's
// deterministic kill-decider (پدر خوانده always decides when alive — see
// startMafiaPhaseStep — no random pick needed) running alongside ماتادور's
// own independent block, both resolving the same night as تفنگدار's handoff.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, selectRoleInPlay, waitFor, teardown
} = require('../lib/device');
const {
  joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1, nightAction, dayGunDecision
} = require('../lib/game-flow');

const PLAYER_NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham', 'Farid', 'Golnar', 'Hana'];
const ROLE_ZODIAC = 'زودیاک';
const ROLE_ZODIAC_SON = 'زودیاک پسر';
const ROLE_GUNNER = 'تفنگدار';
const ROLE_GODFATHER = 'پدر خوانده';
const ROLE_MATADOR = 'ماتادور';

function byLabel(players, label) {
  return players.find((p) => p.label === label);
}

runScenario('09-day-gun-reveals-zodiac-son', async (log) => {
  const server = await startServer();
  const host = createDevice(server.baseURL, { label: 'host' });
  let players = [];

  try {
    log.step('Host configures an 8-player game — Mafia dealt as ماتادور + پدر خوانده, plus زودیاک, زودیاک پسر, and تفنگدار...');
    host.App.goLanding('host');
    host.App.stepPlayers(2); // 6 -> 8 (numMafia stays at its default of 2)
    host.App.stepInquiries(-1); // avoid the unrelated morning inquiry vote — see scenarios 07/08
    [ROLE_GODFATHER, ROLE_MATADOR, ROLE_ZODIAC, ROLE_ZODIAC_SON, ROLE_GUNNER]
      .forEach((roleName) => selectRoleInPlay(host, roleName));
    host.App.createLobby();

    ({ players } = await joinPlayers(server.baseURL, host, PLAYER_NAMES, log));
    const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
    const findByTitle = (title) => Object.keys(roles).find((label) => roles[label].title === title);
    const godfatherName = findByTitle(ROLE_GODFATHER);
    const matadorName = findByTitle(ROLE_MATADOR);
    const zodiacSonName = findByTitle(ROLE_ZODIAC_SON);
    const gunnerName = findByTitle(ROLE_GUNNER);
    log.assert(!!godfatherName, 'پدر خوانده was dealt');
    log.assert(!!matadorName, 'ماتادور was dealt');
    log.assert(mafiaNames.length === 2 && mafiaNames.includes(godfatherName) && mafiaNames.includes(matadorName),
      'both Mafia seats are exactly ماتادور and پدر خوانده (found ' + mafiaNames.join(', ') + ')');
    log.assert(!!findByTitle(ROLE_ZODIAC), 'the main زودیاک was dealt');
    log.assert(!!zodiacSonName, 'زودیاک پسر was dealt');
    log.assert(!!gunnerName, 'تفنگدار was dealt');
    const bystanderNames = PLAYER_NAMES.filter((n) =>
      !mafiaNames.includes(n) && n !== zodiacSonName && n !== gunnerName && n !== findByTitle(ROLE_ZODIAC));
    const [shooter, victim, bystander] = bystanderNames; // 3 plain villagers left
    log.info('پدر خوانده: ' + godfatherName + ' | ماتادور: ' + matadorName +
      ' | زودیاک پسر: ' + zodiacSonName + ' | تفنگدار: ' + gunnerName + ' | gun recipient/shooter: ' + shooter);

    await playDay1AndSkipNight1(host, players, log);

    // ==================== NIGHT 2 ====================
    log.banner('NIGHT 2');
    host.App.continueAfterEyesClosed();

    // پدر خوانده always makes Mafia's kill call when alive (no random pick
    // among the team the way plain مافیا ساده needs — see
    // startMafiaPhaseStep), so unlike the earlier scenarios there's no need
    // to guess who got the prompt.
    log.step(godfatherName + ' (پدر خوانده) makes Mafia\'s kill call, targeting ' + victim + ' — incidental to this test...');
    await nightAction(byLabel(players, godfatherName), log, victim);

    log.step(matadorName + ' (ماتادور) blocks ' + zodiacSonName + ' for the night — a harmless block, since زودیاک پسر has no ability of its own to lose...');
    await nightAction(byLabel(players, matadorName), log, zodiacSonName);

    const zodiac = byLabel(players, findByTitle(ROLE_ZODIAC));
    await nightAction(zodiac, log, null); // زودیاک skips — irrelevant to this test

    log.step(gunnerName + ' (تفنگدار) hands the gun to ' + shooter + '...');
    await nightAction(byLabel(players, gunnerName), log, shooter);

    await waitFor(() => activeScreenId(host) === 'screen-host-night-morning',
      { message: 'Night 2 never reached the morning-ready screen' });
    host.App.announceMorning();
    await waitFor(() => activeScreenId(host) === 'screen-host-night-result',
      { message: 'host never reached the Night 2 result screen' });
    host.App.proceedAfterNight();
    await waitFor(() => activeScreenId(host) === 'screen-host-day',
      { message: 'host never reached Day 3' });

    // ==================== DAY 3 — the actual test ====================
    log.banner('DAY 3');
    log.step(shooter + ' fires the gun at ' + zodiacSonName + ' (زودیاک پسر, NOT the immune main زودیاک)...');
    host.App.startVoting();
    await dayGunDecision(byLabel(players, shooter), log, zodiacSonName);

    await waitFor(() => activeScreenId(byLabel(players, zodiacSonName)) === 'screen-player-eliminated',
      { message: zodiacSonName + ' never saw their own elimination screen — the gun should be able to kill زودیاک پسر' });
    log.death(zodiacSonName, 'زودیاک', 'shot by ' + shooter + '\'s day-gun');

    const hostBanner = text(host, 'day-gun-death-banner-text') || '';
    log.info('Host announcement: "' + hostBanner + '"');
    log.assert(hostBanner.indexOf('زودیاک') !== -1,
      'the announcement correctly says زودیاک (got "' + hostBanner + '")');
    log.assert(hostBanner.indexOf('شهروند') === -1,
      'the announcement does NOT wrongly say "شهروند" (civilian) — this was the actual bug');

    const bystanderBanner = text(byLabel(players, bystander), 'day-gun-death-banner-text') || '';
    log.assert(bystanderBanner === hostBanner,
      'a bystander player device shows the identical announcement (got "' + bystanderBanner + '")');

    await teardown(server, [host, ...players]);
  } catch (err) {
    await teardown(server, [host, ...players]);
    throw err;
  }
});
