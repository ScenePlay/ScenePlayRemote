import uuid
from datetime import datetime, timezone

import databases

from config import DATABASE_URL

database = databases.Database(DATABASE_URL)

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_DDL = [
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        code        TEXT UNIQUE NOT NULL,
        created_at  TEXT NOT NULL,
        scene_json  TEXT,
        map_json    TEXT,
        led_json    TEXT,
        led_seq     INTEGER NOT NULL DEFAULT 0,
        wled_json   TEXT,
        wled_seq    INTEGER NOT NULL DEFAULT 0,
        now_playing_json TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS led_devices (
        username    TEXT PRIMARY KEY,
        pi_url      TEXT NOT NULL DEFAULT '',
        wled_url    TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS characters (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        player_name   TEXT NOT NULL,
        username      TEXT,
        display_name  TEXT,
        password_hash TEXT,
        portrait_url  TEXT,
        sheet_json    TEXT NOT NULL,
        hp_current    INTEGER,
        hp_max        INTEGER,
        has_joined    INTEGER NOT NULL DEFAULT 0,
        joined_at     TEXT,
        updated_at    TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS token_positions (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        character_id TEXT,
        label        TEXT NOT NULL,
        x_pct        REAL NOT NULL,
        y_pct        REAL NOT NULL,
        token_type   TEXT NOT NULL DEFAULT 'player',
        updated_at   TEXT NOT NULL,
        seq          INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS roll_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        player_name TEXT NOT NULL,
        roll_expr   TEXT NOT NULL,
        result      INTEGER NOT NULL,
        breakdown   TEXT NOT NULL,
        rolled_at   TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS character_mutations (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        player_name    TEXT NOT NULL,
        mutation_type  TEXT NOT NULL,
        mutation_data  TEXT NOT NULL,
        applied        INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id),
        username      TEXT NOT NULL,
        display_name  TEXT,
        password_hash TEXT,
        updated_at    TEXT NOT NULL,
        UNIQUE(session_id, username)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_library (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL REFERENCES sessions(id) UNIQUE,
        library_json TEXT NOT NULL,
        updated_at   TEXT NOT NULL
    )
    """,
]


async def create_tables() -> None:
    for stmt in _DDL:
        await database.execute(stmt)
    # Lightweight migration: led_devices.mqtt — player opted into WLED-over-
    # MQTT (relay publishes their lighting to a broker; see mqtt_bridge.py).
    # Idempotent: the ALTER fails harmlessly once the column exists.
    try:
        await database.execute(
            "ALTER TABLE led_devices ADD COLUMN mqtt INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass
    # Migrate existing databases that predate has_joined / joined_at
    for _col, _def in [
        ("has_joined",    "INTEGER NOT NULL DEFAULT 0"),
        ("joined_at",     "TEXT"),
        ("username",      "TEXT"),
        ("display_name",  "TEXT"),
        ("portrait_url",  "TEXT"),
        ("password_hash", "TEXT"),
    ]:
        try:
            await database.execute(f"ALTER TABLE characters ADD COLUMN {_col} {_def}")
        except Exception:
            pass  # column already exists
    # Per-token write sequence for clock-skew-free reconciliation on local
    try:
        await database.execute(
            "ALTER TABLE token_positions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass  # column already exists
    # Session-wide monotonic counter feeding token seqs. Per-row counters
    # restarted at 1 whenever token rows were cleared (map change), which
    # could COLLIDE with the last seq ScenePlay had recorded for that label —
    # ScenePlay then judged the fresh move an echo and never applied it.
    # A counter on the sessions row survives row clears, so a seq can never
    # repeat within a session.
    try:
        await database.execute(
            "ALTER TABLE sessions ADD COLUMN token_seq INTEGER NOT NULL DEFAULT 0")
    except Exception:
        pass  # column already exists
    # Seed the counter past any seqs already handed out, or the first move
    # after this upgrade would reuse a value ScenePlay has already recorded.
    try:
        await database.execute(
            """UPDATE sessions SET token_seq = (
                   SELECT COALESCE(MAX(seq), 0) FROM token_positions
                   WHERE token_positions.session_id = sessions.id)
               WHERE COALESCE(token_seq, 0) = 0""")
    except Exception:
        pass
    # Latest lighting state pushed from local, replayed to late joiners
    for _col, _def in [
        ("led_json",  "TEXT"),
        ("led_seq",   "INTEGER NOT NULL DEFAULT 0"),
        ("wled_json", "TEXT"),
        ("wled_seq",  "INTEGER NOT NULL DEFAULT 0"),
        ("now_playing_json", "TEXT"),
    ]:
        try:
            await database.execute(f"ALTER TABLE sessions ADD COLUMN {_col} {_def}")
        except Exception:
            pass  # column already exists


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(record) -> dict | None:
    return dict(record) if record is not None else None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

async def purge_all_sessions() -> None:
    """Delete every session and all associated data — called before creating a new session."""
    await database.execute("DELETE FROM character_mutations")
    await database.execute("DELETE FROM session_library")
    await database.execute("DELETE FROM roll_log")
    await database.execute("DELETE FROM token_positions")
    await database.execute("DELETE FROM characters")
    await database.execute("DELETE FROM session_users")
    await database.execute("DELETE FROM sessions")


async def clear_token_positions(session_id: str) -> None:
    """Drop a session's incremental token-move rows. Called when the pushed
    map CHANGES: the rows describe the previous map and would otherwise be
    echoed back (matched by label) onto the new map's tokens."""
    await database.execute(
        "DELETE FROM token_positions WHERE session_id = :sid", {"sid": session_id}
    )


async def create_session(session_id: str, code: str) -> None:
    await database.execute(
        "INSERT INTO sessions (id, code, created_at) VALUES (:id, :code, :created_at)",
        {"id": session_id, "code": code, "created_at": _now()},
    )


async def get_session_by_code(code: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM sessions WHERE code = :code", {"code": code}
    ))


async def get_session_by_id(session_id: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM sessions WHERE id = :id", {"id": session_id}
    ))


async def update_session_state(
    session_id: str,
    scene_json: str | None,
    map_json: str | None,
) -> None:
    if scene_json is not None:
        await database.execute(
            "UPDATE sessions SET scene_json = :v WHERE id = :id",
            {"v": scene_json, "id": session_id},
        )
    if map_json is not None:
        await database.execute(
            "UPDATE sessions SET map_json = :v WHERE id = :id",
            {"v": map_json, "id": session_id},
        )


# ---------------------------------------------------------------------------
# Characters
# ---------------------------------------------------------------------------

async def upsert_character(
    character_id: str,
    session_id: str,
    player_name: str,
    sheet_json: str,
    hp_current: int | None,
    hp_max: int | None,
) -> None:
    await database.execute(
        """
        INSERT INTO characters (id, session_id, player_name, sheet_json, hp_current, hp_max, updated_at)
        VALUES (:id, :session_id, :player_name, :sheet_json, :hp_current, :hp_max, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
            player_name = excluded.player_name,
            sheet_json  = excluded.sheet_json,
            hp_current  = excluded.hp_current,
            hp_max      = excluded.hp_max,
            updated_at  = excluded.updated_at
        """,
        {
            "id": character_id,
            "session_id": session_id,
            "player_name": player_name,
            "sheet_json": sheet_json,
            "hp_current": hp_current,
            "hp_max": hp_max,
            "updated_at": _now(),
        },
    )


async def mark_character_joined(character_id: str) -> None:
    await database.execute(
        "UPDATE characters SET has_joined = 1, joined_at = :ts WHERE id = :id",
        {"ts": _now(), "id": character_id},
    )


async def get_character_by_player_name(session_id: str, player_name: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM characters WHERE session_id = :session_id AND player_name = :player_name",
        {"session_id": session_id, "player_name": player_name},
    ))


async def get_character_by_username(session_id: str, username: str) -> dict | None:
    for col in ("username", "display_name", "player_name"):
        row = _row(await database.fetch_one(
            f"SELECT * FROM characters WHERE session_id = :sid AND {col} = :u",
            {"sid": session_id, "u": username},
        ))
        if row:
            return row
    return None


async def upsert_character_by_name(
    session_id: str,
    player_name: str,
    username: str | None,
    display_name: str | None,
    sheet_json: str,
    hp_current: int | None,
    hp_max: int | None,
    portrait_url: str | None = None,
    password_hash: str | None = None,
) -> str:
    existing = await get_character_by_player_name(session_id, player_name)
    if existing:
        # Only overwrite password_hash / portrait_url when a fresh one is provided
        new_hash    = password_hash or existing.get("password_hash")
        new_portrait = portrait_url or existing.get("portrait_url")
        await database.execute(
            """UPDATE characters
               SET username=:un, display_name=:dn, portrait_url=:pu,
                   password_hash=:ph, sheet_json=:sj,
                   hp_current=:hc, hp_max=:hm, updated_at=:ts
               WHERE id=:id""",
            {
                "un": username, "dn": display_name, "pu": new_portrait,
                "ph": new_hash, "sj": sheet_json,
                "hc": hp_current, "hm": hp_max,
                "ts": _now(), "id": existing["id"],
            },
        )
        return existing["id"]
    char_id = str(uuid.uuid4())
    await database.execute(
        """
        INSERT INTO characters
            (id, session_id, player_name, username, display_name,
             password_hash, portrait_url, sheet_json, hp_current, hp_max, updated_at)
        VALUES
            (:id, :session_id, :player_name, :username, :display_name,
             :password_hash, :portrait_url, :sheet_json, :hp_current, :hp_max, :updated_at)
        """,
        {
            "id": char_id,
            "session_id": session_id,
            "player_name": player_name,
            "username": username,
            "display_name": display_name,
            "password_hash": password_hash,
            "portrait_url": portrait_url,
            "sheet_json": sheet_json,
            "hp_current": hp_current,
            "hp_max": hp_max,
            "updated_at": _now(),
        },
    )
    return char_id


async def list_character_names(session_id: str) -> list[str]:
    rows = await database.fetch_all(
        "SELECT player_name FROM characters WHERE session_id = :sid",
        {"sid": session_id},
    )
    return [r["player_name"] for r in rows]


async def delete_character_by_name(session_id: str, player_name: str) -> bool:
    existing = await get_character_by_player_name(session_id, player_name)
    if not existing:
        return False
    await database.execute(
        "DELETE FROM token_positions WHERE character_id = :cid",
        {"cid": existing["id"]},
    )
    await database.execute(
        "DELETE FROM characters WHERE id = :id",
        {"id": existing["id"]},
    )
    return True


async def upsert_session_user(session_id: str, username: str,
                              display_name: str | None,
                              password_hash: str | None) -> None:
    """User accounts pushed from local so anyone at the table can log in
    BEFORE a character is assigned to them."""
    await database.execute(
        """
        INSERT INTO session_users (session_id, username, display_name, password_hash, updated_at)
        VALUES (:sid, :un, :dn, :ph, :ts)
        ON CONFLICT(session_id, username) DO UPDATE SET
            display_name  = excluded.display_name,
            password_hash = CASE WHEN excluded.password_hash != ''
                                 THEN excluded.password_hash
                                 ELSE session_users.password_hash END,
            updated_at    = excluded.updated_at
        """,
        {"sid": session_id, "un": username, "dn": display_name,
         "ph": password_hash or "", "ts": _now()},
    )


async def get_session_user(session_id: str, username: str) -> dict | None:
    row = await database.fetch_one(
        "SELECT * FROM session_users WHERE session_id = :sid AND username = :un",
        {"sid": session_id, "un": username},
    )
    return dict(row) if row else None


async def get_characters_by_username(session_id: str, username: str) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM characters WHERE session_id = :sid AND username = :un ORDER BY player_name",
        {"sid": session_id, "un": username},
    )
    return [dict(r) for r in rows]


