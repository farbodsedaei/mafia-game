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

/* ---------------- Static file server ---------------- */
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/lan-ips') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ips: lanAddresses(), port: PORT }));
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
// rooms: Map(code -> { host: ws|null, players: Map(playerId -> ws) })
const rooms = new Map();

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

    if (msg.type === 'create-room') {
      let code;
      do { code = randomRoomCode(); } while (rooms.has(code));
      rooms.set(code, { host: ws, players: new Map() });
      ws._room = code; ws._role = 'host';
      send(ws, { type: 'room-created', room: code });
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
      // Host left: let players know, then drop the room.
      for (const p of room.players.values()) send(p, { type: 'host-left' });
      rooms.delete(ws._room);
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
