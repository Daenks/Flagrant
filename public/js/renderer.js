// Canvas map renderer: camera, cached terrain layer, units/flags/effects, minimap.
import { S, SQ3, HEX_W, CORNERS, tileXY, neighbors, isGeomVoid, addHex, mapBounds } from './hex.js';
import { hash, clamp } from './util.js';

const TAU = Math.PI * 2;
export const TEAM_RGB = [[229, 72, 77], [59, 130, 246]];
const NEUTRAL_RGB = [222, 204, 140];
const FOG_DARK = [12, 17, 28];
const GREY = [150, 150, 160];

const PAL = {
  '.': [[106, 152, 84], [90, 138, 70]],
  f: [[56, 106, 64], [44, 92, 54]],
  h: [[156, 142, 96], [138, 126, 82]],
  w: [[64, 132, 172], [52, 114, 156]],
  m: [[112, 106, 116], [96, 90, 102]],
  t: [[112, 150, 88], [100, 140, 80]],
  p: [[74, 56, 124], [62, 46, 110]],
  j: [[70, 66, 76], [58, 54, 64]],
  '?': [[22, 28, 42], [18, 24, 37]],
};

export const CRATE_RGB = { haste: [251, 146, 60], cloak: [167, 139, 250], shield: [34, 211, 238] };

// ---------- colour helpers ----------
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const css = (c, a = 1) => (a >= 1
  ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
  : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
const lighten = (c, k) => mix(c, [255, 255, 255], k);
const darken = (c, k) => mix(c, [0, 0, 0], k);
function fogify(c, fog) {
  if (!fog) return c;
  const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  return mix(mix(c, [l, l, l], 0.7), FOG_DARK, 0.48);
}
export const teamRgb = (t) => TEAM_RGB[t] || GREY;

/** 0 visible, 1 explored (fogged), 2 unknown */
export function tileFog(g, i) {
  const ch = g.terrain?.[i];
  if (ch == null || ch === '?') return 2;
  if (g.over) return 0;
  return g.vis && g.vis[i] === '1' ? 0 : 1;
}

export function baseColor(ch, i, zone) {
  const p = PAL[ch] || PAL['?'];
  let c = mix(p[0], p[1], hash(i, 1));
  const j = (hash(i, 2) - 0.5) * 0.1;
  c = j > 0 ? lighten(c, j) : darken(c, -j);
  const k = ch === '?' ? 0.08 : 0.13;
  if (zone === '0') c = mix(c, TEAM_RGB[0], k);
  else if (zone === '1') c = mix(c, TEAM_RGB[1], k);
  else if (zone === '2' && ch !== '?') c = mix(c, NEUTRAL_RGB, 0.06);
  return c;
}

function tri(c, x, apexY, hw, hgt) {
  c.beginPath(); c.moveTo(x, apexY); c.lineTo(x + hw, apexY + hgt); c.lineTo(x - hw, apexY + hgt); c.closePath(); c.fill();
}
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}

