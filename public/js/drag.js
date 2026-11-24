// Movable / collapsible HUD panels. Drag the header to move, double-click it to snap back,
// use the button in it to collapse. Position is remembered per browser.
import { local } from './util.js';

export function makeMovable(panel, handle) {
  const key = 'flagrant.panel.' + panel.id;
  const parent = panel.offsetParent || panel.parentElement;
  let st = null;
  try { st = JSON.parse(local.get(key, 'null')); } catch { st = null; }
  if (!st || typeof st !== 'object') st = {};

  const save = () => local.set(key, JSON.stringify(st));
  const apply = () => {
    panel.classList.toggle('min', !!st.min);
    if (st.x == null || !panel.offsetWidth) {
      for (const p of ['left', 'top', 'right', 'bottom', 'maxHeight']) panel.style[p] = '';
      return;
    }
    const pw = parent.clientWidth, ph = parent.clientHeight;
    // keep at least the header reachable on screen
    const x = Math.max(4 - panel.offsetWidth + 80, Math.min(pw - 80, st.x));
    const y = Math.max(4, Math.min(ph - 30, st.y));
    Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', maxHeight: Math.max(120, ph - y - 6) + 'px' });
  };

  const btn = handle.querySelector('.panel-min');
  const syncBtn = () => { if (btn) { btn.textContent = st.min ? '+' : '–'; btn.title = st.min ? 'Expand' : 'Collapse'; } };
  if (btn) {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', () => { st.min = !st.min; save(); syncBtn(); apply(); btn.blur(); });
  }

  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const pr = parent.getBoundingClientRect(), r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - (r.left - pr.left), dy: e.clientY - (r.top - pr.top), moved: false };
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved = true;
    st.x = e.clientX - drag.dx; st.y = e.clientY - drag.dy;
    panel.classList.add('moving');
    apply();
  });
  const end = () => { if (drag && drag.moved) save(); drag = null; panel.classList.remove('moving'); };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', (e) => {
    if (e.target === btn) return;
    delete st.x; delete st.y; save(); apply();
  });
  window.addEventListener('resize', apply);

  syncBtn();
  apply();
  return apply; // call again once the panel becomes visible
}
