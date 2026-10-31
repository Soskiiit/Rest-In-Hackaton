"""
ai/middleware.py
FastAPI AI Middleware for Rest-In-Hackaton DEV-B (Stage 1-4).

Listens on port 8000. Provides:
- GET /health: Healthcheck and LLM connectivity status
- POST /dialogue: Structured dialogue orchestration, prompt interpolation,
                  LLM inference with resilient mock fallback, response clamping,
                  and dual schema compatibility.
"""

import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, status
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
        SpeechToken,
    )
    from ai.prompt_engine import format_prompt
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
        SpeechToken,
    )
    from prompt_engine import format_prompt

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

# Valid literal sets for schema validation
VALID_EMOTIONS: set[str] = {
    "neutral",
    "angry",
    "happy",
    "suspicious",
    "flattered",
    "surprised",
}

VALID_FSM_STATES: set[str] = {
    "IDLE",
    "CALLING",
    "HAGGLING",
    "FLATTERED",
    "SUSPICIOUS",
    "AGGRO",
    "TALKING",
    "PATROL",
    "DEAL_AGREED",
}

VALID_CHOICE_TYPES: set[str] = {
    "polite",
    "haggle",
    "provoke",
    "leave",
    "brave",
    "weak",
    "bribe",
    "neutral",
}

# Fallback default choices per NPC (ensures 4 choices guarantee)
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
        Choice(id=1, zh="特辣！", py="Tè là!", ru="Очень острое!", type="brave"),
        Choice(id=2, zh="微辣", py="Wēi là", ru="Чуть-чуть острое", type="weak"),
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
        Choice(id=1, zh="这是我的证件", py="Zhè shì wǒ de zhèngjiàn", ru="Вот мои документы", type="polite"),
        Choice(id=2, zh="我只是路过", py="Wǒ zhǐshì lùguò", ru="Я просто прохожу мимо", type="neutral"),
        Choice(id=3, zh="能通融一下吗？", py="Néng tōngróng yíxià ma?", ru="Можно договориться?", type="bribe"),
        Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
    ],
}

# Fallback default speech tokens per NPC
DEFAULT_TOKENS: Dict[str, List[SpeechToken]] = {
    "lao_wang": [
        SpeechToken(zh="这是", py="Zhè shì", ru="Это", id="word_this"),
        SpeechToken(zh="正宗的", py="zhèngzōng de", ru="настоящий", id="word_authentic"),
        SpeechToken(zh="玉", py="yù", ru="нефрит", id="word_jade"),
    ],
    "auntie_li": [
        SpeechToken(zh="尝尝", py="chángchang", ru="попробуй", id="word_taste"),
        SpeechToken(zh="这个", py="zhège", ru="этот", id="word_this_one"),
        SpeechToken(zh="乌龙茶", py="wūlóngchá", ru="улун", id="word_oolong"),
        SpeechToken(zh="很香", py="hěn xiāng", ru="очень ароматный", id="word_very_fragrant"),
    ],
    "electronics_zhang": [
        SpeechToken(zh="这个", py="zhège", ru="этот", id="word_this_one"),
        SpeechToken(zh="转换插头", py="zhuǎnhuàn chātóu", ru="сетевой переходник", id="word_adapter"),
        SpeechToken(zh="质量", py="zhìliàng", ru="качество", id="word_quality"),
        SpeechToken(zh="很好", py="hěn hǎo", ru="очень хорошее", id="word_very_good"),
    ],
    "chef_chen": [
        SpeechToken(zh="你要", py="Nǐ yào", ru="Ты хочешь", id="word_you_want"),
        SpeechToken(zh="特辣吗", py="tè là ma", ru="очень острое?", id="word_extra_spicy"),
    ],
    "granny_liu": [
        SpeechToken(zh="多喝", py="duō hē", ru="пей больше", id="word_drink_more"),
        SpeechToken(zh="热水", py="rèshuǐ", ru="горячей воды", id="word_hot_water"),
        SpeechToken(zh="这个", py="zhège", ru="этот", id="word_this_one"),
        SpeechToken(zh="人参", py="rénshēn", ru="женьшень", id="word_ginseng"),
    ],
    "guard_zhang": [
        SpeechToken(zh="请出示", py="Qǐng chūshì", ru="Пожалуйста, предъявите", id="word_show_please"),
        SpeechToken(zh="证件", py="zhèngjiàn", ru="документы", id="word_id_card"),
    ],
}

