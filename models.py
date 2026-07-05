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


class UserPushEntry(BaseModel):
    username: str
    display_name: str | None = None
    password_hash: str | None = None


class UsersBulkPushRequest(BaseModel):
    users: list[UserPushEntry]


class RollRequest(BaseModel):
    roll_expr: str
    result: int
    breakdown: str
    # Roll AS another character owned by the same login (a player can run
    # several characters). Validated server-side against the username.
    as_player: str | None = None


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


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ConditionUpdateRequest(BaseModel):
    token_id: Optional[str] = None
    player_name: Optional[str] = None
    conditions: list = []


class MutationRequest(BaseModel):
    mutation_type: str
    data: dict[str, Any] = {}
    # Edit AS another character owned by the same login (multi-character
    # players; users who logged in before a character was assigned).
    as_player: str | None = None


class MutationAckRequest(BaseModel):
    mutation_ids: list[int]


class LibraryPushRequest(BaseModel):
    spells: list[dict[str, Any]] = []
    feats: list[dict[str, Any]] = []
    weapons: list[dict[str, Any]] = []
    armor: list[dict[str, Any]] = []
    equipment: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    races: list[dict[str, Any]] = []
    classes: list[dict[str, Any]] = []
    # Newer reference categories (older local servers simply omit them)
    conditions: list[dict[str, Any]] = []
    magic_items: list[dict[str, Any]] = []
    features: list[dict[str, Any]] = []
    class_levels: list[dict[str, Any]] = []
    subclasses: list[dict[str, Any]] = []
    traits: list[dict[str, Any]] = []
    weapon_properties: list[dict[str, Any]] = []
    rules: list[dict[str, Any]] = []


class SheetBroadcastRequest(BaseModel):
    player_name: str


class PortraitUploadRequest(BaseModel):
    portrait_data: str   # base64-encoded image bytes
    portrait_ext: str    # e.g. "png", "jpg", "webp"
