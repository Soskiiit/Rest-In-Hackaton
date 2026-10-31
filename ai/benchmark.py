#!/usr/bin/env python3
"""
ai/benchmark.py
Performance, Latency & Throughput Benchmark Suite for Rest-In-Hackaton DEV-B AI Middleware.

Supports:
- Multi-NPC cycling across all 6 personas (Lao Wang, Auntie Li, Electronics Zhang,
  Chef Chen, Granny Liu, Guard Zhang).
- Concurrent execution (--concurrency / -c).
- Offline TTS synthesis latency & throughput testing (POST /tts).
- Direct mock engine benchmark (--mock) bypassing network retry overhead.
- Pass/Fail verification against SLA targets:
    * Dialogue fallback: < 20.0 ms
    * Offline TTS latency: < 15.0 ms
- 100% offline in-process testing via httpx.ASGITransport or live HTTP server (--url).
"""

import argparse
import asyncio
import logging
import os
import statistics
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# 6 Personas Scenarios
NPC_PROMPTS = {
    "lao_wang": [
        ("老板，这块玉佩太贵了，便宜点！", 800, 120, 50, 0),
        ("听说你是整条街最有信誉的商人！", 750, 120, 60, 5),
        ("隔壁李阿姨说她家只要300块。", 700, 120, 50, 15),
        ("行，成交！", 650, 120, 70, 0),
    ],
    "auntie_li": [
        ("李阿姨，这龙井茶真香，怎么卖？", 300, 80, 50, 0),
        ("李阿姨，老王那边便宜二十块！", 280, 80, 45, 10),
        ("给我来两包好茶，算便宜点呗。", 250, 80, 60, 5),
        ("好，成交，就要这盒！", 220, 80, 75, 0),
    ],
    "electronics_zhang": [
        ("师傅，这万用表220伏能用吗？", 150, 50, 50, 0),
        ("二十块行不行？别蒙我。", 130, 50, 40, 15),
        ("师傅手艺真好，整条街都找你修！", 120, 50, 65, 0),
        ("行，成交！", 100, 50, 70, 0),
    ],
    "chef_chen": [
        ("老板，来一碗特辣牛肉面！", 45, 20, 50, 0),
        ("微辣就行，多放点香菜。", 45, 20, 55, 0),
        ("听说陈师傅的刀工全城第一！", 40, 20, 70, 0),
        ("成交，扫码付了！", 35, 20, 75, 0),
    ],
    "granny_liu": [
        ("刘奶奶，这冬虫夏草怎么泡水？", 500, 150, 50, 0),
        ("便宜点吧，我是附近的学生。", 450, 150, 60, 5),
        ("奶奶身体真硬朗，配药真灵验！", 400, 150, 75, 0),
        ("成交，给您现钱！", 350, 150, 80, 0),
    ],
    "guard_zhang": [
        ("张队长好，这是我的临时通行证。", 0, 0, 50, 0),
        ("我只是路过去找老王买茶壶的。", 0, 0, 50, 5),
        ("队长辛苦了，整条街全靠你们守护！", 0, 0, 65, 0),
        ("对不起，我马上离开这里。", 0, 0, 45, 10),
    ],
}

ALL_NPCS = list(NPC_PROMPTS.keys())

TTS_TEST_PHRASES = [
    "太贵了",
    "便宜点",
    "玉",
    "茶叶",
    "老板，便宜点！",
    "正宗的茶叶，一百块一斤。",
    "你好",
    "对不起",
    "这是正宗的龙井茶",
]


