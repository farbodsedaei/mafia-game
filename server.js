// Mafia app server — runs entirely on the host's own laptop, on the local
// network. It does two jobs, and NOTHING else:
//   1. Serves the single-page app (public/index.html) to any phone on the
//      same WiFi that opens the laptop's LAN address.
//   2. Relays a short WebRTC handshake between the host tab and each player
//      tab (offer / answer / ICE candidates) so they can find each other.
// Once that handshake completes, all game data (names, roles, votes, etc.)
// flows directly phone-to-phone over WebRTC — it never touches this server.
// No game state, names, or roles are stored here. The role list itself is
// hardcoded in public/index.html rather than persisted anywhere, so it can
// never be lost to a server restart.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function randomRoomCode(len) {
  len = len || 5;
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ROOM_CODE_CHARS[crypto.randomInt(0, ROOM_CODE_CHARS.length)];
  }
  return code;
}

// STUN alone only helps two peers find each other when a direct connection
// is actually possible — it has no fallback when it isn't (iCloud Private
// Relay, cellular carrier NAT, a locked-down guest WiFi, etc.), and that's
// exactly the silent "waiting for host" hang some players hit. A TURN
// server is the fix: it relays traffic when a direct path can't be found.
// TURN credentials are read from environment variables rather than hardcoded
// here so they never end up sitting in public/index.html, visible to
// anyone — see the README-style comment where these are documented for
// exactly what to set on the hosting platform (Render, etc.). Until they're
// set, this silently falls back to the original STUN-only behavior — the
// app still works exactly as before, just without the extra reliability.
// Two ways to configure a TURN server, checked in this order:
//
//   1. Cloudflare Realtime TURN (CF_TURN_KEY_ID + CF_TURN_KEY_API_TOKEN) —
//      a different shape from every other provider: instead of one static
//      long-lived username/password, you get a "TURN key" (an ID + a
//      secret API token) from the Cloudflare dashboard (Realtime -> TURN
//      -> Create TURN key), and THIS SERVER calls Cloudflare's API to mint
//      a fresh, short-lived credential pair on demand (see
//      fetchCloudflareIceServers) — cached here and reused until it's
//      close to expiring, rather than one call per request. Never put
//      CF_TURN_KEY_API_TOKEN anywhere but this server's own env vars — it
//      can mint credentials on its own, unlike the short-lived ones it
//      hands out.
//   2. A static provider (TURN_URL / TURN_USERNAME / TURN_CREDENTIAL) —
//      Metered.ca's Open Relay, Xirsys, a self-hosted coturn, etc. — one
//      long-lived username/password pair issued directly by the provider,
//      used as-is.
//        TURN_URL         one URL, or several comma-separated (e.g. a UDP
//                          one on :80 and a TCP one on :443 — most
//                          providers give you both; listing both gives
//                          WebRTC more chances through a restrictive
//                          network)
//        TURN_USERNAME     from your TURN provider
//        TURN_CREDENTIAL   from your TURN provider
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_KEY_API_TOKEN = process.env.CF_TURN_KEY_API_TOKEN;
const CF_TURN_TTL_SECONDS = 6 * 60 * 60; // 6h — comfortably longer than one game night; refreshed proactively below anyway
let cfTurnCache = null; // { iceServers, expiresAt } — process-local; fine to lose on a redeploy/restart, just regenerated on the next request

async function fetchCloudflareIceServers() {
  const now = Date.now();
  // Reuse the cached set until it's close to expiring, rather than calling
  // Cloudflare on every single /api/ice-config request (one per page
  // load) — still comfortably fresh well within its own TTL.
  if (cfTurnCache && cfTurnCache.expiresAt - now > 10 * 60 * 1000) {
    return cfTurnCache.iceServers;
  }
  const res = await fetch(
    'https://rtc.live.cloudflare.com/v1/turn/keys/' + CF_TURN_KEY_ID + '/credentials/generate-ice-servers',
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: CF_TURN_TTL_SECONDS })
    }
  );
  if (!res.ok) throw new Error('Cloudflare TURN credential request failed: ' + res.status + ' ' + (await res.text().catch(() => '')));
  const data = await res.json();
  if (!data || !Array.isArray(data.iceServers) || !data.iceServers.length) {
    throw new Error('Cloudflare TURN response had no iceServers');
  }
  cfTurnCache = { iceServers: data.iceServers, expiresAt: now + CF_TURN_TTL_SECONDS * 1000 };
  return data.iceServers;
}

async function buildIceServers() {
  if (CF_TURN_KEY_ID && CF_TURN_KEY_API_TOKEN && typeof fetch === 'function') {
    try {
      return await fetchCloudflareIceServers();
    } catch (e) {
      console.error('[turn] Cloudflare credential fetch failed, falling back:', e.message);
      // fall through to the static-provider / STUN-only path below
    }
  }
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const turnUrl = process.env.TURN_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;
  if (turnUrl && turnUsername && turnCredential) {
    const urls = turnUrl.split(',').map(u => u.trim()).filter(Boolean);
    if (urls.length) servers.push({ urls, username: turnUsername, credential: turnCredential });
  }
  return servers;
}

