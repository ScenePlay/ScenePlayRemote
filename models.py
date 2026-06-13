from typing import Any, Optional
from pydantic import BaseModel


class GenerateCodeResponse(BaseModel):
    session_id: str
    code: str


class PushRequest(BaseModel):
    session_id: str
    scene: Optional[dict[str, Any]] = None
    map: Optional[dict[str, Any]] = None


class JoinRequest(BaseModel):
    name: str
    password: str
    code: str


class JoinResponse(BaseModel):
    token: str
    character: Optional[dict[str, Any]] = None


class CharacterPushEntry(BaseModel):
    player_name: str
    username: Optional[str] = None
    display_name: Optional[str] = None
    password_hash: Optional[str] = None
    portrait_url: Optional[str] = None
    portrait_data: Optional[str] = None  # base64-encoded image bytes
    portrait_ext: Optional[str] = None   # file extension, e.g. "png"
    sheet_json: str
    hp_current: Optional[int] = None
    hp_max: Optional[int] = None


class CharacterBulkPushRequest(BaseModel):
    characters: list[CharacterPushEntry]


class CharacterRequest(BaseModel):
    sheet: dict[str, Any]
    hp_current: Optional[int] = None
    hp_max: Optional[int] = None


class RollRequest(BaseModel):
    roll_expr: str
    result: int
    breakdown: str


class TokenMoveRequest(BaseModel):
    token_id: str
    x_pct: float
    y_pct: float
    # Required only when GM creates a brand-new token
    session_id: Optional[str] = None
    label: Optional[str] = None
    token_type: str = "npc"
    character_id: Optional[str] = None


class TokenHealthRequest(BaseModel):
    token_id: str
    hp_current: int
    hp_max: int
    session_id: Optional[str] = None


class HpDeltaRequest(BaseModel):
    delta: int
    character_id: Optional[str] = None  # which character to adjust; defaults to JWT sub


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str
