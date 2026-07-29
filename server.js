// Mafia app server — runs entirely on the host's own laptop, on the local
// network. It does two jobs, and NOTHING else:
//   1. Serves the single-page app (public/index.html) to any phone on the
//      same WiFi that opens the laptop's LAN address.
//   2. Relays a short WebRTC handshake between the host tab and each player
//      tab (offer / answer / ICE candidates) so they can find each other.
// Once that handshake completes, all game data (names, roles, votes, etc.)
// flows directly phone-to-phone over WebRTC — it never touches this server.
// No game state, names, or roles are stored here.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const DEFAULT_ROLES = [
  { id: 'builtin-mafia', team: 'mafia', name: 'Mafia', description: 'You know the other Mafia. Work in the dark, blend in by day.', shield: false, builtin: true },
  { id: 'builtin-villager', team: 'villager', name: 'Villager', description: 'You have no special knowledge. Watch closely, and vote wisely.', shield: false, builtin: true }
];

/* ---------------- Role library (persisted to disk) ---------------- */
function ensureRolesFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ROLES_FILE)) fs.writeFileSync(ROLES_FILE, JSON.stringify(DEFAULT_ROLES, null, 2));
}
function readRoles() {
  ensureRolesFile();
  try {
    const raw = fs.readFileSync(ROLES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_ROLES.slice();
  } catch (e) {
    return DEFAULT_ROLES.slice();
  }
}
function writeRoles(roles) {
  ensureRolesFile();
  fs.writeFileSync(ROLES_FILE, JSON.stringify(roles, null, 2));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy(); // 1MB safety cap
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

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

  if (url.pathname === '/api/roles' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readRoles()));
    return;
  }

  if (url.pathname === '/api/roles' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    const name = (body.name || '').toString().trim().slice(0, 40);
    const description = (body.description || '').toString().trim().slice(0, 200);
    const independent = !!body.independent;
    const team = independent ? 'villager' : (body.team === 'mafia' ? 'mafia' : 'villager');
    if (!name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Name is required' })); return; }

    const shield = !!body.shield;
    const roles = readRoles();
    const newRole = { id: 'r-' + crypto.randomBytes(4).toString('hex'), team, name, description, shield, independent, builtin: false };
    roles.push(newRole);
    writeRoles(roles);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roles));
    return;
  }

  if (url.pathname.startsWith('/api/roles/') && req.method === 'PUT') {
    const id = url.pathname.split('/').pop();
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

    const roles = readRoles();
    const target = roles.find(r => r.id === id);
    if (!target) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Role not found' })); return; }

    const name = (body.name || '').toString().trim().slice(0, 40);
    const description = (body.description || '').toString().trim().slice(0, 200);
    const independent = target.builtin ? false : !!body.independent;
    const team = independent ? 'villager' : (body.team === 'mafia' ? 'mafia' : 'villager');
    const shield = !!body.shield;
    if (!name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Name is required' })); return; }

    target.name = name;
    target.description = description;
    target.team = team;
    target.shield = shield;
    target.independent = independent;
    writeRoles(roles);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roles));
    return;
  }

  if (url.pathname.startsWith('/api/roles/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    let roles = readRoles();
    const target = roles.find(r => r.id === id);
    if (target && target.builtin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Built-in roles cannot be deleted' }));
      return;
    }
    roles = roles.filter(r => r.id !== id);
    writeRoles(roles);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(roles));
    return;
  }

  // Single-page app: every non-file route serves index.html so that
  // links like /?join=ABCDE work.
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
      const playerId = crypto.randomBytes(4).toString('hex');
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
      room.players.delete(ws._playerId);
      send(room.host, { type: 'player-left', playerId: ws._playerId });
    }
  });
});

ensureRolesFile();

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
