'use strict';
// Headless bot-vs-bot simulation: node test/sim.js [games=20]
// Plays full games with every player a bot, checks engine/bot invariants after every action,
// prints per-game results and a summary. Exit code 1 on any violation or step-cap hit.

const { Game } = require('../server/game');
const { botStep } = require('../server/bot');
const { PASSABLE } = require('../server/mapgen');

const GAMES = Math.max(1, parseInt(process.argv[2], 10) || 20);
const STEP_CAP = 400;
const SIZES = ['small', 'medium', 'large'];

function invariants(game) {
  const errs = [];
  const seen = new Map();
  for (const u of game.units) {
    if (u.ap < 0) errs.push(`unit ${u.id} has negative AP ${u.ap}`);
    if (u.jailed > 0 && u.pos !== -1) errs.push(`jailed unit ${u.id} has pos ${u.pos}`);
    if (u.jailed === 0 && u.pos < 0) errs.push(`free unit ${u.id} has no position`);
    if (u.pos >= 0) {
      if (!PASSABLE[game.terrain[u.pos]]) errs.push(`unit ${u.id} on impassable '${game.terrain[u.pos]}' tile ${u.pos}`);
      if (seen.has(u.pos)) errs.push(`units ${seen.get(u.pos)} and ${u.id} share tile ${u.pos}`);
      seen.set(u.pos, u.id);
      if (u.pos === game.bases[u.team].flag) errs.push(`unit ${u.id} stands on its own flag stand`);
    }
    if (u.flag && (u.jailed > 0 || u.pos < 0)) errs.push(`jailed unit ${u.id} carries a flag`);
  }
  for (const f of game.flags) {
    const carriers = game.units.filter((u) => u.flag && u.team !== f.team);
    if (carriers.length > 1) errs.push(`flag ${f.team} has ${carriers.length} carriers`);
    if (f.state === 'carried') {
      const c = game.unit(f.carrier);
      if (!c || !c.flag || c.team === f.team) errs.push(`flag ${f.team} carried by invalid unit ${f.carrier}`);
      else if (c.pos !== f.pos) errs.push(`flag ${f.team} pos ${f.pos} != carrier pos ${c.pos}`);
      if (carriers.length !== 1) errs.push(`flag ${f.team} carried but ${carriers.length} units have flag`);
    } else {
      if (f.carrier !== null) errs.push(`flag ${f.team} ${f.state} but carrier=${f.carrier}`);
      if (carriers.length) errs.push(`flag ${f.team} ${f.state} but unit ${carriers[0].id} has flag`);
      if (f.state === 'home' && f.pos !== game.bases[f.team].flag) errs.push(`flag ${f.team} home but pos ${f.pos}`);
      if (f.state === 'dropped' && !PASSABLE[game.terrain[f.pos]]) errs.push(`flag ${f.team} dropped on impassable tile`);
    }
  }
  return errs;
}

function signature(game) {
  return JSON.stringify([
    game.units.map((u) => [u.pos, u.ap, u.cd, u.jailed, u.flag, u.buffs]),
    game.flags, game.traps.length, game.flares.length, game.scores, game.over,
  ]);
}

