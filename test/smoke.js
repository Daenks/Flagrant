'use strict';
// End-to-end smoke test: boots the server on a spare port, connects two WebSocket clients,
// runs lobby flow + a few turns of a real game. Run with: node test/smoke.js
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3999;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, name, last: {}, log: [], events: [] };
  c.send = (m) => ws.send(JSON.stringify(m));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    c.last[m.t] = m;
    c.log.push(m.t);
    if (m.t === 'game') c.events.push(...m.events);
  });
  c.ready = new Promise((res) => ws.on('open', () => { c.send({ t: 'hello', name }); res(); }));
  c.until = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
    throw new Error(`${name}: timed out waiting for ${what}`);
  };
  return c;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv.stdout.on('data', (d) => /running/.test(d) && res()));
  try {
    const a = client('Ann'), b = client('Bob');
    await a.ready; await b.ready;
    await a.until(() => a.last.welcome, 'welcome');
    await b.until(() => b.last.lobbies, 'lobby list');

    a.send({ t: 'create', name: 'Smoke', private: false });
    const room = await a.until(() => a.last.room, 'room');
    await b.until(() => b.last.lobbies.lobbies.some((l) => l.code === room.code), 'public lobby pushed');
    b.send({ t: 'join', code: room.code.toLowerCase() });
    await b.until(() => b.last.room && b.last.room.players.length === 2, 'join');
    assert.notStrictEqual(a.last.room.players[0].team, a.last.room.players[1].team, 'auto-balanced teams');

    b.send({ t: 'start' }); // not host: ignored
    a.send({ t: 'settings', settings: { mapSize: 'small', squadSize: 2, turnTime: 0, capsToWin: 1, bogus: 1 } });
    a.send({ t: 'addBot', team: 0 });
    a.send({ t: 'addBot', team: 1 });
    await a.until(() => a.last.room.players.length === 4 && a.last.room.settings.mapSize === 'small', 'settings+bots');
    const seed0 = a.last.room.settings.seed;
    assert.ok(/^[A-Z0-9]{6}$/.test(seed0), 'room has a map seed');
    b.send({ t: 'settings', settings: { seed: 'HACKED' } }); // not host: ignored
    a.send({ t: 'settings', settings: { seed: '' } });
    await a.until(() => a.last.room.settings.seed !== seed0, 'reroll');
    assert.notStrictEqual(a.last.room.settings.seed, 'HACKED');
    a.send({ t: 'settings', settings: { seed: 'my map-42!' } });
    await a.until(() => a.last.room.settings.seed === 'MYMAP42', 'typed seed normalised');
    a.send({ t: 'chat', text: 'hi team', scope: 'team' });
    await a.until(() => a.last.chat && a.last.chat.text === 'hi team', 'own team chat');
    assert.ok(!b.last.chat || b.last.chat.text !== 'hi team', 'team chat must not leak');

    a.send({ t: 'start' });
    const ga = await a.until(() => a.last.game, 'game A');
    const gb = await b.until(() => b.last.game, 'game B');
    assert.strictEqual(ga.terrain.length, ga.w * ga.h);
    assert.ok(ga.terrain.includes('?'), 'fog hides terrain');
    assert.ok(ga.units.every((u) => u.team === ga.you.team), 'no enemy units visible at start');
    assert.strictEqual(gb.bases[ga.you.team].flag, -1, 'enemy base hidden');

    // Play 6 turns: whoever is on turn moves each unit as far toward the enemy side as possible.
    for (let turn = 0; turn < 6; turn++) {
      const key = () => `${a.last.game.round}:${a.last.game.turnTeam}`;
      await a.until(() => `${b.last.game.round}:${b.last.game.turnTeam}` === key(), 'clients in sync');
      const start = key();
      for (const c of [a, b]) {
        const g = c.last.game;
        if (g.turnTeam !== g.you.team) continue;
        for (const id of Object.keys(g.actions)) {
          const act = c.last.game.actions[id];
          if (!act || !act.reach.length) continue;
          let best = null;
          for (let i = 0; i < act.reach.length; i += 3) {
            const col = act.reach[i] % g.w;
            const score = g.you.team === 0 ? col : -col;
            if (!best || score > best.score) best = { idx: act.reach[i], score };
          }
          const before = c.log.length;
          c.send({ t: 'move', unit: +id, to: best.idx });
          await c.until(() => c.log.length > before, 'move reply');
          const u = c.last.game.units.find((x) => x.id === +id);
          assert.ok(u, 'moved unit still in snapshot');
        }
        // illegal: move a unit we don't own / bogus target must not crash
        c.send({ t: 'move', unit: 9999, to: 0 });
        c.send({ t: 'tag', unit: +Object.keys(g.actions)[0], target: 12345 });
        c.send({ t: 'endTurn' });
      }
      await a.until(() => key() !== start || a.last.game.over, `turn ${turn} to advance`, 60000);
      if (a.last.game.over) break;
    }
    assert.ok(a.events.some((e) => e.e === 'move'), 'move events delivered');
    assert.ok(a.events.some((e) => e.e === 'turn'), 'turn events delivered');

    // Reconnect with token: should land back in the running game.
    const token = b.last.welcome.token;
    b.ws.close();
    await a.until(() => a.last.room.players.some((p) => p.name === 'Bob' && !p.connected), 'disconnect seen');
    const b2 = client('Bob');
    b2.ready = new Promise((res) => b2.ws.on('open', res));
    b2.ws.removeAllListeners('open');
    await new Promise((res) => b2.ws.on('open', () => { b2.send({ t: 'hello', name: 'Bob', token }); res(); }));
    await b2.until(() => b2.last.game && b2.last.room, 'reconnect into game');
    assert.strictEqual(b2.last.welcome.id, b.last.welcome.id, 'same identity after reconnect');

    b2.send({ t: 'leave' });
    await b2.until(() => b2.last.left, 'left');
    await a.until(() => a.last.room.players.some((p) => p.bot && p.name.startsWith('Bob')), 'leaver became a bot');
    a.send({ t: 'leave' });
    await b2.until(() => b2.last.lobbies && !b2.last.lobbies.lobbies.some((l) => l.code === room.code), 'room closed');
    console.log('SMOKE OK');
    a.ws.close(); b2.ws.close();
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