/** Terrain decoration in tile-local coordinates (origin = hex centre). */
export function decorate(c, ch, i, fog, base) {
  const F = (col, a) => css(fogify(col, fog), a);
  const R = (k) => hash(i, 10 + k);
  c.lineCap = 'round'; c.lineJoin = 'round';
  switch (ch) {
    case '.': {
      c.strokeStyle = F(darken(base, 0.2)); c.lineWidth = 1.2;
      const n = 2 + ((R(0) * 3) | 0);
      c.beginPath();
      for (let k = 0; k < n; k++) {
        const a = R(k * 2 + 1) * TAU, d = 5 + R(k * 2 + 2) * 14;
        const x = Math.cos(a) * d, y = Math.sin(a) * d * 0.85;
        c.moveTo(x - 2.5, y + 2); c.lineTo(x - 1.6, y - 1.4);
        c.moveTo(x, y + 2); c.lineTo(x, y - 3);
        c.moveTo(x + 2.5, y + 2); c.lineTo(x + 1.6, y - 1.4);
      }
      c.stroke();
      if (R(9) > 0.7) {
        c.fillStyle = F(R(8) > 0.5 ? [246, 222, 110] : [238, 238, 248]);
        const a = R(7) * TAU, d = 4 + R(6) * 13;
        c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, 1.7, 0, TAU); c.fill();
      }
      break;
    }
    case 'f': {
      const spots = [[-10, -5], [8, -9], [-1, 5], [11, 5], [-11, 10], [2, -14], [-3, 14]];
      const n = 3 + ((R(0) * 2) | 0);
      const start = (R(1) * spots.length) | 0;
      const trees = [];
      for (let k = 0; k < n; k++) {
        const s = spots[(start + k * 3) % spots.length];
        trees.push([s[0] + (R(k + 2) - 0.5) * 4, s[1] + (R(k + 5) - 0.5) * 4, 0.85 + R(k + 8) * 0.35]);
      }
      trees.sort((a, b) => a[1] - b[1]);
      for (const [x, y, k] of trees) {
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.beginPath(); c.ellipse(x + 1, y + 5 * k, 6 * k, 2.2 * k, 0, 0, TAU); c.fill();
        c.fillStyle = F([92, 64, 40]); c.fillRect(x - 1.2 * k, y + k, 2.4 * k, 4.5 * k);
        c.fillStyle = F([26, 74, 40]); tri(c, x, y - 11 * k, 7.5 * k, 13 * k);
        c.fillStyle = F([48, 116, 62]); tri(c, x, y - 15 * k, 5.5 * k, 9.5 * k);
        c.fillStyle = F([80, 150, 90], 0.6); tri(c, x - 0.8 * k, y - 15 * k, 2.2 * k, 5 * k);
      }
      break;
    }
    case 'h': {
      let humps = [[-6, 5, 13], [8, -3, 10]];
      if (R(0) > 0.5) humps = [[6, 5, 13], [-8, -3, 10]];
      humps.sort((a, b) => a[1] - b[1]);
      for (const [x0, y0, s] of humps) {
        const x = x0 + (R(1) - 0.5) * 4, y = y0 + (R(2) - 0.5) * 4;
        c.fillStyle = F(lighten(base, 0.14));
        c.beginPath(); c.moveTo(x - s, y + 4); c.quadraticCurveTo(x, y - s * 1.3, x + s, y + 4); c.closePath(); c.fill();
        c.strokeStyle = F(darken(base, 0.32)); c.lineWidth = 1.3;
        c.beginPath(); c.moveTo(x - s, y + 4); c.quadraticCurveTo(x, y - s * 1.3, x + s, y + 4); c.stroke();
        c.beginPath(); c.moveTo(x - s * 0.55, y + 2.5); c.quadraticCurveTo(x, y - s * 0.62, x + s * 0.55, y + 2.5); c.stroke();
      }
      break;
    }
    case 'w': {
      c.strokeStyle = F(lighten(base, 0.38), 0.85); c.lineWidth = 1.4;
      for (let k = 0; k < 3; k++) {
        const y = -10 + k * 9 + (R(k) - 0.5) * 4, x = -10 + (R(k + 3) - 0.5) * 8, L = 13 + R(k + 6) * 7;
        c.beginPath(); c.moveTo(x, y);
        c.quadraticCurveTo(x + L * 0.25, y - 3, x + L * 0.5, y);
        c.quadraticCurveTo(x + L * 0.75, y + 3, x + L, y);
        c.stroke();
      }
      if (R(12) > 0.6) {
        c.fillStyle = F([220, 240, 255], 0.5);
        c.beginPath(); c.arc((R(13) - 0.5) * 20, (R(14) - 0.5) * 18, 1.3, 0, TAU); c.fill();
      }
      break;
    }
    case 'm': {
      const peaks = R(0) > 0.4 ? [[-8, 6, 10, 0.72], [4, 10, 14, 1]] : [[0, 9, 15, 1]];
      for (const [x, yb, hw, k] of peaks) {
        const top = yb - 24 * k;
        c.fillStyle = F([124, 118, 128]);
        c.beginPath(); c.moveTo(x - hw, yb); c.lineTo(x, top); c.lineTo(x + hw, yb); c.closePath(); c.fill();
        c.fillStyle = F([82, 76, 90]);
        c.beginPath(); c.moveTo(x, top); c.lineTo(x + hw, yb); c.lineTo(x + hw * 0.15, yb); c.closePath(); c.fill();
        const sy = 7.5 * k, sx = hw * (sy / (24 * k));
        c.fillStyle = F([238, 242, 248]);
        c.beginPath(); c.moveTo(x, top); c.lineTo(x + sx, top + sy); c.lineTo(x + sx * 0.3, top + sy * 0.75);
        c.lineTo(x - sx * 0.3, top + sy * 1.05); c.lineTo(x - sx, top + sy); c.closePath(); c.fill();
      }
      break;
    }
    case 't': {
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.beginPath(); c.ellipse(1, 13, 10, 3, 0, 0, TAU); c.fill();
      c.fillStyle = F([156, 146, 130]);
      c.beginPath(); c.moveTo(-6.5, 13); c.lineTo(-4.5, -6); c.lineTo(4.5, -6); c.lineTo(6.5, 13); c.closePath(); c.fill();
      c.fillStyle = F([118, 108, 96]);
      c.beginPath(); c.moveTo(0.5, -6); c.lineTo(4.5, -6); c.lineTo(6.5, 13); c.lineTo(0.5, 13); c.closePath(); c.fill();
      c.fillStyle = F([176, 166, 150]);
      c.fillRect(-8, -11, 16, 5);
      c.fillRect(-8, -14, 3.5, 3); c.fillRect(-1.75, -14, 3.5, 3); c.fillRect(4.5, -14, 3.5, 3);
      c.fillStyle = F([40, 34, 30]); c.fillRect(-1.5, 0, 3, 5);
      c.strokeStyle = F([60, 50, 40]); c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(0, -14); c.lineTo(0, -22); c.stroke();
      c.fillStyle = F([250, 210, 80]);
      c.beginPath(); c.moveTo(0, -22); c.lineTo(8, -20); c.lineTo(0, -17.5); c.closePath(); c.fill();
      break;
    }
    case 'p': {
      const gr = c.createRadialGradient(0, 0, 2, 0, 0, 17);
      gr.addColorStop(0, F([18, 8, 38]));
      gr.addColorStop(0.65, F([96, 64, 190]));
      gr.addColorStop(1, F([150, 110, 255], 0));
      c.fillStyle = gr; c.beginPath(); c.arc(0, 0, 17, 0, TAU); c.fill();
      c.strokeStyle = F([196, 170, 255]); c.lineWidth = 2;
      c.beginPath(); c.arc(0, 0, 13, 0, TAU); c.stroke();
      c.strokeStyle = F([120, 220, 255], 0.6); c.lineWidth = 1;
      c.beginPath(); c.arc(0, 0, 15.5, 0, TAU); c.stroke();
      break;
    }
    case 'j': {
      c.fillStyle = F([24, 22, 28]); rrect(c, -13, -11, 26, 22, 3); c.fill();
      c.strokeStyle = F([160, 160, 172]); c.lineWidth = 2;
      c.beginPath();
      for (let k = 0; k < 5; k++) { const x = -9 + k * 4.5; c.moveTo(x, -10); c.lineTo(x, 10); }
      c.stroke();
      c.strokeStyle = F([112, 112, 124]); c.lineWidth = 3;
      c.beginPath(); c.moveTo(-13, -10.5); c.lineTo(13, -10.5); c.moveTo(-13, 10.5); c.lineTo(13, 10.5); c.stroke();
      break;
    }
    case '?': {
      c.fillStyle = 'rgba(140,160,200,0.035)';
      c.beginPath(); c.arc((R(1) - 0.5) * 16, (R(2) - 0.5) * 16, 9 + R(3) * 6, 0, TAU); c.fill();
      break;
    }
    default: break;
  }
}

