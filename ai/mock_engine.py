"""
ai/mock_engine.py
Deterministic offline dialogue engine for Lao Wang, Chef Chen, and Guard Zhang.
Provides 100% offline fallback when llama-server is unavailable.
"""

from typing import List, Dict, Any, Tuple
import json
import re

try:
    from ai.models import (
        DialogueRequest,
        DialogueResponse,
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
        SpeechToken,
        Choice,
        EmotionType,
        FsmStateType,
        ChoiceType,
    )


# ============================================================================
# Token Bank (Master Vocabulary for Two-Line Subtitles)
# ============================================================================

TOKEN_BANK: Dict[str, Tuple[str, str, str]] = {
    # Pronouns & Demonstratives
    "这是": ("Zhè shì", "Это", "word_this"),
    "你": ("nǐ", "ты", "word_you"),
    "我": ("wǒ", "я", "word_i"),
    "你要": ("Nǐ yào", "Ты хочешь", "word_you_want"),
    "我的": ("wǒ de", "мой", "word_my"),

    # Etiquette & Greetings
    "你好": ("nǐ hǎo", "привет", "word_hello"),
    "老板": ("lǎobǎn", "босс", "word_boss"),
    "朋友": ("péngyou", "друг", "word_friend"),
    "对不起": ("duìbuqǐ", "извините", "word_sorry"),
    "请": ("qǐng", "пожалуйста", "word_please"),
    "请出示": ("Qǐng chūshì", "Пожалуйста, предъявите", "word_show_please"),
    "请进": ("qǐng jìn", "проходите", "word_come_in"),
    "谢谢": ("xièxie", "спасибо", "word_thanks"),
    "大哥": ("dàgē", "старший брат", "word_big_brother"),

    # Market & Haggling (Lao Wang)
    "正宗的": ("zhèngzōng de", "настоящий", "word_authentic"),
    "玉": ("yù", "нефрит", "word_jade"),
    "玉佩": ("yùpèi", "нефритовый амулет", "word_jade_amulet"),
    "太贵了": ("tài guì le", "слишком дорого", "word_expensive"),
    "便宜": ("piányi", "дешево", "word_cheap"),
    "便宜点": ("piányi diǎn", "подешевле", "word_cheaper"),
    "假货": ("jiǎhuò", "подделка", "word_fake"),
    "质量": ("zhìliàng", "качество", "word_quality"),
    "李阿姨": ("Lǐ āyí", "тётушка Ли", "word_auntie_li"),
    "义乌": ("Yìwū", "Иу", "word_yiwu"),
    "不卖": ("bù mài", "не продаю", "word_not_sell"),
    "走开": ("zǒu kāi", "уходи", "word_go_away"),
    "再想想": ("zài xiǎngxiang", "подумаю", "word_think_again"),
    "成交": ("chéngjiāo", "по рукам", "word_deal"),
    "原价": ("yuánjià", "исходная цена", "word_original_price"),
    "打折": ("dǎzhé", "скидка", "word_discount"),
    "眼光": ("yǎnguāng", "вкус / глаз-алмаз", "word_good_eye"),
    "好": ("hǎo", "хорошо", "word_good"),

    # Numbers & Units
    "块": ("kuài", "юаней", "word_yuan"),
    "百": ("bǎi", "сто", "word_hundred"),
    "八百": ("bābǎi", "восемьсот", "word_eight_hundred"),
    "五百": ("wǔbǎi", "пятьсот", "word_five_hundred"),
    "四百": ("sìbǎi", "четыреста", "word_four_hundred"),
    "三百": ("sānbǎi", "триста", "word_three_hundred"),
    "一百": ("yībǎi", "сто", "word_one_hundred"),
    "五十": ("wǔshí", "пятьдесят", "word_fifty"),
    "三十": ("sānshí", "тридцать", "word_thirty"),
    "二十": ("èrshí", "двадцать", "word_twenty"),
    "一碗": ("yī wǎn", "одна пиала", "word_one_bowl"),

    # Food & Sichuan Restaurant (Chef Chen)
    "特辣吗": ("tè là ma", "очень острое?", "word_extra_spicy"),
    "特辣": ("tè là", "очень остро", "word_super_spicy"),
    "微辣": ("wēi là", "чуть-чуть острое", "word_mild_spicy"),
    "不辣": ("bù là", "не острое", "word_not_spicy"),
    "不要": ("bùyào", "не надо", "word_do_not_want"),
    "面条": ("miàntiáo", "лапша", "word_noodles"),
    "面": ("miàn", "лапша", "word_noodle_short"),
    "热汤面": ("rè tāngmiàn", "горячая лапша", "word_hot_soup_noodles"),
    "花生": ("huāshēng", "арахис", "word_peanuts"),
    "菜单": ("càidān", "меню", "word_menu"),
    "推荐": ("tuījiàn", "рекомендовать", "word_recommend"),
    "好吃": ("hǎochī", "вкусный", "word_delicious"),
    "马上": ("mǎshàng", "сейчас же", "word_immediately"),
    "没有": ("méiyǒu", "нет", "word_none"),
    "吃饭": ("chīfàn", "кушать", "word_eat"),
    "师傅": ("shīfu", "мастер/повар", "word_master"),

    # Tea Shop (Auntie Li)
    "尝尝": ("chángchang", "попробуй", "word_taste"),
    "乌龙茶": ("wūlóngchá", "улун", "word_oolong"),
    "茶叶": ("cháyè", "чай", "word_tea"),
    "很香": ("hěn xiāng", "очень ароматный", "word_very_fragrant"),
    "老板娘": ("lǎobǎnniáng", "хозяйка лавки", "word_boss_lady"),
    "茶壶": ("cháhú", "чайник", "word_teapot"),
    "好茶": ("hǎo chá", "хороший чай", "word_good_tea"),

    # Electronics Stall (Electronics Zhang)
    "转换插头": ("zhuǎnhuàn chātóu", "сетевой переходник", "word_adapter"),
    "插头": ("chātóu", "штекер / вилка", "word_plug"),
    "电压": ("diànyā", "напряжение", "word_voltage"),
    "很好": ("hěn hǎo", "очень хорошее", "word_very_good"),
    "充电器": ("chōngdiànqì", "зарядное устройство", "word_charger"),
    "线": ("xiàn", "кабель / провод", "word_cable"),

    # Traditional Chinese Medicine (Granny Liu)
    "人参": ("rénshēn", "женьшень", "word_ginseng"),
    "热水": ("rèshuǐ", "горячая вода", "word_hot_water"),
    "多喝": ("duō hē", "пей больше", "word_drink_more"),
    "补气": ("bǔ qì", "укреплять энергию Ци", "word_tonify_qi"),
    "奶奶": ("nǎinai", "бабушка", "word_granny"),
    "身体": ("shēntǐ", "тело / здоровье", "word_body_health"),
    "健康": ("jiànkāng", "здоровье", "word_health"),

    # Security & Metro (Guard Zhang)
    "证件": ("zhèngjiàn", "документы", "word_id_card"),
    "身份证": ("shēnfènzhèng", "удостоверение личности", "word_id_doc"),
    "路过": ("lùguò", "проходить мимо", "word_pass_by"),
    "通融": ("tōngróng", "договориться", "word_negotiate"),
    "行贿": ("xínghuì", "давать взятку", "word_bribe"),
    "拘留": ("jūliú", "задержание", "word_detention"),
    "站住": ("zhànzhù", "стоять", "word_halt"),
    "安全检查": ("ānquán jiǎnchá", "досмотр безопасности", "word_security_check"),
    "正常": ("zhèngcháng", "в порядке", "word_normal"),
    "地铁": ("dìtiě", "метро", "word_metro"),
    "危险品": ("wēixiǎnpǐn", "опасные предметы", "word_hazardous_goods"),
    "讲清楚": ("jiǎng qīngchu", "говорить четко", "word_speak_clearly"),
    "误会": ("wùhuì", "недоразумение", "word_misunderstanding"),
    "长官": ("zhǎngguān", "офицер", "word_officer"),
}