// Derives turnConfigured from the ACTUAL result rather than just checking
// which env vars are present — correctly flips to false if e.g. the
// Cloudflare API call above failed and buildIceServers had to fall back to
// STUN-only despite CF_TURN_KEY_ID/TOKEN being set. See index.html's
// setup-screen warning, the thing this actually drives.
function iceServersIncludeTurn(iceServers) {
  return iceServers.some(s => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some(u => typeof u === 'string' && /^turns?:/i.test(u));
  });
}

/* ---------------- Static file server ---------------- */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/lan-ips') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
    return;
  }

  if (url.pathname === '/api/ice-config') {
    // turnConfigured lets the client warn the host in-app (see
    // index.html's setup screen) instead of this being a silent fallback
    // only visible by reading this file's own comments — real players on
    // restrictive networks/cellular otherwise fail to connect with no
    // obvious cause.
    const iceServers = await buildIceServers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers, turnConfigured: iceServersIncludeTurn(iceServers) }));
    return;
  }

  // Single-page app: every non-file route serves index.html so that
  // links like /?join=ABCDE work.
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  // No caching: this app changes often during development, and stale HTML/JS
  // in a player's browser silently breaks the game (they'd be running old
  // code with no way to tell). Freshness matters far more than the marginal
  // performance cost of always revalidating for an app this small.
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

/* ---------------- Signaling relay ---------------- */
// rooms: Map(code -> { host: ws, hostToken, players: Map(playerId -> ws), emptyDeleteTimer })
const rooms = new Map();

// A room used to die 90s after just the HOST's own socket closed —
// regardless of how many players were still sitting there connected — which
// is exactly the reported "host's browser refreshes/disconnects and the
// whole room is gone" bug: the game's entire state lives only in the host's
// own browser tab, so losing the room on nothing more than a host hiccup
// threw away everyone else's progress too, even when they were all still
// right there waiting. A room now survives as long as ANYONE — host or any
// player — is still connected, and only starts counting down once it is
// GENUINELY EMPTY (see isRoomEmpty/armEmptyDeleteTimer below), giving a
// refreshed/reconnecting host (see index.html's host-side snapshot +
// auto-resume) real time to come back without losing anything, and letting
// players who are still around keep their own seats reserved the whole
// time. Mobile browsers (iOS Safari especially) also aggressively suspend a
// backgrounded tab's network activity — screen lock, switching apps for a
// moment, even just showing someone the room code — which drops a socket
// even though the tab itself is still alive; this same generous window
// covers that too, for host and players alike, without needing a separate
// short-lived grace period just for that case anymore.
// 10 minutes by default — long enough that "everyone happens to be
// mid-reconnect at the exact same moment" (a real network outage, not just
// one person's blip) doesn't cost the room, short enough that a genuinely
// abandoned room doesn't linger forever.
const ROOM_EMPTY_GRACE_MS = process.env.ROOM_EMPTY_GRACE_MS_OVERRIDE ? parseInt(process.env.ROOM_EMPTY_GRACE_MS_OVERRIDE, 10) : 10 * 60 * 1000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function isRoomEmpty(room) {
  const hostConnected = room.host && room.host.readyState === 1;
  if (hostConnected) return false;
  for (const ws of room.players.values()) {
    if (ws && ws.readyState === 1) return false;
  }
  return true;
}