def calculate_percentiles(values: List[float]) -> Dict[str, float]:
    """Calculate p50, p90, p95, p99 percentiles from a list of sorted values."""
    if not values:
        return {"p50": 0.0, "p90": 0.0, "p95": 0.0, "p99": 0.0}

    sorted_vals = sorted(values)
    n = len(sorted_vals)

    def get_percentile(p: float) -> float:
        k = (n - 1) * p
        f = int(k)
        c = f + 1
        if c < n:
            return sorted_vals[f] + (k - f) * (sorted_vals[c] - sorted_vals[f])
        return sorted_vals[f]

    return {
        "p50": get_percentile(0.50),
        "p90": get_percentile(0.90),
        "p95": get_percentile(0.95),
        "p99": get_percentile(0.99),
    }


def print_stats_table(title: str, total: int, success: int, failures: int, wall_time: float, latencies: List[float]):
    """Pretty prints performance statistics table."""
    throughput = len(latencies) / wall_time if wall_time > 0 else 0.0
    percentiles = calculate_percentiles(latencies)
    min_lat = min(latencies) if latencies else 0.0
    max_lat = max(latencies) if latencies else 0.0
    avg_lat = statistics.mean(latencies) if latencies else 0.0
    med_lat = statistics.median(latencies) if latencies else 0.0

    print("=" * 65)
    print(f"       {title.upper()}")
    print("=" * 65)
    print(f"Total Requests Executed : {total}")
    print(f"Successful Requests     : {success} ({success/total*100:.1f}%)" if total else "0")
    print(f"Failed Requests         : {failures}")
    print(f"Total Benchmark Time    : {wall_time:.4f} s")
    print(f"Throughput              : {throughput:.2f} req/sec")
    print("-" * 65)
    print(f"Min Latency             : {min_lat:6.2f} ms")
    print(f"Average Latency (mean)  : {avg_lat:6.2f} ms")
    print(f"Median Latency (p50)    : {med_lat:6.2f} ms")
    print(f"90th Percentile (p90)   : {percentiles['p90']:6.2f} ms")
    print(f"95th Percentile (p95)   : {percentiles['p95']:6.2f} ms")
    print(f"99th Percentile (p99)   : {percentiles['p99']:6.2f} ms")
    print(f"Max Latency             : {max_lat:6.2f} ms")
    print("=" * 65)


async def execute_concurrent_tasks(
    client: httpx.AsyncClient,
    tasks_args: List[Any],
    handler_fn: Callable[[httpx.AsyncClient, Any], Any],
    concurrency: int = 1,
) -> Tuple[List[float], int, int]:
    """Runs list of tasks with an asyncio Semaphore bounding concurrency."""
    semaphore = asyncio.Semaphore(concurrency)
    latencies: List[float] = []
    success_count = 0
    failure_count = 0

    async def worker(arg):
        nonlocal success_count, failure_count
        async with semaphore:
            start_t = time.perf_counter()
            try:
                ok = await handler_fn(client, arg)
                elapsed_ms = (time.perf_counter() - start_t) * 1000.0
                if ok:
                    success_count += 1
                    latencies.append(elapsed_ms)
                else:
                    failure_count += 1
            except Exception:
                failure_count += 1

    await asyncio.gather(*(worker(arg) for arg in tasks_args))
    return latencies, success_count, failure_count


