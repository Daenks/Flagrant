// Home screen (name, create, join, public list) and lobby room screen.
import { $, $$, el, esc, toast, sfx, local, idEq, CROWN_SVG } from './util.js';

const MAX_PER_TEAM = 4;

const SETTINGS = [
  { key: 'mapSize', label: 'Map size', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  { key: 'squadSize', label: 'Units per player', options: [1, 2, 3, 4] },
  { key: 'capsToWin', label: 'Captures to win', options: [1, 2, 3, 4, 5] },
  { key: 'jailTurns', label: 'Jail turns', options: [1, 2, 3, 4, 5] },
  { key: 'turnTime', label: 'Turn timer', options: [[0, 'Unlimited'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s'], [120, '2 min'], [180, '3 min'], [300, '5 min']] },
  { key: 'roundLimit', label: 'Round limit', options: [[0, 'None'], [20, '20'], [30, '30'], [40, '40'], [50, '50'], [60, '60'], [80, '80'], [100, '100']] },
  { key: 'fog', label: 'Fog of war', type: 'bool' },
  { key: 'portals', label: 'Portals', type: 'bool' },
  { key: 'water', label: 'Water can be crossed', type: 'bool' },
  { key: 'seed', label: 'Map seed', type: 'seed' },
];

export class LobbyUI {
  constructor({ state, net, onEnsureName }) {
    this.state = state;
    this.net = net;
    this.onEnsureName = onEnsureName;
    this.controls = new Map();
    this._bindHome();
    this._bindLobby();
  }

  // ---------------------------------------------------------------- home
  getName() {
    const v = ($('#nameInput').value || '').trim().slice(0, 20);
    return v;
  }

  _bindHome() {
    const nameInput = $('#nameInput');
    nameInput.value = local.get('flagrant.name', '') || '';
    nameInput.addEventListener('input', () => local.set('flagrant.name', nameInput.value.trim()));
    nameInput.addEventListener('change', () => this.onEnsureName?.());

    $('#createBtn').addEventListener('click', () => {
      this.onEnsureName?.();
      if (!this._ready()) return;
      const name = ($('#lobbyNameInput').value || '').trim() || `${this.getName() || 'Player'}'s game`;
      this.net.send({ t: 'create', name: name.slice(0, 32), private: $('#privateInput').checked }, true);
      sfx('click');
    });
    $('#joinForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = ($('#codeInput').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) { toast('Enter a lobby code'); return; }
      this.join(code);
    });
    $('#codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('#refreshBtn').addEventListener('click', () => this.net.send({ t: 'list' }));
    $('#lobbyList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-code]');
      if (b) this.join(b.dataset.code);
    });
  }

  _ready() {
    if (!this.net.open && this.net.status !== 'connecting') { toast('Not connected to the server yet'); return false; }
    return true;
  }

  join(code) {
    this.onEnsureName?.();
    if (!this._ready()) return;
    this.net.send({ t: 'join', code: String(code).toUpperCase() }, true);
    sfx('click');
  }

  renderLobbies() {
    const list = $('#lobbyList');
    const lobbies = Array.isArray(this.state.lobbies) ? this.state.lobbies : [];
    if (!lobbies.length) {
      list.innerHTML = '<div class="empty">No public lobbies right now. Create one!</div>';
      return;
    }
    list.innerHTML = lobbies.map((l) => {
      const full = l.max != null && l.players >= l.max;
      const st = l.state === 'lobby' ? '<span class="badge public">open</span>' : `<span class="badge">${esc(l.state === 'playing' ? 'in game' : l.state || '')}</span>`;
      return `<div class="lobby-row">
        <div><div class="lname">${esc(l.name || l.code)}</div><div class="lhost">${l.host ? 'host: ' + esc(l.host) : ''}</div></div>
        <span class="code">${esc(l.code)}</span>
        <span class="lstate">${st} <span class="muted small">${esc(l.players ?? '?')}/${esc(l.max ?? '?')}</span></span>
        <button class="btn small primary" type="button" data-code="${esc(l.code)}" ${full ? 'disabled' : ''}>Join</button>
      </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- lobby
  _bindLobby() {
    $('#leaveLobbyBtn').addEventListener('click', () => { this.net.send({ t: 'leave' }); sfx('click'); });
    $('#copyLinkBtn').addEventListener('click', () => {
      const code = this.state.room?.code;
      if (!code) return;
      const url = `${location.origin}/#${code}`;
      const done = () => toast('Invite link copied', 'info', 1800);
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this invite link:', url));
      else window.prompt('Copy this invite link:', url);
    });
    for (const col of $$('.team-col')) {
      const team = Number(col.dataset.team);
      col.querySelector('.join-team').addEventListener('click', () => { this.net.send({ t: 'team', team }); sfx('click'); });
      col.querySelector('.add-bot').addEventListener('click', () => { this.net.send({ t: 'addBot', team }); sfx('click'); });
      col.querySelector('.plist').addEventListener('click', (e) => {
        const b = e.target.closest('.kick');
        if (!b) return;
        const p = (this.state.room?.players || []).find((pl) => String(pl.id) === b.dataset.id);
        this.net.send({ t: 'kick', id: p ? p.id : b.dataset.id });
      });
    }
    $('#startBtn').addEventListener('click', () => { this.net.send({ t: 'start' }); sfx('click'); });

    // settings form
    const form = $('#settingsForm');
    for (const s of SETTINGS) {
      const id = 'set_' + s.key;
      let input;
      if (s.type === 'seed') {
        // The map stays hidden until the game starts; the host can only reroll it or type a seed.
        input = el('input', { type: 'text', id, maxlength: '12', spellcheck: 'false', autocomplete: 'off', class: 'seed-input', title: 'Same seed + same map size = same map' });
        input.addEventListener('change', () => this._sendSetting(s, input.value));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        const btn = el('button', { type: 'button', class: 'btn small', id: 'rerollBtn', text: 'Reroll', title: 'Generate a new random map' });
        btn.addEventListener('click', () => { this._sendSetting(s, ''); sfx('click'); });
        const wrap = el('div', { class: 'seed-row' });
        wrap.append(input, btn);
        form.append(el('label', { for: id, text: s.label }), wrap);
        this.controls.set(s.key, { spec: s, input, btn });
        continue;
      }
      if (s.type === 'bool') {
        input = el('input', { type: 'checkbox', id });
        input.addEventListener('change', () => this._sendSetting(s, input.checked));
      } else {
        input = el('select', { id });
        for (const o of s.options) {
          const [v, label] = Array.isArray(o) ? o : [o, String(o)];
          input.append(el('option', { value: String(v), text: label }));
        }
        const numeric = s.options.every((o) => typeof (Array.isArray(o) ? o[0] : o) === 'number');
        input.addEventListener('change', () => {
          const raw = input.value;
          this._sendSetting(s, numeric && Number.isFinite(Number(raw)) ? Number(raw) : raw);
        });
      }
      form.append(el('label', { for: id, text: s.label }), input);
      this.controls.set(s.key, { spec: s, input });
    }
  }

  _sendSetting(spec, value) {
    this.net.send({ t: 'settings', settings: { [spec.key]: value } });
  }

  renderLobby() {
    const room = this.state.room;
    if (!room) return;
    const meId = this.state.me?.id;
    const isHost = idEq(room.hostId, meId);
    const players = Array.isArray(room.players) ? room.players : [];
    $('#roomName').textContent = room.name || 'Lobby';
    const badge = $('#roomBadge');
    badge.textContent = room.private ? 'private' : 'public';
    badge.className = 'badge ' + (room.private ? 'private' : 'public');
    $('#roomCode').textContent = room.code || '----';

    const me = players.find((p) => idEq(p.id, meId));
    for (const col of $$('.team-col')) {
      const team = Number(col.dataset.team);
      const members = players.filter((p) => p.team === team);
      col.querySelector('.count').textContent = `${members.length}/${MAX_PER_TEAM}`;
      const items = members.map((p) => {
        const cls = [];
        if (idEq(p.id, meId)) cls.push('me');
        if (p.connected === false && !p.bot) cls.push('off');
        const kick = isHost && !idEq(p.id, meId) ? `<button class="kick" type="button" data-id="${esc(p.id)}" title="Remove">&times;</button>` : '';
        return `<li class="${cls.join(' ')}">${idEq(p.id, room.hostId) ? CROWN_SVG : ''}
          <span class="pname">${esc(p.name)}${idEq(p.id, meId) ? ' <span class="muted">(you)</span>' : ''}</span>
          ${p.bot ? '<span class="badge bot">bot</span>' : ''}${p.connected === false && !p.bot ? '<span class="muted small">offline</span>' : ''}${kick}</li>`;
      });
      for (let k = members.length; k < MAX_PER_TEAM; k++) items.push('<li class="slot">open slot</li>');
      col.querySelector('.plist').innerHTML = items.join('');
      const full = members.length >= MAX_PER_TEAM;
      const jb = col.querySelector('.join-team');
      jb.disabled = (me && me.team === team) || full || room.state !== 'lobby';
      jb.textContent = me && me.team === team ? 'You are here' : `Join ${team ? 'Blue' : 'Red'}`;
      const bb = col.querySelector('.add-bot');
      bb.hidden = !isHost;
      bb.disabled = full || room.state !== 'lobby';
    }
    const others = players.filter((p) => p.team !== 0 && p.team !== 1);
    $('#otherPlayers').textContent = others.length ? `Not on a team: ${others.map((p) => p.name).join(', ')}` : '';

    // settings
    const settings = room.settings || {};
    for (const [key, { spec, input, btn }] of this.controls) {
      const v = settings[key];
      input.disabled = !isHost || room.state !== 'lobby';
      if (spec.type === 'seed') {
        btn.hidden = !isHost;
        btn.disabled = input.disabled;
        if (document.activeElement !== input) input.value = v ?? '';
        continue;
      }
      if (spec.type === 'bool') { input.checked = !!v; continue; }
      if (v == null) continue;
      const sv = String(v);
      if (![...input.options].some((o) => o.value === sv)) input.append(el('option', { value: sv, text: sv }));
      if (document.activeElement !== input) input.value = sv;
    }
    // unknown extra settings, read-only
    const known = new Set(SETTINGS.map((s) => s.key));
    const form = $('#settingsForm');
    $$('.extra-setting', form).forEach((n) => n.remove());
    for (const [k, v] of Object.entries(settings)) {
      if (known.has(k)) continue;
      form.append(el('label', { class: 'extra-setting', text: k }), el('span', { class: 'extra-setting muted', text: String(v) }));
    }

    const sb = $('#startBtn');
    const hint = $('#startHint');
    const bothTeams = players.some((p) => p.team === 0) && players.some((p) => p.team === 1);
    sb.hidden = !isHost;
    sb.disabled = !bothTeams || room.state !== 'lobby';
    if (room.state === 'playing') hint.textContent = 'Game in progress - loading...';
    else if (room.state === 'over') hint.textContent = 'Game over.';
    else if (!isHost) hint.textContent = 'Waiting for the host to start the game...';
    else if (!bothTeams) hint.textContent = 'Each team needs at least one player or bot.';
    else hint.textContent = '';
  }
}
