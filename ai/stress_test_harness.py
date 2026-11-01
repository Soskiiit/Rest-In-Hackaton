"""
ai/stress_test_harness.py
Empirical stress test harness for AI service /dialogue endpoint and audio synthesis.
Evaluates:
1. Prompt-specified NPCs (lao_wang, chef_chen, guard_zhang, clothier_liu, apothecary_ba, pawn_zhao)
2. Canonical system NPCs (lao_wang, auntie_li, electronics_zhang, chef_chen, granny_liu, guard_zhang)
3. WAV PCM byte-level decoding and audio format compliance (RIFF/WAVE, 16kHz, 16-bit mono)
4. 50 concurrent requests latency under various engine configurations
5. TTS exception resilience and graceful fallback (HTTP 200, audio_base64: null, tokens intact)
"""

import asyncio
import base64
import io
import json
import os
import sys
import time
import wave
from unittest.mock import patch
from typing import Any, Dict, List, Tuple

import httpx

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ai.middleware import app
import ai.middleware


async def run_npc_eval(npcs: List[str], engine_label: str) -> Dict[str, Any]:
    """Tests /dialogue across a list of NPC identifiers."""
    results = {}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=30.0) as ac:
        for npc in npcs:
            req_body = {
                "npc_id": npc,
                "player_message": "你好",
                "context": {
                    "price": 800,
                    "price_floor": 120,
                    "mianzi": 50,
                    "aggro": 0,
                    "history": [],
                    "scene_history": [],
                    "npc_kind": "merchant",
                },
            }
            t0 = time.perf_counter()
            resp = await ac.post("/dialogue", json=req_body)
            elapsed_ms = (time.perf_counter() - t0) * 1000

            res = {
                "status_code": resp.status_code,
                "elapsed_ms": round(elapsed_ms, 2),
                "is_200": resp.status_code == 200,
                "is_500": resp.status_code == 500,
            }

            if resp.status_code == 200:
                data = resp.json()
                root_audio = data.get("audio_base64")
                parsed_audio = data.get("parsed", {}).get("audio_base64") if isinstance(data.get("parsed"), dict) else None
                res["has_root_audio"] = root_audio is not None
                res["has_parsed_audio"] = parsed_audio is not None
                res["audio_match"] = (root_audio == parsed_audio) if (root_audio and parsed_audio) else False

                if root_audio:
                    try:
                        raw_bytes = base64.b64decode(root_audio)
                        is_riff = raw_bytes.startswith(b"RIFF")
                        is_wave = raw_bytes[8:12] == b"WAVE"
                        with wave.open(io.BytesIO(raw_bytes), "rb") as wf:
                            nchannels = wf.getnchannels()
                            sampwidth = wf.getsampwidth()
                            framerate = wf.getframerate()
                            nframes = wf.getnframes()
                            duration = round(nframes / framerate, 3)
                        res["wav_valid"] = is_riff and is_wave and (nchannels == 1) and (sampwidth == 2) and (framerate == 16000)
                        res["wav_info"] = {
                            "riff": is_riff,
                            "wave": is_wave,
                            "channels": nchannels,
                            "bit_depth": sampwidth * 8,
                            "sample_rate": framerate,
                            "duration_sec": duration,
                            "byte_length": len(raw_bytes),
                        }
                    except Exception as exc:
                        res["wav_valid"] = False
                        res["wav_error"] = str(exc)
                else:
                    res["wav_valid"] = False
                res["tokens_count"] = len(data.get("speech_tokens", []))
            else:
                res["error_detail"] = resp.text

            results[npc] = res
    return results


