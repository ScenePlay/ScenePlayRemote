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
        map_json    TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        player_name TEXT NOT NULL,
        sheet_json  TEXT NOT NULL,
        hp_current  INTEGER,
        hp_max      INTEGER,
        updated_at  TEXT NOT NULL
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
        updated_at   TEXT NOT NULL
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
]


async def create_tables() -> None:
    for stmt in _DDL:
        await database.execute(stmt)


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


# ---------------------------------------------------------------------------
# Token positions
# ---------------------------------------------------------------------------

async def upsert_token(
    token_id: str,
    session_id: str,
    character_id: str | None,
    label: str,
    x_pct: float,
    y_pct: float,
    token_type: str,
) -> None:
    await database.execute(
        """
        INSERT INTO token_positions (id, session_id, character_id, label, x_pct, y_pct, token_type, updated_at)
        VALUES (:id, :session_id, :character_id, :label, :x_pct, :y_pct, :token_type, :updated_at)
        ON CONFLICT(id) DO UPDATE SET
            x_pct      = excluded.x_pct,
            y_pct      = excluded.y_pct,
            updated_at = excluded.updated_at
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
    await database.execute(
        "UPDATE token_positions SET x_pct = :x, y_pct = :y, updated_at = :ts WHERE id = :id",
        {"x": x_pct, "y": y_pct, "ts": _now(), "id": token_id},
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
    # Keep at most 500 rows per session
    await database.execute(
        """
        DELETE FROM roll_log
        WHERE session_id = :session_id
          AND id NOT IN (
              SELECT id FROM roll_log
              WHERE session_id = :session_id
              ORDER BY id DESC
              LIMIT 500
          )
        """,
        {"session_id": session_id},
    )


async def get_rolls_for_session(session_id: str, limit: int = 50) -> list[dict]:
    rows = await database.fetch_all(
        "SELECT * FROM roll_log WHERE session_id = :session_id ORDER BY id DESC LIMIT :limit",
        {"session_id": session_id, "limit": limit},
    )
    return [dict(r) for r in rows]
