// Engine test for the flag handoff rule. Run with: node test/handoff.js
const assert = require('assert');
const { Game } = require('../server/game');
const P = [{ id: 1, name: 'a', team: 0 }, { id: 2, name: 'b', team: 1 }];
const S = { mapSize: 'medium', squadSize: 3, capsToWin: 3, jailTurns: 3, turnTime: 0, roundLimit: 40, fog: true };
const g = new Game(P, S, 7);
const [A, B, C] = g.units.filter((u) => u.team === 0);
if (g.turnTeam !== 0) g.nextTurn();
const open = (i) => g.terrain[i] === '.' && !g.units.some((u) => u.pos === i);
// put A and B adjacent, well away from the red stand, and give A the flag
let a = -1, b = -1;
for (let i = 0; i < g.terrain.length && a < 0; i++) {
  if (!open(i) || g.grid.dist(i, g.bases[0].flag) < 6) continue;
  const n = g.grid.nbr[i].find((x) => open(x) && g.grid.dist(x, g.bases[0].flag) > 2);
  if (n != null) { a = i; b = n; }
}
const f = g.flags[1];
A.pos = a; B.pos = b; A.flag = true; A.safe = true; f.state = 'carried'; f.carrier = A.id; f.pos = a;
assert.deepStrictEqual(g.handoffTargets(A).map((u) => u.id), [B.id]);
assert.deepStrictEqual(g.handoffTargets(B).map((u) => u.id), [A.id]);
assert.deepStrictEqual(g.handoffTargets(C), []);
A.ap = 0;
assert.deepStrictEqual(g.handoffTargets(A), [], 'carrier without AP cannot give');
const ap = B.ap;
assert.ok(g.handoff(B, A), 'teammate can take from a carrier that is out of AP');
assert.ok(B.flag && !A.flag && !A.safe && !B.safe && f.carrier === B.id && f.pos === b && B.ap === ap - 1);
assert.deepStrictEqual(g.handoffTargets(B), []);
assert.ok(!g.handoff(B, A), 'once per turn');
g.nextTurn(); g.nextTurn();
assert.strictEqual(g.handoffTargets(B).length, 1, 'available again next turn');
assert.ok(!g.handoff(B, g.units.find((u) => u.team === 1)), 'never to an enemy');
// capture on receive: A stands next to its own stand, B one hex further out
const stand = g.bases[0].flag;
const ok = (i) => g.terrain[i] !== 'm' && g.terrain[i] !== ' ' && i !== stand;
const spot = g.grid.nbr[stand].find((i) => ok(i) && g.grid.nbr[i].some((j) => ok(j) && g.grid.dist(j, stand) > 1));
A.pos = spot; B.pos = g.grid.nbr[spot].find((j) => ok(j) && g.grid.dist(j, stand) > 1); f.pos = B.pos;
for (const u of g.units) if (u !== A && u !== B && (u.pos === A.pos || u.pos === B.pos)) u.pos = g.freeTileNear(g.bases[u.team].spawn);
assert.ok(g.handoff(B, A));
assert.strictEqual(g.scores[0], 1, 'receiving next to the stand captures');
assert.ok(!A.flag && f.state === 'home');
assert.ok(Array.isArray(g.snapshot(1).actions[A.id].handoff));
console.log('HANDOFF OK');
