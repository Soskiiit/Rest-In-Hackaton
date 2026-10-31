"""
ai/models.py
Data models and schemas for Rest-In-Hackaton DEV-B AI Middleware.
Strict Pydantic v2 implementation supporting Godot client, Three.js client, and Go server.
"""

from typing import List, Literal, Optional, Any, Dict, Union
import json
from pydantic import BaseModel, Field, ConfigDict, field_validator, model_validator


# ============================================================================
# Literal Enums
# ============================================================================

EmotionType = Literal[
    "neutral",
    "angry",
    "happy",
    "suspicious",
    "flattered",
    "surprised",
]

FsmStateType = Literal[
    "IDLE",
    "CALLING",
    "HAGGLING",
    "FLATTERED",
    "SUSPICIOUS",
    "AGGRO",
    "TALKING",
    "PATROL",
    "DEAL_AGREED",
]

ChoiceType = Literal[
    "polite",
    "haggle",
    "provoke",
    "leave",
    "brave",
    "weak",
    "bribe",
    "neutral",
]

NpcIdType = Literal[
    "lao_wang",
    "chef_chen",
    "guard_zhang",
]


# ============================================================================
# Sub-Schemas
# ============================================================================

class SpeechToken(BaseModel):
    """
    Individual word or phrase token for two-line subtitle rendering and
    vocabulary progression tracking (known_words filter).
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    zh: str = Field(..., min_length=1, description="Chinese Hanzi characters")
    py: str = Field(..., min_length=1, description="Pinyin transcription with tone marks")
    ru: str = Field(..., min_length=1, description="Russian translation of the token")
    id: str = Field(..., min_length=1, description="Unique word identifier for known_words DB lookup")

    @field_validator("zh", "py", "ru", "id")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("Token field cannot be empty or pure whitespace")
        return s


class Choice(BaseModel):
    """
    Dialogue choice presented to the player (exactly 4 options per turn).
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: int = Field(default=1, ge=1, le=4, description="Choice index 1..4")
    zh: str = Field(..., min_length=1, description="Chinese text for choice")
    py: str = Field(..., min_length=1, description="Pinyin transcription for choice")
    ru: str = Field(..., min_length=1, description="Russian translation for choice")
    type: ChoiceType = Field(default="neutral", description="Choice archetype for UI badge and game mechanics")

    @field_validator("id", mode="before")
    @classmethod
    def clamp_id(cls, v: Any) -> int:
        try:
            iv = int(v)
            return max(1, min(4, iv))
        except (ValueError, TypeError):
            return 1

    @field_validator("zh", "py", "ru")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("Choice field cannot be empty or pure whitespace")
        return s


# ============================================================================
# Request Models
# ============================================================================