def build_tokens(words: List[str]) -> List[SpeechToken]:
    """Helper to convert a list of known words into SpeechToken instances."""
    tokens = []
    for w in words:
        if w in TOKEN_BANK:
            py, ru, tid = TOKEN_BANK[w]
            tokens.append(SpeechToken(zh=w, py=py, ru=ru, id=tid))
        else:
            tokens.append(SpeechToken(zh=w, py="shì", ru="слово", id=f"word_{len(tokens)+1}"))
    return tokens


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

    # Rule 1: High Aggro trigger (Aggro >= 75 or already angry)
    if aggro >= 75:
        tokens = build_tokens(["不卖", "走开", "太贵了"])
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
            aggro_delta=min(10, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 2: Fake goods accusation ("假货" / "подделка" / "fake" / "обман")
    if any(k in msg for k in ["假货", "подделка", "fake", "обман", "паль"]):
        tokens = build_tokens(["假货", "这是", "正宗的", "玉"])
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

    # Rule 3: Mention "Made in Yiwu" / Defect ("yiwu", "иу", "дефект", "царапина")
    if any(k in msg for k in ["yiwu", "义乌", "иу", "дефект", "царапина", "made in yiwu"]):
        tokens = build_tokens(["义乌", "便宜", "三百", "块"])
        price_new = max(price_floor, price - 300)
        choices = [
            Choice(id=1, zh="老板爽快！", py="Lǎobǎn shuǎngkuai!", ru="Босс дело говорит!", type="polite"),
            Choice(id=2, zh="再便宜一百就买", py="Zài piányi yībǎi jiù mǎi", ru="Скинь еще сотню и беру", type="haggle"),
            Choice(id=3, zh="假的就是假的", py="Jiǎ de jiùshì jiǎ de", ru="Фальшивка и есть фальшивка", type="provoke"),
            Choice(id=4, zh="我再考虑考虑", py="Wǒ zài kǎolǜ kǎolǜ", ru="Я еще подумаю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="surprised",
            price_new=price_new,
            mianzi_delta=10,
            aggro_delta=5,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Rule 4: Mention Auntie Li / Competitor ("тётушка ли", "тетушка ли", "ли", "конкурент")
    if any(k in msg for k in ["ли", "li", "тётушка", "тетушка", "конкурент", "ли аи"]):
        tokens = build_tokens(["李阿姨", "假货", "这是", "正宗的", "玉"])
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

    # Rule 5: High Mianzi (> 70) or Player Flattery ("уважение", "красиво", "你好", "босс")
    if mianzi >= 70 or any(k in msg for k in ["уважение", "красиво", "друг", "брат", "眼光"]):
        tokens = build_tokens(["你好", "朋友", "正宗的", "玉", "便宜"])
        price_new = max(price_floor, int(price * 0.9))  # -10% discount
        choices = [
            Choice(id=1, zh="谢谢老板！", py="Xièxie lǎobǎn!", ru="Спасибо, босс!", type="polite"),
            Choice(id=2, zh="能再便宜点吗？", py="Néng zài piányi diǎn ma?", ru="А еще подешевле?", type="haggle"),
            Choice(id=3, zh="真能吹！", py="Zhēn néng chuī!", ru="Ну и заливаешь!", type="provoke"),
            Choice(id=4, zh="我再看看", py="Wǒ zài kànkan", ru="Я еще посмотрю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="flattered",
            price_new=price_new,
            mianzi_delta=10,
            aggro_delta=-5,
            fsm_state="FLATTERED",
            choices=choices,
        )

    # Default / Standard Haggling
    tokens = build_tokens(["这是", "正宗的", "玉"])
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

    # Rule 0: High Aggro trigger (Aggro >= 75)
    if aggro >= 75:
        tokens = build_tokens(["走开", "不要", "没有"])
        choices = [
            Choice(id=1, zh="师傅消消气！", py="Shīfu xiāoxiāo qì!", ru="Мастер, остыньте!", type="polite"),
            Choice(id=2, zh="我就要吃！", py="Wǒ jiù yào chī!", ru="Я всё равно буду есть!", type="brave"),
            Choice(id=3, zh="什么破店！", py="Shénme pò diàn!", ru="Что за дыра!", type="provoke"),
            Choice(id=4, zh="我走还不行吗", py="Wǒ zǒu hái bùxíng ma", ru="Я уже ухожу", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=min(10, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 1: Non-spicy / mild spicy ("微辣" / "不辣" / "не остро" / "без перца")
    if any(k in msg for k in ["不辣", "微辣", "не остро", "без перца", "слабо", "weak"]):
        tokens = build_tokens(["不辣", "面条", "微辣"])
        new_aggro = aggro + 10
        state: FsmStateType = "AGGRO" if new_aggro >= 75 else "TALKING"
        choices = [
            Choice(id=1, zh="特辣！", py="Tè là!", ru="Очень острое!", type="brave"),
            Choice(id=2, zh="微辣", py="Wēi là", ru="Чуть-чуть острое", type="weak"),
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

    # Rule 2: Extra spicy / praises heat ("特辣" / "очень остро" / "огонь" / "люблю острое")
    if any(k in msg for k in ["特辣", "очень остро", "огонь", "горячо", "spicy", "brave"]):
        tokens = build_tokens(["好", "特辣", "马上", "面条"])
        choices = [
            Choice(id=1, zh="再加点辣椒！", py="Zài jiā diǎn làjiāo!", ru="Добавь еще перца!", type="brave"),
            Choice(id=2, zh="多谢师傅", py="Duōxiè shīfu", ru="Спасибо, мастер", type="polite"),
            Choice(id=3, zh="不要花生", py="Bùyào huāshēng", ru="Без арахиса", type="weak"),
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

    # Rule 3: Demands English / Russian menu ("меню", "английском", "русском", "картинки", "menu")
    if any(k in msg for k in ["меню", "menu", "английск", "русск", "картинк"]):
        tokens = build_tokens(["没有", "菜单", "面条"])
        new_aggro = aggro + 20
        state: FsmStateType = "AGGRO" if new_aggro >= 75 else "SUSPICIOUS"
        choices = [
            Choice(id=1, zh="特辣！", py="Tè là!", ru="Очень острое!", type="brave"),
            Choice(id=2, zh="微辣", py="Wēi là", ru="Чуть-чуть острое", type="weak"),
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
    tokens = build_tokens(["你要", "特辣吗"])
    choices = [
        Choice(id=1, zh="特辣！", py="Tè là!", ru="Очень острое!", type="brave"),
        Choice(id=2, zh="微辣", py="Wēi là", ru="Чуть-чуть острое", type="weak"),
        Choice(id=3, zh="有什么推荐？", py="Yǒu shénme tuījiàn?", ru="Что порекомендуешь?", type="polite"),
        Choice(id=4, zh="我先看看", py="Wǒ xiān kànkan", ru="Я пока посмотрю", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="neutral",
        price_new=price,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="TALKING",
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
        tokens = build_tokens(["站住", "拘留", "危险品"])
        choices = [
            Choice(id=1, zh="误会，长官！", py="Wùhuì, zhǎngguān!", ru="Недоразумение, сэр!", type="polite"),
            Choice(id=2, zh="我什么都没做", py="Wǒ shénme dōu méi zuò", ru="Я ничего не делал", type="neutral"),
            Choice(id=3, zh="放开我！", py="Fàngkāi wǒ!", ru="Отпустите меня!", type="provoke"),
            Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=0,
            mianzi_delta=-10,
            aggro_delta=min(10, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 1: Bribe attempt ("взятк", "деньги", "договориться", "通融", "bribe")
    if any(k in msg for k in ["взятк", "bribe", "договориться", "通融", "деньги", "100块"]):
        tokens = build_tokens(["行贿", "站住", "拘留"])
        choices = [
            Choice(id=1, zh="误会，长官！", py="Wùhuì, zhǎngguān!", ru="Недоразумение, сэр!", type="polite"),
            Choice(id=2, zh="我什么都没做", py="Wǒ shénme dōu méi zuò", ru="Я ничего не делал", type="neutral"),
            Choice(id=3, zh="放开我！", py="Fàngkāi wǒ!", ru="Отпустите меня!", type="provoke"),
            Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=0,
            mianzi_delta=-50,
            aggro_delta=100,
            fsm_state="AGGRO",
            choices=choices,
        )

    # Rule 2: Polite ID presentation ("证件", "паспорт", "документы", "вот мои документы")
    if any(k in msg for k in ["证件", "паспорт", "документ", "вот", "police"]):
        tokens = build_tokens(["证件", "正常", "请进", "地铁"])
        choices = [
            Choice(id=1, zh="谢谢长官", py="Xièxie zhǎngguān", ru="Спасибо, офицер", type="polite"),
            Choice(id=2, zh="问一下地铁怎么坐", py="Wèn yíxià dìtiě zěnme zuò", ru="Подскажите, как сесть на метро", type="neutral"),
            Choice(id=3, zh="查得真严", py="Chá de zhēn yán", ru="Строгий у вас контроль", type="provoke"),
            Choice(id=4, zh="再见", py="Zàijiàn", ru="До свидания", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="neutral",
            price_new=0,
            mianzi_delta=5,
            aggro_delta=-10,
            fsm_state="PATROL",
            choices=choices,
        )

    # Default: ID check demand
    tokens = build_tokens(["请出示", "证件"])
    choices = [
        Choice(id=1, zh="这是我的证件", py="Zhè shì wǒ de zhèngjiàn", ru="Вот мои документы", type="polite"),
        Choice(id=2, zh="我只是路过", py="Wǒ zhǐshì lùguò", ru="Я просто прохожу мимо", type="neutral"),
        Choice(id=3, zh="能通融一下吗？", py="Néng tōngróng yíxià ma?", ru="Можно договориться?", type="bribe"),
        Choice(id=4, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
    ]
    return _make_response(
        tokens=tokens,
        emotion="suspicious",
        price_new=0,
        mianzi_delta=0,
        aggro_delta=0,
        fsm_state="PATROL",
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
    parsed_dict: Dict[str, Any] = {
        "speech_tokens": [t.model_dump() for t in tokens],
        "tokens": [t.model_dump() for t in tokens],
        "emotion": emotion,
        "price_new": price_new,
        "mianzi_delta": mianzi_delta,
        "aggro_delta": aggro_delta,
        "fsm_state": fsm_state,
        "choices": [c.model_dump() for c in choices],
    }
    raw_str = json.dumps(parsed_dict, ensure_ascii=False)

    return DialogueResponse(
        speech_tokens=tokens,
        tokens=tokens,
        emotion=emotion,
        price_new=price_new,
        mianzi_delta=mianzi_delta,
        aggro_delta=aggro_delta,
        fsm_state=fsm_state,
        choices=choices,
        raw=raw_str,
        parsed=parsed_dict,
    )


# ============================================================================
# Auntie Li Mock Handler (Tea Shop & Lao Wang Rival)
# ============================================================================

def _handle_auntie_li(req: DialogueRequest) -> DialogueResponse:
    price = req.context.price
    floor = req.context.price_floor
    aggro = req.context.aggro
    msg = req.player_message.lower()

    if aggro >= 75:
        tokens = build_tokens(["走开", "不卖", "喝"])
        choices = [
            Choice(id=1, zh="对不起，阿姨", py="Duìbuqǐ, āyí", ru="Извините, тётушка", type="polite"),
            Choice(id=2, zh="我这就走", py="Wǒ zhè jiù zǒu", ru="Я уже ухожу", type="leave"),
            Choice(id=3, zh="脾气真大", py="Píqi zhēn dà", ru="Ну и характер!", type="provoke"),
            Choice(id=4, zh="我再看看别的", py="Wǒ zài kànkan bié de", ru="Посмотрю в другом месте", type="neutral"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-15,
            aggro_delta=min(10, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Lao Wang competitor trigger
    if any(k in msg for k in ["лао ван", "старик", "конкурент", "老王", "wang", "у лао"]):
        new_price = max(floor, int(price * 0.75))
        tokens = build_tokens(["李阿姨", "乌龙茶", "正宗的", "好茶"])
        choices = [
            Choice(id=1, zh="李阿姨最好，买你的！", py="Lǐ āyí zuì hǎo, mǎi nǐ de!", ru="Тётушка Ли лучше всех, беру у вас!", type="polite"),
            Choice(id=2, zh="还能再便宜点吗？", py="Hái néng zài piányi diǎn ma?", ru="А ещё дешевле можно?", type="haggle"),
            Choice(id=3, zh="老王说你这是假茶", py="Lǎo Wáng shuō nǐ zhè shì jiǎ chá", ru="Лао Ван сказал, что у вас чай ненастоящий", type="provoke"),
            Choice(id=4, zh="我先尝尝看", py="Wǒ xiān chángchang kàn", ru="Сначала попробую", type="neutral"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="flattered",
            price_new=new_price,
            mianzi_delta=10,
            aggro_delta=-10,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Tea aroma & compliment trigger
    if any(k in msg for k in ["вкусный", "аромат", "香", "好喝", "чайник", "попробовать", "чай"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["尝尝", "这个", "乌龙茶", "很香"])
        choices = [
            Choice(id=1, zh="茶很香，老板娘真懂茶！", py="Chá hěn xiāng, lǎobǎnniáng zhēn dǒng chá!", ru="Чай очень ароматный, хозяйка — знаток!", type="polite"),
            Choice(id=2, zh="买两盒能打折吗？", py="Mǎi liǎng hé néng dǎzhé ma?", ru="За две коробки скидку дадите?", type="haggle"),
            Choice(id=3, zh="这是今年的新茶吗？", py="Zhè shì jīnnián de xīn chá ma?", ru="Это свежий урожай?", type="neutral"),
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
        tokens = build_tokens(["不卖", "走开", "好茶"])
        choices = [
            Choice(id=1, zh="阿姨别生气，我开玩笑的", py="Āyí bié shēngqì, wǒ kāi wánxiào de", ru="Тётушка, не сердитесь, я пошутил", type="polite"),
            Choice(id=2, zh="那正宗的多少钱？", py="Nà zhèngzōng de duōshao qián?", ru="А настоящий сколько стоит?", type="haggle"),
            Choice(id=3, zh="我就问问", py="Wǒ jiù wènwen", ru="Я просто спросил", type="neutral"),
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
    tokens = build_tokens(["尝尝", "这个", "乌龙茶", "好茶"])
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
    price = req.context.price
    floor = req.context.price_floor
    aggro = req.context.aggro
    msg = req.player_message.lower()

    if aggro >= 75:
        tokens = build_tokens(["走开", "不卖"])
        choices = [
            Choice(id=1, zh="师傅，消消气", py="Shīfu, xiāoxiāo qì", ru="Мастер, остыньте", type="polite"),
            Choice(id=2, zh="那我不要了", py="Nà wǒ bú yào le", ru="Тогда мне не надо", type="leave"),
            Choice(id=3, zh="态度真差", py="Tàidu zhēn chà", ru="Ужасное обслуживание", type="provoke"),
            Choice(id=4, zh="我换一家", py="Wǒ huàn yì jiā", ru="Пойду к другому", type="neutral"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="angry",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=min(10, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Technical jargon & spec knowledge
    if any(k in msg for k in ["вольт", "ампер", "type-c", "220", "напряжение", "чип", "foxconn", "watt"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["这个", "转换插头", "电压", "很好"])
        choices = [
            Choice(id=1, zh="师傅懂行，就按这个拿！", py="Shīfu dǒngháng, jiù àn zhège ná!", ru="Мастер разбирается, беру этот!", type="polite"),
            Choice(id=2, zh="给个打包价呗", py="Gěi gè dǎbāo jià bei", ru="Сделай скидку за комплект", type="haggle"),
            Choice(id=3, zh="带保修吗？", py="Dài bǎoxiū ma?", ru="Гарантия есть?", type="neutral"),
            Choice(id=4, zh="我再想想", py="Wǒ zài xiǎngxiang", ru="Я подумаю", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="flattered",
            price_new=new_price,
            mianzi_delta=15,
            aggro_delta=-5,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Explosion / fake accusation trigger
    if any(k in msg for k in ["взорв", "сгорит", "подделка", "爆炸", "fake"]):
        tokens = build_tokens(["质量", "很好", "正宗的"])
        choices = [
            Choice(id=1, zh="对不起师傅，我信你", py="Duìbuqǐ shīfu, wǒ xìn nǐ", ru="Извините мастер, я вам верю", type="polite"),
            Choice(id=2, zh="能现场通电测一下吗？", py="Néng xiànchǎng tōngdiàn cè yíxià ma?", ru="Можно на месте включить проверить?", type="neutral"),
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
    tokens = build_tokens(["这个", "转换插头", "质量", "很好"])
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
    price = req.context.price
    floor = req.context.price_floor
    aggro = req.context.aggro
    msg = req.player_message.lower()

    if aggro >= 75:
        tokens = build_tokens(["不卖", "喝", "热水"])
        choices = [
            Choice(id=1, zh="奶奶，我错了", py="Nǎinai, wǒ cuò le", ru="Бабушка, я виноват", type="polite"),
            Choice(id=2, zh="对不起", py="Duìbuqǐ", ru="Извините", type="leave"),
            Choice(id=3, zh="我不喝！", py="Wǒ bù hē!", ru="Не буду я пить!", type="provoke"),
            Choice(id=4, zh="我先走了", py="Wǒ xiān zǒu le", ru="Я пошел", type="neutral"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="sad",
            price_new=price,
            mianzi_delta=-15,
            aggro_delta=min(5, 100 - aggro),
            fsm_state="AGGRO",
            choices=choices,
        )

    # Health & Herb inquiry trigger
    if any(k in msg for k in ["усталость", "здоровье", "женьшень", "травы", "болеть", "人参", "气", "сила", "чай"]):
        new_price = max(floor, int(price * 0.85))
        tokens = build_tokens(["多喝", "热水", "这个", "人参", "补气"])
        choices = [
            Choice(id=1, zh="奶奶真好，我听您的多喝热水", py="Nǎinai zhēn hǎo, wǒ tīng nín de duō hē rèshuǐ", ru="Бабушка добрая, буду пить горячую воду", type="polite"),
            Choice(id=2, zh="学生党没钱，能少十块吗？", py="Xuésheng dǎng méi qián, néng shǎo shí kuài ma?", ru="У студента мало денег, уступите 10 юаней?", type="haggle"),
            Choice(id=3, zh="这味道太苦了", py="Zhè wèidao tài kǔ le", ru="Какой горький вкус!", type="neutral"),
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
        tokens = build_tokens(["不卖", "身体", "多喝", "热水"])
        choices = [
            Choice(id=1, zh="奶奶，我随便说说的", py="Nǎinai, wǒ suíbiàn shuōshuo de", ru="Бабушка, я пошутил", type="polite"),
            Choice(id=2, zh="那正宗人参多少钱？", py="Nà zhèngzōng rénshēn duōshao qián?", ru="А настоящий женьшень сколько стоит?", type="haggle"),
            Choice(id=3, zh="本来就是草根嘛", py="Běnlái jiù shì cǎogēn ma", ru="Ну так это ж просто трава", type="provoke"),
            Choice(id=4, zh="走啦", py="Zǒu la", ru="Пойду", type="leave"),
        ]
        return _make_response(
            tokens=tokens,
            emotion="sad",
            price_new=price,
            mianzi_delta=-10,
            aggro_delta=20,
            fsm_state="HAGGLING",
            choices=choices,
        )

    # Default Granny Liu response
    tokens = build_tokens(["多喝", "热水", "这个", "人参", "补气"])
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
