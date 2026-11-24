# Flagrant — design & wire protocol

Turn-based hex Capture the Flag. Node server (`server/`), static vanilla-JS canvas client (`public/`).
The server is fully authoritative and sends each player only what their team can see.
The client is purely presentational: it never computes rules, only renders snapshots and sends intents.

## Map geometry

- Pointy-top hexes, **odd-r offset** layout. `w` columns x `h` rows (`h` is always odd). Tile index `i = r*w + c`.
- Odd rows are shifted right by half a hex. Pixel centre of (c,r) for hex size `S` (centre to corner):
  `x = S*sqrt(3)*(c + 0.5*(r&1))`, `y = S*1.5*r`.
- The last column of odd rows is void (terrain `' '`), which makes the map exactly point-symmetric.
- Neighbours of (c,r): even rows `[+1,0],[0,-1],[-1,-1],[-1,0],[-1,+1],[0,+1]`,
  odd rows `[+1,0],[+1,-1],[0,-1],[-1,0],[0,+1],[+1,+1]` (as `[dc,dr]`).
- Team 0 = **Red**, home on the left. Team 1 = **Blue**, home on the right.

### Terrain characters

| char | terrain | move cost | notes |
|---|---|---|---|
| `.` | plains | 1 | |
| `f` | forest | 2 | blocks line of sight; units inside are only seen from adjacent hexes |
| `h` | hill | 2 | unit on it: +2 vision, sees over forest |
| `w` | shallows | 3 | |
| `m` | mountain | impassable | blocks line of sight |
| `t` | watchtower | 1 | unit on it: +3 vision, sees over forest |
| `p` | portal | 1 | spend 1 AP standing on it (move onto its twin, which shows up as reachable) to teleport to the mirrored portal |
| `j` | jail | impassable | prisoners are held here |
| ` ` | void | impassable | off-map |
| `?` | unexplored | - | only appears in client snapshots |

### Zones

`zone` string, one char per tile: `0` red territory, `1` blue territory, `2` neutral strip down the middle.
**A unit can only be tagged while standing in the enemy team's territory.** Nobody can be tagged in neutral.

## Rules summary

- Teams alternate turns. On a team's turn every player on it moves their own units at the same time.
  The turn ends when all its connected human players pressed End Turn (bots finish on their own) or the timer runs out.
- Each player controls a squad (1-4 units). Classes:
  - **scout**: 6 AP, vision 5. Ability *Dash*: +4 AP now (cooldown 4).
  - **sentinel**: 4 AP, vision 4. Tag reach 2 (needs line of sight). Ability *Flare*: reveal radius 2 around a hex within 7 until own next turn; reveals hidden units and traps (cooldown 4).
  - **saboteur**: 5 AP, vision 4. Ability *Trap*: hidden trap on own or adjacent hex; an enemy stepping on it is stunned (loses rest of move and its next turn) (cooldown 3, max 2 live traps).
- Tag: 3 AP, target enemy within reach, visible, and standing in the tagger's territory. Tagged unit goes to the tagger's jail and respawns at home at the start of its Nth own turn after the tag (rescued units come back with 0 AP). It drops the flag where it stood.
- Jailbreak: a unit adjacent to the enemy jail that holds teammates can Rescue (1 AP): all prisoners go back to their own base.
- Flags: step on the enemy flag to take it (the carrier is always visible to everyone, and is `safe` — cannot be tagged — until its team's next turn starts). Carry it to a hex **adjacent to** your own flag stand to capture (a team cannot step on its own flag stand, so defenders can't sit on the flag). A dropped flag can be picked up by enemies, or returned home instantly by its own team stepping on it.
- Crates appear in mirrored pairs: `haste` (+3 AP for 3 turns), `cloak` (only seen from adjacent hexes, 3 turns), `shield` (absorbs one tag).
- First team to `capsToWin` wins; at `roundLimit` the higher score wins (tie = draw).

## Transport

WebSocket at `ws(s)://<host>/ws`, JSON text frames, every message has a `t` field.

### Client -> server

