'use strict';
const { Grid, mulberry32 } = require('./hex');

const SIZES = {
  small: [19, 11],
  medium: [27, 15],
  large: [35, 19],
};

// 'w' = shallows (wadeable). 'd' = deep water: impassable, does not block sight. Used instead of
// shallows when the "water" setting is off.
const PASSABLE = { '.': 1, f: 2, h: 2, w: 3, t: 1, p: 1 };

function valueNoise(rng, scale) {
  const lattice = new Map();
  const at = (x, y) => {
    const k = x * 4096 + y;
    let v = lattice.get(k);
    if (v === undefined) { v = rng(); lattice.set(k, v); }
    return v;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    x = x / scale + 100; y = y / scale + 100;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
}

/**
 * Generate a point-symmetric hex map.
 * Returns { grid, w, h, terrain[], zone(Uint8Array), bases[2], crateSpots[] }.
 * opts.water === false makes all water impassable (same layout otherwise, plus whatever
 * the connectivity pass has to open up).
 */
function generateMap(sizeName, seed, opts = {}) {
  const WATER = opts.water === false ? 'd' : 'w';
  const [w, h] = SIZES[sizeName] || SIZES.medium;
  const grid = new Grid(w, h);
  const rng = mulberry32(seed);
  const terrain = new Array(grid.n).fill(' ');
  const elev1 = valueNoise(rng, 3.4), elev2 = valueNoise(rng, 1.6), moist = valueNoise(rng, 2.6);

  const setBoth = (i, ch) => { terrain[i] = ch; terrain[grid.mirror(i)] = ch; };

  for (let i = 0; i < grid.n; i++) {
    if (!grid.validIdx(i)) continue;
    const j = grid.mirror(i);
    if (i > j) continue;
    const x = grid.px(i), y = grid.row(i) * 0.866;
    const e = elev1(x, y) * 0.65 + elev2(x, y) * 0.35;
    const m = moist(x, y);
    let ch = '.';
    if (e > 0.66) ch = 'm';
    else if (e > 0.58) ch = 'h';
    else if (e < 0.34) ch = WATER;
    else if (m > 0.54) ch = 'f';
    setBoth(i, ch);
  }

  const mid = (h - 1) >> 1;
  const clear = (centre, radius) => {
    for (const i of grid.within(centre, radius)) {
      if (!PASSABLE[terrain[i]] || terrain[i] === 'w') setBoth(i, '.');
    }
  };

  // Red base on the left; Blue's is the mirror image.
  const flag = grid.idx(2, mid);
  const jail = grid.idx(4, mid - 3);
  const spawn = grid.idx(4, mid + 2);
  for (const i of grid.within(flag, 2)) setBoth(i, '.');
  clear(spawn, 1);
  clear(jail, 1);
  setBoth(jail, 'j');

  // Watchtowers: two per side.
  const tc = Math.round(w * 0.36), tr = Math.max(2, Math.round(h * 0.22));
  for (const t of [grid.idx(tc, mid - tr), grid.idx(tc - 1, mid + tr)]) {
    if (terrain[t] !== 'j') { clear(t, 1); setBoth(t, 't'); }
  }

  // Portals: each links to its mirror image deep on the other side.
  const pc = Math.round(w * 0.28);
  const portals = [grid.idx(pc, 1)];
  if (sizeName !== 'small') portals.push(grid.idx(pc + 1, h - 2));
  for (const p of portals) { clear(p, 1); setBoth(p, 'p'); }

  // Connectivity: make sure the two flags are linked, then seal unreachable pockets.
  const flags = [flag, grid.mirror(flag)];
  const flood = () => {
    const seen = new Uint8Array(grid.n);
    const stack = [flags[0]];
    seen[flags[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      for (const n of grid.nbr[i]) {
        if (!seen[n] && PASSABLE[terrain[n]]) { seen[n] = 1; stack.push(n); }
      }
    }
    return seen;
  };
  let seen = flood();
  if (!seen[flags[1]]) {
    for (const i of grid.between(flags[0], flags[1])) {
      if (!PASSABLE[terrain[i]] && terrain[i] !== 'j') setBoth(i, '.');
    }
    seen = flood();
  }
  // Unreachable land becomes mountain, or lake when water is impassable (islands would only tease).
  for (let i = 0; i < grid.n; i++) {
    if (grid.validIdx(i) && PASSABLE[terrain[i]] && !seen[i]) terrain[i] = WATER === 'd' ? 'd' : 'm';
  }

  // Zones: 0 red, 1 blue, 2 neutral strip.
  const zone = new Uint8Array(grid.n);
  const cx = (w - 1) / 2;
  for (let i = 0; i < grid.n; i++) {
    const d = grid.px(i) - cx;
    zone[i] = Math.abs(d) <= 1 ? 2 : d < 0 ? 0 : 1;
  }

  // Crate spots: open ground near the middle (canonical half only; crates drop in mirrored pairs).
  const crateSpots = [];
  for (let i = 0; i < grid.n; i++) {
    if (!grid.validIdx(i) || i >= grid.mirror(i)) continue;
    if ((terrain[i] === '.' || terrain[i] === 'f' || terrain[i] === 'h') && Math.abs(grid.px(i) - cx) <= w * 0.2) {
      crateSpots.push(i);
    }
  }

  const bases = [
    { team: 0, flag, jail, spawn },
    { team: 1, flag: grid.mirror(flag), jail: grid.mirror(jail), spawn: grid.mirror(spawn) },
  ];
  return { grid, w, h, terrain, zone, bases, crateSpots };
}

module.exports = { generateMap, SIZES, PASSABLE };
