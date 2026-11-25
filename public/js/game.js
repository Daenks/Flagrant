// In-game controller: snapshot handling, animations, ghosts, input, HUD.
import { makeMovable } from './drag.js';
import { $, el, esc, sfx, toast, idEq, clamp, TEAM, teamName, teamColor, CLASSES, className, TERRAIN, ZONES, flagSvg, isMuted, setMuted } from './util.js';
import { tileXY, pixelToTile, isGeomVoid, hexDist, adjacent } from './hex.js';
import { Renderer, Minimap, tileFog, teamRgb, CRATE_RGB } from './renderer.js';

const MOVE_MS = 90;
const PAN_SPEED = 700; // screen px / s

function unitIcon(cls, team) {
  const col = teamColor(team);
  let g;
  switch (cls) {
    case 'scout': g = '<path d="M7.5 8l4.5 5-4.5 5M13 8l4.5 5-4.5 5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'; break;
    case 'sentinel': g = '<path d="M5.5 13q7.5-7.5 15 0q-7.5 7.5-15 0z" stroke="#fff" stroke-width="1.7" fill="none"/><circle cx="13" cy="13" r="2.5" fill="#fff"/>'; break;
    case 'saboteur': g = '<path d="M13 6.5v13M7.4 9.8l11.2 6.4M7.4 16.2l11.2-6.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>'; break;
    default: g = '<circle cx="13" cy="13" r="3" fill="#fff"/>';
  }
  return `<svg class="uicon" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11.5" fill="${col}" stroke="rgba(0,0,0,.55)"/>${g}</svg>`;
}

function statusHtml(u, long = false) {
  const s = [];
  if (u.jailed > 0) s.push(`<span class="status jail">Jail ${u.jailed}</span>`);
  if (u.stunned) s.push('<span class="status stun">Stunned</span>');
  if (u.safe) s.push('<span class="status">Safe</span>');
  if (u.flag) s.push('<span class="status flag">Flag</span>');
  const b = u.buffs || {};
  if (b.shield) s.push('<span class="status shield">Shield</span>');
  if (b.haste) s.push(`<span class="status haste">Haste${long ? ' ' + b.haste : ''}</span>`);
  if (b.cloak) s.push(`<span class="status cloak">Cloak${long ? ' ' + b.cloak : ''}</span>`);
  return s.join('');
}

export class GameUI {
  constructor({ state, net, log, onLeave }) {
    this.state = state;
    this.net = net;
    this.log = log;
    this.onLeave = onLeave;
    this.canvas = $('#map');
    this.r = new Renderer(this.canvas);
    this.mini = new Minimap($('#minimap'), this.r);
    this.active = false;
    this.g = null;
    this.units = new Map();
    this.sel = null;
    this.mode = null;          // null | 'ability' | 'ping' | 'handoff'
    this.hover = -1;
    this.mouse = null;         // {x,y} screen coords for tooltip
    this.ghosts = new Map();
    this.lastUnits = new Map();
    this.queue = [];
    this.cur = null;
    this.effects = [];
    this.pings = [];
    this.keys = new Set();
    this.clockOffset = 0;
    this.lastFrame = performance.now();
    this._rc = null;

    this._bindInput();
    this._bindHud();
    this._placePanels = [makeMovable($('#sidepanel'), $('#sideHandle')), makeMovable($('#logPanel'), $('#logHandle'))];
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
    setInterval(() => {
      // rAF pauses in background tabs; keep the animation queue draining so state never lags
      if (this.g && (this.cur || this.queue.length)) { try { this._stepAnim(performance.now()); } catch (e) { console.error(e); } }
      this._tickTimer();
    }, 250);
    window.addEventListener('resize', () => { this.r.resize(); });
  }

  // ------------------------------------------------------------ helpers
  get myId() { return this.g?.you?.id ?? this.state.me?.id; }
  get myTeam() { return this.g?.you?.team; }
  get myTurn() { return !!this.g && !this.g.over && this.g.turnTeam === this.myTeam; }
  get isHost() { return idEq(this.state.room?.hostId, this.myId); }
  _unit(id) { return id == null ? null : this.units.get(String(id)) || null; }
  _act(id) {
    if (id == null || !this.g?.actions || this.g.over) return null;
    return this.g.actions[id] ?? this.g.actions[String(id)] ?? null;
  }
  _myUnits() { return (this.g?.units || []).filter((u) => u && idEq(u.owner, this.myId)); }
  _xy(i) { return tileXY(i, this.g.w); }
  _reach() {
    const id = this.sel;
    if (id == null || !this.g) return null;
    if (this._rc && this._rc.g === this.g && this._rc.id === id) return this._rc.map;
    const a = this._act(id);
    let map = null;
    if (a && Array.isArray(a.reach)) {
      map = new Map();
      for (let k = 0; k + 2 < a.reach.length; k += 3) map.set(a.reach[k], { cost: a.reach[k + 1], prev: a.reach[k + 2] });
    }
    this._rc = { g: this.g, id, map };
    return map;
  }
  _pathTo(idx) {
    const reach = this._reach();
    const u = this._unit(this.sel);
    if (!reach || !u || !reach.has(idx)) return null;
    const path = [idx];
    let cur = idx;
    for (let guard = 0; guard < 300; guard++) {
      const p = reach.get(cur)?.prev;
      if (p == null || p < 0 || p === u.pos) { path.push(u.pos); break; }
      path.push(p);
      if (!reach.has(p)) break;
      cur = p;
    }
    return path.reverse();
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    if (on) { this.r.resize(); this.renderHud(); }
    else { $('#tooltip').hidden = true; this.keys.clear(); }
  }

