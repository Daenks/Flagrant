// Small shared helpers: DOM, storage, toasts, sound, constants.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Create an element. props: class, text, html, style(obj), dataset, on<event>, other attributes. */
export function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mkStore(get) {
  return {
    get(k, d = null) { try { const v = get().getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { if (v == null) get().removeItem(k); else get().setItem(k, String(v)); } catch { /* ignore */ } },
  };
}
export const local = mkStore(() => localStorage);
export const session = mkStore(() => sessionStorage);

export function toast(msg, kind = 'error', ms = 4000) {
  const box = $('#toasts');
  if (!box) return;
  const t = el('div', { class: 'toast ' + kind, text: String(msg ?? '') });
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, ms);
}

// ---- sound (public/sfx.js provides window.SFX) ----
export function sfx(name) {
  try { window.SFX?.play?.(name); } catch { /* never let sound break the game */ }
}
export function isMuted() { return local.get('flagrant.muted') === '1'; }
export function setMuted(m) {
  local.set('flagrant.muted', m ? '1' : '0');
  try { if (window.SFX) window.SFX.muted = !!m; } catch { /* ignore */ }
}

// ---- ids ----
export const idEq = (a, b) => a != null && b != null && String(a) === String(b);

// ---- deterministic hash -> [0,1) ----
export function hash(i, s = 0) {
  let x = (i * 374761393 + s * 668265263 + 1013904223) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = Math.imul(x ^ (x >>> 16), 2246822519);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---- game constants (presentation only) ----
export const TEAM = [
  { name: 'Red', color: '#e5484d', rgb: [229, 72, 77] },
  { name: 'Blue', color: '#3b82f6', rgb: [59, 130, 246] },
];
export const teamName = (t) => TEAM[t]?.name ?? 'Neutral';
export const teamColor = (t) => TEAM[t]?.color ?? '#9aa4b2';

export const CLASSES = {
  scout: { name: 'Scout', ability: 'Dash', desc: '+4 AP right now.' },
  sentinel: { name: 'Sentinel', ability: 'Flare', desc: 'Reveal radius 2 around a hex within 7 until your next turn. Exposes hidden units and traps. Tags at range 2.' },
  saboteur: { name: 'Saboteur', ability: 'Trap', desc: 'Hidden trap on own or adjacent hex. An enemy stepping on it is stunned: loses the rest of its move and its next turn. Max 2 live traps.' },
};
export const className = (c) => CLASSES[c]?.name ?? (c ? String(c) : 'Unit');

export const TERRAIN = {
  '.': { name: 'Plains', cost: '1' },
  f: { name: 'Forest', cost: '2', note: 'Blocks sight. Units inside are seen only from adjacent hexes.' },
  h: { name: 'Hill', cost: '2', note: '+2 vision, see over forest.' },
  w: { name: 'Shallows', cost: '3' },
  d: { name: 'Deep water', cost: 'impassable', note: 'Replaces shallows when water crossing is off. Does not block sight.' },
  m: { name: 'Mountain', cost: 'impassable', note: 'Blocks sight.' },
  t: { name: 'Watchtower', cost: '1', note: '+3 vision, see over forest.' },
  p: { name: 'Portal', cost: '1', note: 'Spend 1 AP to jump to its twin.' },
  j: { name: 'Jail', cost: 'impassable', note: 'Prisoners are held here.' },
  ' ': { name: 'Void', cost: 'impassable' },
  '?': { name: 'Unexplored', cost: '?' },
};
export const ZONES = ['Red territory', 'Blue territory', 'Neutral strip'];

/** Small inline SVG flag icon. */
export function flagSvg(color) {
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v13" stroke="#e5e7eb" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 2.5h9l-2.5 3 2.5 3h-9z" fill="${color}"/></svg>`;
}
export const CROWN_SVG = '<svg class="crown" viewBox="0 0 16 16" aria-label="host"><path d="M2 12h12l1-7-4 3-3-5-3 5-4-3z" fill="#fde047" stroke="#a16207" stroke-width=".8"/></svg>';
