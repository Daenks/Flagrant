'use strict';
// Flagrant server: static file host + WebSocket lobby/game server. See docs/PROTOCOL.md.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const { botStep } = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_PER_TEAM = 4;
const BOT_STEP_MS = 420;
const LOBBY_GRACE_MS = 20000; // a refresh in the lobby keeps your seat this long
const EMPTY_ROOM_MS = 120000; // a game with no humans connected is dropped after this
const BOT_NAMES = ['Ada', 'Brook', 'Cato', 'Dune', 'Echo', 'Fern', 'Gale', 'Hex', 'Iris', 'Jinx', 'Kite', 'Lux'];
const DEFAULTS = { mapSize: 'medium', squadSize: 3, capsToWin: 3, jailTurns: 3, turnTime: 90, roundLimit: 40, fog: true, portals: true, water: true };

const sessions = new Map(); // token -> session
const rooms = new Map(); // code -> room

// ------------------------------------------------------------------ static

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/'; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ----------------------------------------------------------------- helpers

function send(s, msg) {
  if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
}
function err(s, msg) { send(s, { t: 'error', msg }); }
function cleanName(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return s || fallback;
}
function sessionById(id) {
  for (const s of sessions.values()) if (s.id === id) return s;
  return null;
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function humans(room) { return room.players.filter((p) => !p.bot); }
function connectedHumans(room) { return room.players.filter((p) => !p.bot && p.connected); }

function roomMsg(room) {
  return {
    t: 'room', code: room.code, name: room.name, private: room.private, hostId: room.hostId,
    state: room.state, settings: room.settings,
    players: room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot, connected: p.connected })),
  };
}
function sendRoom(room) {
  const msg = roomMsg(room);
  for (const p of humans(room)) send(sessionById(p.id), msg);
}
function sendGame(room) {
  if (!room.game) return;
  for (const p of connectedHumans(room)) send(sessionById(p.id), room.game.snapshot(p.id));
}
function chat(room, msg, team = -1) {
  for (const p of connectedHumans(room)) {
    if (team < 0 || p.team === team) send(sessionById(p.id), msg);
  }
}
function sysChat(room, text) { chat(room, { t: 'chat', system: true, text }); }

function lobbyList() {
  const lobbies = [];
  for (const r of rooms.values()) {
    if (r.private) continue;
    const host = r.players.find((p) => p.id === r.hostId);
    lobbies.push({ code: r.code, name: r.name, host: host ? host.name : '?', players: r.players.length, max: MAX_PER_TEAM * 2, state: r.state });
  }
  return { t: 'lobbies', lobbies };
}
function pushLobbies() {
  const msg = lobbyList();
  for (const s of sessions.values()) if (!s.room) send(s, msg);
}

// ------------------------------------------------------------------- rooms

function smallerTeam(room) {
  const n = [0, 1].map((t) => room.players.filter((p) => p.team === t).length);
  return n[1] < n[0] ? 1 : 0;
}

function joinRoom(s, room) {
  const existing = room.players.find((p) => p.id === s.id);
  if (existing) {
    existing.connected = true;
  } else {
    if (room.state !== 'lobby') return err(s, 'That game is already in progress');
    if (room.players.length >= MAX_PER_TEAM * 2) return err(s, 'Lobby is full');
    room.players.push({ id: s.id, name: s.name, team: smallerTeam(room), bot: false, connected: true });
    sysChat(room, `${s.name} joined`);
  }
  s.room = room.code;
  sendRoom(room);
  if (room.game) send(s, room.game.snapshot(s.id));
  pushLobbies();
}

function destroyRoom(room) {
  clearTimeout(room.botTimer);
  clearTimeout(room.turnTimer);
  clearTimeout(room.emptyTimer);
  rooms.delete(room.code);
  for (const p of humans(room)) {
    const s = sessionById(p.id);
    if (s && s.room === room.code) {
      s.room = null;
      send(s, { t: 'left', reason: 'Lobby closed' });
      if (!s.ws) sessions.delete(s.token);
    }
  }
}