function playGame(g) {
  const seed = 1000 + g * 7919;
  const mapSize = SIZES[g % 3];
  const perPlayer = g % 2 === 1; // odd games: botStep called per player instead of per team
  const players = [
    { id: 'r1', name: 'R1', team: 0, bot: true }, { id: 'r2', name: 'R2', team: 0, bot: true },
    { id: 'b1', name: 'B1', team: 1, bot: true }, { id: 'b2', name: 'B2', team: 1, bot: true },
  ];
  const settings = { mapSize, squadSize: 3, capsToWin: 3, jailTurns: 3, turnTime: 0, roundLimit: 40, fog: true };
  const game = new Game(players, settings, seed);
  const groups = perPlayer
    ? [[new Set(['r1']), new Set(['r2'])], [new Set(['b1']), new Set(['b2'])]]
    : [[new Set(['r1', 'r2'])], [new Set(['b1', 'b2'])]];
  const st = { seed, mapSize, perPlayer, tags: 0, violations: [], capHits: 0, steps: 0, time: 0n, maxStep: 0n, abil: { dash: 0, flare: 0, trap: 0 }, rescues: 0 };
  let turns = 0;
  const maxTurns = 2 * (settings.roundLimit + 2);
  while (!game.over && turns < maxTurns) {
    for (const ids of groups[game.turnTeam]) {
      let steps = 0;
      for (;;) {
        if (game.over) break;
        const before = signature(game);
        const jailedBefore = game.units.map((u) => u.jailed);
        const cdBefore = game.units.map((u) => u.cd);
        const t0 = process.hrtime.bigint();
        const did = botStep(game, ids);
        const dt = process.hrtime.bigint() - t0;
        st.time += dt; st.steps++;
        if (dt > st.maxStep) st.maxStep = dt;
        if (!did) break;
        if (signature(game) === before) st.violations.push(`round ${game.round}: botStep returned true without changing state`);
        game.units.forEach((u, i) => {
          if (jailedBefore[i] === 0 && u.jailed > 0) st.tags++;
          if (jailedBefore[i] > 0 && u.jailed === 0) st.rescues++;
          if (cdBefore[i] === 0 && u.cd > 0) st.abil[{ scout: 'dash', sentinel: 'flare', saboteur: 'trap' }[u.cls]]++;
        });
        for (const e of invariants(game)) st.violations.push(`round ${game.round}: ${e}`);
        if (++steps >= STEP_CAP) { st.capHits++; st.violations.push(`round ${game.round}: step cap hit`); break; }
      }
    }
    if (game.over) break;
    game.nextTurn();
    turns++;
    for (const e of invariants(game)) st.violations.push(`round ${game.round} (after nextTurn): ${e}`);
  }
  st.over = game.over;
  st.scores = game.scores.slice();
  st.rounds = game.round;
  st.captures = game.scores[0] + game.scores[1];
  return st;
}

const all = [];
let wins = [0, 0], draws = 0, unfinished = 0;
const t0 = Date.now();
for (let g = 0; g < GAMES; g++) {
  const st = playGame(g);
  all.push(st);
  const w = st.over ? st.over.winner : null;
  if (w === 0 || w === 1) wins[w]++;
  else if (w === -1) draws++;
  else unfinished++;
  const res = w === 0 ? 'Red wins ' : w === 1 ? 'Blue wins' : w === -1 ? 'Draw     ' : 'UNFINISHED';
  console.log(`#${String(g + 1).padStart(2)} ${st.mapSize.padEnd(6)} seed ${String(st.seed).padEnd(6)} ${st.perPlayer ? 'per-player' : 'per-team  '} ` +
    `${res} ${st.scores[0]}-${st.scores[1]}  rounds ${String(st.rounds).padStart(2)}  tags ${String(st.tags).padStart(2)}  captures ${st.captures}  ` +
    `rescues ${st.rescues}  dash/flare/trap ${st.abil.dash}/${st.abil.flare}/${st.abil.trap}` +
    (st.violations.length ? `  VIOLATIONS ${st.violations.length}` : ''));
  for (const v of st.violations.slice(0, 5)) console.log('     ! ' + v);
}

const steps = all.reduce((a, s) => a + s.steps, 0);
const time = all.reduce((a, s) => a + s.time, 0n);
const maxStep = all.reduce((a, s) => (s.maxStep > a ? s.maxStep : a), 0n);
const viol = all.reduce((a, s) => a + s.violations.length, 0);
const caps = all.reduce((a, s) => a + s.capHits, 0);
const scored = all.filter((s) => s.captures > 0).length;
console.log('\n=== Summary ===');
console.log(`games ${GAMES}  red wins ${wins[0]}  blue wins ${wins[1]}  draws ${draws}  unfinished ${unfinished}`);
console.log(`avg rounds ${(all.reduce((a, s) => a + s.rounds, 0) / GAMES).toFixed(1)}  total captures ${all.reduce((a, s) => a + s.captures, 0)}  ` +
  `games with a capture ${scored}/${GAMES}  0-0 games ${GAMES - scored}  total tags ${all.reduce((a, s) => a + s.tags, 0)}`);
console.log(`botStep calls ${steps}  avg ${(Number(time) / steps / 1e6).toFixed(3)} ms  max ${(Number(maxStep) / 1e6).toFixed(2)} ms  wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`invariant violations ${viol}  step-cap hits ${caps}`);
process.exit(viol || caps || unfinished ? 1 : 0);