async def run_dialogue_benchmark(
    client: httpx.AsyncClient,
    num_requests: int,
    concurrency: int,
    npc_target: str,
    target_ms: float,
    verbose: bool,
) -> Tuple[bool, float]:
    """Runs dialogue benchmark across specified NPCs with concurrency."""
    npcs_to_use = ALL_NPCS if npc_target == "all" else [npc_target]
    print(f"\n[*] Starting Dialogue Benchmark: {num_requests} requests across NPCs {npcs_to_use} (concurrency={concurrency})...")
    print(f"[*] Dialogue SLA Latency Target: < {target_ms:.1f} ms")

    tasks_args = []
    for i in range(num_requests):
        npc = npcs_to_use[i % len(npcs_to_use)]
        prompts = NPC_PROMPTS[npc]
        prompt, price, floor, mianzi, aggro = prompts[i % len(prompts)]
        payload = {
            "npc_id": npc,
            "player_message": prompt,
            "context": {
                "price": price,
                "price_floor": floor,
                "mianzi": mianzi,
                "aggro": aggro,
                "history": [],
            },
        }
        tasks_args.append((i, payload))

    async def send_dialogue(cli: httpx.AsyncClient, item: Tuple[int, Dict[str, Any]]) -> bool:
        idx, payload = item
        t0 = time.perf_counter()
        resp = await cli.post("/dialogue", json=payload)
        t_ms = (time.perf_counter() - t0) * 1000.0
        if resp.status_code == 200:
            if verbose:
                data = resp.json()
                print(f"  [Dialogue {idx+1:02d}] {payload['npc_id']:17s} | {t_ms:6.2f} ms | price={data.get('price_new')} state={data.get('fsm_state')}")
            return True
        return False

    t_start = time.perf_counter()
    latencies, success, failures = await execute_concurrent_tasks(client, tasks_args, send_dialogue, concurrency)
    wall_time = time.perf_counter() - t_start

    print_stats_table("Dialogue Latency & Throughput Profile", num_requests, success, failures, wall_time, latencies)

    avg_lat = statistics.mean(latencies) if latencies else 9999.0
    passed = (failures == 0) and (avg_lat <= target_ms)

    if passed:
        print(f"[DIALOGUE RESULT: PASSED] Avg latency {avg_lat:.2f} ms <= target {target_ms:.1f} ms, 0 failures.")
    else:
        print(f"[DIALOGUE RESULT: FAILED] Failures={failures}, Avg latency {avg_lat:.2f} ms (target < {target_ms:.1f} ms).")

    return passed, avg_lat


async def run_tts_benchmark(
    client: httpx.AsyncClient,
    num_requests: int,
    concurrency: int,
    tts_target_ms: float,
    verbose: bool,
) -> Tuple[bool, float]:
    """Runs TTS benchmark testing POST /tts with WAV binary and JSON base64 payloads."""
    # Ensure formant engine is tested for microsecond SLA compliance
    os.environ["TTS_ENGINE"] = "formant"
    print(f"\n[*] Starting TTS Benchmark: {num_requests} requests (concurrency={concurrency})...")
    print(f"[*] TTS SLA Latency Target: < {tts_target_ms:.1f} ms")

    tasks_args = []
    for i in range(num_requests):
        phrase = TTS_TEST_PHRASES[i % len(TTS_TEST_PHRASES)]
        fmt = "json" if (i % 2 == 1) else "wav"
        payload = {"text": phrase, "format": fmt}
        tasks_args.append((i, payload))

    async def send_tts(cli: httpx.AsyncClient, item: Tuple[int, Dict[str, Any]]) -> bool:
        idx, payload = item
        t0 = time.perf_counter()
        resp = await cli.post("/tts", json=payload)
        t_ms = (time.perf_counter() - t0) * 1000.0
        if resp.status_code == 200:
            if verbose:
                fmt = payload["format"]
                size = len(resp.content)
                print(f"  [TTS {idx+1:02d}] {payload['text']:16s} ({fmt:4s}) | {t_ms:6.2f} ms | size={size} bytes")
            return True
        return False

    t_start = time.perf_counter()
    latencies, success, failures = await execute_concurrent_tasks(client, tasks_args, send_tts, concurrency)
    wall_time = time.perf_counter() - t_start

    print_stats_table("TTS Synthesis Latency & Throughput Profile", num_requests, success, failures, wall_time, latencies)

    avg_lat = statistics.mean(latencies) if latencies else 9999.0
    passed = (failures == 0) and (avg_lat <= tts_target_ms)

    if passed:
        print(f"[TTS RESULT: PASSED] Avg latency {avg_lat:.2f} ms <= target {tts_target_ms:.1f} ms, 0 failures.")
    else:
        print(f"[TTS RESULT: FAILED] Failures={failures}, Avg latency {avg_lat:.2f} ms (target < {tts_target_ms:.1f} ms).")

    return passed, avg_lat


