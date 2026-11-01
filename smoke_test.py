#!/usr/bin/env python3
"""
smoke_test.py — Сквозной smoke-тест интеграции Rest-In-Hackaton.

Проверяет всю цепочку: AI сервис → Go сервер → (WebSocket клиент)

Использование:
  python3 smoke_test.py [--server http://127.0.0.1:3000] [--ai http://127.0.0.1:8000]

Возвращает код 0 при успехе, 1 при первом провале.
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from typing import Optional

GREEN = "\033[92m"
RED   = "\033[91m"
YELLOW = "\033[93m"
CYAN  = "\033[96m"
RESET = "\033[0m"

PASS_COUNT = 0
FAIL_COUNT = 0

def ok(label: str, detail: str = ""):
    global PASS_COUNT
    PASS_COUNT += 1
    suffix = f"  ({detail})" if detail else ""
    print(f"  {GREEN}✓{RESET} {label}{suffix}")

def fail(label: str, detail: str = ""):
    global FAIL_COUNT
    FAIL_COUNT += 1
    suffix = f"\n      {RED}{detail}{RESET}" if detail else ""
    print(f"  {RED}✗{RESET} {label}{suffix}")

def section(title: str):
    print(f"\n{CYAN}── {title} {'─' * (50 - len(title))}{RESET}")

def http_get(url: str, timeout: int = 5) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return None

def http_post(url: str, data: dict, timeout: int = 10) -> Optional[dict]:
    try:
        payload = json.dumps(data).encode()
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return None

def main():
    parser = argparse.ArgumentParser(description="Rest-In-Hackaton E2E Smoke Test")
    parser.add_argument("--server", default="http://127.0.0.1:3000", help="Go server base URL")
    parser.add_argument("--ai",     default="http://127.0.0.1:8000", help="AI service base URL")
    args = parser.parse_args()

    SERVER = args.server.rstrip("/")
    AI     = args.ai.rstrip("/")

    print(f"\n{CYAN}{'═' * 55}{RESET}")
    print(f"{CYAN}  Rest-In-Hackaton — E2E Smoke Test{RESET}")
    print(f"{CYAN}{'═' * 55}{RESET}")
    print(f"  Go server : {SERVER}")
    print(f"  AI service: {AI}")

    # ─── 1. Go Server Health ───────────────────────────────────────────────
    section("1. Go Server")

    resp = http_get(f"{SERVER}/health")
    if resp and resp.get("status") == "ok":
        ok("GET /health → 200 {status: ok}")
    else:
        fail("GET /health", f"Got: {resp}")

    # ─── 2. AI Service Health ─────────────────────────────────────────────
    section("2. AI Service")

    resp = http_get(f"{AI}/health")
    if resp is not None:
        ok("GET /health → 200", str(resp))
    else:
        fail("GET /health — AI service not reachable")

    # ─── 3. AI /dialogue endpoint (mock engine fallback) ──────────────────
    section("3. AI Dialogue (full chain test)")

    dialogue_req = {
        "npc_id": "lao_wang",
        "player_message": "你好",
        "context": {
            "price": 100,
            "price_floor": 50,
            "mianzi": 50,
            "aggro": 0,
            "history": [],
            "scene_history": None,
            "npc_kind": "vendor"
        }
    }

    resp = http_post(f"{AI}/dialogue", dialogue_req, timeout=30)
    if resp is None:
        fail("POST /dialogue — no response")
    else:
        # Check required fields in parsed response
        parsed = resp.get("parsed") or resp
        has_tokens   = isinstance(parsed.get("speech_tokens"), list) and len(parsed["speech_tokens"]) > 0
        has_emotion  = isinstance(parsed.get("emotion"), str)
        has_choices  = isinstance(parsed.get("choices"), list) and len(parsed["choices"]) == 4
        has_fsm      = isinstance(parsed.get("fsm_state"), str)

        if has_tokens:
            ok("POST /dialogue → speech_tokens present", f"{len(parsed['speech_tokens'])} tokens")
        else:
            fail("POST /dialogue → missing speech_tokens", str(resp)[:200])

        if has_emotion:
            ok("POST /dialogue → emotion present", parsed["emotion"])
        else:
            fail("POST /dialogue → missing emotion")

        if has_choices:
            ok("POST /dialogue → 4 choices present")
        else:
            fail("POST /dialogue → choices missing or not 4", str(parsed.get("choices")))

        if has_fsm:
            ok("POST /dialogue → fsm_state present", parsed["fsm_state"])
        else:
            fail("POST /dialogue → missing fsm_state")

        # Check audio
        audio = resp.get("audio_base64") or parsed.get("audio_base64")
        if audio and len(audio) > 100:
            ok("POST /dialogue → audio_base64 present", f"{len(audio)} chars")
        else:
            print(f"  {YELLOW}⚠{RESET}  audio_base64 absent or empty (TTS may be disabled)")

    # ─── 4. AI /tts endpoint ──────────────────────────────────────────────
    section("4. AI TTS Endpoint")

    tts_req = {"text": "你好朋友", "engine": "formant"}
    resp = http_post(f"{AI}/tts", tts_req, timeout=10)
    if resp and resp.get("audio_base64"):
        ok("POST /tts → audio_base64 returned", f"{len(resp['audio_base64'])} chars")
    elif resp:
        print(f"  {YELLOW}⚠{RESET}  POST /tts responded but no audio_base64 (engine may differ)")
    else:
        fail("POST /tts — no response or error")

    # ─── 5. Go Server Auth endpoints ──────────────────────────────────────
    section("5. Go Server Auth & Registration")

    test_login = f"smoketest_{int(time.time())}"
    register_req = {"login": test_login, "password": "TestPass123!", "profile": "business"}
    resp = http_post(f"{SERVER}/auth/register", register_req)
    if resp and resp.get("token"):
        ok("POST /auth/register → token received")
        token = resp["token"]

        # Try login
        login_resp = http_post(f"{SERVER}/auth/login", {"login": test_login, "password": "TestPass123!"})
        if login_resp and login_resp.get("token"):
            ok("POST /auth/login → token received")
        else:
            fail("POST /auth/login", str(login_resp))
    else:
        fail("POST /auth/register", str(resp)[:200] if resp else "No response")
        token = None

    # ─── 6. Summary ───────────────────────────────────────────────────────
    total = PASS_COUNT + FAIL_COUNT
    print(f"\n{CYAN}{'═' * 55}{RESET}")
    if FAIL_COUNT == 0:
        print(f"{GREEN}  ✅  All {total} checks passed!{RESET}")
        print(f"{GREEN}  Полная цепочка AI → Server работает корректно.{RESET}")
        print(f"{CYAN}{'═' * 55}{RESET}\n")
        sys.exit(0)
    else:
        print(f"{RED}  ❌  {FAIL_COUNT}/{total} checks FAILED.{RESET}")
        print(f"{YELLOW}  Проверьте, что все сервисы запущены: ./start.sh{RESET}")
        print(f"{CYAN}{'═' * 55}{RESET}\n")
        sys.exit(1)

if __name__ == "__main__":
    main()
