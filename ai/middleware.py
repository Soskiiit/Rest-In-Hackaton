"""
ai/middleware.py
FastAPI AI Middleware for Rest-In-Hackaton DEV-B (Stages 1-8).

Listens on port 8000. Provides:
- GET /health: Healthcheck and LLM connectivity status
- POST /dialogue: Structured dialogue orchestration, prompt interpolation,
                  LLM inference with resilient mock fallback, Go contract clamping,
                  and dual schema compatibility.
- POST /tts: Offline acoustic/formant speech synthesis returning binary WAV or JSON base64.
- GET /tts: Query-based offline speech synthesis for audio streaming.
"""

import base64
import json
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    from ai.llm_client import (
        LLMClient,
        LLMClientError,
        DEFAULT_LLAMA_SERVER_URL,
        DEFAULT_MODEL,
    )
    from ai.mock_engine import generate_mock_dialogue
    from ai.models import (
        Choice,
        ChoiceType,
        DialogueContext,
        DialogueRequest,
        DialogueResponse,
        EmotionType,
        FsmStateType,
        HealthResponse,
        NpcIdType,
        SpeechToken,
        TTSRequest,
        TTSResponse,
    )
    from ai.prompt_engine import format_prompt
    from ai.tts import (
        synthesize_wav,
        synthesize_to_base64,
        SPEAKER_PROFILES,
    )
except (ImportError, ModuleNotFoundError):
    from llm_client import (
        LLMClient,
        LLMClientError,
        DEFAULT_LLAMA_SERVER_URL,
        DEFAULT_MODEL,
    )
    from mock_engine import generate_mock_dialogue
    from models import (
        Choice,
        ChoiceType,
        DialogueContext,
        DialogueRequest,
        DialogueResponse,
        EmotionType,
        FsmStateType,
        HealthResponse,
        NpcIdType,
        SpeechToken,
        TTSRequest,
        TTSResponse,
    )
    from prompt_engine import format_prompt
    from tts import (
        synthesize_wav,
        synthesize_to_base64,
        SPEAKER_PROFILES,
    )

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai.middleware")

# Environment mode
MOCK_MODE_ENV = os.getenv("MOCK_MODE", "").lower() in ("1", "true", "yes")

# Known NPC identifiers
KNOWN_NPCS = {
    "lao_wang",
    "auntie_li",
    "electronics_zhang",
    "chef_chen",
    "granny_liu",
    "guard_zhang",
}

# Strictly Go-compliant literal sets (server/internal/game/dialogue.go:108-143)
VALID_EMOTIONS: set[str] = {
    "neutral",
    "angry",
    "happy",
    "suspicious",
}

VALID_FSM_STATES: set[str] = {
    "IDLE",
    "CALLING",
    "HAGGLING",
    "FLATTERED",
    "SUSPICIOUS",
    "AGGRO",
}

VALID_CHOICE_TYPES: set[str] = {
    "polite",
    "haggle",
    "provoke",
    "leave",
    "bluff",
    "order",
    "documents",
    "bribe",
    "directions",
}

# Normalization maps
EMOTION_NORMALIZATION: Dict[str, EmotionType] = {
    "flattered": "happy",
    "surprised": "suspicious",
    "sad": "neutral",
    "neutral": "neutral",
    "angry": "angry",
    "happy": "happy",
    "suspicious": "suspicious",
}

FSM_NORMALIZATION: Dict[str, FsmStateType] = {
    "TALKING": "HAGGLING",
    "PATROL": "SUSPICIOUS",
    "DEAL_AGREED": "FLATTERED",
    "IDLE": "IDLE",
    "CALLING": "CALLING",
    "HAGGLING": "HAGGLING",
    "FLATTERED": "FLATTERED",
    "SUSPICIOUS": "SUSPICIOUS",
    "AGGRO": "AGGRO",
}

CHOICE_TYPE_NORMALIZATION: Dict[str, ChoiceType] = {
    "brave": "order",
    "weak": "order",
    "neutral": "directions",
}

