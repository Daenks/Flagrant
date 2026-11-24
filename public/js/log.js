// Event log + chat, rendered into both the lobby and the in-game log panels.
import { $, el, idEq, teamName } from './util.js';

const MAX = 250;

export class Log {
  constructor() {
    this.lobbyEl = $('#lobbyLog');
    this.gameEl = $('#gameLog');
  }

  _append(target, node) {
    if (!target) return;
    const stick = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
    target.append(node);
    while (target.children.length > MAX) target.firstChild.remove();
    if (stick || target.offsetParent === null) target.scrollTop = target.scrollHeight;
  }

  _both(make) {
    this._append(this.lobbyEl, make());
    this._append(this.gameEl, make());
  }

  /** Resolve a chat sender: `from` may be a player id or already a name. */
  static senderName(from, players) {
    if (from == null) return '?';
    const p = (players || []).find((pl) => idEq(pl.id, from));
    return p ? p.name : String(from);
  }

  chat(m, players) {
    if (m.system) {
      this._both(() => el('div', { class: 'entry sys', text: String(m.text ?? '') }));
      return;
    }
    const name = Log.senderName(m.from, players);
    const t = m.team === 0 || m.team === 1 ? m.team : -1;
    this._both(() => el('div', { class: 'entry chat' },
      m.scope === 'team' ? el('span', { class: 'scope', text: 'team' }) : null,
      el('span', { class: 'who t' + t, text: name }),
      ': ',
      el('span', { class: 'txt', text: String(m.text ?? '') }),
    ));
  }

  event(msg, team) {
    const t = team === 0 || team === 1 ? ' t' + team : '';
    this._append(this.gameEl, el('div', { class: 'entry ev' + t, text: String(msg) }));
  }

  system(text) {
    this._both(() => el('div', { class: 'entry sys', text: String(text) }));
  }

  ping(name) {
    this._append(this.gameEl, el('div', { class: 'entry ping', text: `${name} pinged the map` }));
  }

  divider(text) {
    this._append(this.gameEl, el('div', { class: 'entry sys', text: `-- ${text} --` }));
  }
}

/** Wire a chat form (scope toggle + input). onSend(text, scope). */
export function bindChatForm(form, onSend) {
  if (!form) return;
  const input = form.querySelector('input');
  const scopeBtn = form.querySelector('.scope');
  scopeBtn?.addEventListener('click', () => {
    const next = scopeBtn.dataset.scope === 'team' ? 'all' : 'team';
    scopeBtn.dataset.scope = next;
    scopeBtn.textContent = next === 'team' ? 'Team' : 'All';
    input?.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = (input?.value || '').trim();
    if (!text) { input?.blur(); return; }
    onSend(text.slice(0, 200), scopeBtn?.dataset.scope === 'team' ? 'team' : 'all');
    input.value = '';
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
    e.stopPropagation();
  });
}

export { teamName };