async def get_characters_for_session(session_id: str) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM characters WHERE session_id = :session_id",
        {"session_id": session_id},
    )
    return [dict(r) for r in rows]


async def get_character(character_id: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM characters WHERE id = :id", {"id": character_id}
    ))


async def update_character_hp(character_id: str, hp_current: int, hp_max: int) -> dict | None:
    await database.execute(
        "UPDATE characters SET hp_current = :hc, hp_max = :hm, updated_at = :ts WHERE id = :id",
        {"hc": hp_current, "hm": hp_max, "ts": _now(), "id": character_id},
    )
    return await get_character(character_id)


async def update_character_password(character_id: str, password_hash: str) -> None:
    await database.execute(
        "UPDATE characters SET password_hash = :ph, updated_at = :ts WHERE id = :id",
        {"ph": password_hash, "ts": _now(), "id": character_id},
    )


# ---------------------------------------------------------------------------
# Token positions
# ---------------------------------------------------------------------------

async def _next_token_seq(session_id: str) -> int:
    """Session-wide monotonic write counter for token positions.

    Seqs must never repeat within a session even across clear_token_positions
    (map changes): a repeated value collides with the last seq ScenePlay
    recorded for that label, making it drop a genuinely new move as an echo."""
    await database.execute(
        "UPDATE sessions SET token_seq = COALESCE(token_seq, 0) + 1 WHERE id = :sid",
        {"sid": session_id},
    )
    row = await database.fetch_one(
        "SELECT token_seq FROM sessions WHERE id = :sid", {"sid": session_id}
    )
    return int(row["token_seq"]) if row else 1