# Fallback default choices per NPC (ensures exactly 4 choices guarantee)
DEFAULT_CHOICES: Dict[str, List[Choice]] = {
    "lao_wang": [
        Choice(id=1, zh="老板，便宜点", py="Lǎobǎn piányi diǎn", ru="Босс, сделай скидку", type="polite"),
        Choice(id=2, zh="太贵了！", py="Tài guì le!", ru="Слишком дорого!", type="haggle"),
        Choice(id=3, zh="这是假货", py="Zhè shì jiǎhuò", ru="Это подделка", type="provoke"),
        Choice(id=4, zh="我再想想", py="Wǒ zài xiǎngxiang", ru="Дай подумаю", type="leave"),
    ],
    "auntie_li": [
        Choice(id=1, zh="茶很香，老板娘真懂茶！", py="Chá hěn xiāng, lǎobǎnniáng zhēn dǒng chá!", ru="Чай очень ароматный, хозяйка — знаток!", type="polite"),
        Choice(id=2, zh="李阿姨，老王那边便宜二十块！", py="Lǐ āyí, Lǎo Wáng nàbiān piányi èrshí kuài!", ru="Тётушка Ли, у Лао Вана на 20 юаней дешевле!", type="haggle"),
        Choice(id=3, zh="有立顿红茶吗？", py="Yǒu Lìdùn hóngchá ma?", ru="А есть Липтон в пакетиках?", type="provoke"),
        Choice(id=4, zh="谢谢，我改天再来", py="Xièxie, wǒ gǎitiān zài lái", ru="Спасибо, я зайду в другой день", type="leave"),
    ],
    "electronics_zhang": [
        Choice(id=1, zh="师傅，220伏能用吗？", py="Shīfu, èrbǎi èrshí fú néng yòng ma?", ru="Мастер, на 220 вольт подходит?", type="polite"),
        Choice(id=2, zh="二十块行不行？", py="Èrshí kuài xíng bu xíng?", ru="За 20 юаней отдашь?", type="haggle"),
        Choice(id=3, zh="这不会爆炸吧？", py="Zhè bú huì bàozhà ba?", ru="Оно не взорвется?", type="provoke"),
        Choice(id=4, zh="我去别家看看", py="Wǒ qù biéjiā kànkan", ru="Я гляну в другом павильоне", type="leave"),
    ],
    "chef_chen": [
        Choice(id=1, zh="不要辣", py="Bùyào là", ru="Без острого, пожалуйста", type="order"),
        Choice(id=2, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса, пожалуйста", type="order"),
        Choice(id=3, zh="有什么推荐？", py="Yǒu shénme tuījiàn?", ru="Что порекомендуешь?", type="polite"),
        Choice(id=4, zh="我先看看", py="Wǒ xiān kànkan", ru="Я пока посмотрю", type="leave"),
    ],
    "granny_liu": [
        Choice(id=1, zh="奶奶，这个怎么泡水？", py="Nǎinai, zhège zěnme pào shuǐ?", ru="Бабушка, как это правильно заваривать?", type="polite"),
        Choice(id=2, zh="便宜点吧，我学生", py="Piányi diǎn ba, wǒ xuésheng", ru="Сделайте скидку, я студент", type="haggle"),
        Choice(id=3, zh="这草根能治病？我不信", py="Zhè cǎogēn néng zhìbìng? Wǒ bú xìn", ru="Эти корешки лечат? Не верю", type="provoke"),
        Choice(id=4, zh="谢谢奶奶，我先走了", py="Xièxie nǎinai, wǒ xiān zǒu le", ru="Спасибо бабушка, я пойду", type="leave"),
    ],
    "guard_zhang": [
        Choice(id=1, zh="这是我的票", py="Zhè shì wǒ de piào", ru="Вот мой билет", type="documents"),
        Choice(id=2, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу, пожалуйста", type="directions"),
        Choice(id=3, zh="能通融一下吗？", py="Néng tōngróng yíxià ma?", ru="Можно договориться?", type="bribe"),
        Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
    ],
}

# Fallback default speech tokens per NPC (100% catalog words)
DEFAULT_TOKENS: Dict[str, List[SpeechToken]] = {
    "lao_wang": [
        SpeechToken(zh="这是", py="Zhè shì", ru="это", id="word_this"),
        SpeechToken(zh="正宗的", py="zhèngzōng de", ru="настоящий", id="word_authentic"),
        SpeechToken(zh="玉", py="yù", ru="нефрит", id="word_jade"),
    ],
    "auntie_li": [
        SpeechToken(zh="茶叶", py="cháyè", ru="чай", id="word_tea"),
        SpeechToken(zh="茶壶", py="cháhú", ru="чайник", id="word_teapot"),
        SpeechToken(zh="茶杯", py="chábēi", ru="чашка", id="word_cup"),
        SpeechToken(zh="水", py="shuǐ", ru="вода", id="word_water"),
    ],
    "electronics_zhang": [
        SpeechToken(zh="这是", py="Zhè shì", ru="это", id="word_this"),
        SpeechToken(zh="便宜", py="piányi", ru="дёшево", id="word_cheap"),
        SpeechToken(zh="钱", py="qián", ru="деньги", id="word_money"),
        SpeechToken(zh="安全", py="ānquán", ru="безопасность", id="word_safe"),
    ],
    "chef_chen": [
        SpeechToken(zh="面条", py="miàntiáo", ru="лапша", id="word_noodles"),
        SpeechToken(zh="辣", py="là", ru="острое", id="word_spicy"),
        SpeechToken(zh="花生", py="huāshēng", ru="арахис", id="word_peanut"),
    ],
    "granny_liu": [
        SpeechToken(zh="水", py="shuǐ", ru="вода", id="word_water"),
        SpeechToken(zh="安全", py="ānquán", ru="безопасность", id="word_safe"),
        SpeechToken(zh="茶叶", py="cháyè", ru="чай", id="word_tea"),
    ],
    "guard_zhang": [
        SpeechToken(zh="票", py="piào", ru="билет", id="word_ticket"),
        SpeechToken(zh="护照", py="hùzhào", ru="паспорт", id="word_passport"),
        SpeechToken(zh="安全", py="ānquán", ru="безопасность", id="word_safe"),
    ],
}

# ============================================================================
# Authoritative Token Catalog (Synchronized 100% with server/world/catalog.json)
# ============================================================================

CATALOG_WORDS: Dict[str, Dict[str, str]] = {
    "word_expensive": {"id": "word_expensive", "zh": "太贵了", "py": "Tài guì le", "ru": "слишком дорого"},
    "word_jade": {"id": "word_jade", "zh": "玉", "py": "yù", "ru": "нефрит"},
    "word_money": {"id": "word_money", "zh": "钱", "py": "qián", "ru": "деньги"},
    "word_cheap": {"id": "word_cheap", "zh": "便宜", "py": "piányi", "ru": "дёшево"},
    "word_one": {"id": "word_one", "zh": "一", "py": "yī", "ru": "один"},
    "word_two": {"id": "word_two", "zh": "二", "py": "èr", "ru": "два"},
    "word_three": {"id": "word_three", "zh": "三", "py": "sān", "ru": "три"},
    "word_five": {"id": "word_five", "zh": "五", "py": "wǔ", "ru": "пять"},
    "word_eight": {"id": "word_eight", "zh": "八", "py": "bā", "ru": "восемь"},
    "word_hundred": {"id": "word_hundred", "zh": "百", "py": "bǎi", "ru": "сто"},
    "word_teapot": {"id": "word_teapot", "zh": "茶壶", "py": "cháhú", "ru": "чайник"},
    "word_cup": {"id": "word_cup", "zh": "茶杯", "py": "chábēi", "ru": "чашка"},
    "word_chopsticks": {"id": "word_chopsticks", "zh": "筷子", "py": "kuàizi", "ru": "палочки"},
    "word_bowl": {"id": "word_bowl", "zh": "碗", "py": "wǎn", "ru": "пиала"},
    "word_tea": {"id": "word_tea", "zh": "茶叶", "py": "cháyè", "ru": "чай"},
    "word_noodles": {"id": "word_noodles", "zh": "面条", "py": "miàntiáo", "ru": "лапша"},
    "word_boss": {"id": "word_boss", "zh": "老板", "py": "lǎobǎn", "ru": "босс"},
    "word_sorry": {"id": "word_sorry", "zh": "对不起", "py": "duìbuqǐ", "ru": "извините"},
    "word_hello": {"id": "word_hello", "zh": "你好", "py": "nǐ hǎo", "ru": "здравствуйте"},
    "word_authentic": {"id": "word_authentic", "zh": "正宗的", "py": "zhèngzōng de", "ru": "настоящий"},
    "word_this": {"id": "word_this", "zh": "这是", "py": "Zhè shì", "ru": "это"},
    "word_spicy": {"id": "word_spicy", "zh": "辣", "py": "là", "ru": "острое"},
    "word_peanut": {"id": "word_peanut", "zh": "花生", "py": "huāshēng", "ru": "арахис"},
    "word_ticket": {"id": "word_ticket", "zh": "票", "py": "piào", "ru": "билет"},
    "word_passport": {"id": "word_passport", "zh": "护照", "py": "hùzhào", "ru": "паспорт"},
    "word_station": {"id": "word_station", "zh": "车站", "py": "chēzhàn", "ru": "станция"},
    "word_water": {"id": "word_water", "zh": "水", "py": "shuǐ", "ru": "вода"},
    "word_safe": {"id": "word_safe", "zh": "安全", "py": "ānquán", "ru": "безопасность"},
}

def _load_catalog_words() -> Dict[str, Dict[str, str]]:
    """Dynamically supplements catalog words from server/world/catalog.json if accessible."""
    words = dict(CATALOG_WORDS)
    possible_paths = [
        os.path.join(os.path.dirname(__file__), "..", "server", "world", "catalog.json"),
        os.path.join(os.getcwd(), "server", "world", "catalog.json"),
    ]
    for p in possible_paths:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "words" in data and isinstance(data["words"], dict):
                        for k, v in data["words"].items():
                            if isinstance(v, dict):
                                words[k] = {
                                    "id": str(v.get("id", k)),
                                    "zh": str(v.get("zh", "")),
                                    "py": str(v.get("py", "")),
                                    "ru": str(v.get("ru", "")),
                                }
                break
        except Exception:
            pass
    return words

CATALOG_WORDS = _load_catalog_words()
CATALOG_BY_ZH: Dict[str, Dict[str, str]] = {
    entry["zh"]: entry for entry in CATALOG_WORDS.values()
}

# Initialize FastAPI App
app = FastAPI(
    title="Rest-In-Hackaton DEV-B AI Middleware",
    description="FastAPI dialogue & TTS orchestrator integrating local llama-server with rule-based fallback.",
    version="1.0.0",
)

# Open CORS configuration for Web, Godot, and Three.js clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# LLM Client singleton
llm_client = LLMClient()


def sanitize_choices(npc_id: str, raw_choices: Any) -> List[Choice]:
    """
    Guarantees exactly 4 valid Choice objects with sequential IDs 1..4.
    Enforces Go server ChoiceType whitelisting.
    """
    sanitized: List[Choice] = []
    defaults = DEFAULT_CHOICES.get(npc_id, DEFAULT_CHOICES["lao_wang"])

    if isinstance(raw_choices, list):
        for item in raw_choices:
            if isinstance(item, dict):
                try:
                    c_type = item.get("type", "polite")
                    if c_type in CHOICE_TYPE_NORMALIZATION:
                        c_type = CHOICE_TYPE_NORMALIZATION[c_type]
                    if c_type not in VALID_CHOICE_TYPES:
                        c_type = "polite"
                    sanitized.append(
                        Choice(
                            id=len(sanitized) + 1,
                            zh=str(item.get("zh", "...")),
                            py=str(item.get("py", "...")),
                            ru=str(item.get("ru", "...")),
                            type=c_type,
                        )
                    )
                except Exception:
                    continue

    # Pad with defaults if fewer than 4
    if len(sanitized) < 4:
        for fallback in defaults:
            if len(sanitized) >= 4:
                break
            if not any(c.zh == fallback.zh for c in sanitized):
                sanitized.append(
                    Choice(
                        id=len(sanitized) + 1,
                        zh=fallback.zh,
                        py=fallback.py,
                        ru=fallback.ru,
                        type=fallback.type,
                    )
                )

    while len(sanitized) < 4:
        idx = len(sanitized)
        fallback = defaults[idx % len(defaults)]
        sanitized.append(
            Choice(
                id=idx + 1,
                zh=fallback.zh,
                py=fallback.py,
                ru=fallback.ru,
                type=fallback.type,
            )
        )

    # Slice to strictly 4
    sanitized = sanitized[:4]

    # Re-index 1..4
    for i, choice in enumerate(sanitized, start=1):
        choice.id = i

    return sanitized


def sanitize_speech_tokens(npc_id: str, raw_tokens: Any) -> List[SpeechToken]:
    """
    Validates speech tokens against authoritative catalog whitelist (28 words).
    Rejects/replaces uncataloged token IDs and canonicalizes fields to guarantee
    100% compliance with Go server dialogue validation contract (dialogue.go:127-132).
    """
    tokens: List[SpeechToken] = []
    defaults = DEFAULT_TOKENS.get(npc_id, DEFAULT_TOKENS["lao_wang"])

    if isinstance(raw_tokens, list):
        for item in raw_tokens:
            token_id = ""
            zh = ""
            py = ""
            ru = ""
            if isinstance(item, dict):
                token_id = str(item.get("id", "")).strip()
                zh = str(item.get("zh", "")).strip()
                py = str(item.get("py", "")).strip()
                ru = str(item.get("ru", "")).strip()
            elif hasattr(item, "id"):
                token_id = str(getattr(item, "id", "")).strip()
                zh = str(getattr(item, "zh", "")).strip()
                py = str(getattr(item, "py", "")).strip()
                ru = str(getattr(item, "ru", "")).strip()
            else:
                continue

            # 1. Exact catalog ID match: canonicalize from authoritative catalog entry
            if token_id in CATALOG_WORDS:
                cat_word = CATALOG_WORDS[token_id]
                tokens.append(
                    SpeechToken(
                        zh=cat_word["zh"],
                        py=cat_word["py"],
                        ru=cat_word["ru"],
                        id=cat_word["id"],
                    )
                )
            # 2. Hanzi match: recover canonical catalog entry if LLM distorted ID
            elif zh in CATALOG_BY_ZH:
                cat_word = CATALOG_BY_ZH[zh]
                tokens.append(
                    SpeechToken(
                        zh=cat_word["zh"],
                        py=cat_word["py"],
                        ru=cat_word["ru"],
                        id=cat_word["id"],
                    )
                )
            else:
                # 3. Uncataloged token ID: reject and log
                logger.warning(
                    f"Rejecting uncataloged speech token id='{token_id}' zh='{zh}' for NPC '{npc_id}'"
                )

    # 4. If all tokens were rejected or input was empty, replace with safe catalog defaults
    if not tokens:
        tokens = [
            SpeechToken(zh=t.zh, py=t.py, ru=t.ru, id=t.id)
            for t in defaults
        ]

    # 5. Enforce Go server upper bound (len <= 64)
    tokens = tokens[:64]
    return tokens[:64]


def clamp_and_validate_response(
    req: DialogueRequest,
    raw_data: Dict[str, Any],
    raw_str: Optional[str] = None,
) -> DialogueResponse:
    """
    Applies strict numerical clamping and business rules to parsed response:
    - mianzi_delta strictly clamped to [-30, 30]
    - aggro_delta strictly clamped to [-30, 30]
    - price_new >= price_floor
    - fsm_state restricted to Go whitelist {IDLE, CALLING, HAGGLING, FLATTERED, SUSPICIOUS, AGGRO}
    - emotion restricted to Go whitelist {neutral, angry, happy, suspicious}
    - Enforces 4 choices and valid tokens
    - Populates dual schema fields (root fields + raw + parsed)
    """
    player_msg_lower = req.player_message.lower()

    # 1. Price Clamping (strictly [price_floor, 100000] per dialogue.go:108)
    price_floor = req.context.price_floor
    if req.npc_id == "guard_zhang":
        clamped_price = 0
    else:
        raw_price = raw_data.get("price_new", req.context.price)
        try:
            parsed_price = int(raw_price)
        except (ValueError, TypeError):
            parsed_price = req.context.price
        clamped_price = min(100000, max(price_floor, max(0, parsed_price)))

    # 2. Guard Zhang Bribe Trigger Check
    is_bribe = (
        req.npc_id == "guard_zhang"
        and any(w in player_msg_lower for w in ("bribe", "взятк", "деньги", "договориться", "通融"))
    )

    # 3. Mianzi Delta Clamping (strictly [-30, 30] and cumulative [0, 100])
    cur_mianzi = req.context.mianzi
    raw_mianzi_delta = raw_data.get("mianzi_delta", 0)
    try:
        m_delta = int(raw_mianzi_delta)
    except (ValueError, TypeError):
        m_delta = 0
    if is_bribe:
        m_delta = -30
    clamped_m_delta = max(-30, min(30, m_delta))
    target_mianzi = max(0, min(100, cur_mianzi + clamped_m_delta))
    effective_mianzi_delta = target_mianzi - cur_mianzi

    # 4. Aggro Delta Clamping (strictly [-30, 30] and cumulative [0, 100])
    cur_aggro = req.context.aggro
    raw_aggro_delta = raw_data.get("aggro_delta", 0)
    try:
        a_delta = int(raw_aggro_delta)
    except (ValueError, TypeError):
        a_delta = 0
    if is_bribe:
        a_delta = 30
    clamped_a_delta = max(-30, min(30, a_delta))
    target_aggro = max(0, min(100, cur_aggro + clamped_a_delta))
    effective_aggro_delta = target_aggro - cur_aggro

    # 5. FSM State Transition & Normalization
    raw_state = raw_data.get("fsm_state", "HAGGLING")
    fsm_state = FSM_NORMALIZATION.get(raw_state, "HAGGLING")
    if fsm_state not in VALID_FSM_STATES:
        fsm_state = "HAGGLING" if req.npc_id != "guard_zhang" else "SUSPICIOUS"

    # Aggro threshold transition
    effective_cur_aggro = target_aggro
    if effective_cur_aggro > 75 or is_bribe:
        fsm_state = "AGGRO"

    # 6. Emotion Normalization
    raw_emotion = raw_data.get("emotion", "neutral")
    emotion = EMOTION_NORMALIZATION.get(raw_emotion, "neutral")
    if emotion not in VALID_EMOTIONS:
        emotion = "neutral"
    if fsm_state == "AGGRO":
        emotion = "angry"

    # 7. Speech Tokens & Choices
    raw_tokens = raw_data.get("speech_tokens")
    if raw_tokens is None:
        raw_tokens = raw_data.get("tokens")
    speech_tokens = sanitize_speech_tokens(req.npc_id, raw_tokens)
    choices = sanitize_choices(req.npc_id, raw_data.get("choices"))

    # Go server envelope alignment
    parsed_payload = {
        "speech_tokens": [t.model_dump() for t in speech_tokens],
        "tokens": [t.model_dump() for t in speech_tokens],
        "emotion": emotion,
        "price_new": clamped_price,
        "mianzi_delta": effective_mianzi_delta,
        "aggro_delta": effective_aggro_delta,
        "fsm_state": fsm_state,
        "choices": [c.model_dump() for c in choices],
    }

    return DialogueResponse(
        speech_tokens=speech_tokens,
        tokens=speech_tokens,
        emotion=emotion,
        price_new=clamped_price,
        mianzi_delta=effective_mianzi_delta,
        aggro_delta=effective_aggro_delta,
        fsm_state=fsm_state,
        choices=choices,
        raw=raw_str,
        parsed=parsed_payload,
    )


def generate_mock_dialogue_clamped(req: DialogueRequest) -> DialogueResponse:
    """
    Wraps generate_mock_dialogue with clamp_and_validate_response to ensure
    effective deltas ([-30, 30] bounds), high aggro FSM/emotion enforcement,
    and price floors are strictly and uniformly maintained on fallback paths.
    """
    mock_resp = generate_mock_dialogue(req)
    raw_data = mock_resp.parsed if mock_resp.parsed is not None else mock_resp.model_dump()
    return clamp_and_validate_response(req, raw_data, mock_resp.raw)


# ============================================================================
# Core API Routes
# ============================================================================

@app.get("/health", response_model=HealthResponse)
async def health():
    """
    Healthcheck endpoint verifying middleware status and llama-server connectivity.
    """
    is_mock = MOCK_MODE_ENV
    llm_alive = False

    if not is_mock:
        llm_alive = await llm_client.check_health()

    backend_mode = "llama-server" if llm_alive else "mock"

    return HealthResponse(
        status="ok",
        model=llm_client.model,
        llm_endpoint=llm_client.completions_url,
        llm_alive=llm_alive,
        llama_server="connected" if llm_alive else "disconnected",
        backend=backend_mode,
        mock_mode=is_mock or not llm_alive,
    )


@app.post("/dialogue", response_model=DialogueResponse)
async def dialogue(req: DialogueRequest):
    """
    Primary dialogue orchestrator endpoint:
    - Validates NPC
    - Formats dynamic prompt context
    - Calls llama-server or falls back to deterministic mock engine
    - Clamps numerical parameters to Go contract bounds ([-30, 30])
    - Enforces exactly 4 choices
    """
    if req.npc_id not in KNOWN_NPCS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"NPC '{req.npc_id}' not found",
        )

    # Force mock mode if requested via environment
    if MOCK_MODE_ENV:
        return generate_mock_dialogue_clamped(req)

    # Format dynamic prompt
    try:
        system_prompt = format_prompt(req.npc_id, req.context)
    except Exception as exc:
        logger.warning(
            f"Prompt formatting failed for NPC '{req.npc_id}': {exc}. Using mock fallback."
        )
        return generate_mock_dialogue_clamped(req)

    # Attempt LLM inference via llama-server
    try:
        parsed_data, raw_str = await llm_client.generate_chat_completion(
            system_prompt=system_prompt,
            user_message=req.player_message,
        )
        return clamp_and_validate_response(req, parsed_data, raw_str)
    except LLMClientError as exc:
        logger.warning(
            f"llama-server inference failed ({type(exc).__name__}: {exc}). Falling back to mock engine."
        )
        return generate_mock_dialogue_clamped(req)
    except Exception as exc:
        logger.error(
            f"Unexpected error during dialogue generation: {exc}. Falling back to mock engine."
        )
        return generate_mock_dialogue_clamped(req)


# ============================================================================
# TTS Audio Synthesis Endpoints (Stage 6 R2)
# ============================================================================

@app.post("/tts")
async def post_tts(req: TTSRequest):
    """
    Offline TTS audio synthesis endpoint.
    Accepts text or speech tokens, and returns 16-bit Mono PCM WAV audio.
    By default returns binary audio/wav stream. If format='json' or 'base64', returns JSON payload.
    """
    if req.format in ("json", "base64"):
        b64_audio, dur = synthesize_to_base64(
            text=req.text,
            tokens=req.tokens,
            speed=req.speed,
            pitch=req.pitch,
            speaker=req.speaker,
        )
        return TTSResponse(
            status="ok",
            format="wav",
            sample_rate=16000,
            channels=1,
            duration_sec=dur,
            audio_base64=b64_audio,
            text=req.text or "",
        )
    else:
        wav_bytes, dur = synthesize_wav(
            text=req.text,
            tokens=req.tokens,
            speed=req.speed,
            pitch=req.pitch,
            speaker=req.speaker,
        )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": 'inline; filename="speech.wav"',
                "X-Audio-Duration": str(dur),
            },
        )


