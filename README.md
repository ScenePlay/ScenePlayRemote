# ScenePlay Remote (Relay)

ScenePlay Remote is the real-time relay that lets **remote players join a
tabletop session hosted on a Game Master's local [ScenePlay](../ScenePlay)
box**. The GM runs ScenePlay at the table; this server runs somewhere both
sides can reach (a cloud host like Render, or the same LAN); players open a
plain browser — no install — enter a join code, and see the battle map,
their character sheet, the party, and every dice roll live.

- **Backend:** Python / FastAPI, SQLite, Server-Sent Events
- **Frontend:** a single-page vanilla-JS portal served by the same process
- **Auth:** shared-secret for the GM side, short-lived JWTs for players
- **Deployment:** Render (or any host that runs uvicorn)

---

## The one design law: local ScenePlay is the authority

Everything in this codebase follows a single rule — **the GM's local
ScenePlay database owns the truth**. The relay is a staging area and a
megaphone, never a source of record:

- State flows **down** from local (characters, maps, users, libraries) via
  authenticated push endpoints, and the relay stores a copy purely so it can
  serve joins and reconnects without round-tripping to the GM's box.
- Player edits flow **up** as **staged mutations** — rows in a
  `character_mutations` table that local ScenePlay polls, applies against its
  own data, acknowledges, and then re-broadcasts in authoritative form.
  The relay never computes so much as an HP subtraction: when a player takes
  damage, the portal submits an `hp_delta` mutation, local applies it against
  *its* `hp_max`, and pushes the resulting sheet back through the relay.
  (Earlier versions had relay-side HP endpoints; they were removed precisely
  because they let the relay become authoritative.)
- If the relay's database were lost mid-session, the GM presses **Sync** and
  everything is rebuilt from local.

This is why the sync surface is small and boring on purpose: push endpoints
down, one mutation queue up, one `/sync` snapshot for reconciliation.

```
┌────────────────────────┐        push (X-Relay-Secret)        ┌─────────────────────┐
│  GM's local ScenePlay   │ ──────────────────────────────────▶ │   ScenePlay Remote   │
│  (Flask, the authority) │   scene/map/characters/users/       │   (FastAPI relay)    │
│                        │   rolls/library/conditions           │                     │
│  relay_broadcaster.py  │                                      │  SQLite: relay.db   │
│  relay_receiver.py     │ ◀────────────────────────────────── │                     │
└────────────────────────┘   poll /sync + pending mutations,    └──────────┬──────────┘
                             ack what was applied                          │ SSE stream
                                                                           ▼
                                                            ┌────────────────────────┐
                                                            │  Player browsers        │
                                                            │  (portal/, join code)   │
                                                            └────────────────────────┘
```

---

## How data moves

### Local → relay (GM side, authenticated by `X-Relay-Secret`)
The local app's `relay_broadcaster.py` pushes through a **single ordered
queue with coalescing**: while the relay is unreachable, repeated pushes of
the same thing (map state, a character) replace each other so only the latest
survives, while dice rolls queue individually; failures retry with backoff
(1s → 30s cap). What gets pushed:

- **Session lifecycle** — `POST /session/create` mints a session + 6-char join
  code (and purges any previous session: the relay hosts exactly one session
  at a time, by design).
- **Scene & battle map** — `POST /session/push`. Map images ride along as
  base64 payloads and are written to `portal/battlemaps/` under a
  content-hash filename (so re-pushes are free); monster token images are
  resolved from the local ScenePlay DB or dnd5eapi and localised the same
  way. The base64 is stripped before the map JSON is stored/broadcast.
- **Characters** — bulk upsert with sheets, HP, portraits (base64 →
  `portal/portraits/`), and **bcrypt password hashes** from local's user
  accounts, so joins verify against the relay copy with no callback needed.
  Each upsert broadcasts `character_upserted` so a newly assigned character
  lights up on an already-open portal without re-login.
- **User accounts** — `POST /session/{id}/users` lets someone log in *before*
  the GM assigns them a character (they join as a spectator; the sheet
  appears live when assigned).
- **Local dice rolls** — pushed via `/push-roll`, *and* (in co-located
  deployments) the SSE stream additionally polls ScenePlay's `tblDiceRolls`
  directly every 4 s so table rolls reach remote players even if the push
  path hiccups. Relay-originated rolls are written back into ScenePlay's dice
  history tagged `character_id = -1`, which the poll excludes — that tag is
  the loop-prevention.
- **Reference library** — spells/feats/weapons/armor/equipment/skills/races/
  classes plus conditions (full SRD rule text), magic items, class features,
  per-level class tables (spell slots, class counters), subclasses, racial
  traits, weapon properties and the SRD rules chapters — one JSON blob per
  session, so the portal's quick-reference and sheet pickers work offline
  from local. The newer categories are optional in the push schema, so older
  local servers keep working.

