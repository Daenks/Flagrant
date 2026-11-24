# Flagrant

Multiplayer, turn-based Capture the Flag on a procedurally generated hex map, with fog of war, a jail for tagged players, bots, and public/private lobbies. No accounts — pick a name and play.

## Run it

Requires Node 18+.

```
npm install
npm start
```

Open http://localhost:3000. To use another port: `PORT=8080 npm start` (PowerShell: `$env:PORT=8080; npm start`).

### Docker

```
docker compose up -d --build
```

Same address, http://localhost:3000. To publish on another host port: `FLAGRANT_PORT=8080 docker compose up -d` (PowerShell: `$env:FLAGRANT_PORT=8080; docker compose up -d`). Stop with `docker compose down`.

**Testing alone:** create a lobby, press **+ Bot** on each team and start. Bots play both with and against you.
**Testing multiplayer locally:** open a second browser tab — every tab is its own player — and join from the public list, by code, or with the invite link. Other machines on your LAN can join at `http://<your-ip>:3000`.

## How to play

Red starts on the left, Blue on the right. Teams alternate turns; everyone on the active team moves their own squad at the same time, then presses End Turn (or the timer runs out).

- **Goal:** step on the enemy flag to grab it and carry it to a hex next to your own flag stand. First to the capture target wins; at the round limit the higher score wins.
- **Tagging (3 AP):** you can tag an enemy that is standing in *your* territory. It drops the flag and goes to your jail for a few turns. Nobody can be tagged in the neutral strip or at home.
- **Jailbreak (1 AP):** get a unit next to the enemy jail to free all your prisoners at once.
- **Flags:** a carrier is visible to everyone, but is *safe* from tags until their next turn starts. A dropped flag can be picked up by attackers or returned by a defender stepping on it.
- **Fog of war:** you only see what your team sees. Forests and mountains block line of sight; units inside a forest are only seen from adjacent hexes. Hills and watchtowers extend vision and see over forest. Enemies that slip out of view leave a "last seen" ghost.

### Squad classes

| Class | AP | Vision | Special |
|---|---|---|---|
| Scout | 6 | 5 | **Dash** — +4 AP right now |
| Sentinel | 4 | 4 | Tags from 2 hexes away. **Flare** — reveal an area (including hidden units and traps) until your next turn |
| Saboteur | 5 | 4 | **Trap** — hidden trap; an enemy stepping on it is stunned and loses its next turn |

### Map features

Plains (1 AP), forest and hills (2), shallows (3), mountains (impassable), **watchtowers** (+3 vision), **portals** (jump to the mirrored portal on the far side of the map for 1 AP), and **supply crates** that drop in mirrored pairs near the middle: *haste* (+3 AP), *cloak* (only visible from adjacent hexes), *shield* (absorbs one tag).

### Controls

Click a unit, then a highlighted hex to move; click a crosshaired enemy to tag. `Q` ability, `R` rescue, `Space` end turn, `Tab` next unit, `P` or Alt+click to ping your team, `Enter` chat, drag or WASD / arrow keys to scroll the map, wheel or `+` / `-` to zoom, `H` home, `?` help. The squad panel and the log can be dragged by their title bars (double-click to snap back) and collapsed with the button in the title.

## Lobby options

Map size, units per player (1–4), captures to win, jail length, turn timer, round limit, fog on/off, and the **map seed**: the host can press **Reroll** for a new random map or type a seed to replay one (same seed + same map size = same map). The map itself stays hidden until the game starts, and a fresh seed is rolled after every game. Up to 4 players or bots per team. Private lobbies are unlisted and joined by code or invite link. If a player disconnects mid-game a bot covers for them until they return; reloading the tab resumes your seat.

## Project layout

```
server/index.js   HTTP static host + WebSocket lobbies, turn flow, timers
server/game.js    authoritative rules engine, vision, per-player snapshots
server/mapgen.js  symmetric hex map generator
server/hex.js     hex grid maths
server/bot.js     bot AI (plays with team knowledge only)
public/           vanilla JS canvas client (no build step)
docs/PROTOCOL.md  rules + wire protocol
test/sim.js       headless bot-vs-bot games with invariant checks   (npm run sim)
test/smoke.js     end-to-end lobby/game test over WebSocket         (node test/smoke.js)
```

The server is authoritative and only sends each player what their team can see, so fog of war can't be bypassed from the browser.
