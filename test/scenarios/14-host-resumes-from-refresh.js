'use strict';
// Feature test for a reported problem: "in case host's browser gets
// refreshed or disconnected, the room gets lost." The entire game only
// ever lived in the host's own browser tab's JS memory — a refresh wiped
// every role, vote, and night decision outright, even with every player
// still sitting there connected and waiting; the room itself was also
// unconditionally deleted 90s after just the host's own socket dropped,
// regardless of how many players were still around.
//
// Fixed with two independent pieces, both exercised here:
//   1. server.js: a room now survives as long as ANYONE (host or any
//      player) is still connected, only starting a teardown countdown
//      (ROOM_EMPTY_GRACE_MS, 10 real minutes — shrunk here via
//      ROOM_EMPTY_GRACE_MS_OVERRIDE) once it's genuinely empty, instead of
//      dying a fixed 90s after just the host specifically disconnected.
//      Players still connected get a 'host-disconnected' notice (and
//      'host-reconnected' once the host's back) instead of silently
//      hanging with no explanation.
//   2. index.html: the host's own browser periodically snapshots the
//      WHOLE authoritative game state to its own localStorage
//      (saveHostSnapshot) while a room is active, and auto-resumes from it
//      on the next page load (resumeAsHost) — reconnecting to the server
//      with the same hostToken and rebuilding every player's WebRTC
//      connection exactly like the existing same-tab reconnect path
//      already did, restoring the host's own screen via
//      resumeHostScreenForPhase. Deliberately local-only (never sent
//      anywhere) and same-device-only — see index.html's own comment on
//      why a different device can't pick up hosting this way.
//
// Part A drives a real game to Day 2, lets a real snapshot save (via the
// test-only 'mafia-snapshot-interval-ms-override' speed hook), then
// simulates "the host's browser refreshes" the only way that's actually
// meaningful to test: a brand-new device, with the OLD device's exact
// localStorage content seeded into it (see createDevice's
// seedLocalStorage), and the OLD device gone — exactly what a real reload
// looks like from the outside (same origin's storage survives, nothing
// else does). Confirms the resumed host lands back on the right screen,
// every player's connection gets rebuilt with no action needed on their
// end, and the game is genuinely still playable afterward (a real vote,
// all the way to a result) — not just superficially "connected."
// Part B confirms the room itself outlives the host being gone as long as
// a player is still there (the server-side half), and that the player
// sees an honest status instead of a silent hang.
const { runScenario } = require('../lib/scenario');
const { startServer } = require('../lib/server-runner');
const {
  createDevice, activeScreenId, text, waitFor, sleep, teardown, roomCode, killWebSocket, blockFutureReconnects, lastMockConnection
} = require('../lib/device');
const { joinPlayers, assignRolesAndBegin, playDay1AndSkipNight1 } = require('../lib/game-flow');

const NAMES = ['Amir', 'Bita', 'Cyrus', 'Dara', 'Elham'];

