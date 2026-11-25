'use strict';
// Flagrant bot AI. One call = at most one engine action for one unit of the active team.
//
// Fairness: the bot only uses what its team knows — explored/visible tiles (plus terrain deduced
// from the point-symmetric map: if the mirror tile is explored, its terrain is known), units the
// team can currently see, public flag state, its own traps and enemy traps revealed by flares.
// Memory (last-seen enemy positions) only stores things the team actually saw.

const { TAG_COST } = require('./game');
const TAG_REACH = { scout: 1, sentinel: 2, saboteur: 1 };
const COST = { '.': 1, f: 2, h: 2, w: 3, t: 1, p: 1, '?': 2 }; // '?' = unknown, assume passable-ish
const INF = 1e9;
const FLARE_RANGE = 7;
const DASH_AP = 4;
const MAX_TRAPS = 2;
const MAX_MOVES = 8; // hard per-unit per-turn move cap (belt and braces; AP already bounds it)

const MEM = new WeakMap(); // game -> [teamMem, teamMem]

function teamMem(game, team) {
  let m = MEM.get(game);
  if (!m) {
    const mk = () => ({ lastSeen: new Map(), prog: new Map(), bumped: new Map() });
    m = [mk(), mk()];
    MEM.set(game, m);
  }
  const tm = m[team];
  const key = game.round + ':' + game.turnTeam;
  if (tm.turnKey !== key) {
    tm.turnKey = key;
    tm.done = new Set(); // units finished for this turn
    tm.visited = new Map(); // unit id -> Set of tiles it stood on this turn (no back-and-forth)
    tm.moves = new Map(); // unit id -> moves made this turn
    tm.abil = new Set(); // units that used their ability this turn
    tm.progChecked = new Set();
    tm.flared = false;
    tm.seed = (Math.random() * 0x7fffffff) | 0;
    tm.roles = null;
    tm.rolesKey = '';
  }
  return tm;
}

// ------------------------------------------------------------------ context

function makeCtx(game, team, tm, mine) {
  const g = game.grid, n = g.n, ex = game.know[team].explored;
  const ter = new Array(n);
  for (let i = 0; i < n; i++) {
    if (ex[i]) ter[i] = game.terrain[i];
    else if (g.validIdx(i)) {
      const m = g.mirror(i);
      ter[i] = ex[m] ? game.terrain[m] : '?';
    } else ter[i] = ' ';
  }
  const foe = 1 - team;
  const vis = game.know[team].visible;
  const ctx = {
    game, team, foe, tm, mine, ter, grid: g,
    stand: game.bases[team].flag,
    foeStand: game.enemyFlagStand(team),
    foeJail: game.bases[foe].jail,
    enemies: game.visibleEnemies(team),
    crates: new Set(game.crates.filter((c) => vis[c.pos]).map((c) => c.pos)),
    knownTraps: new Set(game.traps.filter((t) => t.team === foe && t.seen[team]).map((t) => t.pos)),
    ownTraps: game.traps.filter((t) => t.team === team),
    occ: new Map(), // tile -> extra planning cost (occupied tiles may not clear up)
    fields: new Map(),
    reaches: new Map(),
    lazy: new Map(),
  };
  for (const [i, r] of tm.bumped) {
    if (game.round - r > 4) tm.bumped.delete(i); else ctx.occ.set(i, 30);
  }
  for (const e of ctx.enemies) ctx.occ.set(e.pos, 8);
  for (const o of game.units) if (o.team === team && o.pos >= 0) ctx.occ.set(o.pos, 2);
  return ctx;
}

function lazy(ctx, key, fn) {
  if (!ctx.lazy.has(key)) ctx.lazy.set(key, fn());
  return ctx.lazy.get(key);
}

function passable(ctx, i) {
  return !!COST[ctx.ter[i]] && i !== ctx.stand;
}

/** Reverse Dijkstra (bucket queue): d[x] = estimated AP to get from x onto any goal tile. */
function field(ctx, key, goals, noPortal) {
  if (key && ctx.fields.has(key)) return ctx.fields.get(key);
  const g = ctx.grid;
  const d = new Int32Array(g.n).fill(INF);
  const buckets = [];
  const push = (i, v) => { d[i] = v; (buckets[v] || (buckets[v] = [])).push(i); };
  for (const x of goals) if (passable(ctx, x) && d[x] !== 0) push(x, 0);
  for (let k = 0; k < buckets.length; k++) {
    const b = buckets[k];
    if (!b) continue;
    for (let q = 0; q < b.length; q++) {
      const a = b[q];
      if (d[a] !== k) continue;
      const ta = ctx.ter[a], ca = COST[ta] + (ctx.occ.get(a) || 0);
      for (const nb of g.nbr[a]) {
        if (k + ca < d[nb] && passable(ctx, nb)) push(nb, k + ca);
      }
      if (ta === 'p' && !noPortal) { // standing on the twin portal you can jump here for 1 AP
        const m = g.mirror(a);
        if (k + 1 < d[m] && passable(ctx, m)) push(m, k + 1);
      }
    }
  }
  if (key) ctx.fields.set(key, d);
  return d;
}

