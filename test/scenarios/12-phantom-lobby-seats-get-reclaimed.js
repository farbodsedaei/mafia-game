'use strict';
// Feature test for a reported bug, found while investigating the earlier
// "at least one person can't connect" report (see scenario 10): "if
// someone had a browser on this app left open from the last game, or if
// they click on the game URL and before putting in their name they click
// another one, looks like the browser would keep a link open and reserved
// to the server which no one else can use, even if the original player
// closes the tab."
//
// Confirmed by reading the code, not just suspected: opening the join link
// alone — before ever typing a name — is enough to permanently reserve one
// of numPlayers' worth of capacity. The instant the server relays
// 'player-hello' for a brand-new connection, hostBeginConnectionTo creates
// a real entry in state.players (name: null) and starts a WebRTC
// negotiation, all before the player has typed anything. Nothing ever
// called state.players.delete anywhere in the file — closing the tab (or
// the connection just dying) only ever flipped entry.connected to false,
// never freed the seat. Worse, a reload or a second click before ever
// submitting a name burns ANOTHER seat rather than reusing the first (the
// client only recognizes "I already have a seat here" once a name was
// actually saved to its session — see startPlayerJoin/loadPlayerSession).
// Once enough real + abandoned attempts fill numPlayers, every further
// real joiner was silently, permanently turned away — hostBeginConnectionTo
// just returned early with no message to anyone, no lobby row, nothing —
// leaving them stuck on "Contacting host…" forever, indistinguishable from
// a genuine WebRTC/TURN failure.
//
// Fixed with three changes in index.html, all exercised below:
//   (1) expirePhantomSeats — a never-named seat auto-releases once it's
//       been sitting abandoned long enough (two different grace windows:
//       NEVER_CONNECTED_TIMEOUT_MS for one that never even finished
//       connecting, the much longer CONNECTED_UNNAMED_TIMEOUT_MS for one
//       that's fully connected but just never got named — see its own
//       comment for why those need to differ). Checked on the same 2s
//       lobby ticker that already watches for "stuck" rows.
//   (2) hostBeginConnectionTo's capacity-rejection branch now tells the
//       turned-away player outright (a 'room-full' signal, relayed the
//       same way an offer/candidate already is) instead of silently
//       hanging them — and toasts the host too, so they at least know it
//       happened even before they'd notice anything odd in the lobby.
//   (3) App.removeStuckPlayer — a host-visible "Remove this seat" button
//       (LOBBY_REMOVABLE_THRESHOLD_MS, deliberately shorter than either
//       automatic timeout above) lets the host manually free a seat they're
//       already confident is abandoned, rather than waiting out the more
//       conservative automatic window.
//
// Part A/B (one continuous story, one small room): a real player fills one
// seat, an abandoned tab (connects fine, never submits a name) fills
// another, and a genuinely new third player gets turned away with the
// 'room-full' message — even though only 2 of 3 seats are held by an
// actual person — then recovers on their own once the abandoned seat
// auto-expires and they tap Try Again.
// Part C (a fresh room): the host manually removes a stuck, never-named
// seat well before its automatic timeout would ever fire, and a new
// player takes the freed seat immediately.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, $, text, setValue, waitFor, sleep, teardown, roomCode } = require('../lib/device');

// Excludes the lobby's own "waiting for player" placeholder rows (padding
// the list up to numPlayers for every declared seat nobody's even attempted
// yet — see renderLobby's own `remaining` loop) — those always exist
// whenever state.players.size < numPlayers, including right after a
// phantom seat is released, so a plain "not .connected" filter can never
// reach 0 once even one seat has ever gone unfilled. This isolates rows
// that represent an ACTUAL state.players entry (real or phantom) still
// short of connected+named, which is what every check below actually
// means to ask about.
function nonReadySlotRows(host) {
  return Array.from($(host, 'slot-list').querySelectorAll('.slot')).filter((r) => {
    if (r.classList.contains('connected')) return false;
    const status = r.querySelector('.status');
    return !(status && status.textContent === 'منتظر پیوستن بازیکن با لینک…');
  });
}