async def upsert_token(
    token_id: str,
    session_id: str,
    character_id: str | None,
    label: str,
    x_pct: float,
    y_pct: float,
    token_type: str,
) -> None:
    seq = await _next_token_seq(session_id)
    await database.execute(
        """
        INSERT INTO token_positions (id, session_id, character_id, label, x_pct, y_pct, token_type, updated_at, seq)
        VALUES (:id, :session_id, :character_id, :label, :x_pct, :y_pct, :token_type, :updated_at, :seq)
        ON CONFLICT(id) DO UPDATE SET
            x_pct      = excluded.x_pct,
            y_pct      = excluded.y_pct,
            updated_at = excluded.updated_at,
            seq        = excluded.seq
        """,
        {
            "id": token_id,
            "session_id": session_id,
            "character_id": character_id,
            "label": label,
            "x_pct": x_pct,
            "y_pct": y_pct,
            "token_type": token_type,
            "updated_at": _now(),
            "seq": seq,
        },
    )


async def get_token(token_id: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM token_positions WHERE id = :id", {"id": token_id}
    ))


async def get_token_by_character(character_id: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM token_positions WHERE character_id = :cid", {"cid": character_id}
    ))


async def update_token_position(token_id: str, x_pct: float, y_pct: float) -> dict | None:
    token = await get_token(token_id)
    if token is None:
        return None
    seq = await _next_token_seq(token["session_id"])
    await database.execute(
        "UPDATE token_positions SET x_pct = :x, y_pct = :y, updated_at = :ts, seq = :seq WHERE id = :id",
        {"x": x_pct, "y": y_pct, "ts": _now(), "id": token_id, "seq": seq},
    )
    return await get_token(token_id)


