"""
ai/mock_engine.py
Deterministic offline dialogue engine for Rest-In-Hackaton DEV-B AI Middleware.
Synchronized with server/world/catalog.json (28 authoritative entries).
Supports all 6 market personas (Lao Wang, Chef Chen, Guard Zhang, Auntie Li,
Electronics Zhang, Granny Liu), Stage 5 deal agreement triggers, and collaborative
multi-player negotiation history.
"""

from typing import List, Dict, Any, Tuple, Optional
import json
import re

try:
    from ai.models import (
        DialogueRequest,
        DialogueResponse,
        DialogueContext,
        SpeechToken,
        Choice,
        EmotionType,
        FsmStateType,
        ChoiceType,
    )
except (ImportError, ModuleNotFoundError):
    from models import (
        DialogueRequest,
        DialogueResponse,
        DialogueContext,
        SpeechToken,
        Choice,
        EmotionType,
        FsmStateType,
        ChoiceType,
    )


# ============================================================================
# Authoritative Token Catalog (Synchronized 100% with server/world/catalog.json)
# ============================================================================

TOKEN_BANK: Dict[str, Tuple[str, str, str]] = {
    # 28 Authoritative entries from server/world/catalog.json
    "太贵了": ("Tài guì le", "слишком дорого", "word_expensive"),
    "玉": ("yù", "нефрит", "word_jade"),
    "钱": ("qián", "деньги", "word_money"),
    "便宜": ("piányi", "дёшево", "word_cheap"),
    "一": ("yī", "один", "word_one"),
    "二": ("èr", "два", "word_two"),
    "三": ("sān", "три", "word_three"),
    "五": ("wǔ", "пять", "word_five"),
    "八": ("bā", "восемь", "word_eight"),
    "百": ("bǎi", "сто", "word_hundred"),
    "茶壶": ("cháhú", "чайник", "word_teapot"),
    "茶杯": ("chábēi", "чашка", "word_cup"),
    "筷子": ("kuàizi", "палочки", "word_chopsticks"),
    "碗": ("wǎn", "пиала", "word_bowl"),
    "茶叶": ("cháyè", "чай", "word_tea"),
    "面条": ("miàntiáo", "лапша", "word_noodles"),
    "老板": ("lǎobǎn", "босс", "word_boss"),
    "对不起": ("duìbuqǐ", "извините", "word_sorry"),
    "你好": ("nǐ hǎo", "здравствуйте", "word_hello"),
    "正宗的": ("zhèngzōng de", "настоящий", "word_authentic"),
    "这是": ("Zhè shì", "это", "word_this"),
    "辣": ("là", "острое", "word_spicy"),
    "花生": ("huāshēng", "арахис", "word_peanut"),
    "票": ("piào", "билет", "word_ticket"),
    "护照": ("hùzhào", "паспорт", "word_passport"),
    "车站": ("chēzhàn", "станция", "word_station"),
    "水": ("shuǐ", "вода", "word_water"),
    "安全": ("ānquán", "безопасность", "word_safe"),
}


def build_tokens(words: List[str]) -> List[SpeechToken]:
    """Helper to convert a list of known words into SpeechToken instances."""
    tokens = []
    for w in words:
        if w in TOKEN_BANK:
            py, ru, tid = TOKEN_BANK[w]
            tokens.append(SpeechToken(zh=w, py=py, ru=ru, id=tid))
        else:
            # Fallback to authentic catalog token
            tokens.append(SpeechToken(zh="这是", py="Zhè shì", ru="это", id="word_this"))
    return tokens


# ============================================================================
# Stage 5 Deal & COOP Negotiation Helpers
# ============================================================================

DEAL_KEYWORDS = (
    "成交",
    "по рукам",
    "согласен",
    "согласна",
    "беру",
    "забираю",
    "договорились",
    "deal",
    "agree",
)


def check_deal_agreement(msg: str) -> bool:
    """Checks if player's message triggers deal agreement acceptance."""
    msg_lower = msg.lower()
    return any(kw in msg_lower for kw in DEAL_KEYWORDS)


def analyze_coop_history(context: DialogueContext) -> Dict[str, Any]:
    """
    Analyzes history and scene_history for partner collaboration signals:
    - partner_soothed: prior turn was respectful, complimentary, or apologetic
    - partner_pressured: prior turn accused of fake goods or high aggro
    """
    raw_hist = context.scene_history if context.scene_history is not None else context.history
    turns: List[str] = []

    if isinstance(raw_hist, list):
        for item in raw_hist:
            if isinstance(item, dict):
                turns.append(str(item.get("content", "")).lower())
            else:
                turns.append(str(item).lower())
    elif isinstance(raw_hist, str):
        turns.append(raw_hist.lower())

    hist_str = " ".join(turns)

    partner_soothed = any(k in hist_str for k in ("уважение", "красиво", "друг", "брат", "眼光", "спасибо", "чай", "вкусно", "простите", "精美", "你好"))
    partner_pressured = any(k in hist_str for k in ("假货", "подделка", "fake", "обман", "грабеж", "паль", "вор", "развод"))

    return {
        "partner_soothed": partner_soothed,
        "partner_pressured": partner_pressured,
    }


