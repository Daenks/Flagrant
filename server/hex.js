'use strict';
// Hex grid helpers: pointy-top hexes, odd-r offset layout, tile index = r*w + c.
// The last column of odd rows is void so the map is exactly point-symmetric.

const EVEN = [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
const ODD = [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]];

class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.nbr = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const c = i % w, r = (i / w) | 0;
      const out = [];
      if (this.valid(c, r)) {
        for (const [dc, dr] of (r & 1 ? ODD : EVEN)) {
          const nc = c + dc, nr = r + dr;
          if (this.valid(nc, nr)) out.push(nr * w + nc);
        }
      }
      this.nbr[i] = out;
    }
  }

  valid(c, r) {
    return c >= 0 && r >= 0 && r < this.h && c < this.w - (r & 1);
  }
  validIdx(i) {
    return i >= 0 && i < this.n && this.valid(i % this.w, (i / this.w) | 0);
  }
  idx(c, r) { return r * this.w + c; }
  col(i) { return i % this.w; }
  row(i) { return (i / this.w) | 0; }

  /** Horizontal position in hex widths (for zones / symmetry). */
  px(i) { return this.col(i) + 0.5 * (this.row(i) & 1); }

  /** Point reflection through the map centre. */
  mirror(i) {
    const c = this.col(i), r = this.row(i);
    return (this.h - 1 - r) * this.w + (this.w - 1 - c - (r & 1));
  }

  cube(i) {
    const c = this.col(i), r = this.row(i);
    const x = c - ((r - (r & 1)) >> 1);
    return [x, -x - r, r];
  }

  dist(a, b) {
    const A = this.cube(a), B = this.cube(b);
    return Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2]));
  }

  /** All valid tiles within `range` of `i` (including i). */
  within(i, range) {
    const c0 = this.col(i), r0 = this.row(i), out = [];
    for (let r = Math.max(0, r0 - range); r <= Math.min(this.h - 1, r0 + range); r++) {
      for (let c = Math.max(0, c0 - range - 1); c <= Math.min(this.w - 1, c0 + range + 1); c++) {
        if (!this.valid(c, r)) continue;
        const j = r * this.w + c;
        if (this.dist(i, j) <= range) out.push(j);
      }
    }
    return out;
  }

  /** Tiles strictly between a and b on a straight hex line. */
  between(a, b) {
    const n = this.dist(a, b), out = [];
    if (n < 2) return out;
    const A = this.cube(a), B = this.cube(b);
    const ax = A[0] + 1e-6, ay = A[1] + 2e-6, az = A[2] - 3e-6;
    for (let s = 1; s < n; s++) {
      const t = s / n;
      const x = ax + (B[0] - ax) * t, y = ay + (B[1] - ay) * t, z = az + (B[2] - az) * t;
      let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
      const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
      if (dx > dy && dx > dz) rx = -ry - rz;
      else if (dy > dz) ry = -rx - rz;
      else rz = -rx - ry;
      const r = rz, c = rx + ((r - (r & 1)) >> 1);
      if (this.valid(c, r)) out.push(r * this.w + c);
    }
    return out;
  }
}

/** Small deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { Grid, mulberry32 };