| message | meaning |
|---|---|
| `{t:'hello', name, token?}` | first message. `token` (from a previous `welcome`) resumes a session/reconnects into a running game |
| `{t:'list'}` | request public lobby list |
| `{t:'create', name, private}` | create lobby (`private:true` = unlisted, join by code) |
| `{t:'join', code}` | join by 4-letter code |
| `{t:'leave'}` | leave current lobby/game |
| `{t:'team', team}` | switch to team 0/1 (lobby only) |
| `{t:'settings', settings}` | host only, lobby only; partial settings object. `seed` is a map seed string (A-Z0-9, max 12); sending an empty seed rolls a new random one. The map is never sent before the game starts |
| `{t:'addBot', team}` | host only |
| `{t:'kick', id}` | host only; removes a bot or player |
| `{t:'start'}` | host only; needs at least one player/bot per team |
| `{t:'chat', text, scope}` | `scope`: `'all'` or `'team'` |
| `{t:'move', unit, to}` | move own unit to tile index `to` (must be in that unit's `reach`) |
| `{t:'tag', unit, target}` | tag enemy unit id `target` |
| `{t:'ability', unit, target?}` | use class ability; `target` = tile index for flare/trap, omitted for dash |
| `{t:'rescue', unit}` | jailbreak |
| `{t:'endTurn'}` | mark yourself done for this turn |
| `{t:'ping', idx}` | map ping shown to your team |
| `{t:'toLobby'}` | host only, after game over: back to lobby |

### Server -> client

- `{t:'welcome', id, token, name}`
- `{t:'lobbies', lobbies:[{code, name, host, players, max, state}]}` — pushed to everyone not in a room whenever it changes.
- `{t:'error', msg}`
- `{t:'left', reason?}` — you are no longer in a room.
- `{t:'room', code, name, private, hostId, state:'lobby'|'playing'|'over', settings, players:[{id, name, team, bot, connected}]}`
- `{t:'chat', from, team, scope, text}` or `{t:'chat', system:true, text}` (`team` is the sender's team or -1)
- `{t:'ping', idx, from}`
- `{t:'game', ...}` — full snapshot for this viewer, sent after every action (see below).

Settings object (defaults): `{mapSize:'medium' ('small'|'medium'|'large'), squadSize:3 (1-4), capsToWin:3 (1-5), jailTurns:3 (1-5), turnTime:90 (seconds, 0 = unlimited), roundLimit:40 (0 = none), fog:true, portals:true (false = portals become plains), seed:'ABC123' (map seed, random per room)}`.
Max 4 players (humans+bots) per team.

### Game snapshot

```js
{
  t: 'game',
  w, h,
  zone: "0012...",                 // w*h chars
  terrain: "..f?m...",             // w*h chars, '?' = unexplored
  vis: "0110...",                  // w*h chars, '1' = currently visible to your team
  you: { id, team },
  round, turnTeam,                 // round starts at 1
  turnEndsAt, now,                 // server epoch ms; turnEndsAt 0 = no timer. Use (turnEndsAt - now) for the countdown.
  scores: [red, blue], capsToWin, roundLimit, jailTurns,
  players: [{id, name, team, bot, connected}],
  ended: [playerId, ...],          // players of the active team who pressed End Turn
  units: [{                        // all your team's units + enemy units you can currently see + ALL jailed units
    id, owner, team, cls,          // owner = player id; cls = 'scout'|'sentinel'|'saboteur'
    name,                          // short label e.g. "Ann's Scout"
    pos,                           // tile index, -1 while jailed
    ap, maxAp,
    jailed,                        // turns left in jail, 0 = free
    stunned,                       // bool
    flag,                          // bool, carrying the enemy flag
    safe,                          // bool, just grabbed the flag: untaggable until its next turn
    buffs: { haste: n, cloak: n, shield: bool },   // n = turns left
    cd                             // ability cooldown turns left (0 = ready)
  }],
  flags: [{ team, state:'home'|'carried'|'dropped', pos, carrier }],  // index = team. pos -1 = location unknown to you. carrier = unit id or null
  bases: [{ team, flag, jail, spawn }],   // tile indices; -1 where not yet explored by you
  traps: [{ pos, team }],          // traps you know about
  crates: [{ pos, kind }],         // crates on tiles you currently see
  flares: [{ pos, r, team }],      // active flares (public)
  actions: {                       // ONLY for units you own, only on your team's turn, only while game not over
    "<unitId>": {
      reach: [idx, cost, prev, idx, cost, prev, ...],  // flat triples; prev = tile you come from (for path preview), start tile not included
      tags: [enemyUnitId, ...],
      ability: { kind:'dash'|'flare'|'trap', ready: bool, targets: [idx...] | null },  // targets null = no target needed
      rescue: bool,
      portal: null | { to: idx, ok: bool, why: string }   // set while standing on a portal: where it leads and whether the jump is possible
    }
  },
  events: [...],                   // what happened since your previous snapshot (see below)
  over: null | { winner: 0|1|-1, reason: string }   // when set, terrain/units are fully revealed
}
```

### Events

Each has `e` and usually `msg` (ready-to-print log line; print it if present). `team` on a message is for colouring.

- `{e:'move', id, path:[idx...]}` — tiles the unit passed through *that you could see*, in order, including the start tile. Animate along it. For a portal jump the path contains the jump (non-adjacent tiles): teleport instead of sliding.
- `{e:'tag', by, target, at, msg}` — `at` = tile or -1 if you can't see it.
- `{e:'shield', id, at, msg}` — a tag was absorbed.
- `{e:'jailfree', team, ids, msg}` — units released (rescued or served their time).
- `{e:'flag', kind:'taken'|'dropped'|'returned'|'captured', team, by, at, msg}` — `team` = whose flag.
- `{e:'pickup', id, kind, at, msg}`
- `{e:'trap', id, at, msg}` — a unit triggered a trap.
- `{e:'ability', id, kind, at, msg}`
- `{e:'crates', msg}` — new crates dropped.
- `{e:'turn', team, round, msg}`
- `{e:'over', winner, msg}`