// Called after any disconnect — arms the teardown timer if (and only if)
// NOBODY is left connected right now; a room that still has even one
// live socket (host or player) never starts this countdown at all.
function armEmptyDeleteTimerIfEmpty(code) {
  const room = rooms.get(code);
  if (!room || !isRoomEmpty(room)) return;
  if (room.emptyDeleteTimer) return; // already counting down
  room.emptyDeleteTimer = setTimeout(() => {
    const stillRoom = rooms.get(code);
    // Re-check emptiness rather than trusting the state from when this was
    // armed — someone may well have reconnected in the meantime (that path
    // already clears this timer below, but a defensive re-check costs
    // nothing and protects against any future call site that forgets to).
    if (stillRoom && isRoomEmpty(stillRoom)) rooms.delete(code);
  }, ROOM_EMPTY_GRACE_MS);
}
// Called after any (re)connect — a room that was counting down to deletion
// is no longer empty, so cancel that.
function clearEmptyDeleteTimer(room) {
  if (room.emptyDeleteTimer) { clearTimeout(room.emptyDeleteTimer); room.emptyDeleteTimer = null; }
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  ws._room = null;
  ws._role = null;   // 'host' | 'player'
  ws._playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // App-level heartbeat (see index.html's connectWS/startWsHeartbeat) —
    // lets a client proactively detect a connection that's gone silently
    // dead (a network handover especially) instead of waiting on the OS/
    // browser to notice and fire a real close event, which can take far
    // longer than ROOM_EMPTY_GRACE_MS below.
    if (msg.type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'create-room') {
      let code;
      do { code = randomRoomCode(); } while (rooms.has(code));
      // hostToken is a client-generated secret (see App.createLobby) proving
      // a later 'reclaim-room' request for this code really is the same
      // host reconnecting, not some other tab guessing/hijacking the code.
      const hostToken = typeof msg.hostToken === 'string' && msg.hostToken.length > 0 && msg.hostToken.length <= 64 ? msg.hostToken : null;
      rooms.set(code, { host: ws, hostToken, players: new Map(), emptyDeleteTimer: null });
      ws._room = code; ws._role = 'host';
      send(ws, { type: 'room-created', room: code });
      return;
    }

    if (msg.type === 'reclaim-room') {
      const room = rooms.get(msg.room);
      if (!room || !room.hostToken || room.hostToken !== msg.hostToken) {
        send(ws, { type: 'room-not-found' });
        return;
      }
      const hostWasGone = !room.host || room.host.readyState !== 1; // computed before reassigning room.host below
      clearEmptyDeleteTimer(room);
      room.host = ws;
      ws._room = msg.room; ws._role = 'host';
      // Anyone who tried to join (or reconnect) while the host was briefly
      // offline is already sitting in room.players — but the one-shot
      // 'player-hello' that would normally alert the host about them went
      // nowhere, since there was no live host socket to receive it. Replay
      // the full roster now so the host can catch up on all of them.
      send(ws, { type: 'room-reclaimed', room: msg.room, playerIds: Array.from(room.players.keys()) });
      // Let anyone who was still around while the host was away know it's
      // back — see 'host-disconnected' below for the other half of this.
      if (hostWasGone) {
        for (const p of room.players.values()) send(p, { type: 'host-reconnected' });
      }
      return;
    }

    if (msg.type === 'join-room') {
      const room = rooms.get(msg.room);
      if (!room) { send(ws, { type: 'room-not-found' }); return; }
      clearEmptyDeleteTimer(room);
      // A rejoining player sends back the token it was given the first time
      // (persisted client-side), so it can reclaim its same seat instead of
      // looking like a brand-new joiner — this is what makes reconnecting
      // after a phone screen lock / dropped connection actually work.
      const token = typeof msg.token === 'string' && msg.token.length > 0 && msg.token.length <= 64 ? msg.token : null;
      const playerId = token || crypto.randomBytes(4).toString('hex');
      const prior = room.players.get(playerId);
      if (prior && prior !== ws) { try { prior.close(); } catch (e) {} }
      room.players.set(playerId, ws);
      ws._room = msg.room; ws._role = 'player'; ws._playerId = playerId;
      send(ws, { type: 'joined', room: msg.room, playerId });
      send(room.host, { type: 'player-hello', playerId });
      return;
    }

    if (msg.type === 'signal') {
      const room = rooms.get(ws._room);
      if (!room) return;
      if (ws._role === 'host') {
        const target = room.players.get(msg.to);
        send(target, { type: 'signal', from: 'host', payload: msg.payload });
      } else if (ws._role === 'player') {
        send(room.host, { type: 'signal', from: ws._playerId, payload: msg.payload });
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws._room);
    if (!room) return;
    if (ws._role === 'host') {
      // Only the room's LIVE host socket closing means anything here — if a
      // reclaim already reassigned room.host to a newer socket before this
      // stale close event arrived, this is that old socket catching up, and
      // must not disturb the reclaim that already happened.
      if (room.host === ws) {
        room.host = null;
        // Tell whoever's still here — see 'reclaim-room' for the matching
        // 'host-reconnected' once (if) the host comes back. The room itself
        // is NOT deleted just because the host is gone now, only once
        // EVERYONE is (armEmptyDeleteTimerIfEmpty below) — that's the whole
        // point of this change (see ROOM_EMPTY_GRACE_MS's own comment).
        for (const p of room.players.values()) send(p, { type: 'host-disconnected' });
        armEmptyDeleteTimerIfEmpty(ws._room);
      }
    } else if (ws._role === 'player') {
      // Only evict if this socket is still the live one for that player id —
      // if they already reconnected (a newer socket claimed the same id
      // before this stale one's close event arrived), leave the new mapping
      // alone and don't tell the host they left.
      if (room.players.get(ws._playerId) === ws) {
        room.players.delete(ws._playerId);
        send(room.host, { type: 'player-left', playerId: ws._playerId });
        armEmptyDeleteTimerIfEmpty(ws._room);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  const ips = lanAddresses();
  console.log('\nMafia server running.');
  console.log('  On this laptop:  http://localhost:' + PORT);
  if (ips.length) {
    console.log('  On phones (same WiFi):');
    ips.forEach(ip => console.log('    http://' + ip + ':' + PORT));
  } else {
    console.log('  Could not detect a LAN IP — make sure you are connected to WiFi.');
  }
  console.log('');
});