class DialogueContext(BaseModel):
    """
    State context passed from game client or Go server to inform LLM / Mock Engine.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    price: int = Field(default=800, ge=0, description="Current price in RMB")
    price_floor: int = Field(default=120, ge=0, description="Minimum acceptable floor price")
    mianzi: int = Field(default=50, ge=0, le=100, description="Respect/Face 0..100")
    aggro: int = Field(default=0, ge=0, le=100, description="Rage/Aggro 0..100")
    history: Any = Field(default="[]", description="Dialogue history (string or list of turns)")

    @field_validator("price", "price_floor", mode="before")
    @classmethod
    def clamp_price(cls, v: Any) -> int:
        try:
            return max(0, int(v))
        except (ValueError, TypeError):
            return 0

    @field_validator("mianzi", "aggro", mode="before")
    @classmethod
    def clamp_status(cls, v: Any) -> int:
        try:
            return max(0, min(100, int(v)))
        except (ValueError, TypeError):
            return 0

    def get_history_str(self) -> str:
        """Helper to safely format history for prompt string interpolation."""
        if isinstance(self.history, str):
            return self.history
        try:
            return json.dumps(self.history, ensure_ascii=False)
        except Exception:
            return str(self.history)


class DialogueRequest(BaseModel):
    """
    Incoming request payload for POST /dialogue.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    npc_id: str = Field(..., min_length=1, description="NPC ID: lao_wang, chef_chen, guard_zhang")
    player_message: str = Field(..., min_length=1, description="Message from player or selected choice text")
    context: Optional[DialogueContext] = Field(default_factory=DialogueContext, description="State variables")

    @field_validator("context", mode="before")
    @classmethod
    def default_null_context(cls, v: Any) -> Any:
        if v is None:
            return DialogueContext()
        return v

    @field_validator("npc_id")
    @classmethod
    def normalize_npc_id(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("player_message")
    @classmethod
    def validate_message(cls, v: str) -> str:
        s = v.strip()
        if not s:
            raise ValueError("player_message cannot be empty or pure whitespace")
        return s


# ============================================================================
# Response Model
# ============================================================================

class DialogueResponse(BaseModel):
    """
    Response returned by POST /dialogue.
    Compatible with Go server, Godot client, and TECH.md requirements.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    speech_tokens: List[SpeechToken] = Field(
        ..., min_length=1, description="Tokenized speech for two-line subtitles"
    )
    tokens: Optional[List[SpeechToken]] = Field(
        default=None, description="Direct alias for speech_tokens for Go server compatibility"
    )
    emotion: EmotionType = Field(
        default="neutral", description="Emotional state for 3D character mesh animation"
    )
    price_new: int = Field(
        ..., ge=0, description="Updated price after dialogue exchange"
    )
    mianzi_delta: int = Field(
        default=0, ge=-100, le=100, description="Delta applied to player's Face/Mianzi"
    )
    aggro_delta: int = Field(
        default=0, ge=-100, le=100, description="Delta applied to NPC's Rage/Aggro"
    )
    fsm_state: FsmStateType = Field(
        default="HAGGLING", description="Current FSM state"
    )
    choices: List[Choice] = Field(
        ..., min_length=4, max_length=4, description="Exactly 4 dialogue response options"
    )
    raw: Optional[str] = Field(
        default=None, description="Raw text response from LLM or mock generator"
    )
    parsed: Optional[Dict[str, Any]] = Field(
        default=None, description="Parsed dict for compatibility with TECH.md"
    )

    @model_validator(mode="before")
    @classmethod
    def synchronize_tokens_input(cls, data: Any) -> Any:
        if isinstance(data, dict):
            # If tokens is provided instead of speech_tokens, mirror it
            if "tokens" in data and "speech_tokens" not in data:
                data["speech_tokens"] = data["tokens"]
        return data

    @model_validator(mode="after")
    def synchronize_tokens_output(self) -> "DialogueResponse":
        # Ensure tokens is populated as an exact clone of speech_tokens
        if self.tokens is None or len(self.tokens) != len(self.speech_tokens):
            self.tokens = self.speech_tokens
        return self

    @field_validator("choices")
    @classmethod
    def validate_choices(cls, choices: List[Choice]) -> List[Choice]:
        if len(choices) != 4:
            raise ValueError(f"DialogueResponse must contain exactly 4 choices, got {len(choices)}")
        # Verify choice IDs are 1..4
        ids = [c.id for c in choices]
        if set(ids) != {1, 2, 3, 4}:
            # Normalize choice IDs to 1..4 sequentially
            for idx, c in enumerate(choices, start=1):
                c.id = idx
        return choices


# ============================================================================
# Health Model
# ============================================================================

class HealthResponse(BaseModel):
    """
    Response schema for GET /health.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    status: str = Field(default="ok", description="Overall service status")
    model: str = Field(..., description="Target LLM model name")
    llm_endpoint: str = Field(..., description="Target upstream inference URL")
    llm_alive: bool = Field(default=False, description="Whether llama-server is currently reachable")
    backend: Literal["llama-server", "mock"] = Field(
        ..., description="Active backend used for dialogue inference"
    )
    llama_server: Optional[str] = Field(default=None, description="Status string: connected/disconnected")
    mock_mode: Optional[bool] = Field(default=None, description="Whether mock mode is active")
