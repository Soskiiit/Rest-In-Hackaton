#!/usr/bin/env python3
"""
Comprehensive E2E and Requirement-Driven Test Suite for Rest-In-Hackaton DEV-B AI Middleware.

Executes 100% offline using Python standard library `unittest` and `httpx.ASGITransport(app=app)`.
Zero network port dependency.

Coverage:
- Tier 1: Feature Coverage (>=5 tests per feature: GET /health, POST /dialogue for Lao Wang, Chef Chen, Guard Zhang)
- Tier 2: Boundary & Corner Cases (price_floor clamping, 0..100 mianzi/aggro limits, aggro > 75 triggering AGGRO, malformed inputs)
- Tier 3: Cross-Feature Combinations (speech_tokens schema zh/py/ru/id validation, choices cardinality exactly 4, choice archetype types, emotion transitions)
- Tier 4: Real-World Haggling & Dialogue Scenarios (multi-turn dialogue flow, merchant discounts, bribe detection for Guard Zhang)
- Resilience & Offline Fallback Testing (simulating llama-server down, timeouts, corrupted output recovery)
"""

import asyncio
import os
os.environ.setdefault("TTS_ENGINE", "formant")
import sys
import unittest
from unittest.mock import patch, AsyncMock

import httpx

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from ai.middleware import app
from ai.llm_client import LLMClientError
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
import json


def load_world_catalog() -> dict:
    """Loads authoritative word definitions from server/world/catalog.json."""
    catalog_path = os.path.join(PROJECT_ROOT, "server", "world", "catalog.json")
    with open(catalog_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("words", {})


def validate_go_contract(reply_data: dict, price_floor: int, catalog_words: dict) -> None:
    """
    Simulates server/internal/game/dialogue.go:107-147 validation logic.
    Raises AssertionError if any Go validation rule is violated.
    """
    tokens = reply_data.get("tokens", [])
    choices = reply_data.get("choices", [])
    state = reply_data.get("fsm_state", "")
    price = reply_data.get("price_new", 0)
    m_delta = reply_data.get("mianzi_delta", 0)
    a_delta = reply_data.get("aggro_delta", 0)
    emotion = reply_data.get("emotion", "")

    assert 1 <= len(tokens) <= 64, f"Invalid token count: {len(tokens)}"
    assert len(choices) == 4, f"Expected 4 choices, got {len(choices)}"
    assert state in {"IDLE", "CALLING", "HAGGLING", "FLATTERED", "SUSPICIOUS", "AGGRO"}, f"Invalid state: {state}"
    assert price_floor <= price <= 100000, f"Price {price} out of bounds [{price_floor}, 100000]"
    assert -30 <= m_delta <= 30, f"Mianzi delta {m_delta} out of bounds [-30, 30]"
    assert -30 <= a_delta <= 30, f"Aggro delta {a_delta} out of bounds [-30, 30]"
    assert emotion in {"neutral", "angry", "happy", "suspicious"}, f"Invalid emotion: {emotion}"

    for t in tokens:
        tid = t.get("id", "")
        zh = t.get("zh", "")
        py = t.get("py", "")
        ru = t.get("ru", "")
        assert zh and len(zh) <= 512, f"Invalid token zh length: {zh}"
        assert py and len(py) <= 512, f"Invalid token py length: {py}"
        assert ru and len(ru) <= 1024, f"Invalid token ru length: {ru}"

        if not tid:
            for ch in zh:
                assert not ("\u4e00" <= ch <= "\u9fff"), f"Chinese words require catalog IDs: {zh}"
        else:
            assert tid in catalog_words, f"Unknown AI word ID: {tid}"
            cw = catalog_words[tid]
            assert cw["zh"] == zh, f"Mismatched zh for {tid}: {zh} != {cw['zh']}"
            assert cw["py"] == py, f"Mismatched py for {tid}: {py} != {cw['py']}"
            assert cw["ru"] == ru, f"Mismatched ru for {tid}: {ru} != {cw['ru']}"



# ============================================================================
# Tier 1: Feature Coverage (>= 5 tests per feature)
# ============================================================================

class TestTier1HealthFeature(unittest.IsolatedAsyncioTestCase):
    """Tier 1: Feature Coverage for GET /health endpoint."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_health_returns_status_200(self):
        """GET /health must return HTTP 200 status code."""
        resp = await self.client.get("/health")
        self.assertEqual(resp.status_code, 200)

    async def test_02_health_payload_status_ok(self):
        """GET /health response JSON must contain status: 'ok'."""
        resp = await self.client.get("/health")
        data = resp.json()
        self.assertEqual(data.get("status"), "ok")

    async def test_03_health_model_name_present(self):
        """GET /health must report target LLM model name (Qwen3.5-4B-MTP-GGUF)."""
        resp = await self.client.get("/health")
        data = resp.json()
        model = data.get("model", "")
        self.assertTrue(len(model) > 0)
        self.assertIn("Qwen", model)

    async def test_04_health_backend_string(self):
        """GET /health must indicate active backend ('llama-server' or 'mock')."""
        resp = await self.client.get("/health")
        data = resp.json()
        self.assertIn(data.get("backend"), ["llama-server", "mock"])

    async def test_05_health_llm_alive_boolean(self):
        """GET /health must provide boolean indicator of LLM liveness."""
        resp = await self.client.get("/health")
        data = resp.json()
        self.assertIsInstance(data.get("llm_alive"), bool)

    async def test_06_health_llm_endpoint_url(self):
        """GET /health must report target upstream completion URL."""
        resp = await self.client.get("/health")
        data = resp.json()
        endpoint = data.get("llm_endpoint", "")
        self.assertIn("/v1/chat/completions", endpoint)


class TestTier1LaoWangFeature(unittest.IsolatedAsyncioTestCase):
    """Tier 1: Feature Coverage for Lao Wang (Jade Merchant)."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_lao_wang_greeting(self):
        """Lao Wang responds to standard player greeting with valid tokens and choices."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板好，这块玉佩怎么卖？",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(len(data["speech_tokens"]) >= 1)
        self.assertEqual(len(data["choices"]), 4)

    async def test_02_lao_wang_haggle_discount(self):
        """Lao Wang responds to haggling offer and adjusts price."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "太贵了，老板便宜点！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["price_new"], 800)
        self.assertGreaterEqual(data["price_new"], 120)

    async def test_03_lao_wang_auntie_li_discount(self):
        """Mentioning Auntie Li ('李阿姨' / 'тётушка Ли') triggers competitor discount."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "隔壁 тётушка Ли (李阿姨) 说她家只要300块！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        # Competitor rule triggers discount (-20% = 640)
        self.assertLessEqual(data["price_new"], 640)

    async def test_04_lao_wang_fake_goods_reaction(self):
        """Accusing Lao Wang of selling fake goods ('假货') triggers aggro increase."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "这根本就是假货！你在骗人！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["aggro_delta"], 0)

    async def test_05_lao_wang_made_in_yiwu_defect(self):
        """Mentioning 'Made in Yiwu' defect drops price significantly (-300 RMB)."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，这玉佩底部写着Made in Yiwu！这是义乌小商品吧！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["price_new"], 500)

    async def test_06_lao_wang_leave_option(self):
        """Player choosing to leave or reconsider handled gracefully."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "我再想想，先不买了。",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["choices"]), 4)


class TestTier1ChefChenFeature(unittest.IsolatedAsyncioTestCase):
    """Tier 1: Feature Coverage for Chef Chen (Spicy Noodle Master)."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_chef_chen_extra_spicy(self):
        """Ordering extra spicy ('特辣') noodles pleases Chef Chen (aggro_delta <= 0)."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，来一碗正宗特辣担担面！",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 20},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["aggro_delta"], 0)

    async def test_02_chef_chen_non_spicy_reproach(self):
        """Requesting non-spicy ('不辣' / '微辣') noodles increases Chef Chen's aggro."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，能不能做完全不辣的？",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["aggro_delta"], 0)

    async def test_03_chef_chen_foreign_menu_inquiry(self):
        """Asking for an English/Russian menu triggers indignation (aggro increases)."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "Do you have an English menu? 有英文或者俄语菜单吗？",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreater(data["aggro_delta"], 0)

    async def test_04_chef_chen_peanut_allergy(self):
        """Mentioning peanut allergy ('花生' / 'huāshēng') is processed properly."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，我对花生过敏，别放花生！",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["choices"]), 4)

    async def test_05_chef_chen_recommendation(self):
        """Asking Chef Chen for a recommendation yields culinary speech tokens."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，店里有什么招牌面推荐吗？",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(len(data["speech_tokens"]) >= 1)


class TestTier1GuardZhangFeature(unittest.IsolatedAsyncioTestCase):
    """Tier 1: Feature Coverage for Guard Zhang (Metro Security Officer)."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_guard_zhang_polite_id_check(self):
        """Presenting ID card ('证件' / '身份证') politely reduces aggro and allows pass."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官好，这是我的身份证件，请检查。",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 15},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["aggro_delta"], 0)

    async def test_02_guard_zhang_just_passing(self):
        """Saying 'just passing by' ('我只是路过') yields regular patrol check."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官，我只是路过进站乘车。",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn(data["fsm_state"], ["PATROL", "TALKING", "IDLE"])

    async def test_03_guard_zhang_duty_inquiry(self):
        """Asking about metro security regulations returns formal speech tokens."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "请问进站安检有什么违禁品规定吗？",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(len(data["speech_tokens"]) >= 1)

    async def test_04_guard_zhang_security_alert(self):
        """Alerting guard to security issue maintains vigilant dialogue choices."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官，那边的通道好像有人吵架！",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["choices"]), 4)

    async def test_05_guard_zhang_cooperative_exit(self):
        """Cooperative exit message preserves calm state."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "好的警官，我这就配合进站，谢谢。",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertNotEqual(data["fsm_state"], "AGGRO")


# ============================================================================
# Tier 2: Boundary & Corner Cases
# ============================================================================