async def get_tokens_for_session(session_id: str) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM token_positions WHERE session_id = :session_id",
        {"session_id": session_id},
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Roll log
# ---------------------------------------------------------------------------

async def insert_roll(
    session_id: str,
    player_name: str,
    roll_expr: str,
    result: int,
    breakdown: str,
) -> None:
    await database.execute(
        """
        INSERT INTO roll_log (session_id, player_name, roll_expr, result, breakdown, rolled_at)
        VALUES (:session_id, :player_name, :roll_expr, :result, :breakdown, :rolled_at)
        """,
        {
            "session_id": session_id,
            "player_name": player_name,
            "roll_expr": roll_expr,
            "result": result,
            "breakdown": breakdown,
            "rolled_at": _now(),
        },
    )
    # Keep at most 50 rows per session
    await database.execute(
        """
        DELETE FROM roll_log
        WHERE session_id = :session_id
          AND id NOT IN (
              SELECT id FROM roll_log
              WHERE session_id = :session_id
              ORDER BY id DESC
              LIMIT 50
          )
        """,
        {"session_id": session_id},
    )


async def get_rolls_since(session_id: str, since_id: int = 0) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM roll_log WHERE session_id = :session_id AND id > :since_id ORDER BY id ASC LIMIT 50",
        {"session_id": session_id, "since_id": since_id},
    )
    return [dict(r) for r in rows]


async def get_rolls_for_session(session_id: str, limit: int = 50) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM roll_log WHERE session_id = :session_id ORDER BY id DESC LIMIT :limit",
        {"session_id": session_id, "limit": limit},
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Character mutations
# ---------------------------------------------------------------------------

async def insert_mutation(
    session_id: str,
    player_name: str,
    mutation_type: str,
    mutation_data: str,
) -> int:
    row = await database.fetch_one(
        """
        INSERT INTO character_mutations (session_id, player_name, mutation_type, mutation_data, applied, created_at)
        VALUES (:session_id, :player_name, :mutation_type, :mutation_data, 0, :created_at)
        RETURNING id
        """,
        {
            "session_id": session_id,
            "player_name": player_name,
            "mutation_type": mutation_type,
            "mutation_data": mutation_data,
            "created_at": _now(),
        },
    )
    return row["id"]


async def get_pending_mutations(session_id: str) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM character_mutations WHERE session_id = :sid AND applied = 0 ORDER BY id ASC",
        {"sid": session_id},
    )
    return [dict(r) for r in rows]