def _handle_deal_agreement(req: DialogueRequest) -> DialogueResponse:
    """Generic deal resolution handler for merchant NPCs."""
    ctx = req.context
    price = ctx.price
    price_floor = ctx.price_floor
    agreed_price = max(price_floor, price)
    tokens = build_tokens(["老板", "正宗的", "便宜"])
    choices = [
        Choice(id=1, zh="老板合作愉快！", py="Lǎobǎn hézuò yúkuài!", ru="Приятно иметь дело, босс!", type="polite"),
        Choice(id=2, zh="能给我开发票吗？", py="Néng gěi wǒ kāi fāpiào ma?", ru="Чек выпишете?", type="polite"),
        Choice(id=3, zh="下次还来照顾生意", py="Xià cì hái lái zhàogu shēngyi", ru="В следующий раз снова к вам", type="polite"),
        Choice(id=4, zh="谢谢老板，再见！", py="Xièxie lǎobǎn, zàijiàn!", ru="Спасибо босс, до свидания!", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="happy",
        price_new=agreed_price,
        mianzi_delta=15,
        aggro_delta=-15,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Response Constructor Helper
# ============================================================================

def _make_response(
    tokens: List[SpeechToken],
    emotion: EmotionType,
    price_new: int,
    mianzi_delta: int,
    aggro_delta: int,
    fsm_state: FsmStateType,
    choices: List[Choice],
) -> DialogueResponse:
    # Ensure deltas strictly adhere to [-30, 30] Go server contract
    clamped_mianzi = max(-30, min(30, mianzi_delta))
    clamped_aggro = max(-30, min(30, aggro_delta))

    parsed_dict: Dict[str, Any] = {
        "speech_tokens": [t.model_dump() for t in tokens],
        "tokens": [t.model_dump() for t in tokens],
        "emotion": emotion,
        "price_new": price_new,
        "mianzi_delta": clamped_mianzi,
        "aggro_delta": clamped_aggro,
        "fsm_state": fsm_state,
        "choices": [c.model_dump() for c in choices],
    }
    raw_str = json.dumps(parsed_dict, ensure_ascii=False)

    return DialogueResponse(
        speech_tokens=tokens,
        tokens=tokens,
        emotion=emotion,
        price_new=price_new,
        mianzi_delta=clamped_mianzi,
        aggro_delta=clamped_aggro,
        fsm_state=fsm_state,
        choices=choices,
        raw=raw_str,
        parsed=parsed_dict,
    )


# ============================================================================
# Lao Wang Mock Handler (Shenzhen Jade Merchant)
# ============================================================================

def _handle_lao_wang(req: DialogueRequest) -> DialogueResponse:
    ctx = req.context
    price = ctx.price if ctx.price > 0 else 800
    price_floor = ctx.price_floor if ctx.price_floor > 0 else 120
    mianzi = ctx.mianzi
    aggro = ctx.aggro
    msg = req.player_message.lower()

    # Stage 5 Deal Trigger Check
    if check_deal_agreement(msg):
        return _handle_deal_agreement(req)

    # Collaborative COOP history analysis
    coop = analyze_coop_history(ctx)
    is_polite = any(k in msg for k in ["уважение", "красиво", "друг", "брат", "眼光", "спасибо", "你好", "извините", "对不起", "讲究", "商量", "谈谈", "您", "大师", "面子"])
    is_provoke = any(k in msg for k in ["假货", "подделка", "fake", "обман", "паль"])

    # Good Cop / Bad Cop collaborative dynamic
    if coop["partner_pressured"] and is_polite:
        tokens = build_tokens(["这是", "正宗的", "玉", "便宜"])
        price_new = max(price_floor, int(price * 0.85))
        choices = [
            Choice(id=1, zh="老板讲究，就交你这个朋友！", py="Lǎobǎn jiǎngjiu, jiù jiāo nǐ zhège péngyou!", ru="Босс с понятием, приятно дружить!", type="polite"),
            Choice(id=2, zh="能再少二十吗？", py="Néng zài shǎo èrshí ma?", ru="Скинете еще двадцать?", type="haggle"),
            Choice(id=3, zh="这是假货", py="Zhè shì jiǎhuò", ru="Это подделка", type="provoke"),
            Choice(id=4, zh="我先走了", py="Wǒ xiān zǒu le", ru="Я пошел", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=price_new,
            mianzi_delta=15,
            aggro_delta=-15,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Double Provocation Escalation
    if coop["partner_pressured"] and is_provoke:
        tokens = build_tokens(["太贵了", "钱", "老板"])
        choices = [
            Choice(id=1, zh="老板消消气，我朋友不会说话", py="Lǎobǎn xiāoxiāo qì, wǒ péngyou bú huì shuōhuà", ru="Босс остыньте, мой друг не то сказал", type="polite"),
            Choice(id=2, zh="我就按原价买！", py="Wǒ jiù àn yuánjià mǎi!", ru="Куплю по вашей цене!", type="haggle"),
            Choice(id=3, zh="真小气！", py="Zhēn xiǎoqi!", ru="Какой скупой!", type="provoke"),
            Choice(id=4, zh="我走！", py="Wǒ zǒu!", ru="Я ухожу!", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-20,
            aggro_delta=25,
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 1: High Aggro trigger (Aggro >= 75)
    if aggro >= 75:
        tokens = build_tokens(["太贵了", "钱", "老板"])
        choices = [
            Choice(id=1, zh="对不起，老板", py="Duìbuqǐ, lǎobǎn", ru="Извините, босс", type="polite"),
            Choice(id=2, zh="我就按原价买！", py="Wǒ jiù àn yuánjià mǎi!", ru="Куплю по вашей цене!", type="haggle"),
            Choice(id=3, zh="真小气！", py="Zhēn xiǎoqi!", ru="Какой скупой!", type="provoke"),
            Choice(id=4, zh="我走！", py="Wǒ zǒu!", ru="Я ухожу!", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=min(10, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 2: Fake goods accusation
    if is_provoke:
        tokens = build_tokens(["这是", "正宗的", "玉", "太贵了"])
        new_aggro = aggro + 25
        state: FsmStateType = "AGGRO" if new_aggro >= 75 else "SUSPICIOUS"
        emotion: EmotionType = "angry" if new_aggro >= 75 else "suspicious"
        choices = [
            Choice(id=1, zh="老板，便宜点", py="Lǎobǎn piányi diǎn", ru="Босс, сделай скидку", type="polite"),
            Choice(id=2, zh="太贵了！", py="Tài guì le!", ru="Слишком дорого!", type="haggle"),
            Choice(id=3, zh="这是假货", py="Zhè shì jiǎhuò", ru="Это подделка", type="provoke"),
            Choice(id=4, zh="我再想想", py="Wǒ zài xiǎngxiang", ru="Дай подумаю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion=emotion,
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=25,
            fsm_state=state,
            choices=choices,
        )

    # Rule 3: Mention "Made in Yiwu" / Defect
    if any(k in msg for k in ["yiwu", "义乌", "иу", "дефект", "царапина", "made in yiwu"]):
        tokens = build_tokens(["便宜", "三", "百"])
        price_new = max(price_floor, price - 300)
        choices = [
            Choice(id=1, zh="老板爽快！", py="Lǎobǎn shuǎngkuai!", ru="Босс дело говорит!", type="polite"),
            Choice(id=2, zh="再便宜一百就买", py="Zài piányi yībǎi jiù mǎi", ru="Скинь еще сотню и беру", type="haggle"),
            Choice(id=3, zh="假的就是假的", py="Jiǎ de jiùshì jiǎ de", ru="Фальшивка и есть фальшивка", type="provoke"),
            Choice(id=4, zh="我再考虑考虑", py="Wǒ zài kǎolǜ kǎolǜ", ru="Я еще подумаю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="suspicious",
            price_new=price_new,
            mianzi_delta=10,
            aggro_delta=5,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Rule 4: Mention Auntie Li / Competitor
    if any(k in msg for k in ["ли", "li", "тётушка", "тетушка", "конкурент", "ли аи"]):
        tokens = build_tokens(["这是", "正宗的", "玉", "便宜"])
        price_new = max(price_floor, int(price * 0.8))  # -20%
        choices = [
            Choice(id=1, zh="老板爽快！", py="Lǎobǎn shuǎngkuai!", ru="Босс, по рукам!", type="polite"),
            Choice(id=2, zh="还能再少点吗？", py="Hái néng zài shǎo diǎn ma?", ru="А еще скинешь?", type="haggle"),
            Choice(id=3, zh="我看你俩都一样", py="Wǒ kàn nǐ liǎ dōu yíyàng", ru="По-моему, вы оба жулики", type="provoke"),
            Choice(id=4, zh="我再去问问她", py="Wǒ zài qù wènwen tā", ru="Пойду у неё спрошу", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="suspicious",
            price_new=price_new,
            mianzi_delta=5,
            aggro_delta=-5,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Rule 5: High Mianzi (> 70) or Player Flattery
    if mianzi >= 70 or is_polite:
        tokens = build_tokens(["你好", "老板", "正宗的", "玉", "便宜"])
        price_new = max(price_floor, int(price * 0.9))  # -10% discount
        choices = [
            Choice(id=1, zh="谢谢老板！", py="Xièxie lǎobǎn!", ru="Спасибо, босс!", type="polite"),
            Choice(id=2, zh="能再便宜点吗？", py="Néng zài piányi diǎn ma?", ru="А еще подешевле?", type="haggle"),
            Choice(id=3, zh="真能吹！", py="Zhēn néng chuī!", ru="Ну и заливаешь!", type="provoke"),
            Choice(id=4, zh="我再看看", py="Wǒ zài kànkan", ru="Я еще посмотрю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=price_new,
            mianzi_delta=10,
            aggro_delta=-5,
            fsm_state="FLATTERED",
            choices=choices,
        )

    # Default / Standard Haggling
    tokens = build_tokens(["你好", "这是", "正宗的", "玉"])
    price_new = max(price_floor, price - 50) if any(k in msg for k in ["便宜", "скидк", "дорого", "太贵"]) else price
    choices = [
        Choice(id=1, zh="老板，便宜点", py="Lǎobǎn piányi diǎn", ru="Босс, сделай скидку", type="polite"),
        Choice(id=2, zh="太贵了！", py="Tài guì le!", ru="Слишком дорого!", type="haggle"),
        Choice(id=3, zh="这是假货", py="Zhè shì jiǎhuò", ru="Это подделка", type="provoke"),
        Choice(id=4, zh="我再想想", py="Wǒ zài xiǎngxiang", ru="Дай подумаю", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="neutral",
        price_new=price_new,
        mianzi_delta=2,
        aggro_delta=0,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Chef Chen Mock Handler (Sichuan Spicy Noodles)
# ============================================================================

def _handle_chef_chen(req: DialogueRequest) -> DialogueResponse:
    ctx = req.context
    price = ctx.price if ctx.price > 0 else 30
    aggro = ctx.aggro
    msg = req.player_message.lower()

    if check_deal_agreement(msg):
        return _handle_deal_agreement(req)

    # Rule 0: High Aggro trigger (Aggro >= 75)
    if aggro >= 75:
        tokens = build_tokens(["辣", "面条", "水"])
        choices = [
            Choice(id=1, zh="师傅消消气！", py="Shīfu xiāoxiāo qì!", ru="Мастер, остыньте!", type="polite"),
            Choice(id=2, zh="我就要特辣！", py="Wǒ jiù yào tè là!", ru="Я всё равно буду есть острое!", type="order"),
            Choice(id=3, zh="什么破店！", py="Shénme pò diàn!", ru="Что за дыра!", type="provoke"),
            Choice(id=4, zh="我走还不行吗", py="Wǒ zǒu hái bùxíng ma", ru="Я уже ухожу", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=min(10, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 1: Non-spicy / mild spicy
    if any(k in msg for k in ["不辣", "微辣", "не остро", "без перца", "слабо", "weak"]):
        tokens = build_tokens(["辣", "面条", "水"])
        new_aggro = aggro + 10
        state: FsmStateType = "AGGRO" if new_aggro >= 75 else "HAGGLING"
        choices = [
            Choice(id=1, zh="不要辣", py="Bùyào là", ru="Без острого, пожалуйста", type="order"),
            Choice(id=2, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса, пожалуйста", type="order"),
            Choice(id=3, zh="有什么推荐？", py="Yǒu shénme tuījiàn?", ru="Что порекомендуешь?", type="polite"),
            Choice(id=4, zh="我先看看", py="Wǒ xiān kànkan", ru="Я пока посмотрю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-5,
            aggro_delta=10,
            fsm_state=state,
            choices=choices,
        )

    # Rule 2: Extra spicy / praises heat
    if any(k in msg for k in ["特辣", "очень остро", "огонь", "горячо", "spicy", "brave"]):
        tokens = build_tokens(["辣", "面条", "碗"])
        choices = [
            Choice(id=1, zh="多放辣！", py="Duō fàng là!", ru="Добавь еще перца!", type="order"),
            Choice(id=2, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса", type="order"),
            Choice(id=3, zh="多谢师傅", py="Duōxiè shīfu", ru="Спасибо, мастер", type="polite"),
            Choice(id=4, zh="我吃完了", py="Wǒ chīwán le", ru="Я закончил", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=price,
            mianzi_delta=10,
            aggro_delta=-10,
            fsm_state="FLATTERED",
            choices=choices,
        )

    # Rule 3: Demands English / Russian menu
    if any(k in msg for k in ["меню", "menu", "английск", "русск", "картинк"]):
        tokens = build_tokens(["面条", "碗", "筷子"])
        new_aggro = aggro + 20
        state: FsmStateType = "AGGRO" if new_aggro >= 75 else "SUSPICIOUS"
        choices = [
            Choice(id=1, zh="不要辣", py="Bùyào là", ru="Без острого, пожалуйста", type="order"),
            Choice(id=2, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса, пожалуйста", type="order"),
            Choice(id=3, zh="有什么推荐？", py="Yǒu shénme tuījiàn?", ru="Что порекомендуешь?", type="polite"),
            Choice(id=4, zh="我先看看", py="Wǒ xiān kànkan", ru="Я пока посмотрю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=20,
            fsm_state=state,
            choices=choices,
        )

    # Default: Standard greeting / ordering inquiry
    tokens = build_tokens(["面条", "辣", "花生"])
    choices = [
        Choice(id=1, zh="不要辣", py="Bùyào là", ru="Без острого, пожалуйста", type="order"),
        Choice(id=2, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса, пожалуйста", type="order"),
        Choice(id=3, zh="有什么推荐？", py="Yǒu shénme tuījiàn?", ru="Что порекомендуешь?", type="polite"),
        Choice(id=4, zh="我先看看", py="Wǒ xiān kànkan", ru="Я пока посмотрю", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="neutral",
        price_new=price,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Guard Zhang Mock Handler (Metro Entrance Security)
# ============================================================================

def _handle_guard_zhang(req: DialogueRequest) -> DialogueResponse:
    aggro = req.context.aggro
    msg = req.player_message.lower()

    # Rule 0: High Aggro trigger (Aggro >= 75)
    if aggro >= 75:
        tokens = build_tokens(["车站", "安全", "护照"])
        choices = [
            Choice(id=1, zh="误会，长官！", py="Wùhuì, zhǎngguān!", ru="Недоразумение, сэр!", type="polite"),
            Choice(id=2, zh="我什么都没做", py="Wǒ shénme dōu méi zuò", ru="Я ничего не делал", type="directions"),
            Choice(id=3, zh="放开我！", py="Fàngkāi wǒ!", ru="Отпустите меня!", type="provoke"),
            Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=0,
            mianzi_delta=-10,
            aggro_delta=min(10, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 1: Bribe attempt (Aggro delta clamped to +30, state AGGRO)
    if any(k in msg for k in ["взятк", "bribe", "договориться", "通融", "деньги", "100块"]):
        tokens = build_tokens(["安全", "车站", "护照"])
        choices = [
            Choice(id=1, zh="误会，长官！", py="Wùhuì, zhǎngguān!", ru="Недоразумение, сэр!", type="polite"),
            Choice(id=2, zh="我只是问路", py="Wǒ zhǐshì wènlù", ru="Я просто спросил дорогу", type="directions"),
            Choice(id=3, zh="放开我！", py="Fàngkāi wǒ!", ru="Отпустите меня!", type="provoke"),
            Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=0,
            mianzi_delta=-30,
            aggro_delta=30,
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 2: Polite ID presentation ("证件", "паспорт", "документы", "票")
    if any(k in msg for k in ["证件", "паспорт", "документ", "вот", "police", "票", "临时"]):
        tokens = build_tokens(["护照", "票", "车站", "安全"])
        choices = [
            Choice(id=1, zh="谢谢长官", py="Xièxie zhǎngguān", ru="Спасибо, офицер", type="polite"),
            Choice(id=2, zh="问一下地铁怎么坐", py="Wèn yíxià dìtiě zěnme zuò", ru="Подскажите, как пройти", type="directions"),
            Choice(id=3, zh="查得真严", py="Chá de zhēn yán", ru="Строгий у вас контроль", type="provoke"),
            Choice(id=4, zh="再见", py="Zàijiàn", ru="До свидания", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="neutral",
            price_new=0,
            mianzi_delta=5,
            aggro_delta=-10,
            fsm_state="IDLE",
            choices=choices,
        )

    # Rule 3: "Just passing by" ("我只是路过", "мимо")
    if any(k in msg for k in ["路过", "мимо", "прохожу"]):
        tokens = build_tokens(["安全", "车站"])
        choices = [
            Choice(id=1, zh="这是我的票", py="Zhè shì wǒ de piào", ru="Вот мой билет", type="documents"),
            Choice(id=2, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу, пожалуйста", type="directions"),
            Choice(id=3, zh="能通融一下吗？", py="Néng tōngróng yíxià ma?", ru="Можно договориться?", type="bribe"),
            Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="neutral",
            price_new=0,
            mianzi_delta=0,
            aggro_delta=0,
            fsm_state="IDLE",
            choices=choices,
        )

    # Default: ID / ticket check demand
    tokens = build_tokens(["票", "护照", "安全"])
    choices = [
        Choice(id=1, zh="这是我的票", py="Zhè shì wǒ de piào", ru="Вот мой билет", type="documents"),
        Choice(id=2, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу, пожалуйста", type="directions"),
        Choice(id=3, zh="能通融一下吗？", py="Néng tōngróng yíxià ma?", ru="Можно договориться?", type="bribe"),
        Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="suspicious",
        price_new=0,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="SUSPICIOUS",
        choices=choices,
    )


# ============================================================================
# Auntie Li Mock Handler (Tea Shop & Lao Wang Rival)
# ============================================================================

def _handle_auntie_li(req: DialogueRequest) -> DialogueResponse:
    ctx = req.context
    price = ctx.price if ctx.price > 0 else 300
    floor = ctx.price_floor if ctx.price_floor > 0 else 80
    aggro = ctx.aggro
    msg = req.player_message.lower()

    if check_deal_agreement(msg):
        return _handle_deal_agreement(req)

    if aggro >= 75:
        tokens = build_tokens(["茶叶", "水", "茶壶"])
        choices = [
            Choice(id=1, zh="对不起，阿姨", py="Duìbuqǐ, āyí", ru="Извините, тётушка", type="polite"),
            Choice(id=2, zh="我这就走", py="Wǒ zhè jiù zǒu", ru="Я уже ухожу", type="leave"),
            Choice(id=3, zh="脾气真大", py="Píqi zhēn dà", ru="Ну и характер!", type="provoke"),
            Choice(id=4, zh="我再问问路", py="Wǒ zài wènwen lù", ru="Я дорогу спрошу", type="directions"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-15,
            aggro_delta=min(10, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Lao Wang competitor trigger
    if any(k in msg for k in ["лао ван", "старик", "конкурент", "老王", "wang", "у лао"]):
        new_price = max(floor, int(price * 0.75))
        tokens = build_tokens(["茶叶", "正宗的", "便宜"])
        choices = [
            Choice(id=1, zh="李阿姨最好，买你的！", py="Lǐ āyí zuì hǎo, mǎi nǐ de!", ru="Тётушка Ли лучше всех, беру у вас!", type="polite"),
            Choice(id=2, zh="还能再便宜点吗？", py="Hái néng zài piányi diǎn ma?", ru="А ещё дешевле можно?", type="haggle"),
            Choice(id=3, zh="老王说你这是假茶", py="Lǎo Wáng shuō nǐ zhè shì jiǎ chá", ru="Лао Ван сказал, что у вас чай ненастоящий", type="provoke"),
            Choice(id=4, zh="请问茶店怎么走", py="Qǐngwèn chādiàn zěnme zǒu", ru="Подскажите дорогу к чайной", type="directions"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=new_price,
            mianzi_delta=10,
            aggro_delta=-10,
            fsm_state="FLATTERED",
            choices=choices,
        )

    # Tea aroma & compliment trigger
    if any(k in msg for k in ["вкусный", "аромат", "香", "好喝", "чайник", "попробовать", "чай"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["茶叶", "茶杯", "茶壶", "水"])
        choices = [
            Choice(id=1, zh="茶很香，老板娘真懂茶！", py="Chá hěn xiāng, lǎobǎnniáng zhēn dǒng chá!", ru="Чай очень ароматный, хозяйка — знаток!", type="polite"),
            Choice(id=2, zh="买两盒能打折吗？", py="Mǎi liǎng hé néng dǎzhé ma?", ru="За две коробки скидку дадите?", type="haggle"),
            Choice(id=3, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу", type="directions"),
            Choice(id=4, zh="谢谢，我再转转", py="Xièxie, wǒ zài zhuànzhuan", ru="Спасибо, я ещё похожу", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=new_price,
            mianzi_delta=15,
            aggro_delta=-5,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Cheap teabag provocation
    if any(k in msg for k in ["пакетик", "липтон", "дешев", "lipton", "пыль"]):
        tokens = build_tokens(["茶叶", "水", "茶杯"])
        choices = [
            Choice(id=1, zh="阿姨别生气，我开玩笑的", py="Āyí bié shēngqì, wǒ kāi wánxiào de", ru="Тётушка, не сердитесь, я пошутил", type="polite"),
            Choice(id=2, zh="那正宗的多少钱？", py="Nà zhèngzōng de duōshao qián?", ru="А настоящий сколько стоит?", type="haggle"),
            Choice(id=3, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу", type="directions"),
            Choice(id=4, zh="走就走", py="Zǒu jiù zǒu", ru="Ухожу-ухожу", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=20,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Default Auntie Li response
    tokens = build_tokens(["茶叶", "茶壶", "茶杯", "正宗的"])
    choices = [
        Choice(id=1, zh="茶很香，老板娘真懂茶！", py="Chá hěn xiāng, lǎobǎnniáng zhēn dǒng chá!", ru="Чай очень ароматный, хозяйка — знаток!", type="polite"),
        Choice(id=2, zh="李阿姨，老王那边便宜二十块！", py="Lǐ āyí, Lǎo Wáng nàbiān piányi èrshí kuài!", ru="Тётушка Ли, у Лао Вана на 20 юаней дешевле!", type="haggle"),
        Choice(id=3, zh="有立顿红茶吗？", py="Yǒu Lìdùn hóngchá ma?", ru="А есть Липтон в пакетиках?", type="provoke"),
        Choice(id=4, zh="谢谢，我改天再来", py="Xièxie, wǒ gǎitiān zài lái", ru="Спасибо, я зайду в другой день", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="happy",
        price_new=price,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Master Zhang Mock Handler (Huaqiangbei Electronics Stall)
# ============================================================================

def _handle_electronics_zhang(req: DialogueRequest) -> DialogueResponse:
    ctx = req.context
    price = ctx.price if ctx.price > 0 else 65
    floor = ctx.price_floor if ctx.price_floor > 0 else 25
    aggro = ctx.aggro
    msg = req.player_message.lower()

    if check_deal_agreement(msg):
        return _handle_deal_agreement(req)

    if aggro >= 75:
        tokens = build_tokens(["钱", "这是", "安全"])
        choices = [
            Choice(id=1, zh="师傅，消消气", py="Shīfu, xiāoxiāo qì", ru="Мастер, остыньте", type="polite"),
            Choice(id=2, zh="那我不要了", py="Nà wǒ bú yào le", ru="Тогда мне не надо", type="leave"),
            Choice(id=3, zh="态度真差", py="Tàidu zhēn chà", ru="Ужасное обслуживание", type="provoke"),
            Choice(id=4, zh="问一下地铁怎么走", py="Wèn yíxià dìtiě zěnme zǒu", ru="Подскажите, как пройти к метро", type="directions"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=min(10, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Technical jargon & spec knowledge
    if any(k in msg for k in ["вольт", "ампер", "type-c", "220", "напряжение", "чип", "foxconn", "watt"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["这是", "安全", "钱", "便宜"])
        choices = [
            Choice(id=1, zh="师傅懂行，就按这个拿！", py="Shīfu dǒngháng, jiù àn zhège ná!", ru="Мастер разбирается, беру этот!", type="polite"),
            Choice(id=2, zh="给个打包价呗", py="Gěi gè dǎbāo jià bei", ru="Сделай скидку за комплект", type="haggle"),
            Choice(id=3, zh="请问车站怎么走", py="Qǐngwèn chēzhàn zěnme zǒu", ru="Подскажите дорогу к станции", type="directions"),
            Choice(id=4, zh="我再想想", py="Wǒ zài xiǎngxiang", ru="Я подумаю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=new_price,
            mianzi_delta=15,
            aggro_delta=-5,
            fsm_state="FLATTERED",
            choices=choices,
        )

    # Explosion / fake accusation trigger
    if any(k in msg for k in ["взорв", "сгорит", "подделка", "爆炸", "fake"]):
        tokens = build_tokens(["这是", "安全", "便宜"])
        choices = [
            Choice(id=1, zh="对不起师傅，我信你", py="Duìbuqǐ shīfu, wǒ xìn nǐ", ru="Извините мастер, я вам верю", type="polite"),
            Choice(id=2, zh="能现场通电测一下吗？", py="Néng xiànchǎng tōngdiàn cè yíxià ma?", ru="Можно на месте включить проверить?", type="haggle"),
            Choice(id=3, zh="看着就像山寨货", py="Kàn zhe jiù xiàng shānzhài huò", ru="Выглядит как кустарщина", type="provoke"),
            Choice(id=4, zh="打扰了", py="Dǎrǎo le", ru="Извините за беспокойство", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=25,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Default Electronics Zhang response
    tokens = build_tokens(["这是", "便宜", "钱", "百"])
    choices = [
        Choice(id=1, zh="师傅，220伏能用吗？", py="Shīfu, èrbǎi èrshí fú néng yòng ma?", ru="Мастер, на 220 вольт подходит?", type="polite"),
        Choice(id=2, zh="二十块行不行？", py="Èrshí kuài xíng bu xíng?", ru="За 20 юаней отдашь?", type="haggle"),
        Choice(id=3, zh="这不会爆炸吧？", py="Zhè bú huì bàozhà ba?", ru="Оно не взорвется?", type="provoke"),
        Choice(id=4, zh="我去别家看看", py="Wǒ qù biéjiā kànkan", ru="Я гляну в другом павильоне", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="neutral",
        price_new=price,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Granny Liu Mock Handler (Traditional Chinese Medicine Pharmacy)
# ============================================================================

def _handle_granny_liu(req: DialogueRequest) -> DialogueResponse:
    ctx = req.context
    price = ctx.price if ctx.price > 0 else 150
    floor = ctx.price_floor if ctx.price_floor > 0 else 50
    aggro = ctx.aggro
    msg = req.player_message.lower()

    if check_deal_agreement(msg):
        return _handle_deal_agreement(req)

    if aggro >= 75:
        tokens = build_tokens(["水", "安全", "茶杯"])
        choices = [
            Choice(id=1, zh="奶奶，我错了", py="Nǎinai, wǒ cuò le", ru="Бабушка, я виноват", type="polite"),
            Choice(id=2, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
            Choice(id=3, zh="我不喝！", py="Wǒ bù hē!", ru="Не буду я пить!", type="provoke"),
            Choice(id=4, zh="请问路怎么走", py="Qǐngwèn lù zěnme zǒu", ru="Подскажите дорогу", type="directions"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="neutral",
            price_new=price,
            mianzi_delta=-15,
            aggro_delta=min(5, 30),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Health & Herb inquiry trigger
    if any(k in msg for k in ["усталость", "здоровье", "женьшень", "травы", "болеть", "人参", "气", "сила", "чай"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["水", "安全", "茶叶"])
        choices = [
            Choice(id=1, zh="奶奶真好，我听您的多喝热水", py="Nǎinai zhēn hǎo, wǒ tīng nín de duō hē rèshuǐ", ru="Бабушка добрая, буду пить горячую воду", type="polite"),
            Choice(id=2, zh="学生党没钱，能少十块吗？", py="Xuésheng dǎng méi qián, néng shǎo shí kuài ma?", ru="У студента мало денег, уступите 10 юаней?", type="haggle"),
            Choice(id=3, zh="请问怎么走", py="Qǐngwèn zěnme zǒu", ru="Подскажите дорогу", type="directions"),
            Choice(id=4, zh="谢谢奶奶，下次来买", py="Xièxie nǎinai, xià cì lái mǎi", ru="Спасибо бабушка, куплю в следующий раз", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="happy",
            price_new=new_price,
            mianzi_delta=20,
            aggro_delta=-10,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Weed / disrespect trigger
    if any(k in msg for k in ["сорняк", "обман", "трава", "сухие корни", "не верю"]):
        tokens = build_tokens(["水", "安全", "茶杯"])
        choices = [
            Choice(id=1, zh="奶奶，我随便说说的", py="Nǎinai, wǒ suíbiàn shuōshuo de", ru="Бабушка, я пошутил", type="polite"),
            Choice(id=2, zh="那正宗的多少钱？", py="Nà zhèngzōng de duōshao qián?", ru="А настоящий сколько стоит?", type="haggle"),
            Choice(id=3, zh="本来就是草根嘛", py="Běnlái jiù shì cǎogēn ma", ru="Ну так это ж просто трава", type="provoke"),
            Choice(id=4, zh="走啦", py="Zǒu la", ru="Пойду", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="suspicious",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=20,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Default Granny Liu response
    tokens = build_tokens(["水", "安全", "茶叶", "茶杯"])
    choices = [
        Choice(id=1, zh="奶奶，这个怎么泡水？", py="Nǎinai, zhège zěnme pào shuǐ?", ru="Бабушка, как это правильно заваривать?", type="polite"),
        Choice(id=2, zh="便宜点吧，我学生", py="Piányi diǎn ba, wǒ xuésheng", ru="Сделайте скидку, я студент", type="haggle"),
        Choice(id=3, zh="这草根能治病？我不信", py="Zhè cǎogēn néng zhìbìng? Wǒ bú xìn", ru="Эти корешки лечат? Не верю", type="provoke"),
        Choice(id=4, zh="谢谢奶奶，我先走了", py="Xièxie nǎinai, wǒ xiān zǒu le", ru="Спасибо бабушка, я пойду", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="happy",
        price_new=price,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="HAGGLING",
        choices=choices,
    )


# ============================================================================
# Main Entrypoint
# ============================================================================

def generate_mock_dialogue(req: DialogueRequest) -> DialogueResponse:
    """
    Main mock generator entrypoint.
    Dispatches request based on npc_id to character handlers.
    Raises ValueError if npc_id is unknown.
    """
    npc = req.npc_id.strip().lower()
    if npc == "lao_wang":
        return _handle_lao_wang(req)
    elif npc == "auntie_li":
        return _handle_auntie_li(req)
    elif npc == "electronics_zhang":
        return _handle_electronics_zhang(req)
    elif npc == "chef_chen":
        return _handle_chef_chen(req)
    elif npc == "granny_liu":
        return _handle_granny_liu(req)
    elif npc == "guard_zhang":
        return _handle_guard_zhang(req)
    else:
        raise ValueError(
            f"Unknown NPC ID: '{req.npc_id}'. Supported: lao_wang, auntie_li, electronics_zhang, chef_chen, granny_liu, guard_zhang"
        )