async def run_concurrency_benchmark(
    concurrency: int = 50,
    forced_mock_mode: bool = False,
    tts_engine: str = "kokoro",
) -> Dict[str, Any]:
    """Runs concurrent benchmark against /dialogue."""
    old_engine = os.environ.get("TTS_ENGINE")
    old_mock = os.environ.get("MOCK_MODE")
    old_middleware_mock = ai.middleware.MOCK_MODE_ENV

    try:
        os.environ["TTS_ENGINE"] = tts_engine
        if forced_mock_mode:
            os.environ["MOCK_MODE"] = "true"
            ai.middleware.MOCK_MODE_ENV = True
        else:
            os.environ.pop("MOCK_MODE", None)
            ai.middleware.MOCK_MODE_ENV = False

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            timeout=60.0,
        ) as ac:
            req_body = {
                "npc_id": "lao_wang",
                "player_message": "老板，便宜点",
                "context": {
                    "price": 800,
                    "price_floor": 120,
                    "mianzi": 50,
                    "aggro": 0,
                    "history": [],
                    "scene_history": [],
                    "npc_kind": "merchant",
                },
            }

            async def single_req():
                t0 = time.perf_counter()
                resp = await ac.post("/dialogue", json=req_body)
                elapsed = (time.perf_counter() - t0) * 1000
                return resp.status_code, elapsed

            wall_start = time.perf_counter()
            tasks = [single_req() for _ in range(concurrency)]
            responses = await asyncio.gather(*tasks)
            wall_elapsed = (time.perf_counter() - wall_start) * 1000

            durations = [r[1] for r in responses]
            statuses = [r[0] for r in responses]
            durations.sort()

            avg_lat = sum(durations) / len(durations)
            p50_lat = durations[int(len(durations) * 0.50)]
            p95_lat = durations[int(len(durations) * 0.95)]
            p99_lat = durations[int(len(durations) * 0.99)]
            min_lat = min(durations)
            max_lat = max(durations)

            return {
                "concurrency": concurrency,
                "tts_engine": tts_engine,
                "forced_mock_mode": forced_mock_mode,
                "count": len(durations),
                "status_200_count": statuses.count(200),
                "status_other_count": len(statuses) - statuses.count(200),
                "avg_ms": round(avg_lat, 2),
                "min_ms": round(min_lat, 2),
                "max_ms": round(max_lat, 2),
                "p50_ms": round(p50_lat, 2),
                "p95_ms": round(p95_lat, 2),
                "p99_ms": round(p99_lat, 2),
                "wall_ms": round(wall_elapsed, 2),
                "pass_lt_20ms": avg_lat < 20.0,
            }
    finally:
        if old_engine is not None:
            os.environ["TTS_ENGINE"] = old_engine
        else:
            os.environ.pop("TTS_ENGINE", None)
        if old_mock is not None:
            os.environ["MOCK_MODE"] = old_mock
        else:
            os.environ.pop("MOCK_MODE", None)
        ai.middleware.MOCK_MODE_ENV = old_middleware_mock


async def run_resilience_test() -> Dict[str, Any]:
    """Tests resilience when synthesize_to_base64 throws an exception."""
    with patch("ai.middleware.synthesize_to_base64", side_effect=RuntimeError("Simulated neural TTS audio failure")):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            timeout=10.0,
        ) as ac:
            req_body = {
                "npc_id": "lao_wang",
                "player_message": "你好",
                "context": {
                    "price": 800,
                    "price_floor": 120,
                    "mianzi": 50,
                    "aggro": 0,
                    "history": [],
                    "scene_history": [],
                    "npc_kind": "merchant",
                },
            }
            resp = await ac.post("/dialogue", json=req_body)
            status = resp.status_code
            if status == 200:
                data = resp.json()
                root_audio = data.get("audio_base64")
                parsed = data.get("parsed", {})
                parsed_audio = parsed.get("audio_base64") if isinstance(parsed, dict) else "NOT_DICT"
                tokens = data.get("speech_tokens", [])
                passed = (root_audio is None) and (parsed_audio is None) and (len(tokens) > 0)
                return {
                    "status_code": status,
                    "root_audio_null": root_audio is None,
                    "parsed_audio_null": parsed_audio is None,
                    "tokens_intact": len(tokens) > 0,
                    "tokens_count": len(tokens),
                    "passed": passed,
                }
            else:
                return {
                    "status_code": status,
                    "passed": False,
                    "detail": resp.text,
                }