  reset() {
    this.g = null;
    this.units = new Map();
    this.sel = null; this.mode = null; this.hover = -1;
    this.ghosts.clear(); this.lastUnits.clear();
    this.queue = []; this.cur = null; this.effects = []; this.pings = [];
    this._rc = null;
    this.r.g = null;
    $('#overOverlay').hidden = true;
    $('#tooltip').hidden = true;
    $('#banner').innerHTML = '';
  }

  // ------------------------------------------------------------ snapshots
  onSnapshot(g) {
    if (!g || !(g.w > 0) || !(g.h > 0)) return;
    g.units = Array.isArray(g.units) ? g.units.filter((u) => u && typeof u === 'object') : [];
    const prev = this.g;
    const fresh = !prev || prev.w !== g.w || prev.h !== g.h || (g.round || 0) < (prev.round || 0)
      || !idEq(prev.you?.id, g.you?.id) || (prev.over && !g.over);
    const nowPerf = performance.now();
    if (Number.isFinite(g.now)) this.clockOffset = g.now - Date.now();

    if (fresh) {
      this.ghosts.clear(); this.lastUnits.clear();
      this.queue = []; this.cur = null; this.effects = [];
      this.sel = null; this.mode = null;
    } else if (this.cur || this.queue.length) {
      this._fastForward(nowPerf);
    }

    this.g = g;
    this.units = new Map(g.units.map((u) => [String(u.id), u]));
    const sizeChanged = this.r.setMap(g);
    if (fresh || sizeChanged) {
      this.r.resize();
      this.r.cam.z = window.innerWidth < 700 ? 0.75 : 1;
      this._centerHome(false);
      for (const place of this._placePanels) place();
    }
    this._updateGhosts(fresh ? null : prev, g);

    const evs = Array.isArray(g.events) ? g.events : [];
    for (const ev of evs) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.msg) this.log.event(ev.msg, ev.team);
      if (!fresh) this.queue.push({ ev, dur: this._dur(ev) });
    }
    if (!fresh && prev.turnTeam !== g.turnTeam && !g.over && !evs.some((e) => e?.e === 'turn')) {
      this.queue.push({ ev: { e: 'turn', team: g.turnTeam }, dur: 0 });
    }
    for (const u of g.units) if (u.pos >= 0) this.lastUnits.set(String(u.id), { ...u });

    // selection upkeep
    if (this.sel != null && !this.units.has(String(this.sel))) this.sel = null;
    if (this.mode === 'ability' && !this._abilityTargets()) this.mode = null;
    const turnStarted = fresh || prev.turnTeam !== g.turnTeam;
    if (this.myTurn && turnStarted && (this.sel == null || !this._act(this.sel))) {
      const first = this._myUnits().find((u) => this._act(u.id) && u.ap > 0 && !(u.jailed > 0));
      if (first) this.sel = first.id;
    }
    if (g.over && !fresh && prev && !prev.over) {
      const w = g.over.winner;
      sfx(w === this.myTeam ? 'win' : w === -1 ? 'turn' : 'lose');
    }
    this.renderHud();
  }

  onPing(m) {
    if (!this.g || !(m.idx >= 0)) return;
    // `from` may be an id or a name; our own pings were already shown locally
    const recent = this.pings.some((p) => p.local && p.idx === m.idx && performance.now() - p.start < 2000);
    if (idEq(m.from, this.myId) || (recent && m.from === this.state.me?.name)) return;
    this.pings.push({ idx: m.idx, start: performance.now() });
    const p = (this.g.players || this.state.room?.players || []).find((pl) => idEq(pl.id, m.from));
    this.log.ping(p ? p.name : m.from != null ? String(m.from) : 'Teammate');
    sfx('ping');
  }

  _sendPing(idx) {
    if (!(idx >= 0)) return;
    this.net.send({ t: 'ping', idx });
    this.pings.push({ idx, start: performance.now(), local: true });
    sfx('ping');
  }

  _centerHome(smooth) {
    const g = this.g;
    const b = g.bases?.[this.myTeam];
    let i = b && b.spawn >= 0 ? b.spawn : b && b.flag >= 0 ? b.flag : -1;
    if (i < 0) { const own = this._myUnits().find((u) => u.pos >= 0); if (own) i = own.pos; }
    if (i >= 0) { const [x, y] = this._xy(i); this.r.centerOn(x, y, smooth); }
    else { const bd = this.r.bounds; this.r.centerOn((bd.x0 + bd.x1) / 2, (bd.y0 + bd.y1) / 2, smooth); }
  }

  _updateGhosts(prev, g) {
    if (g.over) { this.ghosts.clear(); return; }
    const myTeam = g.you?.team;
    for (const id of [...this.ghosts.keys()]) if (this.units.has(id)) this.ghosts.delete(id);
    if (prev) {
      for (const u of prev.units || []) {
        if (!u || u.team === myTeam || !(u.pos >= 0)) continue;
        const id = String(u.id);
        if (this.units.has(id) || this.ghosts.has(id)) continue;
        let pos = u.pos;
        const mv = (g.events || []).filter((e) => e && e.e === 'move' && idEq(e.id, u.id) && Array.isArray(e.path) && e.path.length).pop();
        if (mv) pos = mv.path[mv.path.length - 1];
        this.ghosts.set(id, { u: { ...u, pos }, pos, round: g.round || 0, wasHidden: false });
      }
    }
    const mine = g.units.filter((u) => u.team === myTeam && u.pos >= 0);
    for (const [id, gh] of this.ghosts) {
      if ((g.round || 0) - gh.round >= 2) { this.ghosts.delete(id); continue; }
      const vis = g.vis?.[gh.pos] === '1';
      if (!vis) gh.wasHidden = true;
      else if (gh.wasHidden) { this.ghosts.delete(id); continue; }
      if (mine.some((m) => hexDist(m.pos, gh.pos, g.w) <= 1)) this.ghosts.delete(id);
    }
  }

  // ------------------------------------------------------------ animation queue
  _dur(ev) {
    switch (ev.e) {
      case 'move': return Array.isArray(ev.path) && ev.path.length > 1 ? (ev.path.length - 1) * MOVE_MS : 0;
      case 'tag': return 380;
      case 'flag': return ev.kind === 'captured' ? 700 : 260;
      case 'trap': return 320;
      case 'shield': return 260;
      case 'ability': return 240;
      case 'pickup': return 160;
      case 'jailfree': return 220;
      default: return 0;
    }
  }

  _fastForward(now) {
    this.cur = null;
    const q = this.queue;
    this.queue = [];
    for (const a of q) { try { this._startAnim(a, now, true); } catch (e) { console.error(e); } }
  }

  _stepAnim(now) {
    for (let guard = 0; guard < 100; guard++) {
      if (!this.cur) {
        if (!this.queue.length) return;
        this.cur = this.queue.shift();
        this.cur.t0 = now;
        try { this._startAnim(this.cur, now, false); } catch (e) { console.error(e); }
      }
      if (now - this.cur.t0 >= this.cur.dur) { this.cur = null; continue; }
      return;
    }
  }

  _pendingStart(id) {
    for (const q of this.queue) {
      const ev = q.ev;
      if (ev.e === 'move' && idEq(ev.id, id) && Array.isArray(ev.path) && ev.path.length > 1) return ev.path[0];
    }
    return null;
  }

  _animPos(a, now) {
    const p = a.ev.path;
    const el = (now - a.t0) / MOVE_MS;
    const k = Math.min(p.length - 1, Math.max(0, Math.floor(el)));
    if (k >= p.length - 1) return this._xy(p[p.length - 1]);
    const f = el - k;
    const A = this._xy(p[k]), B = this._xy(p[k + 1]);
    if (!adjacent(p[k], p[k + 1], this.g.w, this.g.h)) return f < 0.5 ? A : B;
    const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    return [A[0] + (B[0] - A[0]) * e, A[1] + (B[1] - A[1]) * e];
  }

  _startAnim(a, now, instant) {
    const ev = a.ev, g = this.g, myTeam = this.myTeam;
    const fx = (type, i, rgb, dur, extra = {}, delay = 0) => {
      if (instant || !(i >= 0)) return;
      const [x, y] = this._xy(i);
      this.effects.push({ type, x, y, rgb, dur, start: now + delay, seed: Math.random() * 6, ...extra });
    };
    switch (ev.e) {
      case 'move': {
        if (instant || !Array.isArray(ev.path) || ev.path.length < 2) break;
        sfx('move');
        for (let k = 0; k + 1 < ev.path.length; k++) {
          if (!adjacent(ev.path[k], ev.path[k + 1], g.w, g.h)) {
            fx('beam', ev.path[k], [200, 160, 255], 500, {}, k * MOVE_MS);
            fx('beam', ev.path[k + 1], [140, 220, 255], 500, {}, k * MOVE_MS + MOVE_MS / 2);
          }
        }
        break;
      }
      case 'tag': {
        const tu = this._unit(ev.target);
        sfx(tu && tu.team === myTeam ? 'tagged' : 'tag');
        fx('burst', ev.at, [255, 90, 95], 650);
        fx('text', ev.at, [255, 255, 255], 950, { text: 'TAGGED!' });
        break;
      }
      case 'shield':
        sfx('ability');
        fx('ring', ev.at, CRATE_RGB.shield, 650, { r: 26 });
        fx('text', ev.at, CRATE_RGB.shield, 950, { text: 'BLOCKED' });
        break;
      case 'jailfree': {
        sfx('rescue');
        const sp = g.bases?.[ev.team]?.spawn;
        fx('beam', sp, teamRgb(ev.team), 900);
        fx('ring', g.bases?.[1 - ev.team]?.jail, [52, 211, 153], 700, { r: 30 });
        break;
      }
      case 'flag': {
        const rgb = teamRgb(ev.team);
        if (ev.kind === 'taken') {
          sfx('flagTaken'); fx('sparkle', ev.at, rgb, 800);
          this.banner(`${teamName(ev.team)} flag taken!`, ev.team, 'small');
        } else if (ev.kind === 'dropped') {
          sfx('flagDropped'); fx('ring', ev.at, rgb, 700, { r: 28 });
        } else if (ev.kind === 'passed') {
          sfx('click'); fx('ring', ev.at, rgb, 600, { r: 24 });
          fx('text', ev.at, [255, 255, 255], 900, { text: 'HANDOFF' });
        } else if (ev.kind === 'returned') {
          sfx('flagReturned'); fx('beam', ev.at, rgb, 900);
        } else if (ev.kind === 'captured') {
          const cap = ev.team === 0 || ev.team === 1 ? 1 - ev.team : -1;
          sfx(cap === myTeam ? 'capture' : 'enemyCapture');
          fx('burst', ev.at, teamRgb(cap), 900);
          if (!g.over) this.banner(`${teamName(cap)} scores!`, cap, 'big');
        }
        break;
      }
      case 'pickup':
        sfx('pickup');
        fx('sparkle', ev.at, CRATE_RGB[ev.kind] || [255, 255, 255], 800);
        fx('text', ev.at, CRATE_RGB[ev.kind] || [255, 255, 255], 1000, { text: String(ev.kind || 'crate').toUpperCase() });
        break;
      case 'trap':
        sfx('trap');
        fx('burst', ev.at, [250, 204, 21], 650);
        fx('text', ev.at, [250, 204, 21], 1000, { text: 'STUNNED' });
        break;
      case 'ability': {
        sfx('ability');
        let at = ev.at;
        if (!(at >= 0)) at = this._unit(ev.id)?.pos;
        const rgb = ev.kind === 'dash' ? [251, 146, 60] : ev.kind === 'flare' ? [255, 226, 140] : [168, 85, 247];
        fx(ev.kind === 'flare' ? 'burst' : 'ring', at, rgb, 700, { r: 24 });
        if (ev.kind === 'dash') fx('text', at, rgb, 900, { text: '+AP' });
        break;
      }
      case 'turn':
        if (g.over) break;
        if (ev.team === myTeam) { sfx('turn'); this.banner('Your turn', ev.team); }
        else this.banner(`${teamName(ev.team)}'s turn`, ev.team, 'small');
        break;
      default: break;
    }
  }

  banner(text, team, size = '') {
    const b = $('#banner');
    b.innerHTML = '';
    const d = el('div', { class: 'bn ' + size, text });
    d.style.setProperty('--bc', team === 0 ? 'rgba(229,72,77,.6)' : team === 1 ? 'rgba(59,130,246,.6)' : 'rgba(255,255,255,.15)');
    b.append(d);
    setTimeout(() => d.remove(), 3000);
  }

  // ------------------------------------------------------------ frame
  _frame(ts) {
    requestAnimationFrame(this._frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.active || !this.g) return;
    try {
      let kx = 0, ky = 0;
      if (this.keys.has('left')) kx -= 1;
      if (this.keys.has('right')) kx += 1;
      if (this.keys.has('up')) ky -= 1;
      if (this.keys.has('down')) ky += 1;
      if (kx || ky) this.r.pan(-kx * PAN_SPEED * dt, -ky * PAN_SPEED * dt);
      this._stepAnim(now);
      this.effects = this.effects.filter((e) => now < e.start + e.dur);
      this.pings = this.pings.filter((p) => now - p.start < 3000);
      const view = this._buildView(now);
      this.r.draw(view);
      this.mini.draw(view);
    } catch (e) {
      console.error(e);
    }
  }

  _abilityTargets() {
    const a = this._act(this.sel)?.ability;
    if (!a || !a.ready || !Array.isArray(a.targets)) return null;
    return a;
  }

  _buildView(now) {
    const g = this.g, myId = this.myId, myTurn = this.myTurn;
    const units = [];
    const cur = this.cur && this.cur.ev.e === 'move' && Array.isArray(this.cur.ev.path) && this.cur.ev.path.length > 1 ? this.cur : null;
    const curId = cur ? String(cur.ev.id) : null;
    let curDrawn = false;
    for (const u of g.units) {
      const isCur = curId != null && String(u.id) === curId;
      let x, y;
      if (isCur) { [x, y] = this._animPos(cur, now); curDrawn = true; }
      else {
        if (!(u.pos >= 0)) continue;
        const ps = this._pendingStart(u.id);
        [x, y] = this._xy(ps ?? u.pos);
      }
      const own = idEq(u.owner, myId);
      const act = own ? this._act(u.id) : null;
      units.push({
        u, x, y, own,
        selected: idEq(u.id, this.sel),
        pulse: own && myTurn && !!act && u.ap > 0 && !u.stunned && !(u.jailed > 0),
      });
    }
    if (cur && !curDrawn) {
      const lu = this.lastUnits.get(curId);
      if (lu) {
        const [x, y] = this._animPos(cur, now);
        const p = (now - cur.t0) / Math.max(1, cur.dur);
        units.push({ u: lu, x, y, alpha: p > 0.75 ? Math.max(0, (1 - p) / 0.25) : 1 });
      }
    }
    const ghosts = [];
    for (const gh of this.ghosts.values()) {
      if (!(gh.pos >= 0)) continue;
      const [x, y] = this._xy(gh.pos);
      ghosts.push({ u: gh.u, x, y });
    }

    const act = this._act(this.sel);
    const reach = myTurn && this.mode !== 'ability' ? this._reach() : null;
    let path = null, pathCost = null;
    if (reach && this.hover >= 0 && reach.has(this.hover) && !this.mode) {
      path = this._pathTo(this.hover);
      pathCost = reach.get(this.hover).cost;
    }
    const tagTargets = myTurn && act && Array.isArray(act.tags) ? new Set(act.tags.map(String)) : null;
    let abilityTargets = null, abilityKind = null;
    if (this.mode === 'ability') {
      const ab = this._abilityTargets();
      if (ab) { abilityTargets = new Set(ab.targets); abilityKind = ab.kind; }
    }
    const hoverUnit = this.hover >= 0 ? g.units.find((u) => u.pos === this.hover)?.id : null;
    return {
      g, now, myTeam: this.myTeam, myId, units, ghosts,
      reach, reachFrom: this._unit(this.sel)?.pos ?? -1, path, pathCost, tagTargets, abilityTargets, abilityKind,
      hover: this.hover, hoverUnit, pings: this.pings, effects: this.effects,
    };
  }

  // ------------------------------------------------------------ actions
  select(id, center = false) {
    const u = this._unit(id);
    this.sel = u ? u.id : null; // keep the server's id type (number vs string)
    if (this.mode === 'ability') this.mode = null;
    if (u && center) {
      let i = u.pos;
      if (!(i >= 0) && u.jailed > 0) i = this.g.bases?.[1 - u.team]?.jail ?? -1;
      if (i >= 0) { const [x, y] = this._xy(i); this.r.centerOn(x, y, true); }
    }
    this.renderHud();
  }

  useAbility() {
    const u = this._unit(this.sel);
    if (!u || !idEq(u.owner, this.myId) || !this.myTurn) return;
    const a = this._act(u.id)?.ability;
    if (!a) return;
    if (!a.ready) { toast(u.cd > 0 ? `${CLASSES[u.cls]?.ability || 'Ability'} on cooldown (${u.cd})` : 'Ability not ready', 'info', 1800); return; }
    if (a.kind === 'dash' || !Array.isArray(a.targets)) {
      this.net.send({ t: 'ability', unit: u.id });
      sfx('click');
      this.mode = null;
    } else {
      this.mode = this.mode === 'ability' ? null : 'ability';
      if (this.mode && !a.targets.length) { toast('No valid targets', 'info', 1800); this.mode = null; }
    }
    this.renderHud();
  }

  portal() {
    const u = this._unit(this.sel);
    const p = this._act(this.sel)?.portal;
    if (!u || !p || !this.myTurn) return;
    if (!p.ok) { toast(p.why || 'Cannot jump right now', 'info', 2200); return; }
    this.net.send({ t: 'move', unit: u.id, to: p.to });
    const [x, y] = this._xy(p.to);
    this.r.centerOn(x, y, true);
    sfx('click');
  }

  /** Pass the flag to, or take it from, an adjacent teammate. With several candidates, pick one on the map. */
  handoff(targetId) {
    const u = this._unit(this.sel);
    const list = this._act(this.sel)?.handoff;
    if (!u || !this.myTurn || !Array.isArray(list) || !list.length) return;
    if (targetId == null && list.length > 1) {
      this.mode = this.mode === 'handoff' ? null : 'handoff';
      this.renderHud();
      return;
    }
    const target = targetId == null ? list[0] : list.find((id) => idEq(id, targetId));
    this.mode = null;
    if (target == null) { this.renderHud(); return; }
    this.net.send({ t: 'handoff', unit: u.id, target });
    sfx('click');
  }

  rescue() {
    const u = this._unit(this.sel);
    const a = this._act(this.sel);
    if (!u || !a?.rescue || !this.myTurn) return;
    this.net.send({ t: 'rescue', unit: u.id });
    sfx('click');
  }

  endTurn() {
    if (!this.myTurn) return;
    if ((this.g.ended || []).some((id) => idEq(id, this.myId))) return;
    this.net.send({ t: 'endTurn' });
    sfx('click');
  }

  cycleUnit(dir = 1) {
    const list = this._myUnits().filter((u) => this._act(u.id) && u.ap > 0 && !(u.jailed > 0) && !u.stunned);
    const pool = list.length ? list : this._myUnits().filter((u) => !(u.jailed > 0));
    if (!pool.length) return;
    const idx = pool.findIndex((u) => idEq(u.id, this.sel));
    const next = pool[(idx + dir + pool.length) % pool.length];
    this.select(next.id, true);
  }

  cancel() {
    if (this.mode) { this.mode = null; this.renderHud(); return; }
    if (this.sel != null) { this.sel = null; this.renderHud(); }
  }

  _click(sx, sy, button, alt) {
    const g = this.g;
    if (!g) return;
    const [wx, wy] = this.r.screenToWorld(sx, sy);
    let idx = pixelToTile(wx, wy, g.w, g.h);
    if (idx >= 0 && (isGeomVoid(idx, g.w) || g.terrain?.[idx] === ' ')) idx = -1;
    if (button === 2) { this.cancel(); return; }
    if (button === 1 || alt || this.mode === 'ping') {
      this._sendPing(idx);
      if (this.mode === 'ping') { this.mode = null; this.renderHud(); }
      return;
    }
    this.hover = idx;
    if (idx < 0) { this.cancel(); return; }

    if (this.mode === 'ability') {
      const ab = this._abilityTargets();
      if (ab && ab.targets.includes(idx)) {
        this.net.send({ t: 'ability', unit: this.sel, target: idx });
        sfx('click');
      }
      this.mode = null;
      this.renderHud();
      return;
    }

    const here = g.units.filter((u) => u.pos === idx);
    const act = this.myTurn ? this._act(this.sel) : null;
    if (this.mode === 'handoff') {
      const mate = here.find((u) => (act?.handoff || []).some((id) => idEq(id, u.id)));
      if (mate) this.handoff(mate.id);
      else { this.mode = null; this.renderHud(); }
      return;
    }
    const enemy = here.find((u) => u.team !== this.myTeam);
    if (enemy && act && Array.isArray(act.tags) && act.tags.some((t) => idEq(t, enemy.id))) {
      this.net.send({ t: 'tag', unit: this.sel, target: enemy.id });
      return;
    }
    const own = here.find((u) => idEq(u.owner, this.myId));
    if (own) { if (!idEq(own.id, this.sel)) { this.select(own.id); sfx('click'); } return; }
    const reach = this.myTurn ? this._reach() : null;
    if (reach && reach.has(idx)) {
      this.net.send({ t: 'move', unit: this.sel, to: idx });
      return;
    }
    if (here.length) { this.select(here[0].id); return; }
    this.cancel();
  }

  // ------------------------------------------------------------ input
  _bindInput() {
    const cv = this.canvas;
    const ptrs = new Map();
    let pinch = null;
    const local = (e) => { const rc = cv.getBoundingClientRect(); return [e.clientX - rc.left, e.clientY - rc.top]; };

    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const [x, y] = local(e);
      ptrs.set(e.pointerId, { x, y, sx: x, sy: y, button: e.button, alt: e.altKey, moved: false });
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        a.moved = b.moved = true;
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      const p = ptrs.get(e.pointerId);
      if (p) {
        if (ptrs.size === 1) {
          if (!p.moved && Math.hypot(x - p.sx, y - p.sy) > 6) { p.moved = true; cv.classList.add('dragging'); }
          if (p.moved) this.r.pan(x - p.x, y - p.y);
          p.x = x; p.y = y;
        } else if (ptrs.size === 2) {
          p.x = x; p.y = y;
          const [a, b] = [...ptrs.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
          if (pinch && pinch.d > 0) {
            this.r.zoomAt(d / pinch.d, cx, cy);
            this.r.pan(cx - pinch.cx, cy - pinch.cy);
          }
          pinch = { d, cx, cy };
        }
      }
      if (e.pointerType === 'mouse' && this.g) {
        this.mouse = { x, y };
        const [wx, wy] = this.r.screenToWorld(x, y);
        this._setHover(pixelToTile(wx, wy, this.g.w, this.g.h));
      }
    });
    const up = (e) => {
      const p = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (!ptrs.size) cv.classList.remove('dragging');
      if (p && !p.moved && e.type === 'pointerup' && ptrs.size === 0) {
        const [x, y] = local(e);
        if (e.pointerType !== 'mouse') this.mouse = { x, y };
        this._click(x, y, p.button, p.alt || e.altKey);
        if (e.pointerType !== 'mouse') this._updateTooltip();
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { this._setHover(-1); } });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
      this.r.zoomAt(Math.exp(-clamp(dy, -300, 300) * 0.0015), x, y);
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('auxclick', (e) => e.preventDefault());

    const keyDir = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
    window.addEventListener('keydown', (e) => {
      if (!this.active || !this.g) return;
      const tgt = e.target;
      const typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable);
      if (typing) return;
      if (!$('#helpPop').hidden) return;
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (keyDir[k]) { this.keys.add(keyDir[k]); e.preventDefault(); return; }
      switch (k) {
        case 'enter': e.preventDefault(); $('#gameChatForm input')?.focus(); break;
        case ' ': case 'spacebar':
          e.preventDefault();
          if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
          if (!e.repeat) this.endTurn();
          break;
        case 'q': this.useAbility(); break;
        case 'r': this.rescue(); break;
        case 'g': this.portal(); break;
        case 'f': this.handoff(); break;
        case 'p': this.mode = this.mode === 'ping' ? null : 'ping'; this.renderHud(); break;
        case 'tab': e.preventDefault(); this.cycleUnit(e.shiftKey ? -1 : 1); break;
        case 'escape': this.cancel(); break;
        case '+': case '=': this.r.zoomAt(1.2, this.r.vw / 2, this.r.vh / 2); break;
        case '-': case '_': this.r.zoomAt(1 / 1.2, this.r.vw / 2, this.r.vh / 2); break;
        case 'h': case 'home': this._centerHome(true); break;
        default: break;
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (keyDir[k]) this.keys.delete(keyDir[k]);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  _setHover(i) {
    if (this.g && i >= 0 && (isGeomVoid(i, this.g.w) || this.g.terrain?.[i] === ' ')) i = -1;
    if (i === this.hover) { this._positionTooltip(); return; }
    this.hover = i;
    this._updateTooltip();
  }

  _positionTooltip() {
    const tt = $('#tooltip');
    if (tt.hidden || !this.mouse) return;
    const W = window.innerWidth, H = window.innerHeight;
    let x = this.mouse.x + 16, y = this.mouse.y + 16;
    const r = tt.getBoundingClientRect();
    if (x + r.width > W - 8) x = this.mouse.x - r.width - 12;
    if (y + r.height > H - 8) y = this.mouse.y - r.height - 12;
    tt.style.left = Math.max(4, x) + 'px';
    tt.style.top = Math.max(4, y) + 'px';
  }

  _updateTooltip() {
    const tt = $('#tooltip');
    const html = this.hover >= 0 && this.g ? this._tooltipHtml(this.hover) : null;
    if (!html) { tt.hidden = true; return; }
    tt.innerHTML = html;
    tt.hidden = false;
    this._positionTooltip();
  }

  _tooltipHtml(i) {
    const g = this.g;
    const ch = g.terrain?.[i] ?? '?';
    const T = TERRAIN[ch] || { name: 'Unknown', cost: '?' };
    const z = g.zone?.[i];
    const fog = tileFog(g, i);
    let h = `<div class="tt-title">${esc(T.name)}</div>`;
    h += `<div class="tt-sub">Move cost ${esc(T.cost)}${z != null ? ` &middot; <span class="z${esc(z)}">${esc(ZONES[z] || '')}</span>` : ''}${fog === 1 ? ' &middot; out of sight' : ''}</div>`;
    if (T.note) h += `<div class="tt-sub">${esc(T.note)}</div>`;
    const extra = [];
    (g.bases || []).forEach((b, t) => {
      if (!b) return;
      const tn = teamName(b.team ?? t);
      if (b.flag === i) extra.push(`${tn} flag stand`);
      if (b.spawn === i) extra.push(`${tn} spawn`);
      if (b.jail === i) {
        const n = g.units.filter((u) => u.jailed > 0 && u.team !== (b.team ?? t)).length;
        extra.push(`${tn} jail${n ? ` (${n} prisoner${n > 1 ? 's' : ''})` : ''}`);
      }
    });
    (g.flags || []).forEach((f, t) => { if (f && f.state !== 'carried' && f.pos === i) extra.push(`${teamName(f.team ?? t)} flag (${f.state})`); });
    for (const c of g.crates || []) if (c?.pos === i) extra.push(`Crate: ${c.kind}`);
    for (const tr of g.traps || []) if (tr?.pos === i) extra.push(`${teamName(tr.team)} trap`);
    if (extra.length) h += `<div class="tt-sub">${extra.map(esc).join(' &middot; ')}</div>`;
    const reach = this.myTurn ? this._reach() : null;
    if (reach?.has(i)) h += `<div class="tt-sub">Reach cost: <b>${esc(reach.get(i).cost)}</b> AP</div>`;
    for (const u of g.units.filter((uu) => uu.pos === i)) {
      h += `<div class="tt-unit"><b style="color:${teamColor(u.team)}">${esc(u.name || className(u.cls))}</b> <span class="muted">${esc(className(u.cls))}</span><br>AP ${esc(u.ap)}/${esc(u.maxAp)} ${statusHtml(u, true)}</div>`;
    }
    for (const gh of this.ghosts.values()) {
      if (gh.pos === i) h += `<div class="tt-unit muted">Last seen: ${esc(gh.u.name || className(gh.u.cls))} (round ${esc(gh.round)})</div>`;
    }
    return h;
  }

  // ------------------------------------------------------------ HUD
  _bindHud() {
    $('#abilityBtn').addEventListener('click', () => this.useAbility());
    $('#rescueBtn').addEventListener('click', () => this.rescue());
    $('#handoffBtn').addEventListener('click', () => this.handoff());
    $('#portalBtn').addEventListener('click', () => this.portal());
    $('#endTurnBtn').addEventListener('click', () => this.endTurn());
    $('#pingBtn').addEventListener('click', () => { this.mode = this.mode === 'ping' ? null : 'ping'; this.renderHud(); });
    const mute = $('#muteBtn');
    const paintMute = () => {
      const m = isMuted();
      mute.innerHTML = m
        ? '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.5"/></svg>'
        : '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 6h3l4-3v10l-4-3H2z" fill="currentColor"/><path d="M11 5.5q2 2.5 0 5M12.8 3.8q3.4 4.2 0 8.4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>';
      mute.title = m ? 'Sound off (click to enable)' : 'Sound on (click to mute)';
    };
    paintMute();
    mute.addEventListener('click', () => { setMuted(!isMuted()); paintMute(); if (!isMuted()) sfx('click'); });
    $('#leaveGameBtn').addEventListener('click', () => {
      if (this.g && !this.g.over && !confirm('Leave this game?')) return;
      this.onLeave?.();
    });
    $('#overLeaveBtn').addEventListener('click', () => this.onLeave?.());
    $('#toLobbyBtn').addEventListener('click', () => { this.net.send({ t: 'toLobby' }); sfx('click'); });
    const pick = (e) => {
      const row = e.target.closest('.unit-row');
      if (row) this.select(row.dataset.id, true);
    };
    $('#squadList').addEventListener('click', pick);
    $('#allyList').addEventListener('click', pick);
    // keep Space from re-clicking a focused HUD button
    $('#game').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTimeout(() => b.blur(), 0); });
  }

  renderHud() {
    if (!this.g) return;
    try {
      this._renderTop();
      this._renderSquad();
      this._renderCard();
      this._renderOver();
      this._tickTimer();
      this.canvas.classList.toggle('targeting', this.mode === 'ability' || this.mode === 'ping' || this.mode === 'handoff');
      const hint = $('#modeHint');
      if (this.mode === 'ability') {
        const ab = this._abilityTargets();
        hint.textContent = `Choose a target for ${ab?.kind === 'trap' ? 'Trap' : 'Flare'} (Esc / right-click to cancel)`;
        hint.hidden = false;
      } else if (this.mode === 'handoff') {
        hint.textContent = 'Click the teammate next to you who should get the flag (Esc to cancel)';
        hint.hidden = false;
      } else if (this.mode === 'ping') {
        hint.textContent = 'Click the map to ping your team (Esc to cancel)';
        hint.hidden = false;
      } else hint.hidden = true;
      $('#pingBtn').classList.toggle('active', this.mode === 'ping');
      if (!$('#tooltip').hidden) this._updateTooltip();
    } catch (e) { console.error(e); }
  }

  _renderTop() {
    const g = this.g;
    $('#scRed').textContent = g.scores?.[0] ?? 0;
    $('#scBlue').textContent = g.scores?.[1] ?? 0;
    $('#capsTo').textContent = g.capsToWin ? `first to ${g.capsToWin}` : '';
    const ti = $('#turnInfo');
    const tt = g.turnTeam;
    ti.className = 'tb-turn t' + tt + (this.myTurn ? ' mine' : '');
    ti.textContent = g.over ? 'Game over' : this.myTurn ? 'Your turn' : `${teamName(tt)}'s turn`;
    $('#roundInfo').textContent = `Round ${g.round ?? 1}${g.roundLimit ? ' / ' + g.roundLimit : ''}`;
    const fi = $('#flagInfo');
    fi.innerHTML = '';
    for (const t of [0, 1]) {
      const f = g.flags?.[t];
      let txt = 'unknown', cls = '';
      if (f) {
        if (f.state === 'home') txt = 'home';
        else if (f.state === 'carried') {
          const cu = this._unit(f.carrier);
          txt = `carried by ${cu ? (cu.name || className(cu.cls)) : 'enemy'}`; cls = 'carried';
        } else if (f.state === 'dropped') { txt = f.pos >= 0 ? 'dropped' : 'dropped (unseen)'; cls = 'dropped'; }
        else txt = String(f.state);
      }
      fi.append(el('span', { class: 'fl ' + cls, title: `${teamName(t)} flag: ${txt}`, html: flagSvg(teamColor(t)) + esc(`${teamName(t)}: ${txt}`) }));
    }
  }

  _renderSquad() {
    const g = this.g;
    const mine = this._myUnits();
    const rows = mine.map((u) => {
      const act = this._act(u.id);
      const cls = ['unit-row'];
      if (idEq(u.id, this.sel)) cls.push('sel');
      if (u.jailed > 0) cls.push('jailed');
      if (!act || !(u.ap > 0)) cls.push('done');
      const stat = statusHtml(u) || `<span>${esc(className(u.cls))}</span>`;
      return `<div class="${cls.join(' ')}" data-id="${esc(u.id)}">${unitIcon(u.cls, u.team)}
        <div><div class="uname">${esc(u.name || className(u.cls))}</div><div class="ustat">${stat}</div></div>
        <div class="ap" title="Action points">${u.jailed > 0 ? '-' : `${esc(u.ap)}/${esc(u.maxAp)}`}</div></div>`;
    });
    $('#squadList').innerHTML = rows.join('') || '<div class="muted small">No units</div>';
    const allies = g.units.filter((u) => u.team === this.myTeam && !idEq(u.owner, this.myId));
    $('#allyList').innerHTML = allies.length
      ? '<div class="panel-title">Allies</div>' + allies.map((u) => `<div class="unit-row ally${idEq(u.id, this.sel) ? ' sel' : ''}" data-id="${esc(u.id)}">${unitIcon(u.cls, u.team)}
          <div><div class="uname">${esc(u.name || className(u.cls))}</div><div class="ustat">${statusHtml(u)}</div></div>
          <div class="ap">${u.jailed > 0 ? '-' : esc(u.ap)}</div></div>`).join('')
      : '';
  }

  _renderCard() {
    const u = this._unit(this.sel);
    const card = $('#unitCard');
    const ab = $('#abilityBtn'), rb = $('#rescueBtn'), eb = $('#endTurnBtn');
    const own = u && idEq(u.owner, this.myId);
    const act = own ? this._act(u.id) : null;
    if (!u) card.innerHTML = '';
    else {
      const C = CLASSES[u.cls];
      let h = `<div class="uc-head">${unitIcon(u.cls, u.team)}<div><div class="uc-name" style="color:${teamColor(u.team)}">${esc(u.name || className(u.cls))}</div>
        <div class="muted small">${esc(className(u.cls))} &middot; ${esc(teamName(u.team))}${own ? '' : u.team === this.myTeam ? ' ally' : ' enemy'}</div></div></div>`;
      h += `<div>AP <b>${esc(u.ap)}</b>/${esc(u.maxAp)} ${statusHtml(u, true)}</div>`;
      if (C && u.team === this.myTeam) {
        const cdTxt = u.cd > 0 ? `${u.cd} turn${u.cd > 1 ? 's' : ''}` : 'Ready';
        h += `<div class="uc-ability"><span class="cd ${u.cd > 0 ? '' : 'ready'}">${esc(cdTxt)}</span><b>${esc(C.ability)}</b><div class="muted small">${esc(C.desc)}</div></div>`;
      }
      card.innerHTML = h;
    }
    const abilityName = CLASSES[u?.cls]?.ability || 'Ability';
    ab.innerHTML = `${esc(own ? abilityName : 'Ability')} <kbd>Q</kbd>`;
    ab.disabled = !(this.myTurn && act?.ability?.ready);
    ab.classList.toggle('armed', this.mode === 'ability');
    rb.disabled = !(this.myTurn && act?.rescue);
    const hb = $('#handoffBtn');
    const hand = this.myTurn && Array.isArray(act?.handoff) && act.handoff.length > 0;
    hb.hidden = !hand;
    hb.innerHTML = `${u?.flag ? 'Pass flag' : 'Take flag'} <kbd>F</kbd>`;
    hb.classList.toggle('armed', this.mode === 'handoff');
    if (!hand && this.mode === 'handoff') this.mode = null;
    const pb = $('#portalBtn');
    pb.hidden = !(this.myTurn && act?.portal);
    pb.classList.toggle('dim', !!act?.portal && !act.portal.ok);
    const ended = (this.g.ended || []).some((id) => idEq(id, this.myId));
    eb.disabled = !this.myTurn || ended;
    eb.classList.toggle('waiting', this.myTurn && ended);
    eb.innerHTML = !this.myTurn ? (this.g.over ? 'Game over' : 'Enemy turn') : ended ? 'Waiting for team...' : 'End turn <kbd>Space</kbd>';

    const list = $('#endedList');
    if (this.myTurn) {
      const players = (this.g.players || []).filter((p) => p.team === this.myTeam && !p.bot);
      list.innerHTML = players.length > 1 || ended
        ? players.map((p) => {
          const done = (this.g.ended || []).some((id) => idEq(id, p.id));
          return `<span class="${done ? 'ok' : ''}">${done ? '&#10003; ' : '&hellip; '}${esc(p.name)}${p.connected === false ? ' (offline)' : ''}</span>`;
        }).join('')
        : '';
    } else list.innerHTML = '';
  }

  _renderOver() {
    const g = this.g, ov = $('#overOverlay');
    if (!g.over) { ov.hidden = true; return; }
    ov.hidden = false;
    const w = g.over.winner;
    const title = $('#overTitle');
    title.textContent = w === -1 || w == null ? 'Draw' : w === this.myTeam ? 'Victory!' : 'Defeat';
    title.style.color = w === 0 || w === 1 ? teamColor(w) : '#e6eaf2';
    const reason = g.over.reason ? String(g.over.reason) : '';
    $('#overReason').textContent = (w === 0 || w === 1 ? `${teamName(w)} wins` : 'No winner') + (reason ? ` - ${reason}` : '');
    $('#overScore').innerHTML = `<span class="red">${esc(g.scores?.[0] ?? 0)}</span> : <span class="blue">${esc(g.scores?.[1] ?? 0)}</span>`;
    $('#toLobbyBtn').hidden = !this.isHost;
    $('#overWait').textContent = this.isHost ? '' : 'Waiting for the host to return to the lobby...';
  }

  _tickTimer() {
    const t = $('#timer');
    const g = this.g;
    if (!g || !this.active) return;
    if (g.over || !(g.turnEndsAt > 0)) { t.textContent = g.over ? '' : '--:--'; t.classList.remove('low'); return; }
    const ms = g.turnEndsAt - (Date.now() + this.clockOffset);
    const s = Math.max(0, Math.ceil(ms / 1000));
    t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    t.classList.toggle('low', s <= 10 && this.myTurn);
  }
}
