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
    code: str


class JoinResponse(BaseModel):
    token: str


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