// ---------- dynamic glyphs ----------
function glyph(ctx, cls, x, y) {
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (cls) {
    case 'scout':
      ctx.moveTo(x - 6, y - 5); ctx.lineTo(x - 1, y); ctx.lineTo(x - 6, y + 5);
      ctx.moveTo(x + 0.5, y - 5); ctx.lineTo(x + 5.5, y); ctx.lineTo(x + 0.5, y + 5);
      ctx.stroke(); break;
    case 'sentinel':
      ctx.lineWidth = 1.8;
      ctx.moveTo(x - 8, y); ctx.quadraticCurveTo(x, y - 8, x + 8, y); ctx.quadraticCurveTo(x, y + 8, x - 8, y);
      ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 2.7, 0, TAU); ctx.fill(); break;
    case 'saboteur':
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI / 3 + Math.PI / 2;
        ctx.moveTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7); ctx.lineTo(x - Math.cos(a) * 7, y - Math.sin(a) * 7);
      }
      ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fill(); break;
    default:
      ctx.arc(x, y, 3, 0, TAU); ctx.fill();
  }
}

export function drawFlag(ctx, x, y, rgb, t, scale = 1, tilt = 0) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(tilt); ctx.scale(scale, scale);
  ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -18); ctx.stroke();
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -18); ctx.stroke();
  const wv = Math.sin(t * 5 + x * 0.05) * 1.6;
  ctx.fillStyle = css(rgb); ctx.strokeStyle = css(darken(rgb, 0.45)); ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0.5, -18);
  ctx.bezierCurveTo(5, -20 + wv, 9, -16 - wv, 15, -17 + wv * 0.6);
  ctx.lineTo(15, -8 + wv * 0.6);
  ctx.bezierCurveTo(9, -7 - wv, 5, -11 + wv, 0.5, -9);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fde047';
  ctx.beginPath(); ctx.arc(0, -18.5, 1.8, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawUnit(ctx, it, t) {
  const { u, x, y } = it;
  const col = teamRgb(u.team);
  const r = 14;
  ctx.save();
  let alpha = it.alpha ?? 1;
  if (it.ghost) alpha *= 0.38;
  else if (u.buffs?.cloak) alpha *= 0.62;
  ctx.globalAlpha = alpha;

  if (it.pulse) {
    const a = 0.25 + 0.25 * Math.sin(t * 4);
    ctx.strokeStyle = `rgba(255,226,120,${a})`; ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.arc(x, y, r + 6.5, 0, TAU); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(x + 1, y + r * 0.78, r * 0.95, r * 0.38, 0, 0, TAU); ctx.fill();

  const grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 1, x, y, r);
  grad.addColorStop(0, css(lighten(col, 0.38)));
  grad.addColorStop(1, css(darken(col, 0.22)));
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = css(darken(col, 0.6));
  if (it.ghost) ctx.setLineDash([3, 3]);
  ctx.stroke(); ctx.setLineDash([]);

  glyph(ctx, u.cls, x, y);
  if (it.ghost) {
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', x + r * 0.8, y - r * 0.8);
    ctx.restore();
    return;
  }

  if (u.stunned) {
    ctx.fillStyle = 'rgba(20,20,20,.35)'; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  if (it.own) {
    ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.arc(x, y, r + 2.6, 0, TAU); ctx.stroke();
  }
  if (it.selected) {
    ctx.strokeStyle = '#fde047'; ctx.lineWidth = 2.4; ctx.setLineDash([5, 4]); ctx.lineDashOffset = -t * 18;
    ctx.beginPath(); ctx.arc(x, y, r + 5.5, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  if (u.flag) drawFlag(ctx, x - r * 0.75, y - r * 0.25, teamRgb(1 - u.team), t, 0.72, -0.12);

  // AP pips
  const maxAp = Math.max(0, Number(u.maxAp) || 0), ap = Math.max(0, Number(u.ap) || 0);
  const n = Math.min(10, Math.max(maxAp, ap));
  if (n > 0) {
    const sp = 4.6, x0 = x - ((n - 1) * sp) / 2, py = y + r + 5.5;
    for (let k = 0; k < n; k++) {
      ctx.beginPath(); ctx.arc(x0 + k * sp, py, 1.8, 0, TAU);
      ctx.fillStyle = k < ap ? (k >= maxAp ? '#fb923c' : '#ffd84a') : 'rgba(255,255,255,.2)';
      ctx.fill(); ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
    }
  }
  // status badges
  const badges = [];
  if (u.stunned) badges.push(['#facc15', 'Z']);
  if (u.safe) badges.push(['#4ade80', '+']);
  if (u.buffs?.shield) badges.push(['#22d3ee', 'S']);
  if (u.buffs?.haste) badges.push(['#fb923c', 'H']);
  if (u.buffs?.cloak) badges.push(['#a78bfa', 'C']);
  ctx.font = 'bold 7.5px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  badges.forEach(([bc, ch], k) => {
    const a = -0.95 + k * 0.62;
    const bx = x + Math.cos(a) * (r + 1), by = y + Math.sin(a) * (r + 1);
    ctx.beginPath(); ctx.arc(bx, by, 5.2, 0, TAU); ctx.fillStyle = bc; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke();
    ctx.fillStyle = '#0b0f17'; ctx.fillText(ch, bx, by + 0.3);
  });
  ctx.restore();
}

function drawTrap(ctx, x, y, rgb, own, t) {
  ctx.save();
  ctx.globalAlpha = own ? 0.5 : 0.95;
  ctx.translate(x, y); ctx.rotate(t * 0.3);
  ctx.beginPath();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU, rr = k % 2 ? 4.5 : 9;
    if (k) ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else ctx.moveTo(rr, 0);
  }
  ctx.closePath();
  ctx.fillStyle = css(darken(rgb, 0.1)); ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = own ? 'rgba(0,0,0,.5)' : '#fff'; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, TAU); ctx.fillStyle = '#111'; ctx.fill();
  ctx.restore();
}