runScenario('14-host-resumes-from-refresh', async (log) => {
  log.banner('PART A — the host device refreshes mid-game and resumes exactly where it left off');
  {
    const server = await startServer();
    const host = createDevice(server.baseURL, { label: 'host' });
    let players = [];
    let resumedHost = null;
    try {
      host.App.goLanding('host');
      host.App.stepPlayers(NAMES.length - 6);
      // Speed up the periodic snapshot far below its real 4s default so
      // this test doesn't need a multi-second real wait.
      host.window.localStorage.setItem('mafia-snapshot-interval-ms-override', '150');
      host.App.createLobby();
      ({ players } = await joinPlayers(server.baseURL, host, NAMES, log));
      const { mafiaNames, roles } = await assignRolesAndBegin(host, players, log);
      await playDay1AndSkipNight1(host, players, log);
      const target = players.find((p) => !mafiaNames.includes(p.label)).label;

      // A snapshot saved BEFORE this point (e.g. one taken while still in
      // the lobby) would already satisfy a plain "does one exist yet"
      // check — wait specifically for one saved AFTER we're actually on
      // Day 2, or this could pass while resuming into stale, pre-Day-2 data.
      const reachedDay2At = Date.now();
      log.step('Waiting for a real periodic snapshot to save (taken AFTER reaching Day 2)...');
      await waitFor(() => {
        const raw = host.window.localStorage.getItem('mafia-host-session');
        if (!raw) return false;
        try { return JSON.parse(raw).savedAt >= reachedDay2At; } catch (e) { return false; }
      }, { timeout: 3000, message: 'no fresh (post-Day-2) host snapshot was ever saved' });
      const seededSnapshot = host.window.localStorage.getItem('mafia-host-session');
      log.pass('A real, fresh snapshot exists in the host\'s own localStorage.');

      log.step('Simulating a refresh: the old tab\'s connection dies for good, a brand-new device (seeded with that exact snapshot) replaces it...');
      const code = roomCode(host);
      // A real refresh doesn't just drop the connection — the old tab's OWN
      // JS is gone entirely, so it never gets a chance to auto-reconnect on
      // its own the way a brief network blip would (see
      // blockFutureReconnects' own comment on why that matters here: left
      // alone, the old device's legitimate same-tab reconnect would race
      // the new one below for the same room).
      blockFutureReconnects(host);
      killWebSocket(host); // the "old tab" is simply gone — a real close, without unsafely tearing down its jsdom window (see killWebSocket's own comment)
      resumedHost = createDevice(server.baseURL, { label: 'resumed-host', seedLocalStorage: { 'mafia-host-session': seededSnapshot } });

      await waitFor(() => activeScreenId(resumedHost) === 'screen-host-day',
        { timeout: 5000, message: 'resumed host never landed back on the Day 2 screen it was on before the refresh' });
      log.pass('Resumed host landed back on the exact screen it was on before the refresh, with no manual navigation.');
      const dayEyebrowText = text(resumedHost, 'day-eyebrow') || '';
      log.assert(dayEyebrowText.indexOf('۲') !== -1 || dayEyebrowText.indexOf('2') !== -1,
        'the day count survived the resume (still Day 2, in whichever numeral style) — got "' + dayEyebrowText + '"');

      log.step('Confirming every player\'s connection gets rebuilt with no action needed on their end...');
      // Screen id alone isn't a reliable signal here — these players never
      // actually LEFT screen-player-day in the first place (killWebSocket
      // only kills the OLD host's signaling socket, not the still-live
      // WebRTC data channel each player already had, or their current
      // screen) — a false positive that would pass instantly whether or
      // not the fresh reconnection to resumedHost has actually finished.
      // The data channel's own readyState is the real signal: each player
      // gets a genuinely NEW RTCPeerConnection for this reconnect (see
      // playerHandleSignal's unconditional 'offer' handling), and its data
      // channel only reports 'open' once that fresh negotiation is done.
      for (const p of players) {
        await waitFor(() => {
          const pc = lastMockConnection(p);
          return !!pc && !!pc._dc && pc._dc.readyState === 'open';
        }, { timeout: 5000, message: p.label + '\'s connection to the resumed host never actually finished reconnecting' });
      }
      log.pass('Every player is back, fully connected to the NEW host device, without touching anything themselves.');

      log.step('Proving the game is genuinely still playable, not just superficially connected — a real Day 2 vote...');
      resumedHost.App.startVoting();
      for (const p of players) await waitFor(() => activeScreenId(p) === 'screen-player-vote', { message: p.label + ' never reached the vote screen' });
      for (const p of players) {
        if (p.label !== target) {
          const input = Array.from(p.document.querySelectorAll('#vote-candidate-list label')).find((r) => r.querySelector('.role-name').textContent === target).querySelector('input');
          input.checked = true;
          if (typeof input.onchange === 'function') input.onchange({ target: input });
        }
        p.App.submitVote();
      }
      await sleep(150);
      resumedHost.App.closeVoting();
      await waitFor(() => activeScreenId(resumedHost) === 'screen-host-result' || activeScreenId(resumedHost) === 'screen-host-defense',
        { timeout: 5000, message: 'the resumed host never reached a voting result — the game is not actually functional post-resume' });
      log.pass('The resumed host closed a real vote and reached a result — the game is fully functional again.');

      await teardown(server, [host, resumedHost, ...players].filter(Boolean));
    } catch (err) {
      await teardown(server, [host, resumedHost, ...players].filter(Boolean));
      throw err;
    }
  }

  log.banner('PART B — the room survives the host being gone as long as a player is still connected');
  // Driven with raw WebSocket connections instead of full app/jsdom devices
  // — this is fundamentally a server.js room-lifecycle behavior (see
  // ROOM_EMPTY_GRACE_MS/armEmptyDeleteTimerIfEmpty), and the real app's own
  // ALREADY-EXISTING same-tab auto-reconnect (connectWS's ws.onclose ->
  // attemptHostReconnect — a real, legitimate, separately-tested feature)
  // would otherwise immediately race to reclaim the very room this part
  // means to leave genuinely host-less for a while, muddying exactly what's
  // under test. Talking to the server directly keeps this part focused on
  // just the room-survival behavior itself.
  {
    const WebSocket = require('ws');
    const server = await startServer({ roomEmptyGraceMs: 700 });
    const wsUrl = server.baseURL.replace(/^http/, 'ws') + 'ws'; // baseURL already ends in '/'

    function connectRaw() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
      });
    }
    function nextMessage(ws, matchType, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.removeListener('message', onMsg); reject(new Error('nextMessage(' + matchType + '): timed out after ' + timeoutMs + 'ms')); }, timeoutMs || 5000);
        function onMsg(raw) {
          const msg = JSON.parse(raw);
          if (msg.type !== matchType) return;
          clearTimeout(timer);
          ws.removeListener('message', onMsg);
          resolve(msg);
        }
        ws.on('message', onMsg);
      });
    }

    const hostWs = await connectRaw();
    const hostToken = 'host-token-14b';
    hostWs.send(JSON.stringify({ type: 'create-room', hostToken }));
    const created = await nextMessage(hostWs, 'room-created');
    const code = created.room;
    log.pass('Raw host connection created room ' + code + '.');

    const playerWs = await connectRaw();
    const playerHelloWait = nextMessage(hostWs, 'player-hello');
    playerWs.send(JSON.stringify({ type: 'join-room', room: code, token: 'player-token-14b' }));
    await nextMessage(playerWs, 'joined');
    await playerHelloWait;
    log.pass('A real player joined — the host was notified.');

    log.step('The host\'s connection drops (a real close, exactly like a refresh/crash) while the player stays connected...');
    const playerGetsHostDisconnected = nextMessage(playerWs, 'host-disconnected');
    hostWs.close();
    await playerGetsHostDisconnected;
    log.pass('The still-connected player was told the host disconnected — an honest status, not a silent hang.');

    log.step('Waiting past the (shrunk) empty-room grace window, with the player still connected the whole time...');
    await sleep(1000);
    log.assert(playerWs.readyState === WebSocket.OPEN,
      'the player\'s own connection is untouched — the server never had a reason to drop it');

    log.step('A genuinely new player can still join — proving the room was NOT deleted just because the host was gone...');
    const newcomerWs = await connectRaw();
    newcomerWs.send(JSON.stringify({ type: 'join-room', room: code, token: 'newcomer-token-14b' }));
    const joinedReply = await Promise.race([
      nextMessage(newcomerWs, 'joined', 3000).then((m) => ({ ok: true, m })),
      nextMessage(newcomerWs, 'room-not-found', 3000).then((m) => ({ ok: false, m }))
    ]);
    log.assert(joinedReply.ok, 'a brand-new player successfully joined — the room genuinely survived, exactly as long as the original player stayed connected (got: ' + JSON.stringify(joinedReply.m) + ')');

    log.step('The host reconnects (a fresh connection, same hostToken) — everyone still around hears about it...');
    const hostWs2 = await connectRaw();
    const playerGetsHostReconnected = nextMessage(playerWs, 'host-reconnected');
    hostWs2.send(JSON.stringify({ type: 'reclaim-room', room: code, hostToken }));
    const reclaimed = await nextMessage(hostWs2, 'room-reclaimed');
    await playerGetsHostReconnected;
    log.assert(reclaimed.playerIds && reclaimed.playerIds.length === 2,
      'the reclaim replays the full roster (both the original player and the newcomer) — got ' + JSON.stringify(reclaimed.playerIds));
    log.pass('Host reconnected cleanly; the still-connected player was told so.');

    [hostWs, hostWs2, playerWs, newcomerWs].forEach((ws) => { try { ws.close(); } catch (e) { /* ignore */ } });
    await server.stop();
  }
});
