'use strict';
// Regression test for a reported bug: "a game cannot have زودیاک پسر
// without having a زودیاک" — the role checklist used to let a host check
// زودیاک پسر's box on its own, leaving it in play with no زودیاک to ever
// succeed (a role whose entire point, per its own in-game description, is
// being زودیاک's designated heir). Fixed with enforceZodiacSonDependency in
// index.html's renderRoleChecklist(): the two roles are now linked in both
// directions right at the checkbox —
//   - checking زودیاک پسر while زودیاک isn't selected also selects زودیاک
//   - unchecking زودیاک while زودیاک پسر IS selected also deselects it
// — so the invalid combination can never actually be reached from the
// setup screen, and a toast explains why to the host either way. This
// scenario drives the checklist exactly like a host would and asserts both
// directions, plus that selecting them in the ALREADY-valid order (زودیاک
// first) never fires a spurious correction.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, text, selectRoleInPlay, deselectRoleInPlay, isRoleInPlay, teardown
} = require('../lib/device');

const ROLE_ZODIAC = 'زودیاک';
const ROLE_ZODIAC_SON = 'زودیاک پسر';

runScenario('10-zodiac-son-requires-zodiac', async (log) => {
  const server = await startServer();
  log.info('Spawned real server.js on ' + server.baseURL);
  const host = createDevice(server.baseURL, { label: 'host' });

  try {
    host.App.goLanding('host');

    log.step('Host checks زودیاک پسر WITHOUT ever having checked زودیاک...');
    log.assert(!isRoleInPlay(host, ROLE_ZODIAC), 'زودیاک starts out NOT selected (sanity check)');
    selectRoleInPlay(host, ROLE_ZODIAC_SON);

    log.assert(isRoleInPlay(host, ROLE_ZODIAC_SON), 'زودیاک پسر is now selected, as tapped');
    log.assert(isRoleInPlay(host, ROLE_ZODIAC),
      'زودیاک was AUTOMATICALLY selected too — the invalid combination never actually existed, even for a moment');
    const addedToast = (text(host, 'toast-host') || '').trim();
    log.info('toast: "' + addedToast + '"');
    log.assert(addedToast.length > 0 && addedToast.indexOf(ROLE_ZODIAC) !== -1,
      'a toast explained why زودیاک got auto-selected');

    log.step('Host now unchecks زودیاک while زودیاک پسر is still selected...');
    deselectRoleInPlay(host, ROLE_ZODIAC);

    log.assert(!isRoleInPlay(host, ROLE_ZODIAC), 'زودیاک is now deselected, as tapped');
    log.assert(!isRoleInPlay(host, ROLE_ZODIAC_SON),
      'زودیاک پسر was AUTOMATICALLY deselected too — an heir with no one to inherit from can\'t be left behind');
    const removedToast = (text(host, 'toast-host') || '').trim();
    log.info('toast: "' + removedToast + '"');
    log.assert(removedToast.length > 0 && removedToast !== addedToast,
      'a distinct toast explained why زودیاک پسر got auto-deselected');

    log.step('Selecting them in the ALREADY-valid order (زودیاک first, then زودیاک پسر) should need no correction...');
    selectRoleInPlay(host, ROLE_ZODIAC);
    selectRoleInPlay(host, ROLE_ZODIAC_SON);
    log.assert(isRoleInPlay(host, ROLE_ZODIAC) && isRoleInPlay(host, ROLE_ZODIAC_SON),
      'both end up selected, no auto-correction needed this time');

    log.step('Unchecking زودیاک پسر itself (leaving زودیاک alone in play) is completely normal and untouched...');
    deselectRoleInPlay(host, ROLE_ZODIAC_SON);
    log.assert(isRoleInPlay(host, ROLE_ZODIAC) && !isRoleInPlay(host, ROLE_ZODIAC_SON),
      'زودیاک stays selected on its own — the dependency only runs one direction (son needs father, not the reverse)');

    await teardown(server, [host]);
  } catch (err) {
    await teardown(server, [host]);
    throw err;
  }
});