@app.get("/tts")
async def get_tts(
    text: Optional[str] = Query(None, description="Text in Hanzi or Pinyin to synthesize"),
    format: str = Query("wav", description="Audio format: 'wav' or 'json'"),
    speed: float = Query(1.0, ge=0.5, le=2.0, description="Speed multiplier"),
    pitch: float = Query(1.0, ge=0.5, le=2.0, description="Pitch frequency multiplier"),
    speaker: Optional[str] = Query(None, description="NPC speaker preset"),
):
    """
    GET endpoint for direct browser or engine speech audio playback.
    Requires 'text' query parameter.
    """
    if not text or not text.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Query parameter 'text' is required and must not be empty.",
        )

    if format in ("json", "base64"):
        b64_audio, dur = synthesize_to_base64(
            text=text,
            speed=speed,
            pitch=pitch,
            speaker=speaker,
        )
        return TTSResponse(
            status="ok",
            format="wav",
            sample_rate=16000,
            channels=1,
            duration_sec=dur,
            audio_base64=b64_audio,
            text=text,
        )
    else:
        wav_bytes, dur = synthesize_wav(
            text=text,
            speed=speed,
            pitch=pitch,
            speaker=speaker,
        )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": 'inline; filename="speech.wav"',
                "X-Audio-Duration": str(dur),
            },
        )