/** Remove a player (leave / kick / lobby timeout). In a running game their squad is handed to a bot. */
function removePlayer(room, id, reason) {
  const p = room.players.find((x) => x.id === id);
  if (!p) return;
  const s = p.bot ? null : sessionById(id);
  if (s && s.room === room.code) { s.room = null; send(s, { t: 'left', reason }); send(s, lobbyList()); }
  const wasHuman = !p.bot, origName = p.name;
  if (room.state === 'playing' && !p.bot) {
    p.bot = true;
    p.connected = true;
    p.name = `${p.name} (bot)`.slice(0, 22);
    const gp = room.game.players.find((x) => x.id === id);
    if (gp) { gp.bot = true; gp.name = p.name; }
    room.game.evq.delete(id);
    room.game.ended.delete(id);
  } else {
    room.players = room.players.filter((x) => x.id !== id);
  }
  if (wasHuman) sysChat(room, `${origName} left`);
  if (!humans(room).length) { destroyRoom(room); pushLobbies(); return; }
  if (room.hostId === id) {
    const next = connectedHumans(room)[0] || humans(room)[0];
    room.hostId = next.id;
    sysChat(room, `${next.name} is now the host`);
  }
  sendRoom(room);
  if (room.state === 'playing') { kickBots(room); checkTurnEnd(room); sendGame(room); }
  pushLobbies();
}

function watchEmpty(room) {
  clearTimeout(room.emptyTimer);
  if (!connectedHumans(room).length) {
    room.emptyTimer = setTimeout(() => { if (rooms.has(room.code)) { destroyRoom(room); pushLobbies(); } }, EMPTY_ROOM_MS);
  }
}

// -------------------------------------------------------------- game flow

function startGame(room) {
  room.game = new Game(room.players, room.settings, seedToInt(room.settings.seed));
  room.state = 'playing';
  sendRoom(room);
  beginTurn(room);
  pushLobbies();
}

/** Player ids whose units the server should drive right now (bots + disconnected humans). */
function autoIds(room) {
  const team = room.game.turnTeam;
  return new Set(room.players.filter((p) => p.team === team && (p.bot || !p.connected)).map((p) => p.id));
}

function beginTurn(room) {
  const g = room.game;
  clearTimeout(room.turnTimer);
  const secs = room.settings.turnTime;
  g.turnEndsAt = secs > 0 ? Date.now() + secs * 1000 : 0;
  if (secs > 0) room.turnTimer = setTimeout(() => advance(room), secs * 1000);
  room.botsDone = false;
  sendGame(room);
  kickBots(room);
}

function kickBots(room) {
  clearTimeout(room.botTimer);
  if (room.state !== 'playing') return;
  room.botsDone = false;
  const turnKey = `${room.game.round}:${room.game.turnTeam}`;
  let steps = 0;
  const step = () => {
    if (room.state !== 'playing' || !rooms.has(room.code)) return;
    if (`${room.game.round}:${room.game.turnTeam}` !== turnKey) return;
    let acted = false;
    try {
      const ids = autoIds(room);
      acted = ids.size > 0 && ++steps <= 120 && botStep(room.game, ids);
    } catch (e) {
      console.error('bot error', e);
    }
    if (room.game.over) return finishGame(room);
    if (acted) {
      sendGame(room);
      room.botTimer = setTimeout(step, BOT_STEP_MS);
    } else {
      room.botsDone = true;
      checkTurnEnd(room);
    }
  };
  room.botTimer = setTimeout(step, BOT_STEP_MS);
}

function checkTurnEnd(room) {
  if (room.state !== 'playing' || !room.botsDone) return;
  const g = room.game;
  const waiting = room.players.filter((p) => p.team === g.turnTeam && !p.bot && p.connected && !g.ended.has(p.id));
  if (waiting.length) return;
  advance(room);
}

function advance(room) {
  if (room.state !== 'playing') return;
  clearTimeout(room.botTimer);
  clearTimeout(room.turnTimer);
  room.game.nextTurn();
  if (room.game.over) return finishGame(room);
  beginTurn(room);
}

function finishGame(room) {
  clearTimeout(room.botTimer);
  clearTimeout(room.turnTimer);
  room.state = 'over';
  sendRoom(room);
  sendGame(room);
  pushLobbies();
}

// ---------------------------------------------------------------- messages