async def main_async(args) -> int:
    # 1. Handle mock mode
    if args.mock:
        os.environ["MOCK_MODE"] = "1"
        logging.getLogger("ai.middleware").setLevel(logging.ERROR)
        print("[*] Mock mode activated (--mock): Direct mock execution without network retries.")

    # 2. Build AsyncClient
    client: httpx.AsyncClient
    if args.url:
        print(f"[*] Targeting live server at: {args.url}")
        client = httpx.AsyncClient(base_url=args.url, timeout=30.0)
    else:
        print("[*] Running in-process offline benchmark via httpx.ASGITransport(app=app)...")
        from ai.middleware import app
        if args.mock:
            import ai.middleware
            ai.middleware.MOCK_MODE_ENV = True
        transport = httpx.ASGITransport(app=app)
        client = httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30.0)

    # 3. Pre-warm healthcheck
    async with client:
        try:
            h_resp = await client.get("/health")
            if h_resp.status_code == 200 and args.verbose:
                print(f"[WARMUP] Health: {h_resp.json().get('status')} (backend: {h_resp.json().get('backend')})")
        except Exception as exc:
            if args.verbose:
                print(f"[WARMUP] Warning: {exc}")

        all_passed = True

        # 4. Run Dialogue Benchmark
        if args.mode in ("all", "dialogue"):
            diag_pass, _ = await run_dialogue_benchmark(
                client=client,
                num_requests=args.requests,
                concurrency=args.concurrency,
                npc_target=args.npc,
                target_ms=args.target_ms,
                verbose=args.verbose,
            )
            all_passed = all_passed and diag_pass

        # 5. Run TTS Benchmark
        if args.mode in ("all", "tts"):
            tts_pass, _ = await run_tts_benchmark(
                client=client,
                num_requests=args.requests,
                concurrency=args.concurrency,
                tts_target_ms=args.tts_target_ms,
                verbose=args.verbose,
            )
            all_passed = all_passed and tts_pass

    # 6. Overall Pass/Fail Status
    print("\n" + "=" * 65)
    if all_passed:
        print(" [OVERALL STATUS: PASSED] All benchmarks met latency and reliability SLAs.")
        print("=" * 65 + "\n")
        return 0
    else:
        print(" [OVERALL STATUS: FAILED] One or more benchmarks failed SLA targets.")
        print("=" * 65 + "\n")
        return 1


def main():
    parser = argparse.ArgumentParser(description="Stage 8 Benchmark Suite for Rest-In-Hackaton DEV-B AI Middleware")
    parser.add_argument("--requests", "-n", type=int, default=50, help="Total number of requests (default: 50)")
    parser.add_argument("--concurrency", "-c", type=int, default=1, help="Concurrent async workers (default: 1)")
    parser.add_argument("--npc", type=str, default="all", choices=["all", "lao_wang", "auntie_li", "electronics_zhang", "chef_chen", "granny_liu", "guard_zhang"], help="Target NPC or 'all' to cycle across all 6 (default: all)")
    parser.add_argument("--mode", type=str, default="all", choices=["all", "dialogue", "tts"], help="Benchmark mode: dialogue, tts, or all (default: all)")
    parser.add_argument("--mock", action="store_true", help="Bypass LLM network attempts and benchmark mock engine directly")
    parser.add_argument("--target-ms", type=float, default=20.0, help="Dialogue fallback latency SLA target in ms (default: 20.0)")
    parser.add_argument("--tts-target-ms", type=float, default=15.0, help="TTS latency SLA target in ms (default: 15.0)")
    parser.add_argument("--url", type=str, default=None, help="Target live server base URL (default: None, in-process)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose per-request logging")
    args = parser.parse_args()

    exit_code = asyncio.run(main_async(args))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
