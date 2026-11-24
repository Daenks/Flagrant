'use strict';
const { mulberry32 } = require('./hex');
const { generateMap, PASSABLE } = require('./mapgen');

const CLASSES = {
  scout: { label: 'Scout', ap: 6, vision: 5, reach: 1, ability: 'dash', cd: 4 },
  sentinel: { label: 'Sentinel', ap: 4, vision: 4, reach: 2, ability: 'flare', cd: 4 },
  saboteur: { label: 'Saboteur', ap: 5, vision: 4, reach: 1, ability: 'trap', cd: 3 },
};
const SQUAD = ['scout', 'sentinel', 'saboteur', 'scout'];
const TEAM = ['Red', 'Blue'];
const CRATE_KINDS = ['haste', 'cloak', 'shield'];
const FLARE_RANGE = 7, FLARE_RADIUS = 2, DASH_AP = 4, HASTE_AP = 3, MAX_TRAPS = 2;
const TAG_COST = 3;
const CRATE_EVERY = 3, MAX_CRATES = 6;

class Game {
  /**
   * @param players [{id, name, team, bot}]
   * @param settings see docs/PROTOCOL.md
   */
  constructor(players, settings, seed = (Math.random() * 2 ** 31) | 0) {
    this.settings = settings;
    this.players = players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: !!p.bot }));
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    const map = generateMap(settings.mapSize, seed);
    this.grid = map.grid;
    this.w = map.w;
    this.h = map.h;
    this.terrain = map.terrain;
    // Portals off: same map, with plain ground where the portals would be.
    if (settings.portals === false) for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] === 'p') this.terrain[i] = '.';
    this.zone = map.zone;
    this.bases = map.bases;
    this.crateSpots = map.crateSpots;
    this.fog = settings.fog !== false;

    this.units = [];
    this.flags = [0, 1].map((t) => ({ team: t, state: 'home', pos: this.bases[t].flag, carrier: null }));
    this.traps = []; // {pos, team, owner(unit id), seen:[bool,bool]}
    this.crates = []; // {pos, kind}
    this.flares = []; // {pos, r, team}
    this.scores = [0, 0];
    this.round = 1;
    this.firstTeam = this.rng() < 0.5 ? 0 : 1;
    this.turnTeam = this.firstTeam;
    this.ended = new Set();
    this.turnEndsAt = 0;
    this.over = null;
    this.know = [0, 1].map(() => ({
      explored: new Uint8Array(this.grid.n),
      visible: new Uint8Array(this.grid.n),
    }));
    this.evq = new Map();
    for (const p of this.players) if (!p.bot) this.evq.set(p.id, []);

    let uid = 1;
    for (const p of this.players) {
      const size = Math.max(1, Math.min(4, settings.squadSize | 0 || 3));
      for (let k = 0; k < size; k++) {
        const cls = SQUAD[k];
        const dup = k === 3 ? ' II' : '';
        const u = {
          id: uid++, owner: p.id, team: p.team, cls,
          name: `${p.name}'s ${CLASSES[cls].label}${dup}`,
          pos: -1, ap: 0, jailed: 0, stunned: 0, flag: false, safe: false,
          buffs: { haste: 0, cloak: 0, shield: false }, cd: 0,
        };
        this.units.push(u);
        u.pos = this.freeTileNear(this.bases[p.team].spawn);
      }
    }
    for (const u of this.units) u.ap = u.team === this.turnTeam ? this.maxAp(u) : 0;
    this.refreshVision();
    this.emitAll({ e: 'turn', team: this.turnTeam, round: this.round, msg: `Round 1 — ${TEAM[this.turnTeam]} moves first` });
  }

  // ---------------------------------------------------------------- helpers

  unit(id) { return this.units.find((u) => u.id === id) || null; }
  unitAt(idx) { return this.units.find((u) => u.pos === idx) || null; }
  maxAp(u) { return CLASSES[u.cls].ap + (u.buffs.haste > 0 ? HASTE_AP : 0); }
  isFree(u) { return u.jailed === 0 && u.pos >= 0; }
  /** Best guess for where the enemy flag stand is (exact: maps are point-symmetric). */
  enemyFlagStand(team) { return this.bases[1 - team].flag; }

  freeTileNear(start) {
    const seen = new Set([start]);
    let frontier = [start];
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        if (PASSABLE[this.terrain[i]] && !this.unitAt(i) && i !== this.bases[0].flag && i !== this.bases[1].flag) return i;
        for (const n of this.grid.nbr[i]) {
          if (!seen.has(n) && PASSABLE[this.terrain[n]]) { seen.add(n); next.push(n); }
        }
      }
      frontier = next;
    }
    return start;
  }

  emitTeam(team, ev) {
    for (const p of this.players) {
      if (p.team !== team) continue;
      const q = this.evq.get(p.id);
      if (q) { q.push(ev); if (q.length > 300) q.shift(); }
    }
  }
  emitAll(ev) { this.emitTeam(0, ev); this.emitTeam(1, ev); }

  // ----------------------------------------------------------------- vision

  los(a, b, elevated) {
    for (const i of this.grid.between(a, b)) {
      const t = this.terrain[i];
      if (t === 'm' || (t === 'f' && !elevated)) return false;
    }
    return true;
  }

  inFlare(team, idx) {
    for (const f of this.flares) {
      if (f.team === team && this.grid.dist(f.pos, idx) <= f.r) return true;
    }
    return false;
  }

  computeVisible(team) {
    const k = this.know[team];
    if (!this.fog || this.over) {
      k.visible.fill(1);
      k.explored.fill(1);
      return;
    }
    k.visible.fill(0);
    for (const u of this.units) {
      if (u.team !== team || !this.isFree(u)) continue;
      const t = this.terrain[u.pos];
      const elevated = t === 'h' || t === 't';
      const range = CLASSES[u.cls].vision + (t === 'h' ? 2 : t === 't' ? 3 : 0);
      for (const i of this.grid.within(u.pos, range)) {
        if (!k.visible[i] && this.los(u.pos, i, elevated)) k.visible[i] = 1;
      }
    }
    for (const f of this.flares) {
      if (f.team !== team) continue;
      for (const i of this.grid.within(f.pos, f.r)) k.visible[i] = 1;
    }
    for (const i of this.grid.within(this.bases[team].flag, 1)) k.visible[i] = 1;
    for (let i = 0; i < k.visible.length; i++) if (k.visible[i]) k.explored[i] = 1;
    for (const tr of this.traps) {
      if (tr.team !== team && this.inFlare(team, tr.pos)) tr.seen[team] = true;
    }
  }

  refreshVision() { this.computeVisible(0); this.computeVisible(1); }

  /** Can `team` currently see unit `u`? */
  seesUnit(team, u) {
    if (u.team === team || u.jailed > 0 || !this.fog || this.over) return true;
    if (u.pos < 0) return false;
    if (u.flag) return true; // flag carriers are a beacon
    if (!this.know[team].visible[u.pos]) return false;
    const hidden = this.terrain[u.pos] === 'f' || u.buffs.cloak > 0;
    if (!hidden) return true;
    if (this.inFlare(team, u.pos)) return true;
    for (const o of this.units) {
      if (o.team === team && this.isFree(o) && this.grid.dist(o.pos, u.pos) <= 1) return true;
    }
    return false;
  }

  visibleEnemies(team) {
    return this.units.filter((u) => u.team !== team && this.isFree(u) && this.seesUnit(team, u));
  }

  // ------------------------------------------------------------ action info

  canAct(u) {
    return !this.over && u && u.team === this.turnTeam && this.isFree(u);
  }

  /** Map tileIdx -> {cost, prev} of tiles the unit can move to, using only what its team knows. */
  reach(u) {
    const out = new Map();
    if (!this.canAct(u) || u.ap <= 0) return out;
    const k = this.know[u.team];
    const blocked = new Set();
    for (const o of this.units) {
      if (o !== u && o.pos >= 0 && this.seesUnit(u.team, o)) blocked.add(o.pos);
    }
    blocked.add(this.bases[u.team].flag); // own flag stand is off limits to its own team
    const best = new Map([[u.pos, 0]]);
    const open = [[0, u.pos]];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [c, i] = open.splice(bi, 1)[0];
      if (c > best.get(i)) continue;
      const steps = this.grid.nbr[i].map((n) => [n, PASSABLE[this.terrain[n]], false]);
      if (this.terrain[i] === 'p') steps.push([this.grid.mirror(i), 1, true]);
      for (const [n, cost, portal] of steps) {
        if (!cost || blocked.has(n)) continue;
        if (!portal && !k.explored[n]) continue;
        const nc = c + cost;
        if (nc > u.ap) continue;
        if (best.has(n) && best.get(n) <= nc) continue;
        best.set(n, nc);
        out.set(n, { cost: nc, prev: i });
        open.push([nc, n]);
      }
    }
    return out;
  }

  tagTargets(u) {
    if (!this.canAct(u) || u.ap < TAG_COST) return [];
    const reach = CLASSES[u.cls].reach;
    return this.units.filter((e) => {
      if (e.team === u.team || !this.isFree(e)) return false;
      if (this.zone[e.pos] !== u.team || e.safe) return false;
      const d = this.grid.dist(u.pos, e.pos);
      if (d > reach) return false;
      if (!this.seesUnit(u.team, e)) return false;
      return d <= 1 || this.los(u.pos, e.pos, false);
    });
  }

  abilityInfo(u) {
    const kind = CLASSES[u.cls].ability;
    const ready = this.canAct(u) && u.cd === 0 && !(u.stunned > 0);
    let targets = null;
    if (kind === 'flare') {
      targets = ready ? this.grid.within(u.pos, FLARE_RANGE) : [];
    } else if (kind === 'trap') {
      targets = [];
      if (ready) {
        for (const i of [u.pos, ...this.grid.nbr[u.pos]]) {
          const t = this.terrain[i];
          if (!PASSABLE[t] || t === 'p') continue;
          if (i === this.bases[0].flag || i === this.bases[1].flag) continue;
          if (this.traps.some((tr) => tr.pos === i && (tr.team === u.team || tr.seen[u.team]))) continue;
          const o = this.unitAt(i);
          if (o && o !== u) continue;
          targets.push(i);
        }
      }
    }
    return { kind, ready, targets };
  }

  canRescue(u) {
    if (!this.canAct(u) || u.ap < 1) return false;
    if (this.grid.dist(u.pos, this.bases[1 - u.team].jail) > 1) return false;
    return this.units.some((o) => o.team === u.team && o.jailed > 0);
  }

  // ---------------------------------------------------------------- actions

  move(u, to) {
    const reach = this.reach(u);
    if (!reach.has(to)) return false;
    const path = [];
    for (let i = to; i !== u.pos; i = reach.get(i).prev) path.push(i);
    path.reverse();

    const seenPath = [[], []];
    for (const t of [0, 1]) if (this.seesUnit(t, u)) seenPath[t].push(u.pos);
    let spent = 0;
    for (const n of path) {
      if (this.unitAt(n)) {
        this.emitTeam(u.team, { e: 'log', team: u.team, msg: `${u.name} ran into something hidden!` });
        if (spent === 0) u.ap -= 1; // a blocked first step (portal jump) still costs the attempt
        break;
      }
      const cost = reach.get(n).cost - spent;
      spent += cost;
      u.ap -= cost;
      u.pos = n;
      this.computeVisible(u.team);
      for (const t of [0, 1]) if (this.seesUnit(t, u)) seenPath[t].push(n);
      if (this.enterTile(u, n)) break;
    }
    for (const t of [0, 1]) {
      if (seenPath[t].length > 1) this.emitTeam(t, { e: 'move', id: u.id, path: seenPath[t] });
    }
    this.refreshVision();
    return true;
  }

  /** Apply tile effects after a step. Returns true if the move must stop. */
  enterTile(u, n) {
    const foe = 1 - u.team;
    let stop = false;

    const ti = this.traps.findIndex((tr) => tr.pos === n && tr.team !== u.team);
    if (ti >= 0) {
      this.traps.splice(ti, 1);
      u.stunned = 2;
      u.ap = 0;
      stop = true;
      const msg = `${u.name} stepped on a trap and is stunned!`;
      this.emitTeam(u.team, { e: 'trap', id: u.id, at: n, team: foe, msg });
      this.emitTeam(foe, { e: 'trap', id: u.id, at: this.know[foe].visible[n] ? n : -1, team: foe, msg });
    }

    const ci = this.crates.findIndex((c) => c.pos === n);
    if (ci >= 0) {
      const kind = this.crates[ci].kind;
      this.crates.splice(ci, 1);
      if (kind === 'haste') { u.buffs.haste = 3; if (!u.stunned) u.ap += HASTE_AP; }
      else if (kind === 'cloak') u.buffs.cloak = 3;
      else u.buffs.shield = true;
      this.emitTeam(u.team, { e: 'pickup', id: u.id, kind, at: n, team: u.team, msg: `${u.name} grabbed a ${kind} crate` });
      if (this.seesUnit(foe, u)) this.emitTeam(foe, { e: 'pickup', id: u.id, kind, at: n, team: u.team, msg: `${u.name} grabbed a ${kind} crate` });
    }

    const theirs = this.flags[foe], ours = this.flags[u.team];
    if (!u.flag && theirs.state !== 'carried' && theirs.pos === n) {
      theirs.state = 'carried';
      theirs.carrier = u.id;
      theirs.pos = n;
      u.flag = true;
      u.buffs.cloak = 0;
      u.safe = true; // cannot be tagged until its team's next turn starts
      stop = true;
      this.emitAll({ e: 'flag', kind: 'taken', team: foe, by: u.id, at: n, msg: `${u.name} has taken the ${TEAM[foe]} flag!` });
    }
    if (ours.state === 'dropped' && ours.pos === n) {
      ours.state = 'home';
      ours.pos = this.bases[u.team].flag;
      this.emitAll({ e: 'flag', kind: 'returned', team: u.team, by: u.id, at: n, msg: `${u.name} returned the ${TEAM[u.team]} flag` });
    }
    if (u.flag) theirs.pos = n;
    if (u.flag && this.grid.dist(n, this.bases[u.team].flag) <= 1) {
      u.flag = false;
      theirs.state = 'home';
      theirs.carrier = null;
      theirs.pos = this.bases[foe].flag;
      this.scores[u.team]++;
      stop = true;
      this.emitAll({ e: 'flag', kind: 'captured', team: foe, by: u.id, at: n, msg: `${u.name} CAPTURED the ${TEAM[foe]} flag! (${this.scores[0]} - ${this.scores[1]})` });
      if (this.scores[u.team] >= this.settings.capsToWin) this.finish(u.team, `${TEAM[u.team]} reached ${this.settings.capsToWin} captures`);
    }
    return stop;
  }

  dropFlag(u) {
    if (!u.flag) return;
    const f = this.flags[1 - u.team];
    u.flag = false;
    f.carrier = null;
    if (u.pos === this.bases[f.team].flag) {
      f.state = 'home';
      f.pos = this.bases[f.team].flag;
      this.emitAll({ e: 'flag', kind: 'returned', team: f.team, by: null, at: f.pos, msg: `The ${TEAM[f.team]} flag is back home` });
    } else {
      f.state = 'dropped';
      f.pos = u.pos;
      this.emitAll({ e: 'flag', kind: 'dropped', team: f.team, by: u.id, at: f.pos, msg: `The ${TEAM[f.team]} flag was dropped!` });
    }
  }

  tag(u, target) {
    if (!target || !this.tagTargets(u).includes(target)) return false;
    u.ap -= TAG_COST;
    u.buffs.cloak = 0;
    const at = target.pos;
    const atFor = (t) => (this.know[t].visible[at] || t === u.team ? at : -1);
    if (target.buffs.shield) {
      target.buffs.shield = false;
      for (const t of [0, 1]) {
        this.emitTeam(t, { e: 'shield', id: target.id, at: atFor(t), team: target.team, msg: `${target.name}'s shield absorbed a tag from ${u.name}` });
      }
    } else {
      this.dropFlag(target);
      target.pos = -1;
      target.jailed = this.settings.jailTurns;
      target.stunned = 0;
      target.ap = 0;
      target.buffs = { haste: 0, cloak: 0, shield: false };
      for (const t of [0, 1]) {
        this.emitTeam(t, { e: 'tag', by: u.id, target: target.id, at: atFor(t), team: u.team, msg: `${u.name} tagged ${target.name} — off to jail for ${target.jailed} turns` });
      }
    }
    this.refreshVision();
    return true;
  }

  ability(u, targetIdx) {
    const info = this.abilityInfo(u);
    if (!info.ready) return false;
    const foe = 1 - u.team;
    if (info.kind === 'dash') {
      u.ap += DASH_AP;
      const ev = { e: 'ability', id: u.id, kind: 'dash', at: u.pos, team: u.team, msg: `${u.name} dashes (+${DASH_AP} AP)` };
      this.emitTeam(u.team, ev);
      if (this.seesUnit(foe, u)) this.emitTeam(foe, ev);
    } else if (info.kind === 'flare') {
      if (!info.targets.includes(targetIdx)) return false;
      this.flares.push({ pos: targetIdx, r: FLARE_RADIUS, team: u.team });
      this.emitAll({ e: 'ability', id: u.id, kind: 'flare', at: targetIdx, team: u.team, msg: `${TEAM[u.team]} fired a flare` });
    } else {
      if (!info.targets.includes(targetIdx)) return false;
      const mine = this.traps.filter((tr) => tr.owner === u.id);
      if (mine.length >= MAX_TRAPS) this.traps.splice(this.traps.indexOf(mine[0]), 1);
      this.traps.push({ pos: targetIdx, team: u.team, owner: u.id, seen: [false, false] });
      this.emitTeam(u.team, { e: 'ability', id: u.id, kind: 'trap', at: targetIdx, team: u.team, msg: `${u.name} set a trap` });
    }
    u.cd = CLASSES[u.cls].cd;
    this.refreshVision();
    return true;
  }

  rescue(u) {
    if (!this.canRescue(u)) return false;
    u.ap -= 1;
    const ids = [];
    for (const o of this.units) {
      if (o.team === u.team && o.jailed > 0) { this.release(o); o.ap = 0; ids.push(o.id); }
    }
    this.emitAll({ e: 'jailfree', team: u.team, ids, msg: `JAILBREAK! ${u.name} freed ${ids.length} ${TEAM[u.team]} prisoner${ids.length > 1 ? 's' : ''}` });
    this.refreshVision();
    return true;
  }

  release(u) {
    u.jailed = 0;
    u.pos = this.freeTileNear(this.bases[u.team].spawn);
  }

  // ------------------------------------------------------------------ turns

  nextTurn() {
    if (this.over) return;
    this.turnTeam = 1 - this.turnTeam;
    this.ended.clear();
    if (this.turnTeam === this.firstTeam) {
      this.round++;
      const limit = this.settings.roundLimit;
      if (limit && this.round > limit) {
        const [a, b] = this.scores;
        this.finish(a === b ? -1 : a > b ? 0 : 1, `Round limit reached (${a} - ${b})`);
        return;
      }
      if (this.round % CRATE_EVERY === 2) this.dropCrates();
    }
    const team = this.turnTeam;
    this.flares = this.flares.filter((f) => f.team !== team);
    const freed = [];
    for (const u of this.units) {
      if (u.team !== team) continue;
      if (u.cd > 0) u.cd--;
      u.safe = false;
      if (u.buffs.haste > 0) u.buffs.haste--;
      if (u.buffs.cloak > 0) u.buffs.cloak--;
      if (u.jailed > 0) {
        u.jailed--;
        if (u.jailed === 0) { this.release(u); freed.push(u.id); }
      }
      if (u.stunned > 0) u.stunned--;
      u.ap = u.jailed > 0 || u.stunned > 0 ? 0 : this.maxAp(u);
    }
    for (const u of this.units) if (u.team !== team) u.ap = 0;
    if (freed.length) {
      this.emitAll({ e: 'jailfree', team, ids: freed, msg: `${freed.length} ${TEAM[team]} prisoner${freed.length > 1 ? 's' : ''} served their time` });
    }
    this.refreshVision();
    this.emitAll({ e: 'turn', team, round: this.round, msg: `Round ${this.round} — ${TEAM[team]}'s turn` });
  }

  dropCrates() {
    if (this.crates.length >= MAX_CRATES || !this.crateSpots.length) return;
    for (let attempt = 0; attempt < 20; attempt++) {
      const a = this.crateSpots[(this.rng() * this.crateSpots.length) | 0];
      const b = this.grid.mirror(a);
      const busy = (i) => this.unitAt(i) || this.crates.some((c) => c.pos === i) || this.traps.some((t) => t.pos === i) ||
        this.flags.some((f) => f.pos === i);
      if (busy(a) || busy(b)) continue;
      const kind = CRATE_KINDS[(this.rng() * CRATE_KINDS.length) | 0];
      this.crates.push({ pos: a, kind }, { pos: b, kind });
      this.emitAll({ e: 'crates', msg: 'Supply crates dropped near the midline' });
      return;
    }
  }

  finish(winner, reason) {
    if (this.over) return;
    this.over = { winner, reason };
    this.turnEndsAt = 0;
    this.refreshVision();
    this.emitAll({ e: 'over', winner, team: winner >= 0 ? winner : undefined, msg: winner < 0 ? `Draw — ${reason}` : `${TEAM[winner]} wins — ${reason}` });
  }

  // --------------------------------------------------------------- snapshot

  snapshot(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    const team = p.team, foe = 1 - team;
    const k = this.know[team];
    const n = this.grid.n;
    const all = !this.fog || !!this.over;
    let terrain = '', vis = '', zone = '';
    for (let i = 0; i < n; i++) {
      const t = this.terrain[i];
      terrain += t === ' ' || all || k.explored[i] ? t : '?';
      vis += all || k.visible[i] ? '1' : '0';
      zone += this.zone[i];
    }
    const units = this.units.filter((u) => this.seesUnit(team, u)).map((u) => ({
      id: u.id, owner: u.owner, team: u.team, cls: u.cls, name: u.name,
      pos: u.pos, ap: u.ap, maxAp: this.maxAp(u), jailed: u.jailed, stunned: u.stunned > 0,
      flag: u.flag, safe: u.safe, buffs: { ...u.buffs }, cd: u.cd,
    }));
    const flags = this.flags.map((f) => {
      const known = all || f.team === team || f.state === 'carried' ||
        f.state === 'dropped' || k.explored[f.pos]; // drops are announced publicly
      return { team: f.team, state: f.state, pos: known ? f.pos : -1, carrier: f.carrier };
    });
    const bases = this.bases.map((b) => {
      const see = (i) => (all || b.team === team || k.explored[i] ? i : -1);
      return { team: b.team, flag: see(b.flag), jail: see(b.jail), spawn: see(b.spawn) };
    });
    const actions = {};
    if (!this.over && this.turnTeam === team) {
      for (const u of this.units) {
        if (u.owner !== playerId || !this.isFree(u)) continue;
        const reach = [];
        const rmap = this.reach(u);
        for (const [idx, v] of rmap) reach.push(idx, v.cost, v.prev);
        let portal = null;
        if (this.terrain[u.pos] === 'p') {
          const to = this.grid.mirror(u.pos);
          const ok = rmap.has(to) && rmap.get(to).prev === u.pos;
          portal = { to, ok, why: ok ? '' : u.ap < 1 ? 'No AP left for the jump (it costs 1)' : 'The exit portal is occupied' };
        }
        actions[u.id] = {
          portal,
          reach,
          tags: this.tagTargets(u).map((e) => e.id),
          ability: this.abilityInfo(u),
          rescue: this.canRescue(u),
        };
      }
    }
    const q = this.evq.get(playerId) || [];
    const events = q.splice(0, q.length);
    return {
      t: 'game',
      w: this.w, h: this.h, zone, terrain, vis,
      you: { id: playerId, team },
      round: this.round, turnTeam: this.turnTeam,
      turnEndsAt: this.turnEndsAt, now: Date.now(),
      scores: this.scores, capsToWin: this.settings.capsToWin,
      roundLimit: this.settings.roundLimit, jailTurns: this.settings.jailTurns,
      players: this.players,
      ended: [...this.ended],
      units, flags, bases,
      traps: this.traps.filter((t) => all || t.team === team || t.seen[team]).map((t) => ({ pos: t.pos, team: t.team })),
      crates: this.crates.filter((c) => all || k.visible[c.pos]),
      flares: this.flares.map((f) => ({ pos: f.pos, r: f.r, team: f.team })),
      actions, events,
      over: this.over,
    };
  }
}

module.exports = { Game, CLASSES, TEAM, TAG_COST };