runScenario('12-phantom-lobby-seats-get-reclaimed', async (log) => {
  log.banner('PART A/B — an abandoned tab blocks a real newcomer, then self-heals');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let ali = null, ghost = null, bob = null, cara = null;
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(3 - 6); // default 6 -> exactly 3 seats, so filling 3 is quick
      host.App.createLobby();
      await waitFor(() => roomCode(host), { message: 'room code never appeared' });
      const code = roomCode(host);

      log.step('Ali joins for real, names themselves — seat 1 of 3...');
      ali = createDevice(server.baseURL, { join: code, label: 'Ali' });
      await waitFor(() => activeScreenId(ali) === 'screen-player-name', { message: 'Ali never reached the name screen' });
      setValue(ali, 'input-player-name', 'Ali');
      ali.App.playerSubmitName();

      log.step('A second tab opens the SAME join link and connects fine, but the person never actually types a name (an abandoned tab, or one they clicked away from) — seat 2 of 3...');
      ghost = createDevice(server.baseURL, { join: code, label: 'Ghost' });
      await waitFor(() => activeScreenId(ghost) === 'screen-player-name', { message: 'Ghost never reached the name screen (never even connected)' });
      // Deliberately never calls playerSubmitName — this is the whole bug.

      log.step('Bob joins for real, names themselves — seat 3 of 3, the room is now nominally full...');
      bob = createDevice(server.baseURL, { join: code, label: 'Bob' });
      await waitFor(() => activeScreenId(bob) === 'screen-player-name', { message: 'Bob never reached the name screen' });
      setValue(bob, 'input-player-name', 'Bob');
      bob.App.playerSubmitName();
      await waitFor(() => {
        const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot.connected .name'));
        return rows.some((n) => n.textContent === 'Bob');
      }, { message: 'Bob never showed up fully connected in the lobby' });
      log.pass('Ali and Bob are both in — only 2 of the 3 seats actually have a real person behind them, though.');

      log.step('Cara — a genuinely new, real person — tries to join the same link...');
      cara = createDevice(server.baseURL, { join: code, label: 'Cara' });
      await waitFor(() => activeScreenId(cara) === 'screen-player-connecting', { message: 'Cara never reached the connecting screen' });
      // Devices default to the app's own default language (fa) unless a
      // device explicitly sets 'mafia-lang' in its own localStorage — same
      // as every other scenario in this suite, checking the real default
      // string rather than assuming English.
      await waitFor(() => text(cara, 'connecting-title') === 'اتاق پر است',
        { message: 'Cara was never told the room is full — she\'d have just hung forever with no explanation' });
      log.pass('Cara is told outright the room is full, instead of silently hanging forever.');
      log.assert(!!text(cara, 'connecting-hint'), 'the explanation has real text, not an empty hint');
      log.assert($(cara, 'connecting-retry-btn').style.display !== 'none',
        'her own Try Again button is already showing — no need to wait out the generic 18s stuck-timer for an explanation that would\'ve been misleading anyway');

      log.step('Faking the host\'s clock forward past the "connected but never named" grace window, exactly like real time passing would...');
      const realDateNow = host.window.Date.now;
      host.window.Date.now = () => realDateNow() + 4 * 60 * 1000; // > CONNECTED_UNNAMED_TIMEOUT_MS (3 min)
      await waitFor(() => nonReadySlotRows(host).length === 0,
        { timeout: 6000, message: 'Ghost\'s abandoned seat never auto-released' });
      host.window.Date.now = realDateNow; // restore before anything else reads the clock
      log.pass('Ghost\'s never-named seat released itself automatically — a seat is open again.');

      log.step('Cara taps Try Again, with no other change on her end...');
      // connecting-retry-btn is wired via an inline onclick="..." HTML
      // attribute, which jsdom's runScripts:'outside-only' (see device.js)
      // never compiles into a callable handler — unlike e.g. the host-side
      // lobby's Retry/Remove buttons, which are JS-property-assigned
      // (.onclick = ...) and click() fine. Calling the same App.* entry
      // point directly exercises the exact same logic a real tap would.
      cara.App.retryJoin();
      await waitFor(() => activeScreenId(cara) === 'screen-player-name',
        { timeout: 5000, message: 'Cara never got in even after the seat freed up' });
      log.pass('Cara got in on her own retry — no room recreation, nothing needed from Ali or Bob.');
      setValue(cara, 'input-player-name', 'Cara');
      cara.App.playerSubmitName();
      await waitFor(() => {
        const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot.connected .name'));
        return rows.some((n) => n.textContent === 'Cara');
      }, { message: 'Cara never showed up fully connected in the lobby' });
      log.pass('Cara now shows up fully connected too — all 3 seats genuinely filled by real people.');

      await teardown(server, [host, ali, ghost, bob, cara].filter(Boolean));
    } catch (err) {
      await teardown(server, [host, ali, ghost, bob, cara].filter(Boolean));
      throw err;
    }
  }

  log.banner('PART C — the host can manually remove an abandoned seat early, well before its automatic timeout');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let dara = null, ghost2 = null, eve = null;
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(3 - 6);
      host.App.createLobby();
      await waitFor(() => roomCode(host), { message: 'room code never appeared' });
      const code = roomCode(host);

      log.step('Dara joins for real, names herself — seat 1 of 3...');
      dara = createDevice(server.baseURL, { join: code, label: 'Dara' });
      await waitFor(() => activeScreenId(dara) === 'screen-player-name', { message: 'Dara never reached the name screen' });
      setValue(dara, 'input-player-name', 'Dara');
      dara.App.playerSubmitName();

      log.step('A second tab connects fine and then just... never types a name — seat 2 of 3, abandoned...');
      ghost2 = createDevice(server.baseURL, { join: code, label: 'Ghost2' });
      await waitFor(() => activeScreenId(ghost2) === 'screen-player-name', { message: 'Ghost2 never reached the name screen' });

      await sleep(300);
      log.assert(!Array.from($(host, 'slot-list').querySelectorAll('button')).length,
        'freshly connected — no Retry or Remove button yet, it hasn\'t been sitting long enough to look stuck at all');

      log.step('Faking the host\'s clock forward 60s — past the "remove is safe to offer" threshold, but nowhere near the 3-minute automatic release...');
      const realDateNow = host.window.Date.now;
      host.window.Date.now = () => realDateNow() + 60000;
      await waitFor(() => {
        const buttons = Array.from($(host, 'slot-list').querySelectorAll('button'));
        return buttons.some((b) => b.textContent === 'حذف این جایگاه');
      }, { timeout: 6000, message: 'the "Remove this seat" button never appeared for Ghost2\'s row' });
      log.pass('A "Remove this seat" button appeared — the host doesn\'t have to wait out the full automatic timeout.');
      log.assert(nonReadySlotRows(host).length === 1,
        'Ghost2\'s seat is still genuinely there at 60s — this is NOT the automatic timeout firing coincidentally (that one needs 3 whole minutes)');

      log.step('Host taps Remove on that row...');
      const removeBtn = Array.from($(host, 'slot-list').querySelectorAll('button')).find((b) => b.textContent === 'حذف این جایگاه');
      removeBtn.click();
      host.window.Date.now = realDateNow; // restore

      log.assert(nonReadySlotRows(host).length === 0,
        'Ghost2\'s row is gone the instant the host removed it — back to just Dara plus an open, unclaimed seat');

      log.step('Eve — a new, real player — joins and takes the freed seat...');
      eve = createDevice(server.baseURL, { join: code, label: 'Eve' });
      await waitFor(() => activeScreenId(eve) === 'screen-player-name',
        { timeout: 5000, message: 'Eve never got a seat even after the host freed one up' });
      setValue(eve, 'input-player-name', 'Eve');
      eve.App.playerSubmitName();
      await waitFor(() => {
        const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot.connected .name'));
        return rows.some((n) => n.textContent === 'Eve');
      }, { message: 'Eve never showed up fully connected in the lobby' });
      log.pass('Eve is in — the manually-removed seat was genuinely usable again, not just visually cleared.');

      await teardown(server, [host, dara, ghost2, eve].filter(Boolean));
    } catch (err) {
      await teardown(server, [host, dara, ghost2, eve].filter(Boolean));
      throw err;
    }
  }
});