function reachOf(ctx, u) {
  // Cached per step; any action invalidates (we return right after acting).
  let r = ctx.reaches.get(u.id);
  if (!r) { r = ctx.game.reach(u); ctx.reaches.set(u.id, r); }
  return r;
}

function noise(ctx, u, t) {
  let h = (t * 374761393 + u.id * 668265263 + ctx.tm.seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 0.35;
}

/** How risky is it to end the turn on tile t (only enemy territory is dangerous). */
function danger(ctx, t, carrier) {
  const { game, grid } = ctx;
  if (game.zone[t] !== ctx.foe) return 0;
  let s = 0.3, near = false;
  for (const e of threats(ctx)) {
    const d = grid.dist(t, e.pos);
    if (d <= 1 && e.seen) near = true;
    if (!carrier && game.zone[e.pos] !== ctx.foe) continue; // for non-carriers only defenders at home matter
    // Can e get within tag reach of t on its next turn?
    const m = threatRange(ctx, e) - d;
    if (m >= 0) s += 1.5 + 0.3 * Math.min(m, 6);
    else if (m >= -2) s += 0.3;
  }
  if (!carrier && !near && (ctx.ter[t] === 'f' || ctx.game.units.some((o) => o.id === ctx.cur && o.buffs.cloak > 1))) {
    s *= 0.3; // forest / cloak: only seen from adjacent hexes
  }
  return carrier ? s * 1.6 : s;
}

/** Enemies that might tag us next turn: visible ones plus ones seen last round (at their last position). */
function threats(ctx) {
  return lazy(ctx, 'threats', () => {
    const { game, tm } = ctx;
    const out = ctx.enemies.filter((e) => !e.stunned).map((e) => ({ pos: e.pos, cls: e.cls, cd: e.cd, unit: e, seen: true }));
    const vis = new Set(ctx.enemies.map((e) => e.id));
    for (const [id, s] of tm.lastSeen) {
      if (vis.has(id) || game.round - s.round > 1) continue;
      const e = game.unit(id);
      if (e) out.push({ pos: s.pos, cls: e.cls, cd: 0, unit: e, seen: false });
    }
    return out;
  });
}

/** Ending a turn inside a visible enemy's tag reach (it does not even have to move): avoid at almost any cost. */
function hardDanger(ctx, t) {
  const { game, grid } = ctx;
  if (game.zone[t] !== ctx.foe) return 0;
  let s = 0;
  for (const e of ctx.enemies) {
    if (e.stunned || game.maxAp(e) < TAG_COST) continue;
    const d = grid.dist(t, e.pos);
    if (d <= TAG_REACH[e.cls] && (d <= 1 || game.los(e.pos, t, false))) s += 30;
  }
  return s;
}

/** Outside our own territory move in short hops so newly revealed enemies can still be reacted to. */
function hopLimit(ctx, u) {
  if (ctx.game.zone[u.pos] === ctx.team || u.ap <= 3) return null;
  return 3;
}

function threatRange(ctx, e) {
  const u = e.unit || e;
  return ctx.game.maxAp(u) - TAG_COST + TAG_REACH[e.cls] + (e.cls === 'scout' && e.cd <= 1 ? DASH_AP : 0);
}

function bonus(ctx, u, t) {
  let b = 0;
  if (!u.flag && ctx.game.zone[t] === ctx.foe && ctx.ter[t] === 'f') b -= 0.6;
  if (ctx.crates.has(t)) b -= 2.2;
  return b;
}

/** Does the engine's path to t cross a trap we know about, or a tile where we bumped into something hidden? */
function pathHitsTrap(ctx, u, r, t) {
  const bumped = ctx.tm.bumped;
  if (!ctx.knownTraps.size && !bumped.size) return false;
  for (let i = t; i !== u.pos && r.get(i); i = r.get(i).prev) {
    if (ctx.knownTraps.has(i) || bumped.has(i)) return true;
  }
  return false;
}

/** Best reachable tile by score (lower is better); -1 if staying put is about as good. */
function bestTile(ctx, u, score, opts = {}) {
  const r = reachOf(ctx, u);
  const vis = ctx.tm.visited.get(u.id);
  const stay = score(u.pos, 0);
  let best = -1, bs = INF;
  for (const [t, { cost }] of r) {
    if (vis && vis.has(t)) continue;
    if (opts.maxCost != null && cost > opts.maxCost) continue;
    if (pathHitsTrap(ctx, u, r, t)) continue;
    const s = score(t, cost);
    if (s < bs) { bs = s; best = t; }
  }
  if (best < 0 || bs >= stay - (opts.margin == null ? 0.3 : opts.margin)) return -1;
  return best;
}

// ------------------------------------------------------------------ actions

function doMove(ctx, u, to) {
  const { game, tm } = ctx;
  const p0 = u.pos, a0 = u.ap;
  const r = reachOf(ctx, u);
  let first = to;
  while (r.get(first) && r.get(first).prev !== p0) first = r.get(first).prev;
  const ok = game.move(u, to);
  if (!ok || (u.pos === p0 && u.ap === a0)) {
    // "Ran into something hidden" on the very first step (only possible through a portal):
    // remember that tile as occupied for a few rounds.
    if (ok) { tm.bumped.set(first, game.round); ctx.bumpRetry = true; } else tm.done.add(u.id);
    return false;
  }
  let v = tm.visited.get(u.id);
  if (!v) tm.visited.set(u.id, (v = new Set()));
  v.add(p0); v.add(u.pos);
  tm.moves.set(u.id, (tm.moves.get(u.id) || 0) + 1);
  return true;
}

function abilityReady(ctx, u) {
  return u.cd === 0 && !u.stunned && !ctx.tm.abil.has(u.id) && ctx.game.canAct(u);
}

function canDash(ctx, u) { return u.cls === 'scout' && abilityReady(ctx, u); }

function dash(ctx, u) {
  const a0 = u.ap;
  ctx.tm.abil.add(u.id);
  return ctx.game.ability(u) && u.ap > a0;
}

// ------------------------------------------------------------------ roles

function roles(ctx) {
  const { game, team, mine, tm } = ctx;
  const key = mine.map((u) => u.id).join(',');
  if (tm.roles && tm.rolesKey === key) return tm.roles;
  const R = new Map();
  const by = (cls) => mine.filter((u) => u.cls === cls).sort((a, b) => a.id - b.id);
  const sc = by('scout'), se = by('sentinel'), sa = by('saboteur');
  sc.forEach((u) => R.set(u.id, 'attack'));
  se.forEach((u, i) => R.set(u.id, i === 0 ? 'defend' : i === 1 ? 'support' : 'hunt'));
  sa.forEach((u, i) => R.set(u.id, i === 0 ? 'trap' : 'attack'));
  if (mine.length === 1) R.set(mine[0].id, 'attack');

  // Late game and not ahead: hunters join the attack.
  const limit = game.settings.roundLimit;
  if (limit && game.round > limit * 0.6 && game.scores[team] <= game.scores[1 - team]) {
    for (const u of se.slice(2)) R.set(u.id, 'attack');
  }
  // Trapper with its traps set becomes an attacker (if attack is thin) or a defender.
  for (const u of sa) {
    if (R.get(u.id) !== 'trap') continue;
    const own = game.traps.filter((t) => t.owner === u.id).length;
    if (own >= MAX_TRAPS) {
      const attackers = [...R.values()].filter((r) => r === 'attack').length;
      const defenders = [...R.values()].filter((r) => r === 'defend').length;
      R.set(u.id, defenders > 0 || attackers < 2 ? 'attack' : 'defend');
    }
  }
  tm.roles = R;
  tm.rolesKey = key;
  return R;
}

// ------------------------------------------------------------------ goal tiles

function foeField(ctx) { return field(ctx, 'efs', [ctx.foeStand]); }

function guardTiles(ctx) {
  return lazy(ctx, 'guard', () => {
    const { grid, game, team } = ctx;
    const ef = foeField(ctx);
    const own = new Set(ctx.ownTraps.map((t) => t.pos));
    const c = grid.within(ctx.stand, 3).filter((i) => {
      const d = grid.dist(i, ctx.stand);
      return d >= 2 && game.zone[i] === team && passable(ctx, i) && !own.has(i) && ef[i] < INF;
    });
    c.sort((a, b) => ef[a] - ef[b] + (ctx.ter[a] === 'h' ? -1 : 0) - (ctx.ter[b] === 'h' ? -1 : 0));
    return c.slice(0, 3);
  });
}

function watchTiles(ctx, u) {
  const { grid, game, team } = ctx;
  const towers = lazy(ctx, 'towers', () => {
    const out = [];
    for (let i = 0; i < grid.n; i++) if (ctx.ter[i] === 't' && game.zone[i] === team) out.push(i);
    return out;
  });
  if (towers.length) return [towers[u.id % towers.length]];
  // No tower: a spot in our half, ~5 tiles out from the flag towards the enemy.
  return lazy(ctx, 'watch', () => {
    const ef = foeField(ctx);
    const c = grid.within(ctx.stand, 6).filter((i) => grid.dist(i, ctx.stand) >= 4 && game.zone[i] === team && passable(ctx, i) && ef[i] < INF);
    c.sort((a, b) => ef[a] - ef[b]);
    return c.slice(0, 3);
  });
}

function stageTiles(ctx) {
  return lazy(ctx, 'stage', () => {
    const { grid, game } = ctx;
    const ef = foeField(ctx);
    const c = [];
    for (let i = 0; i < grid.n; i++) if (game.zone[i] === 2 && passable(ctx, i) && ef[i] < INF) c.push(i);
    c.sort((a, b) => ef[a] - ef[b]);
    return c.slice(0, 6);
  });
}

/** Approach tiles near our own flag stand worth trapping, best first, minus already trapped ones. */
function trapSpots(ctx) {
  return lazy(ctx, 'trapspots', () => {
    const { grid, game, team } = ctx;
    const ef = foeField(ctx);
    const trapped = new Set(game.traps.filter((t) => t.team === team).map((t) => t.pos));
    const c = grid.within(ctx.stand, 2).filter((i) => i !== ctx.stand && game.zone[i] === team &&
      passable(ctx, i) && ctx.ter[i] !== 'p' && ef[i] < INF);
    const sc = (i) => ef[i] + (grid.dist(i, ctx.stand) === 1 ? 0 : 2);
    c.sort((a, b) => sc(a) - sc(b));
    const top = c.slice(0, 3);
    if (top.filter((i) => trapped.has(i)).length >= 2) return [];
    return top.filter((i) => !trapped.has(i));
  });
}

function jailSpots(ctx) {
  return ctx.grid.nbr[ctx.foeJail].filter((i) => passable(ctx, i));
}

function canTagFrom(ctx, u, t, e) {
  const { game, grid } = ctx;
  const d = grid.dist(t, e.pos);
  if (d > TAG_REACH[u.cls]) return false;
  if (d <= 1) return true;
  const hidden = game.terrain[e.pos] === 'f' || e.buffs.cloak > 0;
  if (hidden && !game.inFlare(ctx.team, e.pos)) return false;
  return game.los(t, e.pos, false);
}

function tagSpots(ctx, u, pos) {
  return ctx.grid.within(pos, TAG_REACH[u.cls]).filter((i) => i !== pos && passable(ctx, i));
}

function suspects(ctx) {
  return lazy(ctx, 'suspects', () => {
    const { game, team, tm } = ctx;
    const seen = new Set(ctx.enemies.map((e) => e.id));
    const out = [];
    for (const [id, s] of tm.lastSeen) {
      if (seen.has(id) || game.round - s.round > 1) continue;
      if (game.zone[s.pos] !== team && ctx.grid.dist(s.pos, ctx.stand) > 8) continue;
      out.push(s.pos);
    }
    out.sort((a, b) => ctx.grid.dist(a, ctx.stand) - ctx.grid.dist(b, ctx.stand));
    return out;
  });
}

function updateSeen(ctx) {
  const { game, team, tm } = ctx;
  const vis = game.know[team].visible;
  const seen = new Set();
  for (const e of ctx.enemies) { tm.lastSeen.set(e.id, { pos: e.pos, round: game.round }); seen.add(e.id); }
  for (const [id, s] of tm.lastSeen) {
    const e = game.unit(id);
    if (!e || e.jailed > 0 || game.round - s.round > 2) { tm.lastSeen.delete(id); continue; }
    // We are looking at the spot and it is not concealing terrain: it moved on.
    if (!seen.has(id) && vis[s.pos] && (game.terrain[s.pos] !== 'f' || game.inFlare(team, s.pos))) tm.lastSeen.delete(id);
  }
}

// ------------------------------------------------------------------ unit logic

function actCarrier(ctx, u) {
  const { game, grid } = ctx;
  const goals = grid.nbr[ctx.stand].filter((i) => passable(ctx, i));
  const f = field(ctx, 'home', goals);
  const r = reachOf(ctx, u);
  let bg = -1, bc = INF;
  for (const g of goals) { const e = r.get(g); if (e && e.cost < bc && !pathHitsTrap(ctx, u, r, g)) { bc = e.cost; bg = g; } }
  if (bg >= 0) return doMove(ctx, u, bg);
  const inDanger = game.zone[u.pos] === ctx.foe;
  if (canDash(ctx, u) && f[u.pos] > u.ap && (inDanger || f[u.pos] <= u.ap + DASH_AP) && dash(ctx, u)) return true;
  // Outside enemy territory nobody can tag us: get there first, then walk home.
  const safe = lazy(ctx, 'safeTiles', () => {
    const out = [];
    for (let i = 0; i < grid.n; i++) if (grid.validIdx(i) && game.zone[i] !== ctx.foe && passable(ctx, i)) out.push(i);
    return out;
  });
  const sf = field(ctx, 'safe', safe);
  const th = threats(ctx);
  const caught = (t) => th.reduce((n, e) => n + (grid.dist(e.pos, t) <= threatRange(ctx, e) ? 1 : 0), 0);
  // If some reachable tile is out of every known threat's reach, take the best such tile; if none is,
  // being caught is likely anyway, so just make as much progress as possible.
  let anySafe = caught(u.pos) === 0;
  for (const t of reachOf(ctx, u).keys()) if (!anySafe && (game.zone[t] !== ctx.foe || caught(t) === 0)) anySafe = true;
  const cw = u.safe ? 0 : anySafe ? 25 : 2;
  const score = (t) => (game.zone[t] !== ctx.foe ? f[t] * 0.5 - 100
    : caught(t) * cw + sf[t] * 2 + f[t] * 0.5 + (u.safe ? 0 : danger(ctx, t, true) * 0.2 + hardDanger(ctx, t)));
  const to = bestTile(ctx, u, (t, c) => score(t) + bonus(ctx, u, t) + noise(ctx, u, t) * 0.5 + c * 0.01, { margin: 0.1, maxCost: hopLimit(ctx, u) });
  return to >= 0 ? doMove(ctx, u, to) : false;
}

function tryIntercept(ctx, u) {
  if (u.ap < TAG_COST + 1) return false;
  const { game, grid, team } = ctx;
  // Defenders intercept anyone in our territory; everybody else only detours for flag carriers.
  const guard = ['defend', 'trap', 'hunt'].includes(roles(ctx).get(u.id));
  const targets = ctx.enemies.filter((e) => game.zone[e.pos] === team && !e.safe && (guard || e.flag));
  if (!targets.length) return false;
  const r = reachOf(ctx, u);
  let best = -1, bs = INF;
  for (const e of targets) {
    const pri = (e.flag ? 0 : 10) + grid.dist(e.pos, ctx.stand) * 0.3;
    for (const t of grid.within(e.pos, TAG_REACH[u.cls])) {
      const ent = r.get(t);
      if (!ent || ent.cost > u.ap - TAG_COST || !canTagFrom(ctx, u, t, e)) continue;
      const s = pri + ent.cost * 0.1;
      if (s < bs) { bs = s; best = t; }
    }
  }
  return best >= 0 ? doMove(ctx, u, best) : false;
}

function tryFlare(ctx, u) {
  if (u.cls !== 'sentinel' || ctx.tm.flared || !abilityReady(ctx, u)) return false;
  const { game, grid, team, foe } = ctx;
  const cands = [];
  const ours = game.flags[team];
  if (ours.state === 'dropped') cands.push([ours.pos, 0]);
  for (const p of suspects(ctx)) cands.push([p, 1 + grid.dist(p, ctx.stand) * 0.1]);
  if (game.flags[foe].state === 'home') {
    const pushing = ctx.mine.some((o) => o !== u && game.isFree(o) && !o.flag && grid.dist(o.pos, ctx.foeStand) <= 7);
    if (pushing) cands.push([ctx.foeStand, 3]);
  }
  cands.sort((a, b) => a[1] - b[1]);
  for (const [p] of cands) {
    if (grid.dist(u.pos, p) > FLARE_RANGE || game.inFlare(team, p)) continue;
    ctx.tm.abil.add(u.id);
    ctx.tm.flared = true;
    if (game.ability(u, p)) return true;
  }
  return false;
}

function tryTrap(ctx, u) {
  if (u.cls !== 'saboteur' || roles(ctx).get(u.id) !== 'trap' || !abilityReady(ctx, u)) return false;
  const { game } = ctx;
  if (game.traps.filter((t) => t.owner === u.id).length >= MAX_TRAPS) return false;
  const spots = trapSpots(ctx);
  if (!spots.length) return false;
  const info = game.abilityInfo(u);
  if (!info.ready) return false;
  const want = spots.find((s) => info.targets.includes(s));
  if (want == null) return false;
  ctx.tm.abil.add(u.id);
  return game.ability(u, want);
}

function chooseGoal(ctx, u) {
  const { game, grid, team, foe } = ctx;
  const role = roles(ctx).get(u.id) || 'attack';
  const ours = game.flags[team], theirs = game.flags[foe];

  // Our flag lies on the ground: the nearest two go and return it.
  if (ours.state === 'dropped') {
    const ret = lazy(ctx, 'returners', () => {
      const f = field(ctx, 'ret', [ours.pos]);
      return new Set(ctx.mine.filter((o) => game.isFree(o) && !o.flag).sort((a, b) => f[a.pos] - f[b.pos]).slice(0, 2).map((o) => o.id));
    });
    if (ret.has(u.id)) return { key: 'ret', tiles: [ours.pos], direct: true, dash: true, dangerW: 0.4 };
  }

  // Our flag is being carried through our territory: chase / cut it off.
  if (ours.state === 'carried') {
    const c = game.unit(ours.carrier);
    if (c && c.pos >= 0 && game.zone[c.pos] === team) {
      const pred = lazy(ctx, 'pred', () => predictCarrier(ctx, c));
      const tiles = [...new Set([...tagSpots(ctx, u, c.pos), ...grid.within(pred, 1).filter((i) => passable(ctx, i))])];
      const f = field(ctx, 'chase' + TAG_REACH[u.cls], tiles);
      if (role === 'defend' || role === 'hunt' || f[u.pos] <= Math.max(u.ap, 4) + 2) {
        return { key: 'chase' + TAG_REACH[u.cls], tiles, direct: false, dash: true, dangerW: 0.3 };
      }
    }
  }

  // Jailbreak.
  const rescuer = lazy(ctx, 'rescuer', () => {
    const jailed = game.units.filter((o) => o.team === team && o.jailed >= 2);
    if (!jailed.length) return -1;
    const f = field(ctx, 'jail', jailSpots(ctx));
    let best = -1, bd = INF;
    for (const o of ctx.mine) {
      if (!game.isFree(o) || o.flag) continue;
      const r = roles(ctx).get(o.id);
      if (r !== 'attack' && r !== 'hunt') continue;
      if (f[o.pos] < bd) { bd = f[o.pos]; best = o.id; }
    }
    return bd <= 14 ? best : -1;
  });
  if (rescuer === u.id) return { key: 'jail', tiles: jailSpots(ctx), direct: true, keep: 1, dash: true, dangerW: 0.8 };

  if (role === 'trap') {
    const spots = trapSpots(ctx);
    if (spots.length && u.cd <= 2) {
      const tiles = [...new Set(grid.within(spots[0], 1).filter((i) => passable(ctx, i)))];
      return { key: 'trapnear', tiles, dangerW: 0 };
    }
  }

  if (role === 'attack') {
    if (theirs.state === 'home') {
      // Go for the flag; grabbing grants a free enemy turn, so always take it when reachable.
      return { key: 'eflag', tiles: [ctx.foeStand], direct: true, grab: true, commit: true, dash: false, dangerW: 0.6 };
    }
    if (theirs.state === 'dropped') return { key: 'eflagd', tiles: [theirs.pos], direct: true, dash: true, dangerW: 0.7 };
    return { key: 'stage', tiles: stageTiles(ctx), dangerW: 1 };
  }

  if (role === 'support') {
    // Shadow the attack at flare range from the enemy flag; flare it when attackers move in.
    if (theirs.state !== 'carried') {
      return { key: 'eflag', tiles: [ctx.foeStand], dangerW: 1.5, stage: 6 };
    }
    return { key: 'stage', tiles: stageTiles(ctx), dangerW: 1 };
  }

  // defend / hunt / trap-done
  const threats = ctx.enemies.filter((e) => game.zone[e.pos] === team || (role === 'defend' && grid.dist(e.pos, ctx.stand) <= 8 && game.zone[e.pos] !== foe));
  if (threats.length) {
    const ref = role === 'defend' ? ctx.stand : u.pos;
    if (role === 'defend') {
      // Defenders only leave their post for threats that are close to the flag.
      const close = threats.filter((e) => grid.dist(e.pos, ctx.stand) <= 9);
      threats.length = 0; threats.push(...close);
    }
    if (threats.length) {
      threats.sort((a, b) => (b.flag - a.flag) || grid.dist(a.pos, ref) - grid.dist(b.pos, ref));
      const e = threats[0];
      return { key: 'thr' + e.id + ':' + TAG_REACH[u.cls], tiles: tagSpots(ctx, u, e.pos), dangerW: 0.3 };
    }
  }
  const sus = suspects(ctx);
  if (sus.length && (role !== 'defend' || grid.dist(sus[0], ctx.stand) <= 6)) {
    return { key: 'sus' + sus[0], tiles: grid.within(sus[0], 1).filter((i) => passable(ctx, i)), dangerW: 0.5 };
  }
  if (role === 'hunt') return { key: 'watch' + u.id, tiles: watchTiles(ctx, u), dangerW: 1 };
  return { key: 'guard', tiles: guardTiles(ctx), dangerW: 1 };
}

/** Where an enemy carrier will probably be after its next move (greedy walk towards its stand). */
function predictCarrier(ctx, c) {
  const { grid } = ctx;
  const goals = grid.nbr[ctx.foeStand].filter((i) => passable(ctx, i));
  const f = field(ctx, 'foehome', goals);
  let p = c.pos, budget = 5;
  while (budget > 0) {
    let nx = -1, nv = f[p];
    for (const n of grid.nbr[p]) if (f[n] < nv && COST[ctx.ter[n]] <= budget) { nv = f[n]; nx = n; }
    if (nx < 0) break;
    budget -= COST[ctx.ter[nx]];
    p = nx;
  }
  return p;
}

/** Track per-unit progress towards its goal across turns; >= 2 means it has been stuck. */
function stallOf(ctx, u, goal, f) {
  const { tm, game } = ctx;
  let p = tm.prog.get(u.id);
  if (!p || p.key !== goal.key) { p = { key: goal.key, best: f[u.pos], stall: 0, until: 0 }; tm.prog.set(u.id, p); tm.progChecked.add(u.id); }
  if (!tm.progChecked.has(u.id)) {
    tm.progChecked.add(u.id);
    if (f[u.pos] < p.best - 0.5) { p.best = f[u.pos]; p.stall = 0; } else p.stall++;
    if (p.stall >= 2 && p.until < game.round) { p.until = game.round + 3; } // unstick mode for a few rounds
    if (p.until && p.until < game.round) { p.until = 0; p.stall = 0; p.best = INF; }
  }
  return p.until >= game.round;
}

/** After picking up the flag at `from` with `esc` AP to spend, is there a tile out of every known threat's reach? */
function canEscape(ctx, u, from, esc) {
  const { game, grid } = ctx;
  const ex = game.know[ctx.team].explored;
  const th = threats(ctx);
  const blocked = new Set(ctx.enemies.map((e) => e.pos));
  for (const o of game.units) if (o.team === ctx.team && o !== u && o.pos >= 0) blocked.add(o.pos);
  const safeAt = (t) => game.zone[t] !== ctx.foe || th.every((e) => grid.dist(e.pos, t) > threatRange(ctx, e));
  const best = new Map([[from, 0]]);
  const open = [from];
  while (open.length) {
    const a = open.shift();
    if (safeAt(a)) return true;
    const c = best.get(a);
    const steps = grid.nbr[a].map((n) => [n, COST[game.terrain[n]]]);
    if (game.terrain[a] === 'p') steps.push([grid.mirror(a), 1]);
    for (const [n, k] of steps) {
      if (!k || !ex[n] || blocked.has(n) || n === ctx.stand) continue;
      const nc = c + k;
      if (nc > esc || (best.has(n) && best.get(n) <= nc)) continue;
      best.set(n, nc);
      open.push(n);
    }
  }
  return false;
}

function pursue(ctx, u, goal) {
  if (!goal.tiles.length) return false;
  let f = field(ctx, goal.key, goal.tiles);
  if (stallOf(ctx, u, goal, f)) {
    // Stuck (blocked portal, stand-off...): try the long way round and accept more risk for a while.
    f = field(ctx, goal.key + ':np', goal.tiles, true);
    goal = { ...goal, dangerW: (goal.dangerW == null ? 1 : goal.dangerW) * 0.4, stage: 0, yolo: true };
  }
  const r = reachOf(ctx, u);
  const keep = goal.keep || 0;
  if (goal.direct) {
    let bt = -1, bc = INF;
    for (const g of goal.tiles) {
      const e = r.get(g);
      if (e && e.cost <= u.ap - keep && e.cost < bc && !pathHitsTrap(ctx, u, r, g)) { bc = e.cost; bt = g; }
    }
    if (bt >= 0 && goal.grab) {
      // Only grab the flag if the carrier keeps enough AP to run (unless nobody is watching / time is short).
      // Escape budget after the pickup; a threat can catch us if it is closer than its range minus that budget.
      const esc = Math.min(u.ap - bc, ctx.game.maxAp(u) - 1) + (canDash(ctx, u) ? DASH_AP : 0);
      const late = ctx.game.settings.roundLimit && ctx.game.round >= ctx.game.settings.roundLimit - 2;
      // Engine rule: a fresh carrier is untaggable during the following enemy turn, so grabbing is
      // only bad when the escape afterwards is hopeless; we still prefer some AP left to run.
      if (!late && !goal.commit && esc < 1 && !canEscape(ctx, u, bt, esc + DASH_AP)) bt = -1;
    }
    if (bt >= 0) return doMove(ctx, u, bt);
  }
  if (f[u.pos] >= INF) return false;
  if (goal.dash && canDash(ctx, u) && f[u.pos] + keep > u.ap && f[u.pos] + keep <= u.ap + DASH_AP - (goal.dashSlack || 0) &&
      dash(ctx, u)) return true;
  const dw = goal.dangerW == null ? 1 : goal.dangerW;
  const st = goal.stage;
  const prog = st ? (t) => Math.max(0, f[t] - st) + 0.08 * f[t] : (t) => f[t];
  const to = bestTile(ctx, u, (t, c) => prog(t) + dw * danger(ctx, t, false) + hardDanger(ctx, t) + bonus(ctx, u, t) + noise(ctx, u, t) + c * 0.01,
    { maxCost: hopLimit(ctx, u) });
  return to >= 0 ? doMove(ctx, u, to) : false;
}

function actUnit(ctx, u) {
  ctx.cur = u.id;
  if (u.flag) return actCarrier(ctx, u);
  if (tryFlare(ctx, u) || tryTrap(ctx, u)) return true;
  if (tryIntercept(ctx, u)) return true;
  return pursue(ctx, u, chooseGoal(ctx, u));
}

// ------------------------------------------------------------------ entry point

/**
 * Perform at most ONE action for one unit owned by any of `ownerIds` on the team whose turn it is.
 * Returns true if an action changed the game state, false if there is nothing (more) useful to do.
 */
function botStep(game, ownerIds) {
  if (!game || game.over) return false;
  const team = game.turnTeam;
  const tm = teamMem(game, team);
  const mine = game.units.filter((u) => u.team === team && ownerIds.has(u.owner));
  if (!mine.length) return false;
  let ctx = makeCtx(game, team, tm, mine);
  updateSeen(ctx);

  const free = mine.filter((u) => game.canAct(u));

  // 1. Tag whenever possible (carriers first, then whoever is closest to our flag).
  for (const u of free) {
    const tg = game.tagTargets(u);
    if (!tg.length) continue;
    tg.sort((a, b) => (b.flag - a.flag) || ctx.grid.dist(a.pos, ctx.stand) - ctx.grid.dist(b.pos, ctx.stand));
    if (game.tag(u, tg[0])) return true;
  }
  // 2. Jailbreak whenever possible.
  for (const u of free) if (game.canRescue(u) && game.rescue(u)) return true;

  // 2b. Take the flag from an adjacent teammate that is stuck (stunned or out of AP) when we can still run.
  //     Never from a "safe" carrier: the protection is lost on a handoff.
  for (const u of free) {
    if (u.flag || u.ap < 4) continue;
    const c = game.handoffTargets(u)[0];
    if (c && !c.safe && (c.stunned || c.ap <= 1) && game.handoff(u, c)) return true;
  }

  // 3. One unit at a time: carriers first.
  const active = free.filter((u) => !tm.done.has(u.id)).sort((a, b) => (b.flag - a.flag) || a.id - b.id);
  for (const u of active) {
    if ((tm.moves.get(u.id) || 0) >= MAX_MOVES) { tm.done.add(u.id); continue; }
    if (actUnit(ctx, u)) return true;
    if (ctx.bumpRetry) { // bumped into a hidden unit through a portal: replan once with that knowledge
      ctx = makeCtx(game, team, tm, mine);
      if (actUnit(ctx, u)) return true;
    }
    tm.done.add(u.id);
    ctx.reaches.clear();
  }
  return false;
}

module.exports = { botStep };
