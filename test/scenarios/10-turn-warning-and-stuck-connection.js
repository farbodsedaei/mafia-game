'use strict';
// Feature test for a reported bug: "whenever we try to start the game,
// especially with more than 10 people, there is always at least one
// person who can't connect. so several times I end up recreating the
// room and reshare a link."
//
// Investigated (with the user, before touching code) and landed on: no
// TURN server is configured for this deployment, and WebRTC without one
// can only succeed via direct peer-to-peer hole-punching — which reliably
// fails for anyone on a restrictive network (cellular data, corporate/
// guest WiFi, carrier-grade NAT), independent of how many times you
// retry. That's a deployment/config fix (setting TURN_URL/TURN_USERNAME/
// TURN_CREDENTIAL), not something the app itself can route around. What
// IS fixable in the app: (1) make the missing-TURN gap visible to the
// host instead of a silent, undiagnosable "waiting for host" hang, and
// (2) give the host visibility into WHICH specific player is stuck and a
// way to nudge just them, instead of everyone having to guess and
// recreate the whole room.
//
// Part A: the setup screen's TURN warning banner — hidden by default
// until the /api/ice-config fetch actually resolves, shown only when the
// server genuinely reports no TURN configured, hidden when it does.
// Part B: a player whose connection never completes shows up in the
// lobby as "taking a while" (not just an indefinite "connecting…") past
// a threshold, with a Retry button the host can tap — which tears down
// and restarts JUST that player's negotiation (hostBeginConnectionTo),
// without touching anyone else or needing the room recreated. Simulates
// "never completes" deterministically by making that one player's own
// setRemoteDescription hang forever (a promise that never resolves) —
// the same shape a real no-response WebRTC negotiation takes — rather
// than relying on any real network failure.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const { createDevice, activeScreenId, $, text, setValue, waitFor, sleep, teardown, roomCode } = require('../lib/device');