async def main():
    print("=" * 70)
    print("EMIRICAL ADVERSARIAL STRESS HARNESS — AI SERVICE /dialogue & TTS")
    print("=" * 70)

    # 1. Prompt-specified NPCs
    prompt_npcs = ["lao_wang", "chef_chen", "guard_zhang", "clothier_liu", "apothecary_ba", "pawn_zhao"]
    print("\n--- 1. Evaluating Prompt-Specified 6 NPCs ---")
    prompt_results = await run_npc_eval(prompt_npcs, "default")
    for npc, res in prompt_results.items():
        print(f"[{npc}] HTTP {res['status_code']} | 200: {res['is_200']} | Elapsed: {res['elapsed_ms']}ms")
        if not res["is_200"]:
            print(f"       Error: {res.get('error_detail')}")

    # 2. Canonical middleware NPCs
    canonical_npcs = ["lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu", "guard_zhang"]
    print("\n--- 2. Evaluating Canonical System 6 NPCs ---")
    canonical_results = await run_npc_eval(canonical_npcs, "default")
    for npc, res in canonical_results.items():
        print(f"[{npc}] HTTP {res['status_code']} | Root audio: {res.get('has_root_audio')} | Parsed audio: {res.get('has_parsed_audio')} | Audio match: {res.get('audio_match')} | WAV valid: {res.get('wav_valid')}")
        if res.get("wav_info"):
            w = res["wav_info"]
            print(f"       WAV Info: {w['sample_rate']}Hz, {w['bit_depth']}-bit, ch={w['channels']}, dur={w['duration_sec']}s, bytes={w['byte_length']}")

    # 3. Formant synthesis WAV check
    print("\n--- 3. Evaluating Canonical 6 NPCs with Formant Engine ---")
    os.environ["TTS_ENGINE"] = "formant"
    formant_results = await run_npc_eval(canonical_npcs, "formant")
    os.environ.pop("TTS_ENGINE", None)
    for npc, res in formant_results.items():
        print(f"[{npc}] HTTP {res['status_code']} | Formant WAV valid: {res.get('wav_valid')} | dur={res.get('wav_info', {}).get('duration_sec')}s | bytes={res.get('wav_info', {}).get('byte_length')}")

    # 4. Resilience Test
    print("\n--- 4. TTS Exception Resilience Test ---")
    resilience_res = await run_resilience_test()
    print(f"Resilience Result: passed={resilience_res['passed']}, status={resilience_res['status_code']}, root_null={resilience_res.get('root_audio_null')}, parsed_null={resilience_res.get('parsed_audio_null')}, tokens={resilience_res.get('tokens_count')}")

    # 5. Concurrency Benchmarks
    print("\n--- 5. Concurrency Benchmarks (50 concurrent requests) ---")

    print("[Benchmark A: Default engine (Kokoro neural ONNX, upstream down)]")
    bench_kokoro = await run_concurrency_benchmark(50, forced_mock_mode=False, tts_engine="kokoro")
    print(f"Results: avg={bench_kokoro['avg_ms']}ms, p50={bench_kokoro['p50_ms']}ms, p95={bench_kokoro['p95_ms']}ms, wall={bench_kokoro['wall_ms']}ms | <20ms: {bench_kokoro['pass_lt_20ms']}")

    print("\n[Benchmark B: Formant engine, upstream down (connect attempt per req)]")
    bench_formant_probe = await run_concurrency_benchmark(50, forced_mock_mode=False, tts_engine="formant")
    print(f"Results: avg={bench_formant_probe['avg_ms']}ms, p50={bench_formant_probe['p50_ms']}ms, p95={bench_formant_probe['p95_ms']}ms, wall={bench_formant_probe['wall_ms']}ms | <20ms: {bench_formant_probe['pass_lt_20ms']}")

    print("\n[Benchmark C: Formant engine + MOCK_MODE=true]")
    bench_formant_mock = await run_concurrency_benchmark(50, forced_mock_mode=True, tts_engine="formant")
    print(f"Results: avg={bench_formant_mock['avg_ms']}ms, p50={bench_formant_mock['p50_ms']}ms, p95={bench_formant_mock['p95_ms']}ms, wall={bench_formant_mock['wall_ms']}ms | <20ms: {bench_formant_mock['pass_lt_20ms']}")

    # Compile JSON report
    summary = {
        "prompt_npcs": prompt_results,
        "canonical_npcs_default": canonical_results,
        "canonical_npcs_formant": formant_results,
        "resilience": resilience_res,
        "benchmarks": {
            "kokoro_default": bench_kokoro,
            "formant_with_probe": bench_formant_probe,
            "formant_with_mock_mode": bench_formant_mock,
        },
    }

    with open("/home/archi/Projects/Rest-In-Hackaton/ai/stress_test_results.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print("\nFull results saved to /home/archi/Projects/Rest-In-Hackaton/ai/stress_test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