# Initialize FastAPI App
app = FastAPI(
    title="Rest-In-Hackaton DEV-B AI Middleware",
    description="FastAPI dialogue orchestrator integrating local llama-server with rule-based fallback.",
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
    """
    sanitized: List[Choice] = []
    defaults = DEFAULT_CHOICES.get(npc_id, DEFAULT_CHOICES["lao_wang"])

    if isinstance(raw_choices, list):
        for item in raw_choices:
            if isinstance(item, dict):
                try:
                    c_type = item.get("type", "neutral")
                    if c_type not in VALID_CHOICE_TYPES:
                        c_type = "neutral"
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
            # Avoid duplicate zh if possible
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

    # If still fewer than 4 (in case fallback duplicates), pad directly
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
    Validates speech tokens, ensuring at least one valid token with non-empty fields.
    """
    tokens: List[SpeechToken] = []
    if isinstance(raw_tokens, list):
        for item in raw_tokens:
            if isinstance(item, dict):
                zh = str(item.get("zh", "")).strip()
                py = str(item.get("py", "")).strip()
                ru = str(item.get("ru", "")).strip()
                token_id = str(item.get("id", "")).strip()
                if zh and py and ru and token_id:
                    tokens.append(SpeechToken(zh=zh, py=py, ru=ru, id=token_id))

    if not tokens:
        tokens = list(DEFAULT_TOKENS.get(npc_id, DEFAULT_TOKENS["lao_wang"]))

    return tokens


def clamp_and_validate_response(
    req: DialogueRequest,
    raw_data: Dict[str, Any],
    raw_str: Optional[str] = None,
) -> DialogueResponse:
    """
    Applies numerical clamping and business rules to parsed LLM response:
    - price_new >= price_floor (except defect/guard rules)
    - 0 <= mianzi <= 100
    - 0 <= aggro <= 100
    - aggro > 75 -> FSM state = "AGGRO"
    - Enforces 4 choices and valid tokens
    - Populates dual schema fields (root fields + raw + parsed)
    """
    player_msg_lower = req.player_message.lower()

    # 1. Price Clamping
    price_floor = req.context.price_floor
    if req.npc_id == "guard_zhang":
        clamped_price = 0
    else:
        raw_price = raw_data.get("price_new", req.context.price)
        try:
            parsed_price = int(raw_price)
        except (ValueError, TypeError):
            parsed_price = req.context.price
        # Harmonize with mock_engine: strictly preserve price_new >= price_floor
        clamped_price = max(price_floor, max(0, parsed_price))

    # 2. Mianzi Clamping (Face/Respect 0..100)
    cur_mianzi = req.context.mianzi
    raw_mianzi_delta = raw_data.get("mianzi_delta", 0)
    try:
        mianzi_delta = int(raw_mianzi_delta)
    except (ValueError, TypeError):
        mianzi_delta = 0
    target_mianzi = max(0, min(100, cur_mianzi + mianzi_delta))
    effective_mianzi_delta = target_mianzi - cur_mianzi

    # 3. Aggro Clamping (Rage 0..100)
    cur_aggro = req.context.aggro
    raw_aggro_delta = raw_data.get("aggro_delta", 0)
    try:
        aggro_delta = int(raw_aggro_delta)
    except (ValueError, TypeError):
        aggro_delta = 0
    target_aggro = max(0, min(100, cur_aggro + aggro_delta))

    # Guard Zhang Bribe Trigger
    is_bribe = (
        req.npc_id == "guard_zhang"
        and any(w in player_msg_lower for w in ("bribe", "взятк", "деньги", "договориться", "通融"))
    )
    if is_bribe:
        target_aggro = 100

    effective_aggro_delta = target_aggro - cur_aggro

    # 4. FSM State Transition
    fsm_state = raw_data.get("fsm_state")
    if fsm_state not in VALID_FSM_STATES:
        if req.npc_id == "lao_wang":
            fsm_state = "HAGGLING"
        elif req.npc_id == "chef_chen":
            fsm_state = "TALKING"
        else:
            fsm_state = "PATROL"

    if target_aggro > 75 or is_bribe:
        fsm_state = "AGGRO"

    # 5. Emotion
    emotion = raw_data.get("emotion")
    if emotion not in VALID_EMOTIONS:
        emotion = "neutral"
    if fsm_state == "AGGRO":
        emotion = "angry"

    # 6. Speech Tokens
    speech_tokens = sanitize_speech_tokens(req.npc_id, raw_data.get("speech_tokens"))

    # 7. Choices
    choices = sanitize_choices(req.npc_id, raw_data.get("choices"))

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
        parsed=raw_data,
    )


def generate_mock_dialogue_clamped(req: DialogueRequest) -> DialogueResponse:
    """
    Wraps generate_mock_dialogue with clamp_and_validate_response to ensure
    effective deltas (0..100 bounds), high aggro FSM/emotion enforcement,
    and price floors are strictly and uniformly maintained on fallback paths.
    """
    mock_resp = generate_mock_dialogue(req)
    raw_data = mock_resp.parsed if mock_resp.parsed is not None else mock_resp.model_dump()
    return clamp_and_validate_response(req, raw_data, mock_resp.raw)


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
    - Clamps numerical parameters and enforces exactly 4 choices
    """
    # Validate known NPC
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
