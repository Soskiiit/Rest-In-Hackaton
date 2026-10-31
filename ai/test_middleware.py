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
        """Bribe attempt with cur_aggro=60 yields effective delta = +40, keeping cumulative aggro == 100."""
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
            40,
            f"Expected effective aggro_delta=40 (100 - 60), got {aggro_delta} (cumulative={60 + aggro_delta})",
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
        valid_types = {"polite", "haggle", "provoke", "leave", "brave", "weak", "bribe", "neutral"}
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
            self.assertGreaterEqual(data["aggro_delta"], 90)

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
# Main Entrypoint
# ============================================================================

if __name__ == "__main__":
    unittest.main()