/** Map seeds are short codes the host can reroll, type in, or share; the map itself stays hidden until play. */
function randSeed() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[(Math.random() * abc.length) | 0];
  return out;
}
function seedToInt(seed) {
  let h = 0x811c9dc5;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h | 0;
}

function sanitizeSettings(cur, inp) {
  const out = { ...cur };
  if (!inp || typeof inp !== 'object') return out;
  const int = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
  if (['small', 'medium', 'large'].includes(inp.mapSize)) out.mapSize = inp.mapSize;
  if ('squadSize' in inp) out.squadSize = int(inp.squadSize, 1, 4, out.squadSize);
  if ('capsToWin' in inp) out.capsToWin = int(inp.capsToWin, 1, 5, out.capsToWin);
  if ('jailTurns' in inp) out.jailTurns = int(inp.jailTurns, 1, 5, out.jailTurns);
  if ('turnTime' in inp) { const v = int(inp.turnTime, 0, 600, out.turnTime); out.turnTime = v > 0 && v < 15 ? 15 : v; }
  if ('roundLimit' in inp) { const v = int(inp.roundLimit, 0, 200, out.roundLimit); out.roundLimit = v > 0 && v < 5 ? 5 : v; }
  if ('fog' in inp) out.fog = !!inp.fog;
  if ('portals' in inp) out.portals = !!inp.portals;
  if ('water' in inp) out.water = !!inp.water;
  if ('seed' in inp) { // empty / invalid = roll a new random one
    const v = typeof inp.seed === 'string' ? inp.seed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
    out.seed = v || randSeed();
  }
  return out;
}

