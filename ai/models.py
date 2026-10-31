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
]

FsmStateType = Literal[
    "IDLE",
    "CALLING",
    "HAGGLING",
    "FLATTERED",
    "SUSPICIOUS",
    "AGGRO",
]

ChoiceType = Literal[
    "polite",
    "haggle",
    "provoke",
    "leave",
    "bluff",
    "order",
    "documents",
    "bribe",
    "directions",
]

NpcIdType = Literal[
    "lao_wang",
    "auntie_li",
    "electronics_zhang",
    "chef_chen",
    "granny_liu",
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
    scene_history: Optional[Any] = Field(default=None, description="Multiplayer scene history sent by Go server")
    npc_kind: Optional[str] = Field(default=None, description="NPC kind (merchant, chef, guard)")

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

    npc_id: str = Field(
        ...,
        min_length=1,
        description="NPC ID: lao_wang, auntie_li, electronics_zhang, chef_chen, granny_liu, guard_zhang",
    )
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
        ...,
        ge=0,
        le=100000,
        description="Updated price after dialogue exchange strictly in [0, 100000]",
    )

    @field_validator("price_new", mode="before")
    @classmethod
    def clamp_price_new(cls, v: Any) -> int:
        try:
            return max(0, min(100000, int(v)))
        except (ValueError, TypeError):
            return 0
    mianzi_delta: int = Field(
        default=0, ge=-30, le=30, description="Delta applied to player's Face/Mianzi strictly in [-30, 30]"
    )
    aggro_delta: int = Field(
        default=0, ge=-30, le=30, description="Delta applied to NPC's Rage/Aggro strictly in [-30, 30]"
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


# ============================================================================
# TTS Models (Stage 6 R2)
# ============================================================================

class TTSRequest(BaseModel):
    """
    Incoming request payload for POST /tts.
    Accepts raw text or structured speech tokens, with optional speed/pitch/speaker overrides.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    text: Optional[str] = Field(
        default=None, description="Text in Hanzi or Pinyin to synthesize"
    )
    tokens: Optional[List[Union[SpeechToken, Dict[str, Any]]]] = Field(
        default=None, description="List of speech tokens with 'zh' and/or 'py' fields"
    )
    lang: Literal["zh-CN", "zh", "cmn", "en"] = Field(
        default="zh-CN", description="Language code (default zh-CN)"
    )
    format: Literal["wav", "json", "base64"] = Field(
        default="wav", description="Output format: 'wav' (binary stream) or 'json'/'base64' (JSON payload)"
    )
    speed: float = Field(
        default=1.0, ge=0.5, le=2.0, description="Speed multiplier (0.5 slow, 2.0 fast)"
    )
    pitch: float = Field(
        default=1.0, ge=0.5, le=2.0, description="Pitch frequency multiplier (0.5 low, 2.0 high)"
    )
    speaker: Optional[Union[NpcIdType, str]] = Field(
        default=None,
        description="NPC speaker preset (lao_wang, auntie_li, electronics_zhang, chef_chen, granny_liu, guard_zhang)",
    )

    @field_validator("speed", "pitch", mode="before")
    @classmethod
    def clamp_multiplier(cls, v: Any) -> float:
        try:
            fv = float(v)
            return max(0.5, min(2.0, fv))
        except (ValueError, TypeError):
            return 1.0

    @model_validator(mode="after")
    def validate_content_presence(self) -> "TTSRequest":
        has_text = self.text is not None and bool(self.text.strip())
        has_tokens = bool(self.tokens)
        if not has_text and not has_tokens:
            raise ValueError("TTSRequest must provide either non-empty 'text' or non-empty 'tokens'")
        return self


class TTSResponse(BaseModel):
    """
    Structured JSON response schema returned when format='json' or format='base64'.
    """
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    status: str = Field(default="ok", description="Synthesis status")
    format: Literal["wav"] = Field(default="wav", description="Audio format")
    sample_rate: int = Field(default=16000, description="Audio sample rate in Hz")
    channels: int = Field(default=1, description="Audio channels (1=mono)")
    duration_sec: float = Field(..., ge=0.0, description="Audio duration in seconds")
    audio_base64: str = Field(..., description="Base64-encoded RIFF WAV audio data")
    text: str = Field(default="", description="Text representation synthesized")

