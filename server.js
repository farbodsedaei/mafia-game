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
//   TURN_URL         one URL, or several comma-separated (e.g. a UDP one on
//                     :80 and a TCP one on :443 — most providers give you
//                     both; listing both gives WebRTC more chances to get
//                     through a restrictive network)
//   TURN_USERNAME     from your TURN provider
//   TURN_CREDENTIAL   from your TURN provider
function buildIceServers() {
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

/* ---------------- Static file server ---------------- */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/lan-ips') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
    return;
  }

  if (url.pathname === '/api/ice-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ iceServers: buildIceServers() }));
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
// rooms: Map(code -> { host: ws, hostToken, players: Map(playerId -> ws), hostDeleteTimer })
const rooms = new Map();

// How long a room survives after its host's socket closes before being torn
// down for good. Mobile browsers (iOS Safari especially) aggressively
// suspend a backgrounded tab's network activity — screen lock, switching
// apps for a moment, even just showing someone the room code — which drops
// this WebSocket even though the tab itself is still alive. Without a grace
// window, that single blip destroyed the room instantly and permanently for
// every player still trying to join, which is the exact "room doesn't
// exist" failure this grace period exists to prevent. See 'reclaim-room'.
// 90s (was 45s) — the client now proactively detects a silently-dead
// connection itself (see index.html's WS heartbeat) rather than only
// relying on this window to cover the browser/OS's own close detection, so
// this is now purely a safety margin for how long a full network handover
// (WiFi <-> cellular, DNS+TLS re-establishment and all) can reasonably take
// end-to-end before the room gives up on the host coming back.
const HOST_GRACE_MS = process.env.HOST_GRACE_MS_OVERRIDE ? parseInt(process.env.HOST_GRACE_MS_OVERRIDE, 10) : 90000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
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
    // longer than HOST_GRACE_MS below.
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
      // Dev/testing aid only (see index.html's Test Mode setup checkbox):
      // told to every joining player via 'joined' below, so their client can
      // persist its session in per-TAB sessionStorage instead of the
      // normally-shared localStorage — lets one person open several browser
      // tabs on one machine as several distinct players without their
      // sessions overwriting each other. Never set by a real game.
      const testMode = !!msg.testMode;
      rooms.set(code, { host: ws, hostToken, players: new Map(), hostDeleteTimer: null, testMode });
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
      if (room.hostDeleteTimer) { clearTimeout(room.hostDeleteTimer); room.hostDeleteTimer = null; }
      room.host = ws;
      ws._room = msg.room; ws._role = 'host';
      // Anyone who tried to join (or reconnect) while the host was briefly
      // offline is already sitting in room.players — but the one-shot
      // 'player-hello' that would normally alert the host about them went
      // nowhere, since there was no live host socket to receive it. Replay
      // the full roster now so the host can catch up on all of them.
      send(ws, { type: 'room-reclaimed', room: msg.room, playerIds: Array.from(room.players.keys()) });
      return;
    }

    if (msg.type === 'join-room') {
      const room = rooms.get(msg.room);
      if (!room) { send(ws, { type: 'room-not-found' }); return; }
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
      send(ws, { type: 'joined', room: msg.room, playerId, testMode: !!room.testMode });
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
      // Only the room's LIVE host socket closing starts the grace timer — if
      // a reclaim already reassigned room.host to a newer socket before this
      // stale close event arrived, this is that old socket catching up, and
      // must not tear down the reclaim that already happened.
      if (room.host === ws) {
        room.hostDeleteTimer = setTimeout(() => {
          const stillRoom = rooms.get(ws._room);
          if (stillRoom && stillRoom.host === ws) {
            for (const p of stillRoom.players.values()) send(p, { type: 'host-left' });
            rooms.delete(ws._room);
          }
        }, HOST_GRACE_MS);
      }
    } else if (ws._role === 'player') {
      // Only evict if this socket is still the live one for that player id —
      // if they already reconnected (a newer socket claimed the same id
      // before this stale one's close event arrived), leave the new mapping
      // alone and don't tell the host they left.
      if (room.players.get(ws._playerId) === ws) {
        room.players.delete(ws._playerId);
        send(room.host, { type: 'player-left', playerId: ws._playerId });
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
