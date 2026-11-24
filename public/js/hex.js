// Hex geometry: pointy-top, odd-r offset layout (see docs/PROTOCOL.md).

export const S = 32;                  // hex size in world units (centre to corner)
export const SQ3 = Math.sqrt(3);
export const HEX_W = S * SQ3;         // horizontal centre spacing

const N_EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const N_ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

export const CORNERS = Array.from({ length: 6 }, (_, k) => {
  const a = (Math.PI / 180) * (60 * k - 30);
  return [Math.cos(a), Math.sin(a)];
});

export function tileXY(i, w) {
  const c = i % w, r = (i - c) / w;
  return [HEX_W * (c + 0.5 * (r & 1)), S * 1.5 * r];
}

export function neighbors(i, w, h) {
  const c = i % w, r = (i - c) / w;
  const out = [];
  for (const [dc, dr] of (r & 1 ? N_ODD : N_EVEN)) {
    const nc = c + dc, nr = r + dr;
    if (nc >= 0 && nc < w && nr >= 0 && nr < h) out.push(nr * w + nc);
  }
  return out;
}

export function isGeomVoid(i, w) {
  const c = i % w, r = (i - c) / w;
  return (r & 1) === 1 && c === w - 1;
}

export function cube(i, w) {
  const c = i % w, r = (i - c) / w;
  const q = c - (r - (r & 1)) / 2;
  return [q, r, -q - r];
}

export function hexDist(a, b, w) {
  const A = cube(a, w), B = cube(b, w);
  return Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2]));
}

export function adjacent(a, b, w, h) {
  return neighbors(a, w, h).includes(b);
}

/** World pixel -> tile index, or -1 when outside the grid. */
export function pixelToTile(x, y, w, h) {
  const qf = (SQ3 / 3 * x - y / 3) / S;
  const rf = (2 / 3 * y) / S;
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  if (r < 0 || r >= h) return -1;
  const col = q + (r - (r & 1)) / 2;
  if (col < 0 || col >= w) return -1;
  return r * w + col;
}

/** Append a hex sub-path (no beginPath). */
export function addHex(ctx, x, y, s = S) {
  for (let k = 0; k < 6; k++) {
    const px = x + s * CORNERS[k][0], py = y + s * CORNERS[k][1];
    if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

export function mapBounds(w, h) {
  return { x0: -HEX_W / 2, y0: -S, x1: HEX_W * (w - 1) + HEX_W / 2, y1: S * 1.5 * (h - 1) + S };
}