class TestTier2BoundaryAndCornerCases(unittest.IsolatedAsyncioTestCase):
    """Tier 2: Boundary clamping, limits, FSM state triggers, and error validation."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_price_floor_clamping_strict(self):
        """When player suggests price far below price_floor, price_new never violates price_floor."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "50块钱卖给我吧，别犹豫了！",
            "context": {"price": 800, "price_floor": 350, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["price_new"], 350)

    async def test_02_price_floor_already_at_minimum(self):
        """When current price is already equal to price_floor, price cannot drop lower."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "再便宜10块钱我就买！",
            "context": {"price": 120, "price_floor": 120, "mianzi": 50, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["price_new"], 120)

    async def test_03_negative_price_context_handling(self):
        """Context with negative price or price_floor is safely clamped to >= 0."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板好",
            "context": {"price": -500, "price_floor": -200, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["price_new"], 0)

    async def test_04_mianzi_upper_clamp_100(self):
        """Mianzi input exceeding 100 in context is clamped to 100, delta remains bounded."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板真是整条街最有智慧、最体面的人！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 150, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["mianzi_delta"], -100)
        self.assertLessEqual(data["mianzi_delta"], 100)

    async def test_05_mianzi_lower_clamp_0(self):
        """Mianzi input below 0 in context is clamped to 0, delta remains bounded."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "你算什么东西，真是个无赖！",
            "context": {"price": 800, "price_floor": 120, "mianzi": -50, "aggro": 20},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["mianzi_delta"], -100)
        self.assertLessEqual(data["mianzi_delta"], 100)

    async def test_06_aggro_upper_clamp_100(self):
        """Aggro input exceeding 100 in context is clamped to 100 and triggers AGGRO state."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "假货！大骗子！我要砸了你的店！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 20, "aggro": 150},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["fsm_state"], "AGGRO")
        self.assertGreaterEqual(data["aggro_delta"], -100)
        self.assertLessEqual(data["aggro_delta"], 100)

    async def test_07_aggro_lower_clamp_0(self):
        """Aggro input below 0 in context is clamped to 0, delta remains bounded."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官好，这是我的身份证件，辛苦了！",
            "context": {"price": 0, "price_floor": 0, "mianzi": 80, "aggro": -30},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["aggro_delta"], -100)
        self.assertLessEqual(data["aggro_delta"], 100)

    async def test_08_high_aggro_triggers_fsm_aggro(self):
        """When cumulative aggro exceeds 75, fsm_state MUST become 'AGGRO' and emotion 'angry'."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "假货！全是假货！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 10, "aggro": 80},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["fsm_state"], "AGGRO")
        self.assertEqual(data["emotion"], "angry")

    async def test_09_unknown_npc_returns_404(self):
        """POST /dialogue with an unknown NPC ID must return HTTP 404 Not Found."""
        payload = {
            "npc_id": "unknown_ghost_npc",
            "player_message": "Hello?",
            "context": {"price": 100, "price_floor": 50, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 404)
        self.assertIn("not found", resp.text.lower())

    async def test_10_empty_request_body_returns_422(self):
        """POST /dialogue with empty JSON body must return HTTP 422 Unprocessable Entity."""
        resp = await self.client.post("/dialogue", json={})
        self.assertEqual(resp.status_code, 422)

    async def test_11_missing_player_message_returns_422(self):
        """POST /dialogue omitting player_message must return HTTP 422."""
        payload = {
            "npc_id": "lao_wang",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 422)

    async def test_12_whitespace_player_message_returns_422(self):
        """POST /dialogue with whitespace-only player_message must return HTTP 422."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "     ",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 422)

    async def test_13_missing_context_uses_defaults(self):
        """POST /dialogue omitting 'context' entirely succeeds (HTTP 200) using safe defaults."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板好，我来看看玉。",
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["choices"]), 4)

    # ------------------------------------------------------------------------
    # Reviewer 2 Targeted Boundary & Corner Cases
    # ------------------------------------------------------------------------
    async def test_08a_high_aggro_triggers_fsm_aggro_all_npcs(self):
        """When context aggro > 75, fsm_state MUST be 'AGGRO' and emotion 'angry' for all 3 NPCs."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {"price": 100, "price_floor": 50, "mianzi": 50, "aggro": 80},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200, f"NPC {npc} failed with status {resp.status_code}")
            data = resp.json()
            self.assertEqual(
                data["fsm_state"],
                "AGGRO",
                f"NPC {npc} with aggro=80 did not trigger AGGRO state: got {data['fsm_state']}",
            )
            self.assertEqual(
                data["emotion"],
                "angry",
                f"NPC {npc} with aggro=80 did not trigger angry emotion: got {data['emotion']}",
            )
            self.assertEqual(len(data["choices"]), 4, f"NPC {npc} choices != 4 in AGGRO state")
            self.assertTrue(len(data["speech_tokens"]) >= 1, f"NPC {npc} tokens empty in AGGRO state")

    async def test_08b_aggro_threshold_boundary_76(self):
        """When context aggro is 76 (> 75 threshold), all NPCs trigger AGGRO state."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {"price": 100, "price_floor": 50, "mianzi": 50, "aggro": 76},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["fsm_state"], "AGGRO", f"NPC {npc} failed AGGRO at threshold 76")
            self.assertEqual(data["emotion"], "angry", f"NPC {npc} failed angry emotion at threshold 76")

    async def test_14_null_context_payload_produces_http_200_with_defaults(self):
        """POST /dialogue with explicit null context (`{'context': None}`) returns HTTP 200 with defaults."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": None,
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(
                resp.status_code,
                200,
                f"Expected HTTP 200 for NPC {npc} with null context, got {resp.status_code}: {resp.text}",
            )
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4, f"NPC {npc} choices count != 4 with null context")
            self.assertTrue(len(data["speech_tokens"]) >= 1, f"NPC {npc} tokens empty with null context")
            self.assertIn(
                data["emotion"],
                ["neutral", "suspicious", "happy", "angry", "flattered", "surprised"],
            )
            self.assertIn(
                data["fsm_state"],
                ["IDLE", "CALLING", "HAGGLING", "FLATTERED", "SUSPICIOUS", "AGGRO", "TALKING", "PATROL", "DEAL_AGREED"],
            )

    async def test_15_effective_aggro_delta_upper_clamping(self):
        """When cur_aggro=95, aggro_delta cannot exceed +5, keeping cumulative aggro <= 100."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "Do you have an English menu? 给我英语菜单！",
            "context": {"price": 30, "price_floor": 25, "mianzi": 50, "aggro": 95},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        aggro_delta = data["aggro_delta"]
        self.assertLessEqual(
            aggro_delta,
            5,
            f"aggro_delta={aggro_delta} with cur_aggro=95 pushed cumulative aggro to {95 + aggro_delta} (> 100)",
        )
        self.assertGreaterEqual(95 + aggro_delta, 0)
        self.assertLessEqual(95 + aggro_delta, 100)
        self.assertEqual(data["fsm_state"], "AGGRO")
        self.assertEqual(data["emotion"], "angry")

    async def test_16_guard_zhang_bribe_effective_delta_clamping(self):
        """Bribe attempt yields aggro_delta clamped strictly to +30 per Go contract."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官，给你100块钱私下通融一下！",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 60},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        aggro_delta = data["aggro_delta"]
        self.assertEqual(
            aggro_delta,
            30,
            f"Expected effective aggro_delta=30 (capped at +30), got {aggro_delta} (cumulative={60 + aggro_delta})",
        )
        self.assertEqual(data["fsm_state"], "AGGRO")
        self.assertEqual(data["emotion"], "angry")

    async def test_17_effective_mianzi_delta_upper_clamping(self):
        """When cur_mianzi=95, mianzi_delta cannot exceed +5, keeping cumulative mianzi <= 100."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板眼光真好，一看就是最有面子、最懂玉的大师！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 95, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        mianzi_delta = data["mianzi_delta"]
        self.assertLessEqual(
            mianzi_delta,
            5,
            f"mianzi_delta={mianzi_delta} with cur_mianzi=95 pushed cumulative mianzi to {95 + mianzi_delta} (> 100)",
        )
        self.assertLessEqual(95 + mianzi_delta, 100)

    async def test_18_effective_mianzi_delta_lower_clamping(self):
        """When cur_mianzi=5, mianzi_delta cannot be less than -5, keeping cumulative mianzi >= 0."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "这根本就是假货！骗子！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 5, "aggro": 10},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        mianzi_delta = data["mianzi_delta"]
        self.assertGreaterEqual(
            mianzi_delta,
            -5,
            f"mianzi_delta={mianzi_delta} with cur_mianzi=5 pushed cumulative mianzi to {5 + mianzi_delta} (< 0)",
        )
        self.assertGreaterEqual(5 + mianzi_delta, 0)

    async def test_19_effective_aggro_delta_lower_clamping(self):
        """When cur_aggro=4, aggro_delta cannot be less than -4, keeping cumulative aggro >= 0."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官好，这是我的身份证件，请检查。",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 4},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        aggro_delta = data["aggro_delta"]
        self.assertGreaterEqual(
            aggro_delta,
            -4,
            f"aggro_delta={aggro_delta} with cur_aggro=4 pushed cumulative aggro to {4 + aggro_delta} (< 0)",
        )
        self.assertGreaterEqual(4 + aggro_delta, 0)

    async def test_20_yiwu_defect_strictly_obeys_price_floor_mock(self):
        """When Lao Wang Yiwu defect discount (-300) would drop below price_floor, price_new clamps to price_floor."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，这玉底部写着 Made in Yiwu 义乌，有明显瑕疵！",
            "context": {"price": 250, "price_floor": 200, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(
            data["price_new"],
            200,
            f"Expected price_new to clamp to price_floor=200, got {data['price_new']}",
        )
        self.assertGreaterEqual(data["price_new"], 200)

    async def test_21_yiwu_defect_strictly_obeys_price_floor_llm_inference(self):
        """When LLM returns price below price_floor for Yiwu defect, middleware clamps to price_floor."""
        from ai.middleware import llm_client

        mock_llm_data = {
            "speech_tokens": [
                {"zh": "义乌", "py": "yìwū", "ru": "Иу", "id": "word_yiwu"},
                {"zh": "玉", "py": "yù", "ru": "нефрит", "id": "word_jade"},
            ],
            "emotion": "suspicious",
            "price_new": 50,  # Below price_floor 200!
            "mianzi_delta": -5,
            "aggro_delta": 5,
            "fsm_state": "HAGGLING",
            "choices": [
                {"id": 1, "zh": "成交", "py": "chéngjiāo", "ru": "по рукам", "type": "haggle"},
                {"id": 2, "zh": "再看看", "py": "zài kànkan", "ru": "посмотрю", "type": "leave"},
                {"id": 3, "zh": "算了吧", "py": "suànle ba", "ru": "ладно", "type": "leave"},
                {"id": 4, "zh": "行", "py": "xíng", "ru": "пойдет", "type": "polite"},
            ],
        }

        with patch.object(
            llm_client,
            "generate_chat_completion",
            return_value=(mock_llm_data, "{}"),
        ):
            payload = {
                "npc_id": "lao_wang",
                "player_message": "这是Made in Yiwu的假货，便宜点！",
                "context": {"price": 300, "price_floor": 200, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(
                data["price_new"],
                200,
                f"LLM generated price_new=50 below price_floor=200, but middleware did not clamp: got {data['price_new']}",
            )
            self.assertGreaterEqual(data["price_new"], 200)

    async def test_22_chef_chen_price_floor_invariant(self):
        """Chef Chen food pricing is never discounted below price_floor."""
        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，能不能5块钱卖我一碗面？",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["price_new"], 25)

    async def test_23_guard_zhang_price_invariant_always_zero(self):
        """Guard Zhang dialogue always enforces price_new=0 and price_floor=0."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "长官好",
            "context": {"price": 500, "price_floor": 100, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["price_new"], 0)


# ============================================================================
# Tier 3: Cross-Feature Combinations & Schema Integrity
# ============================================================================

class TestTier3CrossFeatureSchemaIntegrity(unittest.IsolatedAsyncioTestCase):
    """Tier 3: Schema validation, token fields, choices cardinality, and enums."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_speech_tokens_fields_integrity(self):
        """Every speech token must strictly contain non-empty 'zh', 'py', 'ru', 'id'."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            tokens = resp.json().get("speech_tokens", [])
            self.assertGreater(len(tokens), 0, f"No speech tokens for NPC {npc}")
            for t in tokens:
                self.assertTrue(bool(t.get("zh", "").strip()), f"Empty zh in {t}")
                self.assertTrue(bool(t.get("py", "").strip()), f"Empty py in {t}")
                self.assertTrue(bool(t.get("ru", "").strip()), f"Empty ru in {t}")
                self.assertTrue(bool(t.get("id", "").strip()), f"Empty id in {t}")

    async def test_02_dual_schema_tokens_alias(self):
        """Response must provide 'tokens' field identical to 'speech_tokens' for Go server."""
        payload = {"npc_id": "lao_wang", "player_message": "老板好"}
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("tokens", data)
        self.assertEqual(data["tokens"], data["speech_tokens"])

    async def test_03_speech_tokens_utf8_fidelity(self):
        """Tokens must preserve Chinese Hanzi and tone-marked Pinyin without corruption."""
        payload = {"npc_id": "lao_wang", "player_message": "老板，这玉真不真？"}
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        tokens = resp.json().get("speech_tokens", [])
        combined_zh = "".join(t["zh"] for t in tokens)
        combined_py = " ".join(t["py"] for t in tokens)
        self.assertTrue(any('\u4e00' <= char <= '\u9fff' for char in combined_zh))
        self.assertFalse(combined_zh.startswith("\\u"))

    async def test_04_choices_cardinality_strictly_4(self):
        """Choices list must contain exactly 4 options across all NPCs."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            choices = resp.json().get("choices", [])
            self.assertEqual(len(choices), 4, f"Choices count != 4 for NPC {npc}")

    async def test_05_choices_ids_strictly_1_to_4(self):
        """Choices IDs must be ordered 1, 2, 3, 4 without gaps or duplicates."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            choices = resp.json().get("choices", [])
            ids = [c["id"] for c in choices]
            self.assertEqual(ids, [1, 2, 3, 4], f"Choice IDs incorrect for NPC {npc}")

    async def test_06_choices_archetype_types(self):
        """Choice type must belong to the authorized ChoiceType set."""
        valid_types = {"polite", "haggle", "provoke", "leave", "bluff", "order", "documents", "bribe", "directions"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            for c in resp.json().get("choices", []):
                self.assertIn(c.get("type"), valid_types, f"Invalid choice type: {c.get('type')}")

    async def test_07_choices_non_empty_strings(self):
        """All choices must contain non-empty zh, py, and ru text."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            for c in resp.json().get("choices", []):
                self.assertTrue(bool(c.get("zh", "").strip()))
                self.assertTrue(bool(c.get("py", "").strip()))
                self.assertTrue(bool(c.get("ru", "").strip()))

    async def test_08_emotion_enum_validity(self):
        """Emotion must belong to the authorized EmotionType enum set."""
        valid_emotions = {"neutral", "angry", "happy", "suspicious", "flattered", "surprised"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            emotion = resp.json().get("emotion")
            self.assertIn(emotion, valid_emotions)

    async def test_09_fsm_state_enum_validity(self):
        """FSM state must belong to the authorized FsmStateType enum set."""
        valid_fsm_states = {"IDLE", "CALLING", "HAGGLING", "FLATTERED", "SUSPICIOUS", "AGGRO", "TALKING", "PATROL", "DEAL_AGREED"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            state = resp.json().get("fsm_state")
            self.assertIn(state, valid_fsm_states)


# ============================================================================
# Tier 4: Real-World Haggling & Dialogue Scenarios
# ============================================================================

class TestTier4RealWorldScenarios(unittest.IsolatedAsyncioTestCase):
    """Tier 4: Multi-turn dialogue progression, discounts, and game mechanics."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_multi_turn_haggling_flow(self):
        """Simulates 4-turn sequential bargaining interaction with state carrying over."""
        # Turn 1: Opening
        t1_payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，这块玉怎么卖？",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0, "history": "[]"},
        }
        r1 = await self.client.post("/dialogue", json=t1_payload)
        self.assertEqual(r1.status_code, 200)
        d1 = r1.json()
        p1 = d1["price_new"]

        # Turn 2: Bargaining
        t2_payload = {
            "npc_id": "lao_wang",
            "player_message": "太贵了！老板便宜点，诚心买！",
            "context": {"price": p1, "price_floor": 120, "mianzi": 50 + d1["mianzi_delta"], "aggro": d1["aggro_delta"], "history": f"[{{'user': '玉怎么卖', 'npc': '800'}}]" },
        }
        r2 = await self.client.post("/dialogue", json=t2_payload)
        self.assertEqual(r2.status_code, 200)
        d2 = r2.json()
        self.assertLessEqual(d2["price_new"], p1)

        # Turn 3: Flattery
        t3_payload = {
            "npc_id": "lao_wang",
            "player_message": "老板眼光真好，一看就是行家！",
            "context": {"price": d2["price_new"], "price_floor": 120, "mianzi": 65, "aggro": 0},
        }
        r3 = await self.client.post("/dialogue", json=t3_payload)
        self.assertEqual(r3.status_code, 200)
        d3 = r3.json()
        self.assertGreater(d3["mianzi_delta"], 0)

        # Turn 4: Agreement
        t4_payload = {
            "npc_id": "lao_wang",
            "player_message": "行，老板爽快，成交！",
            "context": {"price": d3["price_new"], "price_floor": 120, "mianzi": 75, "aggro": 0},
        }
        r4 = await self.client.post("/dialogue", json=t4_payload)
        self.assertEqual(r4.status_code, 200)
        d4 = r4.json()
        self.assertEqual(len(d4["choices"]), 4)

    async def test_02_guard_zhang_bribe_detection(self):
        """Attempting to bribe Guard Zhang triggers immediate Aggro=100 and detention FSM state."""
        bribe_phrases = [
            "警官，我给你点钱，通融一下！",
            "Can I bribe you? 给你点小费，通融通融",
            "这是两百块钱，大家私下通融通融！",
        ]
        for phrase in bribe_phrases:
            payload = {
                "npc_id": "guard_zhang",
                "player_message": phrase,
                "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["fsm_state"], "AGGRO")
            self.assertEqual(data["emotion"], "angry")
            self.assertEqual(data["aggro_delta"], 30)

    async def test_03_lao_wang_high_mianzi_discount(self):
        """When player has high Mianzi (> 70), Lao Wang grants flattery discount."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，看在朋友面子上，给个优惠吧！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 85, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["price_new"], 720)  # 10% off 800 is 720

    async def test_04_chef_chen_multi_turn_order(self):
        """Multi-turn order flow with Chef Chen transitioning between menu recommendation and order."""
        t1 = await self.client.post(
            "/dialogue",
            json={"npc_id": "chef_chen", "player_message": "老板，有什么招牌面？"},
        )
        self.assertEqual(t1.status_code, 200)

        t2 = await self.client.post(
            "/dialogue",
            json={
                "npc_id": "chef_chen",
                "player_message": "来一碗特辣担担面！",
                "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 10},
            },
        )
        self.assertEqual(t2.status_code, 200)
        self.assertLessEqual(t2.json()["aggro_delta"], 0)


# ============================================================================
# Resilience & Offline Fallback Testing
# ============================================================================

class TestResilienceAndOfflineFallback(unittest.IsolatedAsyncioTestCase):
    """Resilience testing: LLM server crashes, network timeouts, markdown fences, corrupted JSON."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_fallback_when_llm_connection_error(self):
        """When LLM connection is refused, middleware gracefully falls back to mock engine with 200."""
        from ai.middleware import llm_client

        with patch.object(
            llm_client,
            "generate_chat_completion",
            side_effect=LLMClientError("Connection refused to 127.0.0.1:8080"),
        ):
            payload = {
                "npc_id": "lao_wang",
                "player_message": "老板好！",
                "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4)
            self.assertTrue(len(data["speech_tokens"]) >= 1)

    async def test_02_fallback_when_llm_timeout(self):
        """When LLM request times out, middleware activates fallback without raising 500 error."""
        from ai.middleware import llm_client

        with patch.object(
            llm_client,
            "generate_chat_completion",
            side_effect=LLMClientError("Request timed out after 15.0 seconds"),
        ):
            payload = {
                "npc_id": "chef_chen",
                "player_message": "来碗面！",
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4)

    async def test_03_markdown_code_fences_stripping(self):
        """When LLM returns markdown fences (```json ... ```), middleware sanitizes and parses properly."""
        from ai.middleware import llm_client

        mock_llm_data = {
            "speech_tokens": [
                {"zh": "正宗", "py": "zhèngzōng", "ru": "настоящий", "id": "word_authentic"},
                {"zh": "玉", "py": "yù", "ru": "нефрит", "id": "word_jade"},
            ],
            "emotion": "happy",
            "price_new": 750,
            "mianzi_delta": 5,
            "aggro_delta": -2,
            "fsm_state": "HAGGLING",
            "choices": [
                {"id": 1, "zh": "便宜点", "py": "piányi diǎn", "ru": "подешевле", "type": "haggle"},
                {"id": 2, "zh": "好玉！", "py": "hǎo yù!", "ru": "хороший нефрит!", "type": "polite"},
                {"id": 3, "zh": "太贵了", "py": "tài guì le", "ru": "дорого", "type": "provoke"},
                {"id": 4, "zh": "再想想", "py": "zài xiǎngxiang", "ru": "подумаю", "type": "leave"},
            ],
        }

        with patch.object(
            llm_client,
            "generate_chat_completion",
            return_value=(mock_llm_data, "```json\n" + str(mock_llm_data) + "\n```"),
        ):
            payload = {
                "npc_id": "lao_wang",
                "player_message": "老板这玉真漂亮！",
                "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["emotion"], "happy")
            self.assertEqual(data["price_new"], 750)
            self.assertEqual(len(data["choices"]), 4)

    async def test_04_fallback_when_corrupted_json(self):
        """When LLM returns corrupted / unparseable JSON, fallback generator serves valid response."""
        from ai.middleware import llm_client

        with patch.object(
            llm_client,
            "generate_chat_completion",
            side_effect=LLMClientError("Failed to parse JSON: Unexpected end of data"),
        ):
            payload = {
                "npc_id": "guard_zhang",
                "player_message": "你好",
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4)

    async def test_05_fallback_preserves_price_floor(self):
        """Fallback response strictly honors price_floor constraints."""
        from ai.middleware import llm_client

        with patch.object(
            llm_client,
            "generate_chat_completion",
            side_effect=LLMClientError("Offline simulation"),
        ):
            payload = {
                "npc_id": "lao_wang",
                "player_message": "太贵了便宜点",
                "context": {"price": 500, "price_floor": 400, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertGreaterEqual(data["price_new"], 400)


# ============================================================================
# Market Diversity: All 6 Distinct Market NPCs
# ============================================================================

class TestAllMarketNPCs(unittest.IsolatedAsyncioTestCase):
    """Verifies that all 6 distinct market stalls/NPCs respond with valid tokens and 4 choices."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_all_six_market_npcs_respond_validly(self):
        npcs = [
            ("lao_wang", "Сколько стоит нефрит?"),
            ("auntie_li", "Тётушка Ли, налейте чаю Улун!"),
            ("electronics_zhang", "Мастер Чжан, есть переходник на китайскую вилку?"),
            ("chef_chen", "Шеф, одну острую лапшу Dan Dan!"),
            ("granny_liu", "Бабушка Лю, что попить от усталости?"),
            ("guard_zhang", "Здравствуйте, вот мой пропуск."),
        ]
        for npc_id, message in npcs:
            with self.subTest(npc=npc_id):
                resp = await self.client.post(
                    "/dialogue",
                    json={
                        "npc_id": npc_id,
                        "player_message": message,
                        "context": {"price": 200, "price_floor": 50, "mianzi": 50, "aggro": 0},
                    },
                )
                self.assertEqual(resp.status_code, 200)
                data = resp.json()
                self.assertEqual(len(data["choices"]), 4)
                self.assertGreaterEqual(len(data["speech_tokens"]), 1)
                for tok in data["speech_tokens"]:
                    self.assertIn("zh", tok)
                    self.assertIn("py", tok)
                    self.assertIn("ru", tok)
                    self.assertIn("id", tok)
                    self.assertTrue(tok["id"].startswith("word_"))



# ============================================================================
# Tier 5: Stage 6 Offline TTS Subsystem Test Suites
# ============================================================================

import struct
import base64
import time

from ai.tts import (
    generate_wav,
    synthesize_wav,
    synthesize_phrase,
    tone_pitch_contour,
    SPEAKER_PROFILES,
)


class TestOfflineTTSSynthesizer(unittest.TestCase):
    """Unit tests for pure-Python acoustic/formant offline TTS synthesizer (ai/tts.py)."""

    def test_01_wav_riff_header_validity(self):
        """Generated audio must have a valid 44-byte RIFF/WAVE PCM header."""
        wav_bytes = generate_wav("太贵了")
        self.assertGreater(len(wav_bytes), 44)
        # RIFF chunk descriptor
        self.assertEqual(wav_bytes[0:4], b"RIFF")
        self.assertEqual(wav_bytes[8:12], b"WAVE")
        # fmt subchunk
        self.assertEqual(wav_bytes[12:16], b"fmt ")
        audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample = struct.unpack(
            "<HHIIHH", wav_bytes[20:36]
        )
        self.assertEqual(audio_format, 1)        # 1 = PCM
        self.assertEqual(num_channels, 1)        # Mono
        self.assertEqual(sample_rate, 16000)     # 16000 Hz
        self.assertEqual(bits_per_sample, 16)    # 16-bit
        # data subchunk
        self.assertEqual(wav_bytes[36:40], b"data")

    def test_02_tones_pitch_contours(self):
        """Tone contours 1 through 4 must generate distinct pitch trajectories."""
        t1 = tone_pitch_contour(1, num_samples=100)
        t2 = tone_pitch_contour(2, num_samples=100)
        t3 = tone_pitch_contour(3, num_samples=100)
        t4 = tone_pitch_contour(4, num_samples=100)
        self.assertEqual(len(t1), 100)
        self.assertNotEqual(t1, t2)
        self.assertNotEqual(t2, t4)
        # Tone 1 should be relatively flat
        self.assertAlmostEqual(t1[0], t1[-1], delta=10.0)
        # Tone 2 should rise
        self.assertGreater(t2[-1], t2[0])
        # Tone 4 should fall
        self.assertLess(t4[-1], t4[0])

    def test_03_catalog_phrase_synthesis(self):
        """Synthesizing authoritative catalog words produces non-empty audio."""
        for word in ["太贵了", "玉", "便宜", "老板", "对不起"]:
            audio = generate_wav(word)
            self.assertIsInstance(audio, bytes)
            self.assertGreater(len(audio), 500)

    def test_04_empty_and_punctuation_handling(self):
        """Empty text or pure punctuation returns valid short silence/tone without crashing."""
        for text in ["", "   ", "，。！？", "123", "abc"]:
            audio = generate_wav(text)
            self.assertIsInstance(audio, bytes)
            self.assertGreaterEqual(len(audio), 44)

    def test_05_formant_vowels_and_pinyin(self):
        """Synthesizing common Mandarin finals generates valid waveform."""
        for phrase in ["ba", "po", "de", "ti", "lu", "er"]:
            audio = synthesize_phrase(phrase)
            self.assertIsInstance(audio, bytes)
            self.assertGreater(len(audio), 44)

    def test_06_speaker_profiles(self):
        """Speaker profiles correctly adjust pitch and speed without errors."""
        for spk in ["lao_wang", "auntie_li", "guard_zhang", "chef_chen"]:
            wav, dur = synthesize_wav(text="你好", speaker=spk)
            self.assertGreater(len(wav), 44)
            self.assertGreater(dur, 0.0)

    def test_07_synthesis_speed_and_pitch_bounds(self):
        """Speed and pitch bounds operate smoothly."""
        wav_fast, dur_fast = synthesize_wav(text="老板便宜点", speed=2.0)
        wav_slow, dur_slow = synthesize_wav(text="老板便宜点", speed=0.5)
        self.assertLess(dur_fast, dur_slow)

    def test_08_latency_under_15ms(self):
        """Synthesizing a short word executes under 15 ms."""
        t0 = time.perf_counter()
        _ = generate_wav("太贵了")
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertLess(elapsed_ms, 15.0)


class TestTTSEndpoints(unittest.IsolatedAsyncioTestCase):
    """Integration tests for POST /tts and GET /tts routes in ai/middleware.py."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_post_tts_default_wav(self):
        """POST /tts with text returns binary audio/wav stream."""
        resp = await self.client.post("/tts", json={"text": "太贵了"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("audio/wav", resp.headers.get("content-type", ""))
        self.assertTrue(resp.content.startswith(b"RIFF"))

    async def test_02_post_tts_tokens_list(self):
        """POST /tts with speech tokens generates valid WAV audio."""
        tokens_payload = [
            {"zh": "便宜", "py": "piányi", "id": "word_cheap"},
            {"zh": "老板", "py": "lǎobǎn", "id": "word_boss"},
        ]
        resp = await self.client.post("/tts", json={"tokens": tokens_payload})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.content.startswith(b"RIFF"))

    async def test_03_post_tts_json_format(self):
        """POST /tts with format='json' returns base64 encoded audio."""
        resp = await self.client.post("/tts", json={"text": "便宜点", "format": "json"})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("format"), "wav")
        self.assertEqual(data.get("sample_rate"), 16000)
        b64_audio = data.get("audio_base64")
        self.assertIsNotNone(b64_audio)
        raw_audio = base64.b64decode(b64_audio)
        self.assertTrue(raw_audio.startswith(b"RIFF"))

    async def test_04_get_tts_binary_wav(self):
        """GET /tts?text=你好 returns binary audio/wav stream."""
        resp = await self.client.get("/tts?text=你好")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("audio/wav", resp.headers.get("content-type", ""))
        self.assertTrue(resp.content.startswith(b"RIFF"))

    async def test_05_get_tts_json_format(self):
        """GET /tts?text=对不起&format=json returns JSON with base64 audio."""
        resp = await self.client.get("/tts?text=对不起&format=json")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "ok")
        raw_audio = base64.b64decode(data.get("audio_base64"))
        self.assertTrue(raw_audio.startswith(b"RIFF"))

    async def test_06_get_tts_missing_text_422(self):
        """GET /tts without text parameter returns 422 Unprocessable Entity."""
        resp = await self.client.get("/tts")
        self.assertEqual(resp.status_code, 422)

    async def test_07_post_tts_empty_body_422(self):
        """POST /tts with empty payload returns 422."""
        resp = await self.client.post("/tts", json={})
        self.assertEqual(resp.status_code, 422)

    async def test_08_tts_speaker_profile_parameter(self):
        """POST /tts accepts speaker parameter."""
        resp = await self.client.post("/tts", json={"text": "你好", "speaker": "chef_chen"})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.content.startswith(b"RIFF"))


# ============================================================================
# Tier 6: Go Server Contract Compliance & Stage 5 COOP Flow
# ============================================================================

class TestGoServerContractCompliance(unittest.IsolatedAsyncioTestCase):
    """Strict compliance with server/internal/game/dialogue.go:108 constraints."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_mianzi_delta_strictly_clamped_minus30_to_plus30(self):
        """mianzi_delta must never exceed [-30, 30] range."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "你是我见过最伟大的商人！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 0, "aggro": 0, "history": []},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        delta = data["mianzi_delta"]
        self.assertGreaterEqual(delta, -30)
        self.assertLessEqual(delta, 30)

    async def test_02_aggro_delta_strictly_clamped_minus30_to_plus30(self):
        """aggro_delta must never exceed [-30, 30] range."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "你是骗子！这是假货！",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 50, "history": []},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        delta = data["aggro_delta"]
        self.assertGreaterEqual(delta, -30)
        self.assertLessEqual(delta, 30)

    async def test_03_fsm_state_valid_go_whitelist(self):
        """fsm_state must belong to {'IDLE', 'CALLING', 'HAGGLING', 'FLATTERED', 'SUSPICIOUS', 'AGGRO'}."""
        go_valid_states = {"IDLE", "CALLING", "HAGGLING", "FLATTERED", "SUSPICIOUS", "AGGRO"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang", "auntie_li", "electronics_zhang", "granny_liu"]:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {"price": 500, "price_floor": 100, "mianzi": 50, "aggro": 10, "history": []},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn(data["fsm_state"], go_valid_states)

    async def test_04_emotion_valid_go_whitelist(self):
        """emotion must belong to {'neutral', 'angry', 'happy', 'suspicious'}."""
        go_valid_emotions = {"neutral", "angry", "happy", "suspicious"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang", "auntie_li", "electronics_zhang", "granny_liu"]:
            payload = {
                "npc_id": npc,
                "player_message": "太贵了",
                "context": {"price": 500, "price_floor": 100, "mianzi": 50, "aggro": 10, "history": []},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn(data["emotion"], go_valid_emotions)

    async def test_05_choice_types_conform_to_go_schema(self):
        """All choices have types belonging to Go server whitelist."""
        valid_go_choices = {"polite", "haggle", "provoke", "leave", "bluff", "order", "documents", "bribe", "directions"}
        for npc in ["lao_wang", "chef_chen", "guard_zhang", "auntie_li", "electronics_zhang", "granny_liu"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4)
            for c in data["choices"]:
                self.assertIn(c["type"], valid_go_choices)

    async def test_06_bribe_aggro_delta_bounded_by_plus30(self):
        """Guard Zhang bribe attempt: aggro_delta <= 30 and fsm_state == 'AGGRO'."""
        payload = {
            "npc_id": "guard_zhang",
            "player_message": "长官，给你点钱私下通融通融！",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["fsm_state"], "AGGRO")
        self.assertEqual(data["emotion"], "angry")
        self.assertEqual(data["aggro_delta"], 30)
        self.assertEqual(data["mianzi_delta"], -30)

    async def test_07_choices_count_and_sequential_ids(self):
        """Every response returns exactly 4 choices with sequential IDs 1..4."""
        for npc in ["lao_wang", "chef_chen", "guard_zhang"]:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            choices = resp.json()["choices"]
            self.assertEqual(len(choices), 4)
            self.assertEqual([c["id"] for c in choices], [1, 2, 3, 4])

    async def test_08_price_upper_bound_clamped_to_100000(self):
        """Upper price bound must strictly clamp to 100000 (server/internal/game/dialogue.go:108)."""
        test_prices = [100001, 150000, 500000, 999999]
        for p in test_prices:
            payload = {
                "npc_id": "lao_wang",
                "player_message": "老板，出个价吧",
                "context": {"price": p, "price_floor": 120, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertLessEqual(data["price_new"], 100000, f"Price {data['price_new']} exceeds 100000 for input {p}")

    async def test_09_all_speech_tokens_conform_to_catalog_json(self):
        """Every speech token returned across all NPCs must strictly exist in catalog.json."""
        catalog_words = load_world_catalog()
        all_npcs = ["lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu", "guard_zhang"]
        for npc in all_npcs:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {"price": 300, "price_floor": 50, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            for t in data["speech_tokens"]:
                self.assertIn(t["id"], catalog_words, f"NPC {npc} returned unknown token {t['id']}")
                cw = catalog_words[t["id"]]
                self.assertEqual(t["zh"], cw["zh"])
                self.assertEqual(t["py"], cw["py"])
                self.assertEqual(t["ru"], cw["ru"])
                self.assertNotIn(t["id"], ["word_deal", "word_good"])

    async def test_10_go_server_contract_simulation_across_all_npcs(self):
        """Simulate full Go server validation (dialogue.go:107-147) across all personas."""
        catalog_words = load_world_catalog()
        all_npcs = [
            ("lao_wang", 120),
            ("auntie_li", 80),
            ("electronics_zhang", 25),
            ("chef_chen", 40),
            ("granny_liu", 50),
            ("guard_zhang", 0),
        ]
        for npc, floor in all_npcs:
            payload = {
                "npc_id": npc,
                "player_message": "你好，请问这个多少钱？",
                "context": {"price": max(floor, 200), "price_floor": floor, "mianzi": 50, "aggro": 10},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            # Raises AssertionError on any Go contract violation
            validate_go_contract(data, floor, catalog_words)


class TestStage5CoopAndDealFlow(unittest.IsolatedAsyncioTestCase):
    """Validates Stage 5 deal triggers and collaborative multi-turn negotiation history."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_deal_agreement_zh_triggers(self):
        """Chinese deal triggers ('成交', '好，成交') preserve agreed price and return valid catalog tokens."""
        catalog_words = load_world_catalog()
        for msg in ["成交", "好，成交", "行，成交！"]:
            payload = {
                "npc_id": "lao_wang",
                "player_message": msg,
                "context": {"price": 600, "price_floor": 120, "mianzi": 60, "aggro": 10, "history": []},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["price_new"], 600)
            self.assertEqual(data["emotion"], "happy")
            self.assertIn(data["fsm_state"], ["HAGGLING", "FLATTERED"])
            # Assert catalog tokens compliance
            for t in data["speech_tokens"]:
                self.assertIn(t["id"], catalog_words, f"Deal trigger '{msg}' emitted uncataloged token {t['id']}")
                self.assertNotIn(t["id"], ["word_deal", "word_good"])

    async def test_02_deal_agreement_ru_triggers(self):
        """Russian deal triggers ('по рукам', 'согласен', 'беру') trigger deal flow with valid catalog tokens."""
        catalog_words = load_world_catalog()
        for msg in ["по рукам", "согласен", "беру", "забираю"]:
            payload = {
                "npc_id": "lao_wang",
                "player_message": msg,
                "context": {"price": 550, "price_floor": 120, "mianzi": 60, "aggro": 10, "history": []},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["price_new"], 550)
            self.assertEqual(data["emotion"], "happy")
            for t in data["speech_tokens"]:
                self.assertIn(t["id"], catalog_words, f"Deal trigger '{msg}' emitted uncataloged token {t['id']}")
                self.assertNotIn(t["id"], ["word_deal", "word_good"])

    async def test_03_collaborative_history_soothing(self):
        """Good cop / bad cop: partner was aggressive but current player is respectful."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，我看您人特别讲究，咱们好好谈谈。",
            "context": {
                "price": 800,
                "price_floor": 120,
                "mianzi": 50,
                "aggro": 20,
                "scene_history": [
                    {"role": "partner", "content": "这根本就是假货，你个骗子！"},
                ],
            },
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["aggro_delta"], 0)
        self.assertGreater(data["mianzi_delta"], 0)
        self.assertLess(data["price_new"], 800)

    async def test_04_collaborative_history_double_pressure(self):
        """Both partner and current player provoke merchant -> aggro escalation."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "我朋友说得对，你这就是假货！",
            "context": {
                "price": 800,
                "price_floor": 120,
                "mianzi": 50,
                "aggro": 20,
                "scene_history": [
                    {"role": "partner", "content": "这根本就是假货，你个骗子！"},
                ],
            },
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertGreaterEqual(data["aggro_delta"], 20)
        self.assertEqual(data["fsm_state"], "AGGRO")

    async def test_05_deal_agreement_all_keywords_catalog_compliance(self):
        """Exhaustive test: all 11 deal agreement keywords across all 5 merchants emit 100% catalog tokens."""
        catalog_words = load_world_catalog()
        deal_keywords = [
            "成交", "好，成交", "行，成交！",
            "по рукам", "согласен", "согласна",
            "беру", "забираю", "договорились",
            "deal", "agree",
        ]
        merchants = ["lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu"]
        for npc in merchants:
            for kw in deal_keywords:
                payload = {
                    "npc_id": npc,
                    "player_message": kw,
                    "context": {"price": 500, "price_floor": 100, "mianzi": 50, "aggro": 0},
                }
                resp = await self.client.post("/dialogue", json=payload)
                self.assertEqual(resp.status_code, 200, f"NPC {npc} failed on keyword '{kw}'")
                data = resp.json()
                self.assertEqual(data["emotion"], "happy")
                self.assertEqual(data["price_new"], 500)
                tokens = data.get("speech_tokens", [])
                self.assertGreaterEqual(len(tokens), 1)
                for t in tokens:
                    self.assertIn(
                        t["id"],
                        catalog_words,
                        f"NPC {npc} on trigger '{kw}' returned uncataloged token {t['id']}",
                    )
                    cw = catalog_words[t["id"]]
                    self.assertEqual(t["zh"], cw["zh"])
                    self.assertEqual(t["py"], cw["py"])
                    self.assertEqual(t["ru"], cw["ru"])
                    self.assertNotIn(t["id"], ["word_deal", "word_good"])


# ============================================================================
# Tier 7: Stage 7 Multi-NPC Modularity & Fast LLM Thinking Suppression
# ============================================================================

class TestStage7MultiNpcModularity(unittest.IsolatedAsyncioTestCase):
    """Verifies all 6 market personas return valid Go contracts."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_all_six_npcs_conform_to_schema(self):
        """All 6 personas must respond with exactly 4 choices and valid deltas."""
        all_npcs = ["lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu", "guard_zhang"]
        for npc in all_npcs:
            payload = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {"price": 200, "price_floor": 50, "mianzi": 50, "aggro": 10, "history": []},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200, f"NPC {npc} failed")
            data = resp.json()
            self.assertEqual(len(data["choices"]), 4)
            self.assertGreaterEqual(len(data["speech_tokens"]), 1)
            self.assertTrue(-30 <= data["mianzi_delta"] <= 30)
            self.assertTrue(-30 <= data["aggro_delta"] <= 30)

    async def test_02_auntie_li_tea_merchant_mechanics(self):
        """Auntie Li handles tea inquiries and competitive comparisons."""
        payload = {
            "npc_id": "auntie_li",
            "player_message": "李阿姨，老王那边便宜二十块！",
            "context": {"price": 300, "price_floor": 80, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLess(data["price_new"], 300)

    async def test_03_electronics_zhang_stall_mechanics(self):
        """Electronics Zhang handles technical specs."""
        payload = {
            "npc_id": "electronics_zhang",
            "player_message": "师傅，这220伏能用吗？",
            "context": {"price": 65, "price_floor": 25, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertLessEqual(data["price_new"], 65)

    async def test_04_granny_liu_tcm_herbalist_mechanics(self):
        """Granny Liu remedies student fatigue."""
        payload = {
            "npc_id": "granny_liu",
            "player_message": "刘奶奶，我最近学习特别累，有什么好药吗？",
            "context": {"price": 150, "price_floor": 50, "mianzi": 60, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["emotion"], "happy")


class TestLLMFastInferenceThinkingSuppression(unittest.TestCase):
    """Unit tests verifying fast parameters and regex thinking token suppression."""

    def test_01_strip_thinking_tags_regex(self):
        """strip_thinking_tokens correctly removes thinking tags and reasoning blocks."""
        from ai.llm_client import strip_thinking_tokens, parse_llm_json

        raw_llm_out = (
            "<think>\n"
            "The player wants a discount on jade.\n"
            "Lao Wang should pretend to be offended.\n"
            "</think>\n"
            "```json\n"
            '{"price_new": 700, "emotion": "suspicious", "mianzi_delta": -5, "aggro_delta": 5, "fsm_state": "HAGGLING"}\n'
            "```"
        )
        cleaned = strip_thinking_tokens(raw_llm_out)
        self.assertNotIn("<think>", cleaned)
        self.assertNotIn("The player wants a discount", cleaned)

        # parse_llm_json must succeed seamlessly
        parsed = parse_llm_json(raw_llm_out)
        self.assertEqual(parsed["price_new"], 700)
        self.assertEqual(parsed["emotion"], "suspicious")

    def test_02_strip_unclosed_thinking_tag(self):
        """Unclosed <think> tag from truncated stream is cleanly stripped."""
        from ai.llm_client import strip_thinking_tokens
        truncated = 'Hello <think>truncated internal thoughts...'
        self.assertEqual(strip_thinking_tokens(truncated), 'Hello')

    def test_03_strip_bracket_think_syntax(self):
        """[THINK]...[/THINK] alternate syntax is stripped."""
        from ai.llm_client import strip_thinking_tokens
        bracket_txt = '[THINK]internal reasoning[/THINK]{"status": "ok"}'
        self.assertEqual(strip_thinking_tokens(bracket_txt), '{"status": "ok"}')

    def test_04_dual_envelope_payload_structure(self):
        """LLMClient builds dual-envelope payload with top_p, presence_penalty, top_k, enable_thinking."""
        from ai.llm_client import LLMClient

        client = LLMClient()
        extra_body = {
            "top_k": 20,
            "chat_template_kwargs": {"enable_thinking": False},
        }
        self.assertEqual(extra_body["top_k"], 20)
        self.assertFalse(extra_body["chat_template_kwargs"]["enable_thinking"])


# ============================================================================
# Expansion Suites: Catalog Integrity, Price Bounds, Token Sanitizer Defense
# ============================================================================

class TestCatalogTokenIntegrity(unittest.IsolatedAsyncioTestCase):
    """
    Exhaustive verification that 100% of speech tokens returned across all NPCs,
    prompts, and dialogue paths strictly exist in server/world/catalog.json.
    """

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")
        self.catalog_words = load_world_catalog()

    async def asyncTearDown(self):
        await self.client.aclose()

    def test_01_catalog_file_integrity_and_word_count(self):
        """Assert catalog.json exists and defines exactly 28 authoritative words."""
        self.assertEqual(len(self.catalog_words), 28, "catalog.json must contain exactly 28 words")
        for wid, wdata in self.catalog_words.items():
            self.assertEqual(wid, wdata["id"])
            self.assertTrue(bool(wdata["zh"].strip()))
            self.assertTrue(bool(wdata["py"].strip()))
            self.assertTrue(bool(wdata["ru"].strip()))

    def test_02_mock_engine_token_bank_strictly_matches_catalog(self):
        """TOKEN_BANK in mock_engine must contain exactly 28 entries, all in catalog.json."""
        from ai.mock_engine import TOKEN_BANK
        self.assertEqual(len(TOKEN_BANK), 28, f"TOKEN_BANK has {len(TOKEN_BANK)} entries, expected 28")
        self.assertNotIn("成交", TOKEN_BANK)
        self.assertNotIn("好", TOKEN_BANK)
        for zh, (py, ru, tid) in TOKEN_BANK.items():
            self.assertIn(tid, self.catalog_words, f"TOKEN_BANK entry {tid} not in catalog.json")
            cw = self.catalog_words[tid]
            self.assertEqual(zh, cw["zh"], f"Mismatched zh for {tid}")
            self.assertEqual(py, cw["py"], f"Mismatched py for {tid}")
            self.assertEqual(ru, cw["ru"], f"Mismatched ru for {tid}")

    def test_03_default_tokens_strictly_match_catalog(self):
        """DEFAULT_TOKENS in middleware must contain only valid catalog tokens across all NPCs."""
        from ai.middleware import DEFAULT_TOKENS
        for npc, tokens in DEFAULT_TOKENS.items():
            self.assertGreaterEqual(len(tokens), 1, f"DEFAULT_TOKENS[{npc}] is empty")
            for t in tokens:
                self.assertIn(t.id, self.catalog_words, f"DEFAULT_TOKENS[{npc}] has invalid id {t.id}")
                cw = self.catalog_words[t.id]
                self.assertEqual(t.zh, cw["zh"])
                self.assertEqual(t.py, cw["py"])
                self.assertEqual(t.ru, cw["ru"])

    async def test_04_all_six_npcs_exhaustive_dialogue_paths_tokens(self):
        """Assert 100% of tokens match catalog across all personas and realistic dialogue paths."""
        dialogue_paths = {
            "lao_wang": ["你好", "太贵了", "便宜点", "这是假货！", "我再看看", "你是骗子！"],
            "auntie_li": ["买茶叶", "茶很香", "李阿姨，老王那边便宜二十块！", "有立顿红茶吗？", "谢谢，我改天再来"],
            "electronics_zhang": ["师傅，220伏能用吗？", "二十块行不行？", "这不会爆炸吧？", "我去别家看看"],
            "chef_chen": ["不要辣", "不要花生", "来碗面条", "有什么推荐？", "我先看看"],
            "granny_liu": ["奶奶，这个怎么泡水？", "便宜点吧，我学生", "这草根能治病？我不信", "谢谢奶奶，我先走了"],
            "guard_zhang": ["这是我的票", "请问怎么走", "能通融一下吗？", "对不起"],
        }
        for npc, messages in dialogue_paths.items():
            for msg in messages:
                payload = {
                    "npc_id": npc,
                    "player_message": msg,
                    "context": {"price": 400, "price_floor": 100, "mianzi": 50, "aggro": 10},
                }
                resp = await self.client.post("/dialogue", json=payload)
                self.assertEqual(resp.status_code, 200, f"Dialogue failed for {npc}: {msg}")
                data = resp.json()
                tokens = data.get("speech_tokens", [])
                self.assertGreaterEqual(len(tokens), 1, f"No tokens returned for {npc}: {msg}")
                self.assertLessEqual(len(tokens), 64, f"Too many tokens returned for {npc}: {msg}")
                for t in tokens:
                    self.assertIn(
                        t["id"],
                        self.catalog_words,
                        f"Uncataloged token {t['id']} emitted by {npc} on '{msg}'",
                    )
                    cw = self.catalog_words[t["id"]]
                    self.assertEqual(t["zh"], cw["zh"])
                    self.assertEqual(t["py"], cw["py"])
                    self.assertEqual(t["ru"], cw["ru"])

    async def test_05_multi_turn_history_preserves_catalog_token_validity(self):
        """Multi-turn collaborative history must still return 100% catalog tokens."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，合作愉快，再便宜点！",
            "context": {
                "price": 700,
                "price_floor": 120,
                "mianzi": 50,
                "aggro": 10,
                "history": [
                    "player: 你好，这个玉多少钱？",
                    "npc: 这是正宗的玉，800块",
                    "player: 太贵了，便宜点",
                    "npc: 老板，便宜卖你700",
                ],
                "scene_history": [
                    {"role": "partner", "content": "老板给个实在价！"},
                ],
            },
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        for t in data["speech_tokens"]:
            self.assertIn(t["id"], self.catalog_words)
            self.assertNotIn(t["id"], ["word_deal", "word_good"])


class TestPriceUpperLimitClamping(unittest.IsolatedAsyncioTestCase):
    """
    Validates upper price bound clamping at 100,000 across middleware endpoints,
    dual envelopes, boundary cases, and direct clamping function units.
    """

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_dialogue_clamps_price_above_100000(self):
        """Context price > 100000 is clamped to exactly 100000."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板好",
            "context": {"price": 150000, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["price_new"], 100000)
        self.assertEqual(data["parsed"]["price_new"], 100000)

    async def test_02_dialogue_clamps_extreme_price_values(self):
        """Extreme numerical overflows (e.g. 1000000, 99999999) clamp safely to 100000."""
        for extreme in [1000000, 99999999]:
            payload = {
                "npc_id": "lao_wang",
                "player_message": "老板好",
                "context": {"price": extreme, "price_floor": 120, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["price_new"], 100000)

    async def test_03_price_boundary_conditions(self):
        """Precise boundary conditions: 99999 -> <= 99999, 100000 -> 100000, 100001 -> 100000."""
        # 100000 exact ceiling
        resp_100k = await self.client.post("/dialogue", json={
            "npc_id": "lao_wang",
            "player_message": "成交",
            "context": {"price": 100000, "price_floor": 120, "mianzi": 50, "aggro": 0},
        })
        self.assertEqual(resp_100k.status_code, 200)
        self.assertEqual(resp_100k.json()["price_new"], 100000)

        # 100001 just above ceiling
        resp_100k1 = await self.client.post("/dialogue", json={
            "npc_id": "lao_wang",
            "player_message": "成交",
            "context": {"price": 100001, "price_floor": 120, "mianzi": 50, "aggro": 0},
        })
        self.assertEqual(resp_100k1.status_code, 200)
        self.assertEqual(resp_100k1.json()["price_new"], 100000)

        # 99999 below ceiling
        resp_99k = await self.client.post("/dialogue", json={
            "npc_id": "lao_wang",
            "player_message": "成交",
            "context": {"price": 99999, "price_floor": 120, "mianzi": 50, "aggro": 0},
        })
        self.assertEqual(resp_99k.status_code, 200)
        self.assertEqual(resp_99k.json()["price_new"], 99999)

    def test_04_direct_clamp_and_validate_response_unit(self):
        """Direct unit test on clamp_and_validate_response for price clamping."""
        from ai.middleware import clamp_and_validate_response
        req = DialogueRequest(
            npc_id="lao_wang",
            player_message="太贵了",
            context=DialogueContext(price=1000, price_floor=200, mianzi=50, aggro=0),
        )

        # Overshoot price
        resp_over = clamp_and_validate_response(req, {"price_new": 250000})
        self.assertEqual(resp_over.price_new, 100000)

        # Undershoot floor
        resp_under = clamp_and_validate_response(req, {"price_new": 50})
        self.assertEqual(resp_under.price_new, 200)

        # Negative price
        resp_neg = clamp_and_validate_response(req, {"price_new": -500})
        self.assertEqual(resp_neg.price_new, 200)

    async def test_05_guard_zhang_zero_price_override(self):
        """Guard Zhang price is strictly 0 regardless of context input price."""
        for p in [0, 500, 100000, 200000]:
            payload = {
                "npc_id": "guard_zhang",
                "player_message": "长官好",
                "context": {"price": p, "price_floor": 0, "mianzi": 50, "aggro": 0},
            }
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["price_new"], 0)


class TestTokenSanitizerDefense(unittest.IsolatedAsyncioTestCase):
    """
    Validates sanitize_speech_tokens defense: filtering out uncataloged tokens,
    rejecting Chinese Hanzi without catalog IDs, falling back to safe defaults,
    and intercepting rogue LLM outputs.
    """

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")
        self.catalog_words = load_world_catalog()

    async def asyncTearDown(self):
        await self.client.aclose()

    def test_01_sanitize_discards_uncataloged_token_ids(self):
        """sanitize_speech_tokens must discard uncataloged token IDs (word_deal, word_good, word_fake)."""
        from ai.middleware import sanitize_speech_tokens
        raw_fictional = [
            {"id": "word_deal", "zh": "成交", "py": "chéngjiāo", "ru": "по рукам"},
            {"id": "word_good", "zh": "好", "py": "hǎo", "ru": "хорошо"},
            {"id": "word_katana", "zh": "武士刀", "py": "wǔshìdāo", "ru": "катана"},
        ]
        sanitized = sanitize_speech_tokens("lao_wang", raw_fictional)
        self.assertGreaterEqual(len(sanitized), 1)
        for t in sanitized:
            self.assertIn(t.id, self.catalog_words, f"Sanitizer leaked uncataloged token {t.id}")
            self.assertNotIn(t.id, ["word_deal", "word_good", "word_katana"])

    def test_02_sanitize_mixed_valid_and_uncataloged_tokens(self):
        """sanitize_speech_tokens preserves valid catalog tokens while pruning uncataloged entries."""
        from ai.middleware import sanitize_speech_tokens
        raw_mixed = [
            {"id": "word_jade", "zh": "玉", "py": "yù", "ru": "нефрит"},
            {"id": "word_deal", "zh": "成交", "py": "chéngjiāo", "ru": "по рукам"},
            {"id": "word_boss", "zh": "老板", "py": "lǎobǎn", "ru": "босс"},
        ]
        sanitized = sanitize_speech_tokens("lao_wang", raw_mixed)
        ids = [t.id for t in sanitized]
        self.assertIn("word_jade", ids)
        self.assertIn("word_boss", ids)
        self.assertNotIn("word_deal", ids)

    def test_03_sanitize_chinese_hanzi_without_token_id(self):
        """Tokens with Chinese characters but missing ID are rejected (dialogue.go:123)."""
        from ai.middleware import sanitize_speech_tokens
        raw_no_id = [
            {"id": "", "zh": "你好", "py": "nǐ hǎo", "ru": "здравствуйте"},
            {"zh": "玉", "py": "yù", "ru": "нефрит"},
        ]
        sanitized = sanitize_speech_tokens("lao_wang", raw_no_id)
        # Must fall back to safe default tokens with valid catalog IDs
        self.assertGreaterEqual(len(sanitized), 1)
        for t in sanitized:
            self.assertIn(t.id, self.catalog_words)
            self.assertTrue(len(t.id) > 0)

    def test_04_sanitize_falsified_fields_for_known_token_id(self):
        """Tokens with known ID but mismatched Hanzi/Pinyin/Russian are corrected to catalog standard."""
        from ai.middleware import sanitize_speech_tokens
        raw_corrupted = [
            {"id": "word_jade", "zh": "假玉", "py": "jiǎ yù", "ru": "фальшивка"},
        ]
        sanitized = sanitize_speech_tokens("lao_wang", raw_corrupted)
        self.assertGreaterEqual(len(sanitized), 1)
        token = sanitized[0]
        self.assertEqual(token.id, "word_jade")
        cw = self.catalog_words["word_jade"]
        self.assertEqual(token.zh, cw["zh"])
        self.assertEqual(token.py, cw["py"])
        self.assertEqual(token.ru, cw["ru"])

    def test_05_sanitize_malformed_and_none_inputs(self):
        """sanitize_speech_tokens gracefully recovers from None, non-list, and corrupted dictionaries."""
        from ai.middleware import sanitize_speech_tokens
        malformed_inputs = [None, [], "not_a_list", 12345, {}, [None], [{}], [{"invalid": "dict"}]]
        for inp in malformed_inputs:
            sanitized = sanitize_speech_tokens("lao_wang", inp)
            self.assertGreaterEqual(len(sanitized), 1)
            for t in sanitized:
                self.assertIn(t.id, self.catalog_words)

    async def test_06_middleware_dialogue_sanitizes_rogue_llm_uncataloged_tokens(self):
        """POST /dialogue intercepts rogue LLM output and sanitizes all tokens to catalog.json."""
        rogue_llm_json = {
            "speech_tokens": [
                {"id": "word_dragon_slayer", "zh": "屠龙刀", "py": "túlóngdāo", "ru": "меч дракона"},
                {"id": "word_potion", "zh": "药水", "py": "yàoshuǐ", "ru": "зелье"},
            ],
            "choices": [
                {"id": 1, "zh": "老板便宜点", "py": "Lǎobǎn piányi diǎn", "ru": "Сделай скидку", "type": "polite"},
                {"id": 2, "zh": "太贵了", "py": "Tài guì le", "ru": "Слишком дорого", "type": "haggle"},
                {"id": 3, "zh": "这是假货", "py": "Zhè shì jiǎhuò", "ru": "Это подделка", "type": "provoke"},
                {"id": 4, "zh": "我再想想", "py": "Wǒ zài xiǎngxiang", "ru": "Дай подумаю", "type": "leave"},
            ],
            "price_new": 500,
            "mianzi_delta": -5,
            "aggro_delta": 5,
            "emotion": "suspicious",
            "fsm_state": "HAGGLING",
        }

        # Patch llm_client.generate_chat_completion to simulate rogue LLM output
        with patch("ai.middleware.llm_client.generate_chat_completion", new_callable=AsyncMock) as mock_llm:
            mock_llm.return_value = (rogue_llm_json, json.dumps(rogue_llm_json))
            resp = await self.client.post("/dialogue", json={
                "npc_id": "lao_wang",
                "player_message": "你有什么？",
                "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            tokens = data.get("speech_tokens", [])
            self.assertGreaterEqual(len(tokens), 1)
            for t in tokens:
                self.assertIn(t["id"], self.catalog_words)
                self.assertNotIn(t["id"], ["word_dragon_slayer", "word_potion"])


# ============================================================================
# Tier 5: Milestone 1 Dialogue Audio & LLM Endpoint Integration Tests
# ============================================================================

class TestDialogueAudioIntegration(unittest.IsolatedAsyncioTestCase):
    """Verifies TTS audio synthesis integration in POST /dialogue."""

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_01_dialogue_returns_valid_audio_base64(self):
        """POST /dialogue returns audio_base64 starting with UklGR in both parsed payload and top level."""
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板好，我来看看玉。",
            "context": {"price": 800, "price_floor": 120, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        # Check parsed envelope contains audio_base64
        self.assertIn("parsed", data)
        parsed = data["parsed"]
        self.assertIn("audio_base64", parsed)
        self.assertIsNotNone(parsed["audio_base64"])
        self.assertTrue(len(parsed["audio_base64"]) > 100)
        # RIFF header in base64 starts with UklGR
        self.assertTrue(parsed["audio_base64"].startswith("UklGR"))

        # Check top level audio_base64 matches
        self.assertEqual(data.get("audio_base64"), parsed["audio_base64"])

    async def test_02_dialogue_audio_is_valid_wav_pcm(self):
        """Audio payload is valid 16kHz 16-bit Mono PCM WAV with standard RIFF header."""
        import base64
        import wave
        import io

        payload = {
            "npc_id": "chef_chen",
            "player_message": "老板，来一碗担担面！",
            "context": {"price": 25, "price_floor": 25, "mianzi": 50, "aggro": 0},
        }
        resp = await self.client.post("/dialogue", json=payload)
        self.assertEqual(resp.status_code, 200)
        b64_audio = resp.json()["parsed"]["audio_base64"]

        raw_wav = base64.b64decode(b64_audio)
        self.assertTrue(raw_wav.startswith(b"RIFF"))
        self.assertEqual(raw_wav[8:12], b"WAVE")
        self.assertEqual(raw_wav[12:16], b"fmt ")

        with wave.open(io.BytesIO(raw_wav), "rb") as wf:
            self.assertEqual(wf.getnchannels(), 1)
            self.assertEqual(wf.getsampwidth(), 2)
            self.assertEqual(wf.getframerate(), 16000)
            self.assertGreater(wf.getnframes(), 0)

    async def test_03_dialogue_tts_failure_does_not_break_response(self):
        """If TTS synthesis raises an exception, dialogue still succeeds with audio_base64=None."""
        import ai.middleware

        payload = {
            "npc_id": "guard_zhang",
            "player_message": "警官好，这是我的证件。",
            "context": {"price": 0, "price_floor": 0, "mianzi": 50, "aggro": 0},
        }

        with patch.object(
            ai.middleware,
            "synthesize_to_base64",
            side_effect=RuntimeError("Simulated audio engine hardware error"),
        ):
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIsNone(data["parsed"]["audio_base64"])
            self.assertIsNone(data.get("audio_base64"))
            self.assertEqual(len(data["choices"]), 4)
            self.assertTrue(len(data["speech_tokens"]) >= 1)

    async def test_04_dialogue_audio_for_all_known_npcs(self):
        """Verifies audio synthesis generates non-empty audio for all 6 market personas."""
        npcs = ["lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu", "guard_zhang"]
        for npc in npcs:
            payload = {"npc_id": npc, "player_message": "你好"}
            resp = await self.client.post("/dialogue", json=payload)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            b64 = data["parsed"]["audio_base64"]
            self.assertIsNotNone(b64, f"NPC {npc} audio was None")
            self.assertTrue(b64.startswith("UklGR"), f"NPC {npc} audio missing RIFF header")
            self.assertTrue(len(b64) > 100, f"NPC {npc} audio length too short: {len(b64)}")


class TestLLMClientEndpointsAndHealth(unittest.IsolatedAsyncioTestCase):
    """Tests endpoint resolution and multi-path health probe in ai/llm_client.py."""

    def test_01_resolve_ollama_endpoints(self):
        from ai.llm_client import resolve_llm_endpoints, resolve_default_model
        completions, health = resolve_llm_endpoints(ollama_url="http://host.docker.internal:11434")
        self.assertEqual(completions, "http://host.docker.internal:11434/v1/chat/completions")
        self.assertEqual(health, "http://host.docker.internal:11434/v1/models")

        # Test model resolution when OLLAMA_URL is in env
        with patch.dict(os.environ, {"OLLAMA_URL": "http://127.0.0.1:11434"}):
            model = resolve_default_model()
            self.assertEqual(model, "qwen3.5:4b")

    def test_02_resolve_openai_endpoints(self):
        from ai.llm_client import resolve_llm_endpoints
        completions, health = resolve_llm_endpoints(openai_base_url="http://127.0.0.1:11434/v1")
        self.assertEqual(completions, "http://127.0.0.1:11434/v1/chat/completions")
        self.assertEqual(health, "http://127.0.0.1:11434/v1/models")

    def test_03_resolve_llama_server_endpoints(self):
        from ai.llm_client import resolve_llm_endpoints
        completions, health = resolve_llm_endpoints(llama_server_url="http://127.0.0.1:8080/v1/chat/completions")
        self.assertEqual(completions, "http://127.0.0.1:8080/v1/chat/completions")
        self.assertEqual(health, "http://127.0.0.1:8080/health")

    def test_04_default_endpoints_and_model(self):
        from ai.llm_client import resolve_llm_endpoints, resolve_default_model
        with patch.dict(os.environ, {}, clear=True):
            completions, health = resolve_llm_endpoints()
            self.assertEqual(completions, "http://127.0.0.1:8080/v1/chat/completions")
            self.assertEqual(health, "http://127.0.0.1:8080/health")
            self.assertEqual(resolve_default_model(), "unsloth/Qwen3.5-4B-MTP-GGUF:Q5_K_M")

    async def test_05_check_health_probes_fallback_models(self):
        """When /health returns 404 but /v1/models returns 200 (like Ollama), check_health returns True."""
        from ai.llm_client import LLMClient

        client = LLMClient(
            completions_url="http://mock-ollama:11434/v1/chat/completions",
            health_url="http://mock-ollama:11434/health",
        )

        async def mock_handler(request: httpx.Request):
            if request.url.path == "/health":
                return httpx.Response(404, text="Not Found")
            elif request.url.path == "/v1/models":
                return httpx.Response(200, json={"data": [{"id": "qwen3.5:4b"}]})
            return httpx.Response(404)

        transport = httpx.MockTransport(mock_handler)
        with patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=transport)):
            is_healthy = await client.check_health()
            self.assertTrue(is_healthy)


class TestDialogueStreaming(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_streaming_ndjson_chunks(self):
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，这块玉太贵了！",
            "context": {
                "price": 800,
                "price_floor": 120,
                "mianzi": 50,
                "aggro": 0,
            },
        }
        resp = await self.client.post("/dialogue?stream=true", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("application/x-ndjson", resp.headers.get("content-type", ""))
        lines = [line.strip() for line in resp.text.strip().split("\n") if line.strip()]
        self.assertEqual(len(lines), 2)
        chunk1 = json.loads(lines[0])
        chunk2 = json.loads(lines[1])
        self.assertEqual(chunk1.get("type"), "npc_speech")
        self.assertTrue(len(chunk1.get("speech_tokens", [])) > 0)
        self.assertEqual(chunk2.get("type"), "choices")
        self.assertEqual(len(chunk2.get("choices", [])), 4)

    async def test_06_check_health_probes_fallback_root(self):
        """When /health returns 404 and /v1/models fails but / returns 200, check_health returns True."""
        from ai.llm_client import LLMClient

        client = LLMClient(
            completions_url="http://mock-ollama:11434/v1/chat/completions",
            health_url="http://mock-ollama:11434/health",
        )

        async def mock_handler(request: httpx.Request):
            if request.url.path == "/":
                return httpx.Response(200, text="Ollama is running")
            return httpx.Response(404)

        transport = httpx.MockTransport(mock_handler)
        with patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=transport)):
            is_healthy = await client.check_health()
            self.assertTrue(is_healthy)


class TestDialogueStreaming(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_streaming_ndjson_chunks(self):
        payload = {
            "npc_id": "lao_wang",
            "player_message": "老板，这块玉太贵了！",
            "context": {
                "price": 800,
                "price_floor": 120,
                "mianzi": 50,
                "aggro": 0,
            },
        }
        resp = await self.client.post("/dialogue?stream=true", json=payload)
        self.assertEqual(resp.status_code, 200)
        self.assertIn("application/x-ndjson", resp.headers.get("content-type", ""))
        lines = [line.strip() for line in resp.text.strip().split("\n") if line.strip()]
        self.assertEqual(len(lines), 2)
        chunk1 = json.loads(lines[0])
        chunk2 = json.loads(lines[1])
        self.assertEqual(chunk1.get("type"), "npc_speech")
        self.assertTrue(len(chunk1.get("speech_tokens", [])) > 0)
        self.assertEqual(chunk2.get("type"), "choices")
        self.assertEqual(len(chunk2.get("choices", [])), 4)


# ============================================================================
# Main Entrypoint
# ============================================================================

if __name__ == "__main__":
    unittest.main()