function handle(s, m) {
  const room = s.room ? rooms.get(s.room) : null;
  const isHost = room && room.hostId === s.id;
  const me = room ? room.players.find((p) => p.id === s.id) : null;

  switch (m.t) {
    case 'list':
      return send(s, lobbyList());

    case 'create': {
      if (room) return err(s, 'Leave your current lobby first');
      const r = {
        code: newCode(), name: cleanName(m.name, `${s.name}'s game`).slice(0, 24), private: !!m.private,
        hostId: s.id, state: 'lobby', settings: { ...DEFAULTS, seed: randSeed() }, players: [], game: null, botsDone: false,
      };
      rooms.set(r.code, r);
      return joinRoom(s, r);
    }

    case 'join': {
      if (room) return err(s, 'Leave your current lobby first');
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return err(s, 'No lobby with that code');
      return joinRoom(s, r);
    }

    case 'leave':
      if (room) removePlayer(room, s.id);
      else send(s, { t: 'left' });
      return;

    case 'team': {
      if (!room || room.state !== 'lobby' || !me) return;
      const team = m.team === 1 ? 1 : 0;
      if (me.team === team) return;
      if (room.players.filter((p) => p.team === team).length >= MAX_PER_TEAM) return err(s, 'That team is full');
      me.team = team;
      return sendRoom(room);
    }

    case 'settings':
      if (!isHost || room.state !== 'lobby') return;
      room.settings = sanitizeSettings(room.settings, m.settings);
      return sendRoom(room);

    case 'addBot': {
      if (!isHost || room.state !== 'lobby') return;
      const team = m.team === 1 ? 1 : 0;
      if (room.players.filter((p) => p.team === team).length >= MAX_PER_TEAM) return err(s, 'That team is full');
      const used = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${crypto.randomInt(100)}`;
      room.players.push({ id: `bot-${crypto.randomBytes(4).toString('hex')}`, name, team, bot: true, connected: true });
      sendRoom(room);
      return pushLobbies();
    }

    case 'kick': {
      if (!isHost || m.id === s.id) return;
      const target = room.players.find((p) => p.id === m.id);
      if (!target) return;
      if (room.state !== 'lobby' && target.bot) return;
      return removePlayer(room, target.id, 'You were removed by the host');
    }

    case 'start': {
      if (!isHost || room.state !== 'lobby') return;
      for (const t of [0, 1]) {
        if (!room.players.some((p) => p.team === t)) return err(s, 'Each team needs at least one player or bot');
      }
      return startGame(room);
    }

    case 'toLobby': {
      if (!isHost || room.state !== 'over') return;
      room.state = 'lobby';
      room.game = null;
      room.settings.seed = randSeed(); // fresh map for the rematch
      for (const p of room.players) {
        if (p.bot && p.name.endsWith(' (bot)')) p.gone = true; // humans who left mid-game
      }
      for (const p of room.players) {
        if (p.bot || p.connected) continue;
        p.gone = true;
        const gs = sessionById(p.id);
        if (gs) { gs.room = null; sessions.delete(gs.token); }
      }
      room.players = room.players.filter((p) => !p.gone);
      sendRoom(room);
      return pushLobbies();
    }

    case 'chat': {
      if (!room || !me) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
      if (!text) return;
      const scope = m.scope === 'team' ? 'team' : 'all';
      return chat(room, { t: 'chat', from: me.name, team: me.team, scope, text }, scope === 'team' ? me.team : -1);
    }

    case 'ping': {
      if (!room || !me || !room.game) return;
      const idx = m.idx | 0;
      if (!room.game.grid.validIdx(idx)) return;
      return chat(room, { t: 'ping', idx, from: me.name }, me.team);
    }

    case 'move': case 'tag': case 'ability': case 'rescue': case 'handoff': {
      if (!room || room.state !== 'playing' || !me) return;
      const g = room.game;
      const u = g.unit(m.unit | 0);
      if (!u || u.owner !== s.id) return;
      let ok = false;
      if (m.t === 'move') ok = g.move(u, m.to | 0);
      else if (m.t === 'tag') ok = g.tag(u, g.unit(m.target | 0));
      else if (m.t === 'ability') ok = g.ability(u, m.target == null ? undefined : m.target | 0);
      else if (m.t === 'handoff') ok = g.handoff(u, g.unit(m.target | 0));
      else ok = g.rescue(u);
      if (!ok) return send(s, g.snapshot(s.id)); // resync a stale client
      if (g.over) return finishGame(room);
      return sendGame(room);
    }

    case 'endTurn': {
      if (!room || room.state !== 'playing' || !me) return;
      const g = room.game;
      if (me.team !== g.turnTeam || g.ended.has(s.id)) return;
      g.ended.add(s.id);
      const before = `${g.round}:${g.turnTeam}`;
      checkTurnEnd(room);
      if (room.state === 'playing' && `${g.round}:${g.turnTeam}` === before) sendGame(room);
      return;
    }
  }
}

// --------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let s = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      if (m.t === 'hello') {
        if (s) return;
        const old = typeof m.token === 'string' ? sessions.get(m.token) : null;
        if (old) {
          s = old;
          clearTimeout(s.dropTimer);
          if (s.ws && s.ws !== ws) { try { s.ws.close(); } catch { /* ignore */ } }
          if (m.name && !s.room) s.name = cleanName(m.name, s.name);
        } else {
          s = { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name: cleanName(m.name, `Player${crypto.randomInt(100, 999)}`), room: null };
          sessions.set(s.token, s);
        }
        s.ws = ws;
        send(s, { t: 'welcome', id: s.id, token: s.token, name: s.name });
        const room = s.room ? rooms.get(s.room) : null;
        if (room) {
          clearTimeout(room.emptyTimer);
          joinRoom(s, room);
        } else {
          s.room = null;
          send(s, lobbyList());
        }
        return;
      }
      if (s) handle(s, m);
    } catch (e) {
      console.error('handler error', e);
    }
  });

  ws.on('close', () => {
    if (!s || s.ws !== ws) return;
    s.ws = null;
    const room = s.room ? rooms.get(s.room) : null;
    if (room) {
      const p = room.players.find((x) => x.id === s.id);
      if (p) p.connected = false;
      sendRoom(room);
      if (p && room.state === 'playing') {
        // A bot covers for them from now on; they can reconnect with their token.
        if (room.game.turnTeam === p.team && !room.game.ended.has(s.id)) kickBots(room);
        else checkTurnEnd(room);
      }
      watchEmpty(room);
    }
    const sess = s;
    sess.dropTimer = setTimeout(() => {
      if (sess.ws) return;
      const r = sess.room ? rooms.get(sess.room) : null;
      if (r && r.state !== 'lobby') return; // keep the seat while a game is running
      if (r) removePlayer(r, sess.id);
      sessions.delete(sess.token);
    }, LOBBY_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Flagrant running at http://localhost:${PORT}`);
});