### Relay → local (the mutation queue)
Player actions that change character state are **staged, not applied**:
`POST /character/mutate` inserts a row with a `mutation_type` and JSON data.
Local ScenePlay's `relay_receiver.py` polls `GET /session/{id}/sync`, applies
pending mutations to its own database, then `POST /session/{id}/mutations/ack`
marks them done. Supported mutation types:

```
hp_delta   attr_save   condition_add/remove
inventory_add/save/remove    skill_add/save/remove
spell_add/save/remove        weapon_add/save/remove
armor_add/save/remove        feat_add/save/remove
note_add/save/remove         resource_add/save
```

Mutations are keyed by the **character name** (not the login's display name)
— one login can run several characters, and `as_player` targets a specific
one after the server verifies that character belongs to the same username.

### Relay → players (Server-Sent Events)
`GET /session/{id}/stream` (JWT in query or bearer header) opens the live
feed. On connect the client receives a full `session_state` snapshot (tokens,
characters, map, last 50 rolls), then incremental events:

| event | meaning |
|---|---|
| `session_state` | full snapshot on connect |
| `scene_update` / `map_update` | GM pushed a new scene / battle map |
| `character_upserted` | sheet created/edited/reassigned from local |
| `character_sheet_updated` | authoritative state after a mutation was applied |
| `player_joined` / `player_online` / `player_offline` | presence changes |
| `token_moved` / `token_health` | map token updates |
| `roll_result` | anyone rolled — portal players or the local table |
| `condition_update` | condition badges for a token/character |
| `ping` | keep-alive every 30 s |

Token moves carry a per-token **`seq` counter** incremented on every write,
so local can reconcile without trusting wall clocks.

---

## The player portal

A single-page app served from `portal/` at `/` by the same process
(mounted after the API so `/api/v1/...` always wins; HTML/JS/CSS are served
`no-cache, must-revalidate` so a deploy is never hidden behind a stale
browser cache, while images stay cacheable).

What players get:

- **Join** with username + password + 6-char code. No account on the relay —
  credentials are the same ones the GM manages in local ScenePlay.
- **Battle map** — live map with tokens, drag-to-move for your own token
  (ownership checked server-side against your username's characters), token
  tooltips, HP bars, SVG map effects, and a movement-radius circle while
  dragging.
- **Character sheet** — full sheet rendered from the pushed JSON: attributes,
  skills, inventory, weapons, armor, spells, feats, notes, resources,
  conditions; edits stage mutations (see above) and update when local
  confirms. Multi-character players can switch which character they act as.
- **Party view** — everyone's portrait, HP and online status (presence is
  heartbeat-based: the portal pings every 30 s).
- **Dice** — a roller with a floating panel, roll-as-character, quick
  reference, animated results and sound (Tone.js / `sfx.js`); every roll
  lands in the shared log and on the GM's local dice history.
- **Theme picker** mirroring the local app's, and a password-change form
  (bcrypt, verified against the relay copy).

`sfx.js`, `Tone.js` and `dice.js` are shared with the local repo — they're
synced from there by `make sync-assets` (see the ScenePlay repo's Makefile);
edit them at the source, not here.

---

## Home lighting (players' Pis and WLED strips)

Players can have lights at home follow the DM's scene. Two transports:

**Browser path (`portal/led.js`) — locally hosted relay ONLY.** The portal
page POSTs directly to a device address the player saved in Settings (a
ScenePlay Pi or a WLED controller on *their* LAN). This only works when the
portal itself is served over plain HTTP — i.e. the relay is self-hosted on
the player's own network (see `docs/SELF_HOSTED.md`). From the hosted
(HTTPS) portal it does NOT work in any browser: Firefox/Safari always
blocked HTTPS→LAN-HTTP, and Chrome's Local Network Access permission
(`targetAddressSpace`) no longer permits it either — that option is dead;
`led.js` no longer attempts it on HTTPS, and the Home Lights card explains
and points players at the alternatives instead.

**MQTT path (`mqtt_bridge.py`) — works in any browser, WLED only.** WLED has
a built-in MQTT client, so instead of the browser pushing *into* the player's
LAN, the player's WLED dials *out* to a broker and the relay publishes each
lighting change there. No player-side software, no mixed content, browser not
involved. Enable by setting `MQTT_HOST` (see `.env.example`); a checkbox then
appears in the portal's Home Lights card, and its info line tells the player
exactly what to enter in their WLED web UI (Config → Sync Interfaces → MQTT):

    Broker:       <MQTT_PUBLIC_HOST>       Port: <MQTT_PUBLIC_PORT>
    Device Topic: <MQTT_TOPIC_PREFIX>/<their-username-slug>

The relay publishes WLED `/json/state` payloads to `<device topic>/api`,
**retained** — a strip that powers on mid-session immediately snaps to the
current scene. Effects and palettes are sent as *numeric firmware IDs*
(WLED's JSON API cannot resolve names); the local ScenePlay server resolves
names → indices against the DM's own device catalog and ships them as
`effect_id`/`palette_id` in the `/wled` push, so players need a reasonably
mainline WLED firmware for IDs to line up (mainline IDs are stable — it's
the same reason WLED presets survive firmware updates).

Broker notes: any reachable MQTT broker works (mosquitto on a VPS is the
recommended setup; Render can't host raw TCP, so the broker lives elsewhere).
Stock WLED speaks MQTT **without TLS**, so treat the player→broker leg as
cleartext: per-player broker passwords are fine, just not ones that matter
elsewhere. `MQTT_TLS=1` secures only the relay→broker leg.

Step-by-step broker + relay + player setup: **`docs/MQTT_SETUP.md`**.

---

## Auth & security model

Two principals, two mechanisms:

- **GM / local server** — every GM-side endpoint requires the
  `X-Relay-Secret` header, compared with `hmac.compare_digest` against
  `RELAY_SECRET`. This secret is configured on both sides (relay env var,
  local appsettings) and never leaves headers.
- **Players** — `POST /join` verifies the password against the **bcrypt hash
  pushed from local** and issues a 12-hour HS256 JWT (`JWT_SECRET`) carrying
  the character id, display name, username and session id, `scope: player`.
  Every player endpoint validates scope and session match. Join attempts are
  **rate-limited per IP** (sliding window) to blunt code/password guessing.
- Portraits and map images are stored under **content-hash filenames** — no
  user-controlled paths touch the filesystem.
- The relay holds only per-session copies: one session at a time, and
  creating a new session **purges everything** from the previous one.
- CORS is open (`*`) for GET/POST — the portal itself is same-origin; the
  open policy exists so a locally-hosted portal variant can hit a remote
  relay during development.

Secrets live in `.env` (git-ignored; `.env.example` documents the required
keys) or the host's environment. `config.py` fails fast at startup if
`RELAY_SECRET` / `JWT_SECRET` are missing.

---

## Data model (`relay.db`)

| table | contents |
|---|---|
| `sessions` | one row per session: id, join `code`, `scene_json`, `map_json` |
| `characters` | per-session character copies: sheet JSON, HP, portrait URL, username, bcrypt hash, joined flags |
| `session_users` | login accounts pushed from local (spectator-capable, pre-assignment) |
| `token_positions` | map tokens: percent coordinates, type, `seq` write counter |
| `roll_log` | last 50 rolls per session (auto-trimmed) |
| `character_mutations` | the staged player-edit queue: type, JSON payload, `applied` flag |
| `session_library` | the reference-library JSON blob |

Schema is created on startup (`db.create_tables()`), with idempotent
`ALTER TABLE` migrations for columns added since the first release — the same
lightweight migration idiom the local app uses.

---

## API reference (`/api/v1`)

**GM endpoints — require `X-Relay-Secret` header**

| endpoint | purpose |
|---|---|
| `POST /session/create` | purge old session, mint session id + join code |
| `POST /session/push` | scene and/or battle-map state (base64 images localised) |
| `POST /session/{id}/characters` | bulk character upsert (+ broadcast) |
| `POST /session/{id}/users` | bulk login-account upsert |
| `POST /session/{id}/push-roll` | broadcast a local table roll |
| `POST /session/{id}/condition-update` | condition badges |
| `POST /session/{id}/library` | reference library blob |
| `POST /session/{id}/character-sheet-broadcast` | re-broadcast one sheet |
| `POST /session/{id}/mutations/ack` | mark staged mutations applied |
| `GET /session/{id}/sync` | full snapshot + pending mutations (local's poll) |
| `GET /session/{id}/presence` | who's online (seconds since last seen) |
| `GET /session/{id}/rolls` | roll log |

**Player endpoints — require the join JWT (bearer)**

| endpoint | purpose |
|---|---|
| `POST /join` | code + username + password → JWT (+ character sheet), rate-limited |
| `GET /session/{id}/stream` | the SSE feed (token also accepted as `?token=`) |
| `POST /heartbeat` | refresh presence (every 30 s) |
| `POST /roll` | log + broadcast a dice roll (also written to local's history) |
| `POST /character/mutate` | stage a character edit for local to apply |
| `POST /character/password` | change password (bcrypt, old one verified) |
| `POST /character/portrait` | upload a portrait (base64) |
| `GET /library` | the session's reference library |

**Token endpoints — GM secret *or* player JWT** (`/token/move`,
`/token/health`): the GM may move anything; a player may only move tokens
whose label matches a character owned by their username.

---

## Running it

### Self-hosted (non-technical, Windows & Linux)

One-shot installers create the venv, install the pinned dependencies and
generate a `.env` with random secrets: run `./install.sh` (Linux /
Raspberry Pi / macOS) or double-click `install.bat` (Windows 10/11), then
start with `./start.sh` / `start.bat`. Full walkthrough:
[`docs/SELF_HOSTED.md`](docs/SELF_HOSTED.md).

### Local development

```bash
cd ScenePlayRemote
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # exact pins, tested together
cp .env.example .env                     # set RELAY_SECRET + JWT_SECRET
python main.py                           # uvicorn with reload, port 8000
```

Portal: `http://localhost:8000/` · API docs (FastAPI auto-docs):
`http://localhost:8000/docs`.

### Two deployment shapes

1. **Remote relay (Render / any cloud)** — the normal shape for players
   joining over the internet. `render.yaml` describes the service and
   auto-generates `RELAY_SECRET` / `JWT_SECRET` on first deploy —
   **non-technical setup walkthrough: [`docs/RENDER_SETUP.md`](docs/RENDER_SETUP.md)**.
   In this shape the relay
   *cannot* reach the GM's LAN, which is why every push carries its images as
   base64 and why auth verifies against pushed hashes: **the relay never
   needs to call local**. (The optional ScenePlay-DB polling in the stream
   simply no-ops because the DB path doesn't exist.)
2. **Co-located** (relay on the same box/LAN as ScenePlay, checked out as a
   sibling directory of `ScenePlay/`) — everything above plus two direct
   integrations: the SSE stream polls ScenePlay's dice table so local rolls
   appear even without the push path, and portal rolls are written straight
   into local dice history.

### Configuring the local ScenePlay side

In local ScenePlay's TTRPG relay admin: set the relay URL and the same
`RELAY_SECRET`, enable the relay, and press **Sync** — local creates the
session, pushes the party/users/library/map, and shows the join code to hand
to players. (Under the hood that's `relay_enabled` / `relay_url` /
`relay_secret` / `relay_session_id` in appsettings, driven by
`relay_broadcaster.py` and `relay_receiver.py`.)

---

## Repository layout

| path | what |
|---|---|
| `main.py` | FastAPI app: lifespan (DB + asset dirs), CORS, no-cache middleware, router mounting, portal static mount |
| `config.py` | env loading (`.env` or host env), fails fast on missing secrets |
| `auth.py` | GM secret verification (HMAC), player JWT issue/verify |
| `db.py` | schema DDL + migrations, all query helpers (async `databases`) |
| `models.py` | pydantic request/response models |
| `broadcast.py` | in-memory pub/sub per session + presence tracking |
| `routers/gm.py` | GM push surface + image localisation |
| `routers/player.py` | join, mutations, rolls, portraits, heartbeat |
| `routers/stream.py` | the SSE feed (+ co-located dice polling) |
| `routers/tokens.py` | token move/health with dual GM/player auth |
| `routers/sync.py` | local's reconciliation snapshot |
| `portal/` | the player SPA (`index.html`, `app.js`, `style.css`, `dice.js`, `sfx.js`, Tone.js) + localised images (`portraits/`, `battlemaps/`, `monsters/`) |
| `render.yaml` | Render deployment description |
| `install.sh` / `install.bat`, `start.sh` / `start.bat` | self-hosted one-shot installers + start scripts (see `docs/SELF_HOSTED.md`) |
| `requirements.txt` | exact-pinned dependencies |

---

## Design decisions worth knowing

- **SSE, not WebSockets** — traffic is almost entirely server→client; the few
  client→server actions are ordinary POSTs. SSE survives proxies, reconnects
  natively in the browser, and keeps the server loop simple. A 30 s ping
  keeps idle connections open.
- **One session at a time** — `session/create` purges everything. The relay
  serves *a* game night, not a multi-tenant service; this keeps auth, purge
  and reasoning trivial. Run more relays for more simultaneous tables.
- **Staged mutations over direct writes** — the queue survives local being
  briefly offline, gives local a serialized, inspectable list of changes to
  apply, and keeps every game rule (HP clamping, validation) in exactly one
  codebase.
- **Coalescing push queue on the local side** — a flaky relay loses nothing:
  latest-state pushes replace their queued predecessor; event-like pushes
  (rolls) all queue; retries back off to 30 s.
- **Content-hash image filenames** — pushes are idempotent, re-pushes are
  free, and no user input ever forms a filesystem path.
- **`seq` counters on tokens** — reconciliation between relay and local never
  depends on two machines' clocks agreeing.
- **Exact-pinned requirements** — what deploys on Render is byte-for-byte
  what was tested locally; upgrades are deliberate (`pip install -U`,
  retest, re-freeze).