async def ack_mutations(mutation_ids: list[int]) -> None:
    if not mutation_ids:
        return
    placeholders = ", ".join(f":id{i}" for i in range(len(mutation_ids)))
    params = {f"id{i}": mid for i, mid in enumerate(mutation_ids)}
    await database.execute(
        f"UPDATE character_mutations SET applied = 1 WHERE id IN ({placeholders})",
        params,
    )


# ---------------------------------------------------------------------------
# Session library
# ---------------------------------------------------------------------------

async def upsert_library(session_id: str, library_json: str) -> None:
    await database.execute(
        """
        INSERT INTO session_library (session_id, library_json, updated_at)
        VALUES (:session_id, :library_json, :updated_at)
        ON CONFLICT(session_id) DO UPDATE SET
            library_json = excluded.library_json,
            updated_at   = excluded.updated_at
        """,
        {"session_id": session_id, "library_json": library_json, "updated_at": _now()},
    )


async def get_library(session_id: str) -> dict | None:
    return _row(await database.fetch_one(
        "SELECT * FROM session_library WHERE session_id = :sid",
        {"sid": session_id},
    ))


# ---------------------------------------------------------------------------
# Lighting (LED / WLED) state + player home devices
# ---------------------------------------------------------------------------

async def _bump_lighting(session_id: str, json_col: str, seq_col: str,
                         payload_json: str) -> int:
    """Store the latest lighting payload and return the new monotonic seq.
    The seq lets portals skip replays on SSE reconnect (mirror of token_seq)."""
    await database.execute(
        f"UPDATE sessions SET {json_col} = :v, "
        f"{seq_col} = COALESCE({seq_col}, 0) + 1 WHERE id = :sid",
        {"v": payload_json, "sid": session_id},
    )
    row = await database.fetch_one(
        f"SELECT {seq_col} AS seq FROM sessions WHERE id = :sid", {"sid": session_id}
    )
    return int(row["seq"]) if row else 1


async def update_session_led(session_id: str, led_json: str) -> int:
    return await _bump_lighting(session_id, "led_json", "led_seq", led_json)


async def update_session_wled(session_id: str, wled_json: str) -> int:
    return await _bump_lighting(session_id, "wled_json", "wled_seq", wled_json)


async def update_session_now_playing(session_id: str, payload_json: str) -> None:
    # No seq: replay is an idempotent UI label, not a reconciled state stream
    await database.execute(
        "UPDATE sessions SET now_playing_json = :v WHERE id = :sid",
        {"v": payload_json, "sid": session_id},
    )


async def upsert_led_device(username: str, pi_url: str, wled_url: str,
                            mqtt: bool = False) -> None:
    """Keyed by username, NOT session: a player's home device addresses
    survive session regeneration. Everything empty/off deletes the row."""
    if not pi_url and not wled_url and not mqtt:
        await database.execute(
            "DELETE FROM led_devices WHERE username = :un", {"un": username})
        return
    await database.execute(
        """
        INSERT INTO led_devices (username, pi_url, wled_url, mqtt, updated_at)
        VALUES (:un, :pi, :wl, :mq, :ts)
        ON CONFLICT(username) DO UPDATE SET
            pi_url     = excluded.pi_url,
            wled_url   = excluded.wled_url,
            mqtt       = excluded.mqtt,
            updated_at = excluded.updated_at
        """,
        {"un": username, "pi": pi_url, "wl": wled_url,
         "mq": 1 if mqtt else 0, "ts": _now()},
    )


async def get_led_device(username: str) -> dict:
    row = _row(await database.fetch_one(
        "SELECT pi_url, wled_url, mqtt FROM led_devices WHERE username = :un",
        {"un": username},
    ))
    if not row:
        return {"pi_url": "", "wled_url": "", "mqtt": False}
    row["mqtt"] = bool(row.get("mqtt"))
    return row


async def get_session_mqtt_usernames(session_id: str) -> list[str]:
    """Usernames of this session's players who opted into WLED-over-MQTT.
    Roster = session_users plus any character logins carrying a username."""
    rows = await database.fetch_all(
        """
        SELECT username FROM led_devices
        WHERE mqtt = 1 AND username IN (
            SELECT username FROM session_users WHERE session_id = :sid
            UNION
            SELECT username FROM characters
            WHERE session_id = :sid AND username IS NOT NULL AND username != ''
        )
        """,
        {"sid": session_id},
    )
    return [r["username"] for r in rows]