function drawCrate(ctx, x, y, kind, t, seed) {
  const col = CRATE_RGB[kind] || [200, 200, 200];
  y += Math.sin(t * 2.2 + seed) * 1.6;
  const g = ctx.createRadialGradient(x, y, 2, x, y, 18);
  g.addColorStop(0, css(col, 0.45)); g.addColorStop(1, css(col, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 18, 0, TAU); ctx.fill();
  ctx.fillStyle = css(darken(col, 0.55)); rrect(ctx, x - 8.5, y - 8.5, 17, 17, 3.5); ctx.fill();
  ctx.strokeStyle = css(lighten(col, 0.25)); ctx.lineWidth = 1.4; ctx.stroke();
  ctx.fillStyle = css(lighten(col, 0.3)); ctx.strokeStyle = css(lighten(col, 0.3)); ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (kind === 'haste') {
    ctx.moveTo(x + 1.5, y - 6.5); ctx.lineTo(x - 4, y + 1); ctx.lineTo(x - 0.2, y + 1);
    ctx.lineTo(x - 1.5, y + 6.5); ctx.lineTo(x + 4, y - 1); ctx.lineTo(x + 0.2, y - 1); ctx.closePath(); ctx.fill();
  } else if (kind === 'cloak') {
    ctx.moveTo(x - 5.5, y); ctx.quadraticCurveTo(x, y - 5.5, x + 5.5, y); ctx.quadraticCurveTo(x, y + 5.5, x - 5.5, y);
    ctx.stroke(); ctx.beginPath(); ctx.moveTo(x - 5, y + 5); ctx.lineTo(x + 5, y - 5); ctx.stroke();
  } else if (kind === 'shield') {
    ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y - 4); ctx.lineTo(x + 4.5, y + 1.5); ctx.quadraticCurveTo(x + 3, y + 5, x, y + 6.5);
    ctx.quadraticCurveTo(x - 3, y + 5, x - 4.5, y + 1.5); ctx.lineTo(x - 5, y - 4); ctx.closePath(); ctx.fill();
  } else {
    ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y);
  }
}

