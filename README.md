# barrel.io — TDM Server

This is the authoritative game server: the same physics, collisions, base
shields, scoring, and bot AI as your single-file prototype, now running on
Node.js instead of in a browser tab, so real players can share one game.

**Files:**
| File | What it does |
|---|---|
| `constants.js` | Shared game numbers (map size, tiers, block stats) + small math helpers |
| `schema.js` | Colyseus state definitions — what gets synced to clients |
| `TDMRoom.js` | The actual game: physics, collisions, bot AI, scoring — ported from your client's `update()`/`botAI()` |
| `index.js` | Server entry point, starts listening |

## 1. Run it locally

```bash
npm install
npm start
```

You should see:
```
barrel.io server listening on ws://localhost:2567 (room: "tdm")
```

Open **http://localhost:2567/colyseus** — Colyseus's built-in dashboard, shows rooms and connected clients live. Once a client connects you'll see the `tdm` room and its player count there.

> **Heads up:** this code was written against the Colyseus API from memory/docs — this sandbox has no network access to actually `npm install` and run it. The very first `npm start` might surface a small version-specific hiccup (most likely in `schema.js`'s manual `type(...)(...)` calls if your installed `@colyseus/schema` version prefers decorator syntax — the comment at the top of that file explains the swap). Everything else — the physics, collisions, and AI — is plain JS with no Colyseus-specific quirks, so it should just work.

## 2. Test it without a real client yet

Colyseus ships a client SDK for exactly this. Quick smoke test in Node:

```js
// test-client.js
const { Client } = require('colyseus.js');
const client = new Client('ws://localhost:2567');

client.joinOrCreate('tdm', { name: 'TestPlayer' }).then(room => {
  console.log('joined!', room.sessionId);
  room.state.tanks.onAdd((tank, id) => console.log('tank added', id, tank.name, tank.team));
  setInterval(() => {
    room.send('input', { mx: 1, my: 0, angle: 0, fire: true }); // walk right, shoot right
  }, 100);
});
```

```bash
npm install colyseus.js
node test-client.js
```

You should see a stream of `tank added` lines (your test player + ~20 bots per team getting created), and if you open the monitor dashboard you'll see the player count go to 1.

## 3. The HTML client — now wired up

`barrel-io.html` no longer runs its own local simulation. It:
1. Loads `colyseus.js` from jsdelivr and connects with `Colyseus.Client(url).joinOrCreate('tdm', { name })`.
2. Reads tanks/bullets/blocks directly from the live `room.state` schema instances (`onAdd`/`onRemove` on each `MapSchema`, then just reading `.x`/`.y`/`.hp`/etc. straight off those instances every frame — no local copying needed).
3. Sends `room.send('input', { mx, my, angle, fire })` at ~30Hz from `playerControl()`.
4. Predicts your own tank's movement locally the instant you press a key (so it feels instant), then gently corrects toward the server's real position every frame — it does **not** predict collisions with blocks/bases/other tanks, so you'll see a quick snap-back if you'd have hit something the server stops you on. That's a deliberate simplification, not a bug.
5. Adds a server picker (Local / North America / Europe / India) in the menu, pinging each region's `/status` for a live player count before you connect.

**Known gaps in this pass, worth knowing about:**
- Bullet-impact sparks are approximated from "a bullet just despawned" rather than a real server-sent hit event, so you'll occasionally see a spark on a bullet that just expired instead of hit something. Cosmetic only.
- The "who killed me" screen matches on the `victimId`/`killerId` now included in the server's `kill` broadcast (added in this pass) rather than matching by name, so it's accurate even with duplicate names.
- This was written and syntax-checked (`node --check`) but not run end-to-end — this sandbox has no network access to `npm install` and actually connect a client to the server. Test it with the steps in section 1–2 before trusting it in front of real players.

## 4. Deploying to 3 regions

See `fly.toml.example`. Short version:

```bash
fly auth login
cp fly.toml.example fly.toml    # edit `app` name first
fly launch --name barrel-na --region iad --now   # North America
fly launch --name barrel-eu --region fra --now   # Europe
fly launch --name barrel-in --region bom --now   # India
```

Each gives you an independent URL (`barrel-na.fly.dev`, etc.) — that's your
3-server list for the client's server-browser screen. Each server exposes
`GET /status` → `{ "players": N, "capacity": 100 }` for showing a live
player count per region without needing a websocket connection just to check.

## 5. Things worth doing before this is production-ready

**Done in this pass:**
- ✅ **Rate-limit `input` messages** — `TDMRoom.allowInput()` is a per-client token bucket (40/sec, burst 10); messages over that are silently dropped.
- ✅ **Validate `name`** — `TDMRoom.sanitizeName()` strips anything that isn't a letter/number/space/dash/underscore and falls back to `'Player'`.
- ✅ **Reconnect handling** — `onLeave` now calls `allowReconnection(client, 20)` for an unexpected disconnect (20s grace window) and only deletes the tank on a consented leave or a reconnection that never happens.
- ✅ Fixed a porting gap where blocks never had their `rot` advanced server-side (the client used to do this locally every frame) — they were visually static forever; now `tick()` spins them same as before.

**Still open:**
- **Bandwidth**: right now every bullet is a fully-synced schema entity. Fine
  for testing; at real scale, switch bullets to one-shot broadcast events
  (`this.broadcast('bulletFired', {...})`) that clients simulate locally,
  instead of persistent synced state.
- **Spatial partitioning**: the collision loops here are plain nested loops
  like the client's fallback path, not the grid-bucketed version — reintroduce
  a grid (same `CELL`/`GN` idea as the client) once you're running this at
  full 100-player rooms and it needs to be faster.
- **Deploy the actual 3 regions** (section 4) and drop their real `.fly.dev`
  URLs into the `SERVERS` list near the top of `barrel-io.html`'s script —
  it currently points at the placeholder names from the `fly.toml.example`
  comments (`barrel-na`/`barrel-eu`/`barrel-in`.fly.dev).