runScenario('10-turn-warning-and-stuck-connection', async (log) => {
  log.banner('PART A — the setup screen warns when no TURN server is configured');
  {
    const serverNoTurn = await startServer();
    const hostNoTurn = createDevice(serverNoTurn.baseURL, { label: 'host-no-turn' });
    try {
      hostNoTurn.App.goLanding('host');
      const warning = () => $(hostNoTurn, 'turn-not-configured-warning');
      log.assert(warning().style.display === 'none',
        'starts hidden (optimistic) before the /api/ice-config fetch has actually resolved');
      await waitFor(() => warning().style.display !== 'none',
        { message: 'the warning never appeared even though no TURN server is configured' });
      log.pass('The warning appeared once the server genuinely confirmed no TURN is configured.');
      log.assert(!!text(hostNoTurn, 'turn-not-configured-warning'), 'the warning actually has real text, not an empty banner');

      await teardown(serverNoTurn, [hostNoTurn]);
    } catch (err) {
      await teardown(serverNoTurn, [hostNoTurn]);
      throw err;
    }
  }
  {
    const serverWithTurn = await startServer({ turn: { url: 'turn:example.invalid:3478', username: 'u', credential: 'c' } });
    const hostWithTurn = createDevice(serverWithTurn.baseURL, { label: 'host-with-turn' });
    try {
      hostWithTurn.App.goLanding('host');
      const warning = () => $(hostWithTurn, 'turn-not-configured-warning');
      // No positive event to wait on here (staying hidden), so just give
      // the fetch a real moment to resolve, then confirm it never showed.
      await sleep(400);
      log.assert(warning().style.display === 'none',
        'stays hidden the whole time when TURN genuinely IS configured');

      await teardown(serverWithTurn, [hostWithTurn]);
    } catch (err) {
      await teardown(serverWithTurn, [hostWithTurn]);
      throw err;
    }
  }

  log.banner('PART B — a stuck player shows up in the lobby, with a host-side retry');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let goodPlayer = null;
    let stuckPlayer = null;
    try {
      host.App.goLanding('host');
      host.App.createLobby();
      await waitFor(() => roomCode(host), { message: 'room code never appeared' });
      const code = roomCode(host);

      log.step('A normal player joins fine...');
      goodPlayer = createDevice(server.baseURL, { join: code, label: 'Good' });
      await waitFor(() => activeScreenId(goodPlayer) === 'screen-player-name', { message: 'Good never reached the name screen' });
      setValue(goodPlayer, 'input-player-name', 'Good');
      goodPlayer.App.playerSubmitName();

      log.step('A second player\'s negotiation is made to hang forever (never resolves setRemoteDescription — same shape a real stuck WebRTC handshake takes)...');
      stuckPlayer = createDevice(server.baseURL, { join: code, label: 'Stuck' });
      const RealPC = stuckPlayer.window.RTCPeerConnection;
      stuckPlayer.window.RTCPeerConnection = function (config) {
        const pc = new RealPC(config);
        pc.setRemoteDescription = () => new Promise(() => {}); // never resolves — the offer just sits there forever
        return pc;
      };
      // Data-channel-open (and everything after — the name screen
      // included) never happens for this one — they sit on
      // screen-player-connecting exactly like a real no-response
      // negotiation would. Nothing to submit; the host-side entry
      // already exists from 'player-hello' alone, well before any
      // WebRTC negotiation even starts.
      await sleep(300);
      log.assert(activeScreenId(stuckPlayer) === 'screen-player-connecting',
        'Stuck genuinely never gets past the connecting screen — the hang worked as intended');

      await waitFor(() => {
        const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot'));
        return rows.some((r) => r.classList.contains('connected') && r.querySelector('.name') && r.querySelector('.name').textContent === 'Good');
      }, { message: 'Good never showed up as connected in the lobby' });
      log.pass('Good is connected and showing correctly.');

      log.step('Faking the clock forward so Stuck\'s slot crosses the "taking a while" threshold, exactly like real time passing would...');
      const realDateNow = host.window.Date.now;
      host.window.Date.now = () => realDateNow() + 20000;
      await waitFor(() => {
        const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot'));
        // Only a genuinely STUCK (non-ready, past-threshold) row ever
        // renders a button at all — a ready row shows a checkmark instead,
        // and a plain "still connecting" row shows neither.
        return rows.some((r) => !!r.querySelector('button'));
      }, { timeout: 6000, message: 'Stuck\'s slot never flipped to "taking a while" with a Retry button' });
      log.pass('Stuck\'s slot now shows a distinct status and a Retry button — the host can actually SEE who\'s stuck.');

      log.step('Tapping the host-side Retry button for that slot (un-hanging the player first, so the retry can actually succeed)...');
      stuckPlayer.window.RTCPeerConnection = RealPC; // the retry creates a genuinely fresh pc — let THIS one behave normally
      const rows = Array.from($(host, 'slot-list').querySelectorAll('.slot'));
      const stuckRow = rows.find((r) => r.querySelector('button'));
      stuckRow.querySelector('button').click();
      host.window.Date.now = realDateNow; // restore — the fresh attempt needs a real, current connectingSince

      // No manual retry from Stuck's own side at all — the host's tap
      // alone pushed a fresh, unprompted offer straight to their existing
      // tab (see playerHandleSignal's unconditional 'offer' handling).
      await waitFor(() => activeScreenId(stuckPlayer) === 'screen-player-name',
        { timeout: 5000, message: 'Stuck never reached the name screen after the host-side retry' });
      log.pass('The host-side Retry button alone recovered the connection — no room recreation, no tab closing, nothing needed from Stuck at all.');
      setValue(stuckPlayer, 'input-player-name', 'Stuck');
      stuckPlayer.App.playerSubmitName();

      await waitFor(() => {
        const rows2 = Array.from($(host, 'slot-list').querySelectorAll('.slot'));
        return rows2.some((r) => r.classList.contains('connected') && r.querySelector('.name') && r.querySelector('.name').textContent === 'Stuck');
      }, { timeout: 5000, message: 'Stuck never showed up fully connected in the lobby' });
      log.pass('Stuck now shows up fully connected in the lobby, same as Good.');

      await teardown(server, [host, goodPlayer, stuckPlayer].filter(Boolean));
    } catch (err) {
      await teardown(server, [host, goodPlayer, stuckPlayer].filter(Boolean));
      throw err;
    }
  }
});