function crosshair(ctx, x, y, t, hot) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(t * 1.2);
  ctx.strokeStyle = hot ? '#ff4d52' : 'rgba(255,90,95,.85)'; ctx.lineWidth = hot ? 2.8 : 2;
  const R = hot ? 21 : 20;
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    ctx.beginPath(); ctx.arc(0, 0, R, a + 0.25, a + Math.PI / 2 - 0.25); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R + 4), Math.sin(a) * (R + 4)); ctx.lineTo(Math.cos(a) * (R - 5), Math.sin(a) * (R - 5)); ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.vw = 1; this.vh = 1;
    this.cam = { x: 0, y: 0, z: 1 };
    this.camTarget = null;
    this.g = null;
    this.bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.cache = null;        // {canvas, scale}
    this.cacheDirty = true;
    this.cacheKey = '';
    this.scaleTimer = 0;
    this.portals = [];
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.vw = Math.max(1, r.width); this.vh = Math.max(1, r.height);
    this.canvas.width = Math.round(this.vw * this.dpr);
    this.canvas.height = Math.round(this.vh * this.dpr);
    this.clampCam();
  }

  // ---- camera ----
  screenToWorld(sx, sy) { return [(sx - this.vw / 2) / this.cam.z + this.cam.x, (sy - this.vh / 2) / this.cam.z + this.cam.y]; }
  worldToScreen(x, y) { return [(x - this.cam.x) * this.cam.z + this.vw / 2, (y - this.cam.y) * this.cam.z + this.vh / 2]; }
  get minZoom() {
    const b = this.bounds;
    const fit = Math.min(this.vw / (b.x1 - b.x0 + 80), this.vh / (b.y1 - b.y0 + 80));
    return clamp(Math.min(fit, 0.6), 0.15, 0.6);
  }
  get maxZoom() { return 2.6; }
  zoomAt(factor, sx, sy) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.cam.z = clamp(this.cam.z * factor, this.minZoom, this.maxZoom);
    this.cam.x = wx - (sx - this.vw / 2) / this.cam.z;
    this.cam.y = wy - (sy - this.vh / 2) / this.cam.z;
    this.camTarget = null;
    this.clampCam();
  }
  pan(dx, dy) {
    this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z;
    this.camTarget = null;
    this.clampCam();
  }
  centerOn(x, y, smooth = true) {
    if (smooth) this.camTarget = { x, y };
    else { this.cam.x = x; this.cam.y = y; this.camTarget = null; this.clampCam(); }
  }
  clampCam() {
    // The view centre may go anywhere on the map, at any zoom, so every hex can be scrolled
    // out from under the HUD panels (even when the whole map fits on screen).
    const b = this.bounds;
    this.cam.x = clamp(this.cam.x, b.x0, b.x1);
    this.cam.y = clamp(this.cam.y, b.y0, b.y1);
  }
  viewRect(margin = 0) {
    const hw = this.vw / 2 / this.cam.z, hh = this.vh / 2 / this.cam.z;
    return { x0: this.cam.x - hw - margin, y0: this.cam.y - hh - margin, x1: this.cam.x + hw + margin, y1: this.cam.y + hh + margin };
  }
  _updateCamera() {
    if (!this.camTarget) return;
    const t = this.camTarget;
    this.cam.x += (t.x - this.cam.x) * 0.18;
    this.cam.y += (t.y - this.cam.y) * 0.18;
    if (Math.hypot(t.x - this.cam.x, t.y - this.cam.y) < 0.5) { this.cam.x = t.x; this.cam.y = t.y; this.camTarget = null; }
    this.clampCam();
  }

  // ---- map / cache ----
  setMap(g) {
    const sizeChanged = !this.g || this.g.w !== g.w || this.g.h !== g.h;
    this.g = g;
    if (sizeChanged) {
      this.bounds = mapBounds(g.w, g.h);
      this.cache = null;
    }
    const key = `${g.w}x${g.h}|${g.terrain}|${g.vis}|${g.zone}|${g.over ? 1 : 0}`;
    if (key !== this.cacheKey) { this.cacheKey = key; this.cacheDirty = true; }
    this.portals = [];
    const ter = g.terrain || '';
    for (let i = 0; i < ter.length; i++) if (ter[i] === 'p') this.portals.push(i);
    return sizeChanged;
  }

  _desiredScale() {
    const want = this.cam.z * this.dpr;
    const steps = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    let s = steps.find((v) => v >= want) ?? 3;
    const b = this.bounds, W = b.x1 - b.x0 + 16, H = b.y1 - b.y0 + 16;
    const maxS = Math.min(4096 / W, 4096 / H, Math.sqrt(14e6 / (W * H)));
    return Math.max(0.25, Math.min(s, maxS));
  }

  _ensureCache(now) {
    if (!this.g) return;
    const want = this._desiredScale();
    if (!this.cache || this.cacheDirty) { this._buildCache(want); return; }
    if (Math.abs(want - this.cache.scale) > 1e-3) {
      // debounce scale rebuilds while zooming
      if (!this.scaleTimer) this.scaleTimer = now;
      else if (now - this.scaleTimer > 160) { this.scaleTimer = 0; this._buildCache(want); }
    } else this.scaleTimer = 0;
  }

  _buildCache(scale) {
    const g = this.g;
    const { w, h } = g;
    const terrain = g.terrain || '', zone = g.zone || '';
    const b = this.bounds, pad = 8;
    const cv = this.cache?.canvas || document.createElement('canvas');
    cv.width = Math.ceil((b.x1 - b.x0 + pad * 2) * scale);
    cv.height = Math.ceil((b.y1 - b.y0 + pad * 2) * scale);
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(scale, 0, 0, scale, (pad - b.x0) * scale, (pad - b.y0) * scale);

    const shadeGrad = c.createLinearGradient(0, -S, 0, S);
    shadeGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
    shadeGrad.addColorStop(0.5, 'rgba(255,255,255,0)');
    shadeGrad.addColorStop(1, 'rgba(0,0,0,0.14)');

    const n = w * h;
    const fogs = new Uint8Array(n);
    const drawn = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const ch = terrain[i] ?? '?';
      if (ch === ' ' || isGeomVoid(i, w)) continue;
      drawn[i] = 1;
      const fog = tileFog(g, i);
      fogs[i] = fog;
      const [x, y] = tileXY(i, w);
      const base = baseColor(ch, i, zone[i]);
      c.save();
      c.translate(x, y);
      c.beginPath(); addHex(c, 0, 0, S + 0.4);
      c.fillStyle = css(fog === 2 ? base : fogify(base, fog)); c.fill();
      if (fog !== 2) { c.fillStyle = shadeGrad; c.fill(); }
      if (fog !== 2 || ch === '?') decorate(c, ch, i, fog, base);
      c.restore();
    }

    // grid lines
    c.beginPath();
    for (let i = 0; i < n; i++) if (drawn[i]) { const [x, y] = tileXY(i, w); addHex(c, x, y); }
    c.lineWidth = 1; c.strokeStyle = 'rgba(0,0,0,0.26)'; c.stroke();

    // soft fog edge: darken explored tiles that border visible ones only slightly (inner glow on visible region)
    c.beginPath();
    for (let i = 0; i < n; i++) {
      if (!drawn[i] || fogs[i] !== 0) continue;
      const [x, y] = tileXY(i, w);
      for (const nb of neighbors(i, w, h)) {
        if (!drawn[nb] || fogs[nb] === 0) continue;
        this._edge(c, x, y, ...tileXY(nb, w));
      }
    }
    c.lineWidth = 2; c.strokeStyle = 'rgba(200,220,255,0.10)'; c.stroke();

    // zone borders
    const paths = [[], [], []]; // 0: red|neutral, 1: blue|neutral, 2: red|blue
    for (let i = 0; i < n; i++) {
      if (!drawn[i]) continue;
      const zi = zone[i];
      for (const nb of neighbors(i, w, h)) {
        if (nb < i || !drawn[nb]) continue;
        const zn = zone[nb];
        if (zi === zn || zi == null || zn == null) continue;
        const pair = (zi + zn);
        const k = pair === '01' || pair === '10' ? 2 : (zi === '0' || zn === '0') ? 0 : 1;
        paths[k].push([i, nb]);
      }
    }
    const cols = ['rgba(255,110,115,', 'rgba(110,160,255,', 'rgba(255,255,255,'];
    for (let k = 0; k < 3; k++) {
      if (!paths[k].length) continue;
      c.beginPath();
      for (const [a, bb] of paths[k]) { const [x, y] = tileXY(a, w); this._edge(c, x, y, ...tileXY(bb, w)); }
      c.lineCap = 'round';
      c.lineWidth = 6; c.strokeStyle = cols[k] + '0.12)'; c.stroke();
      c.lineWidth = 2.2; c.strokeStyle = cols[k] + '0.75)'; c.stroke();
    }
    this.cache = { canvas: cv, scale, pad };
    this.cacheDirty = false;
  }

  _edge(c, x, y, nx, ny) {
    const a = Math.atan2(ny - y, nx - x);
    c.moveTo(x + S * Math.cos(a - Math.PI / 6), y + S * Math.sin(a - Math.PI / 6));
    c.lineTo(x + S * Math.cos(a + Math.PI / 6), y + S * Math.sin(a + Math.PI / 6));
  }

  // ---- frame ----
  draw(view) {
    const ctx = this.ctx;
    const now = view.now, t = now / 1000;
    this._updateCamera();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0e16';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const g = this.g;
    if (!g) return;
    this._ensureCache(now);
    const z = this.cam.z, d = this.dpr;
    ctx.setTransform(d * z, 0, 0, d * z, d * (this.vw / 2 - this.cam.x * z), d * (this.vh / 2 - this.cam.y * z));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.cache) {
      const { canvas: cv, scale, pad } = this.cache;
      ctx.drawImage(cv, this.bounds.x0 - pad, this.bounds.y0 - pad, cv.width / scale, cv.height / scale);
    }
    const vr = this.viewRect(S * 2);
    const inView = (x, y) => x > vr.x0 && x < vr.x1 && y > vr.y0 && y < vr.y1;
    const w = g.w;
    const XY = (i) => tileXY(i, w);

    // portal swirls
    for (const i of this.portals) {
      const [x, y] = XY(i);
      if (!inView(x, y)) continue;
      const fog = tileFog(g, i);
      if (fog === 2) continue;
      ctx.save(); ctx.translate(x, y); ctx.globalAlpha = fog ? 0.35 : 0.9;
      for (let k = 0; k < 3; k++) {
        ctx.rotate(t * (1.2 + k * 0.5) + k * 2.1);
        ctx.strokeStyle = k % 2 ? 'rgba(120,220,255,.8)' : 'rgba(220,170,255,.85)';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(0, 0, 4 + k * 3.2, 0, Math.PI * 1.1); ctx.stroke();
      }
      ctx.restore();
    }

    // flares
    for (const f of g.flares || []) {
      if (!(f?.pos >= 0)) continue;
      const [x, y] = XY(f.pos);
      const R = ((Number(f.r) || 2) + 0.55) * HEX_W;
      const gr = ctx.createRadialGradient(x, y, 4, x, y, R);
      gr.addColorStop(0, 'rgba(255,226,140,0.30)');
      gr.addColorStop(0.75, 'rgba(255,210,120,0.12)');
      gr.addColorStop(1, 'rgba(255,200,100,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
      ctx.strokeStyle = css(teamRgb(f.team), 0.55); ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -t * 10;
      ctx.beginPath(); ctx.arc(x, y, R * 0.93, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,240,180,.9)'; ctx.beginPath(); ctx.arc(x, y, 2.5 + Math.sin(t * 6) * 0.8, 0, TAU); ctx.fill();
    }

    // reach highlight
    if (view.reach && view.reach.size) {
      let maxC = 1;
      for (const v of view.reach.values()) maxC = Math.max(maxC, v.cost);
      for (const [i, v] of view.reach) {
        const [x, y] = XY(i);
        if (!inView(x, y)) continue;
        const k = 1 - (v.cost - 1) / Math.max(1, maxC);
        ctx.beginPath(); addHex(ctx, x, y, S - 1.5);
        ctx.fillStyle = `rgba(190,235,255,${0.12 + 0.26 * k})`; ctx.fill();
        ctx.strokeStyle = 'rgba(10,20,35,.35)'; ctx.lineWidth = 1; ctx.stroke();
      }
      // outline of the reachable area
      ctx.beginPath();
      const inSet = (i) => view.reach.has(i) || i === view.reachFrom;
      for (const i of view.reach.keys()) {
        const [x, y] = XY(i);
        if (!inView(x, y)) continue;
        for (const nb of neighbors(i, w, g.h)) if (!inSet(nb)) this._edge(ctx, x, y, ...XY(nb));
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 4.5; ctx.stroke();
      ctx.strokeStyle = 'rgba(220,245,255,.95)'; ctx.lineWidth = 2; ctx.stroke();
    }
    // ability targets
    if (view.abilityTargets) {
      for (const i of view.abilityTargets) {
        const [x, y] = XY(i);
        if (!inView(x, y)) continue;
        ctx.beginPath(); addHex(ctx, x, y, S - 2);
        ctx.fillStyle = `rgba(168,85,247,${0.16 + 0.08 * Math.sin(t * 4)})`; ctx.fill();
        ctx.strokeStyle = 'rgba(216,180,254,.7)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
      if (view.hover >= 0 && view.abilityTargets.has(view.hover)) {
        const [x, y] = XY(view.hover);
        if (view.abilityKind === 'flare') {
          const R = 2.55 * HEX_W;
          ctx.fillStyle = 'rgba(255,226,140,0.14)'; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(255,226,140,.8)'; ctx.setLineDash([5, 5]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
        } else if (view.abilityKind === 'trap') {
          drawTrap(ctx, x, y, teamRgb(view.myTeam), false, t);
        }
      }
    }
    // path preview
    if (view.path && view.path.length > 1) {
      const p = view.path;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let k = 1; k < p.length; k++) {
        const [ax, ay] = XY(p[k - 1]), [bx, by] = XY(p[k]);
        const jump = !neighbors(p[k - 1], w, g.h).includes(p[k]);
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 6;
        if (jump) ctx.setLineDash([4, 7]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.strokeStyle = jump ? '#d8b4fe' : '#fde68a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (let k = 1; k < p.length - 1; k++) {
        const [x, y] = XY(p[k]); ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
      }
      const [ex, ey] = XY(p[p.length - 1]);
      ctx.beginPath(); ctx.arc(ex, ey, 9, 0, TAU); ctx.fillStyle = '#fde68a'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = '#1a1405'; ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(view.pathCost ?? ''), ex, ey + 0.5);
      ctx.restore();
    }

    // bases: flag stands, spawns, jails
    const units = g.units || [];
    for (const base of g.bases || []) {
      if (!base) continue;
      const rgb = teamRgb(base.team);
      if (base.spawn >= 0) {
        const [x, y] = XY(base.spawn);
        if (inView(x, y)) {
          ctx.strokeStyle = css(rgb, 0.35); ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
          ctx.beginPath(); addHex(ctx, x, y, S * 0.7); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      if (base.flag >= 0) {
        const [x, y] = XY(base.flag);
        if (inView(x, y)) {
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x, y + 5, 15, 7, 0, 0, TAU); ctx.fill();
          ctx.strokeStyle = css(rgb, 0.9); ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.ellipse(x, y + 4, 14, 6.5, 0, 0, TAU); ctx.stroke();
          ctx.strokeStyle = css(lighten(rgb, 0.4), 0.5); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(x, y + 4, 9, 4, 0, 0, TAU); ctx.stroke();
        }
      }
      if (base.jail >= 0) {
        const [x, y] = XY(base.jail);
        if (inView(x, y)) {
          const pris = units.filter((u) => u && u.jailed > 0 && u.team !== base.team);
          const shown = pris.slice(0, 4);
          shown.forEach((u, k) => {
            const px = x + (k - (shown.length - 1) / 2) * 12.5, py = y - 1;
            const col = teamRgb(u.team);
            ctx.beginPath(); ctx.arc(px, py, 5.8, 0, TAU); ctx.fillStyle = css(col); ctx.fill();
            ctx.lineWidth = 1.2; ctx.strokeStyle = '#fff'; ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.font = 'bold 8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(u.jailed), px, py + 0.5);
          });
          if (pris.length) {
            ctx.fillStyle = 'rgba(10,14,22,.85)'; rrect(ctx, x - 13, y + 11, 26, 11, 4); ctx.fill();
            ctx.fillStyle = '#fff'; ctx.font = 'bold 8px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(`${pris.length} held`, x, y + 16.8);
          }
        }
      }
    }

    // traps
    for (const tr of g.traps || []) {
      if (!(tr?.pos >= 0)) continue;
      const [x, y] = XY(tr.pos);
      if (inView(x, y)) drawTrap(ctx, x, y, teamRgb(tr.team), tr.team === view.myTeam, t);
    }
    // crates
    for (const cr of g.crates || []) {
      if (!(cr?.pos >= 0)) continue;
      const [x, y] = XY(cr.pos);
      if (inView(x, y)) drawCrate(ctx, x, y, cr.kind, t, cr.pos);
    }
    // flags on the ground
    (g.flags || []).forEach((f, idx) => {
      if (!f || f.state === 'carried' || !(f.pos >= 0)) return;
      const team = f.team ?? idx;
      const [x, y] = XY(f.pos);
      if (!inView(x, y)) return;
      if (f.state === 'dropped') {
        const pu = 0.5 + 0.5 * Math.sin(t * 5);
        ctx.fillStyle = css(teamRgb(team), 0.18 + 0.2 * pu);
        ctx.beginPath(); ctx.arc(x, y + 2, 12 + pu * 4, 0, TAU); ctx.fill();
        drawFlag(ctx, x - 3, y + 6, teamRgb(team), t, 0.95, 0.5);
      } else {
        drawFlag(ctx, x - 4, y + 4, teamRgb(team), t, 1.05, 0);
      }
    });

    // ghosts
    for (const gh of view.ghosts || []) if (inView(gh.x, gh.y)) drawUnit(ctx, { u: gh.u, x: gh.x, y: gh.y, ghost: true }, t);
    // units
    const list = (view.units || []).slice().sort((a, b) => a.y - b.y);
    for (const it of list) if (inView(it.x, it.y)) drawUnit(ctx, it, t);
    // tag crosshairs
    for (const it of list) {
      if (view.tagTargets?.has(String(it.u.id))) crosshair(ctx, it.x, it.y, t, view.hoverUnit != null && String(view.hoverUnit) === String(it.u.id));
    }

    // hover outline
    if (view.hover >= 0) {
      const [x, y] = XY(view.hover);
      ctx.beginPath(); addHex(ctx, x, y, S - 1);
      ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2; ctx.stroke();
    }

    // pings
    for (const p of view.pings || []) {
      const age = (now - p.start) / 1000;
      if (age < 0 || age > 3 || !(p.idx >= 0)) continue;
      const [x, y] = XY(p.idx);
      const fade = 1 - age / 3;
      for (let k = 0; k < 3; k++) {
        const ph = (age * 1.1 + k / 3) % 1;
        ctx.strokeStyle = `rgba(253,224,71,${(1 - ph) * fade})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, 5 + ph * S * 1.5, 0, TAU); ctx.stroke();
      }
      const by = y - 22 - Math.abs(Math.sin(age * 5)) * 6;
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#fde047';
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 6, by + 4); ctx.arc(x, by, 7, Math.PI * 0.8, Math.PI * 0.2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1a1405'; ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', x, by);
      ctx.globalAlpha = 1;
    }

    // effects
    for (const e of view.effects || []) this._effect(ctx, e, now);
  }

  _effect(ctx, e, now) {
    const p = (now - e.start) / e.dur;
    if (p < 0 || p > 1) return;
    const { x, y } = e;
    const col = e.rgb || [255, 255, 255];
    ctx.save();
    switch (e.type) {
      case 'burst': {
        for (let k = 0; k < 2; k++) {
          const q = clamp(p * 1.3 - k * 0.2, 0, 1);
          ctx.strokeStyle = css(col, (1 - q) * 0.9); ctx.lineWidth = 4 * (1 - q) + 1;
          ctx.beginPath(); ctx.arc(x, y, 6 + q * 38, 0, TAU); ctx.stroke();
        }
        ctx.strokeStyle = `rgba(255,255,255,${1 - p})`; ctx.lineWidth = 2;
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * TAU + e.seed, r0 = 8 + p * 20, r1 = r0 + 8 * (1 - p);
          ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0); ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1); ctx.stroke();
        }
        if (p < 0.25) { ctx.fillStyle = `rgba(255,255,255,${0.8 - p * 3})`; ctx.beginPath(); ctx.arc(x, y, 18, 0, TAU); ctx.fill(); }
        break;
      }
      case 'ring': {
        ctx.strokeStyle = css(col, 1 - p); ctx.lineWidth = 3 * (1 - p) + 1;
        ctx.beginPath(); ctx.arc(x, y, 8 + p * (e.r || 30), 0, TAU); ctx.stroke();
        break;
      }
      case 'sparkle': {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * TAU + e.seed, rr = 6 + p * 22;
          const sx = x + Math.cos(a) * rr, sy = y + Math.sin(a) * rr - p * 10;
          ctx.fillStyle = css(col, 1 - p);
          ctx.beginPath(); ctx.arc(sx, sy, 2.2 * (1 - p) + 0.5, 0, TAU); ctx.fill();
        }
        break;
      }
      case 'beam': {
        const a = Math.sin(p * Math.PI);
        const gr = ctx.createLinearGradient(x, y - 60, x, y);
        gr.addColorStop(0, css(col, 0)); gr.addColorStop(1, css(col, 0.7 * a));
        ctx.fillStyle = gr; ctx.fillRect(x - 10 * a, y - 60, 20 * a, 60);
        ctx.strokeStyle = css(col, a); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y, 16 * a + 4, 7 * a + 2, 0, 0, TAU); ctx.stroke();
        break;
      }
      case 'text': {
        ctx.globalAlpha = 1 - p;
        ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
        ctx.strokeText(e.text, x, y - 20 - p * 18);
        ctx.fillStyle = css(col); ctx.fillText(e.text, x, y - 20 - p * 18);
        break;
      }
      default: break;
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------

export class Minimap {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.r = renderer;
    this.base = null;
    this.key = '';
    this.k = 1;
    let down = false;
    const go = (e) => {
      const rc = canvas.getBoundingClientRect();
      const b = this.r.bounds;
      const wx = b.x0 + ((e.clientX - rc.left) / rc.width) * (b.x1 - b.x0);
      const wy = b.y0 + ((e.clientY - rc.top) / rc.height) * (b.y1 - b.y0);
      this.r.centerOn(wx, wy, false);
    };
    canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); go(e); e.stopPropagation(); });
    canvas.addEventListener('pointermove', (e) => { if (down) go(e); });
    canvas.addEventListener('pointerup', () => { down = false; });
    canvas.addEventListener('pointercancel', () => { down = false; });
    canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  }

  _layout() {
    const b = this.r.bounds;
    const cssW = this.canvas.clientWidth || 0;
    if (!cssW) return false;
    const aspect = (b.y1 - b.y0) / (b.x1 - b.x0);
    const cssH = Math.round(cssW * aspect);
    if (this.canvas.style.height !== cssH + 'px') {
      this.canvas.style.height = cssH + 'px';
      this.canvas.parentElement?.style.setProperty('--mini-h', cssH + 'px');
    }
    const dpr = this.r.dpr;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.key = ''; }
    this.k = W / (b.x1 - b.x0);
    return true;
  }

  _buildBase(g) {
    const cv = this.base || document.createElement('canvas');
    cv.width = this.canvas.width; cv.height = this.canvas.height;
    const c = cv.getContext('2d');
    const b = this.r.bounds, k = this.k;
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(k, 0, 0, k, -b.x0 * k, -b.y0 * k);
    const n = g.w * g.h, ter = g.terrain || '', zone = g.zone || '';
    for (let i = 0; i < n; i++) {
      const ch = ter[i] ?? '?';
      if (ch === ' ' || isGeomVoid(i, g.w)) continue;
      const fog = tileFog(g, i);
      const base = baseColor(ch, i, zone[i]);
      const col = fog === 2 ? base : fogify(ch === 'f' ? darken(base, 0.15) : ch === 'm' ? lighten(base, 0.1) : base, fog);
      const [x, y] = tileXY(i, g.w);
      c.beginPath(); addHex(c, x, y, S + 1); c.fillStyle = css(col); c.fill();
    }
    this.base = cv;
  }

  draw(view) {
    const g = this.r.g;
    if (!g || this.canvas.offsetParent === null) return;
    if (!this._layout()) return;
    const key = `${this.r.cacheKey}|${this.canvas.width}`;
    if (key !== this.key) { this.key = key; this._buildBase(g); }
    const ctx = this.ctx, b = this.r.bounds, k = this.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.base) ctx.drawImage(this.base, 0, 0);
    const P = (i) => { const [x, y] = tileXY(i, g.w); return [(x - b.x0) * k, (y - b.y0) * k]; };
    const dpr = this.r.dpr;
    for (const f of g.flags || []) {
      if (!f || f.state === 'carried' || !(f.pos >= 0)) continue;
      const [x, y] = P(f.pos);
      ctx.fillStyle = css(teamRgb(f.team)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * dpr;
      ctx.fillRect(x - 3 * dpr, y - 3 * dpr, 6 * dpr, 6 * dpr); ctx.strokeRect(x - 3 * dpr, y - 3 * dpr, 6 * dpr, 6 * dpr);
    }
    for (const it of view.units || []) {
      const x = (it.x - b.x0) * k, y = (it.y - b.y0) * k;
      ctx.beginPath(); ctx.arc(x, y, (it.own ? 3 : 2.5) * dpr, 0, TAU);
      ctx.fillStyle = css(teamRgb(it.u.team)); ctx.fill();
      ctx.lineWidth = 1 * dpr; ctx.strokeStyle = it.u.flag ? '#fde047' : it.own ? '#fff' : 'rgba(0,0,0,.6)'; ctx.stroke();
    }
    for (const p of view.pings || []) {
      if (!(p.idx >= 0)) continue;
      const [x, y] = P(p.idx);
      const ph = ((view.now - p.start) / 700) % 1;
      ctx.strokeStyle = `rgba(253,224,71,${1 - ph})`; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(x, y, (3 + ph * 8) * dpr, 0, TAU); ctx.stroke();
    }
    const vr = this.r.viewRect();
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect((vr.x0 - b.x0) * k, (vr.y0 - b.y0) * k, (vr.x1 - vr.x0) * k, (vr.y1 - vr.y0) * k);
  }
}

/** Draw a single terrain swatch (for the help legend). */
export function drawSwatch(canvas, ch) {
  const dpr = window.devicePixelRatio || 1;
  const size = 28;
  canvas.width = size * dpr; canvas.height = size * dpr;
  const c = canvas.getContext('2d');
  const k = (size * dpr) / (S * 2.1);
  c.setTransform(k, 0, 0, k, (size * dpr) / 2, (size * dpr) / 2);
  const base = baseColor(ch, 7, '2');
  c.beginPath(); addHex(c, 0, 0, S); c.fillStyle = css(base); c.fill();
  decorate(c, ch, 7, 0, base);
  c.beginPath(); addHex(c, 0, 0, S); c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 2; c.stroke();
}
