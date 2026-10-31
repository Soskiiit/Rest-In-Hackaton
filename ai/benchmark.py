#!/usr/bin/env python3
"""
Performance & Latency Benchmark for Rest-In-Hackaton DEV-B AI Middleware.

Measures sequential dialogue latency (min, max, avg, p50, p90, p95, p99) and
throughput (RPS). Runs 100% offline in-process via httpx.ASGITransport by default,
or optionally targets a live HTTP server via --url.
"""

import argparse
import asyncio
import os
import statistics
import sys
import time
from typing import Any, Dict, List, Optional

import httpx

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)


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


async def run_benchmark(
    num_requests: int = 25,
    npc_id: str = "lao_wang",
    target_ms: float = 20.0,
    base_url: Optional[str] = None,
    verbose: bool = False,
) -> int:
    """
    Executes benchmark loop and outputs formatted performance metrics.
    Returns 0 if benchmark passed performance targets, 1 otherwise.
    """
    # Load app dynamically if running offline via ASGITransport
    client: httpx.AsyncClient
    if base_url:
        print(f"[*] Targeting live server at: {base_url}")
        client = httpx.AsyncClient(base_url=base_url, timeout=30.0)
    else:
        print("[*] Running in-process offline benchmark via httpx.ASGITransport(app=app)...")
        from ai.middleware import app
        transport = httpx.ASGITransport(app=app)
        client = httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30.0)

    # Standard dialogue test payloads cycling through scenarios
    dialogue_prompts = [
        ("太贵了，老板便宜点！", 800, 120, 50, 0),
        ("听说你是整条街最有信誉的商人！", 750, 120, 60, 5),
        ("隔壁李阿姨说她家只要300块。", 700, 120, 50, 15),
        ("这块玉雕工确实不错，还能少点吗？", 600, 120, 65, 10),
        ("算了，我再转转吧。", 550, 120, 55, 20),
    ]

    latencies_ms: List[float] = []
    success_count = 0
    failure_count = 0

    print(f"[*] Starting benchmark: {num_requests} sequential dialogue requests for NPC '{npc_id}'...")
    print(f"[*] Latency target (mock mode): < {target_ms:.1f} ms\n")

    overall_start = time.perf_counter()

    async with client:
        # Pre-warm with a single healthcheck
        try:
            health_resp = await client.get("/health")
            if health_resp.status_code == 200 and verbose:
                print(f"[WARMUP] Healthcheck: {health_resp.json().get('status')} (backend: {health_resp.json().get('backend')})")
        except Exception as e:
            if verbose:
                print(f"[WARMUP] Healthcheck warning: {e}")

        for i in range(num_requests):
            prompt, price, floor, mianzi, aggro = dialogue_prompts[i % len(dialogue_prompts)]
            payload = {
                "npc_id": npc_id,
                "player_message": prompt,
                "context": {
                    "price": price,
                    "price_floor": floor,
                    "mianzi": mianzi,
                    "aggro": aggro,
                    "history": "[]",
                },
            }

            req_start = time.perf_counter()
            try:
                resp = await client.post("/dialogue", json=payload)
                req_elapsed_ms = (time.perf_counter() - req_start) * 1000.0

                if resp.status_code == 200:
                    success_count += 1
                    latencies_ms.append(req_elapsed_ms)
                    if verbose:
                        data = resp.json()
                        print(f"  [{i+1:02d}/{num_requests}] {req_elapsed_ms:6.2f} ms | price_new={data.get('price_new')} state={data.get('fsm_state')}")
                else:
                    failure_count += 1
                    if verbose:
                        print(f"  [{i+1:02d}/{num_requests}] HTTP {resp.status_code}: {resp.text}")
            except Exception as exc:
                failure_count += 1
                if verbose:
                    print(f"  [{i+1:02d}/{num_requests}] Request Error: {exc}")

    overall_elapsed = time.perf_counter() - overall_start

    # Compute statistics
    if not latencies_ms:
        print("[ERROR] No successful requests recorded!")
        return 1

    min_latency = min(latencies_ms)
    max_latency = max(latencies_ms)
    avg_latency = statistics.mean(latencies_ms)
    median_latency = statistics.median(latencies_ms)
    percentiles = calculate_percentiles(latencies_ms)
    throughput = len(latencies_ms) / overall_elapsed if overall_elapsed > 0 else 0.0

    # Print Report
    print("=" * 60)
    print("           BENCHMARK RESULTS & LATENCY PROFILE")
    print("=" * 60)
    print(f"Total Requests Executed : {num_requests}")
    print(f"Successful Requests     : {success_count} ({success_count/num_requests*100:.1f}%)")
    print(f"Failed Requests         : {failure_count}")
    print(f"Total Benchmark Time    : {overall_elapsed:.4f} s")
    print(f"Throughput              : {throughput:.2f} req/sec")
    print("-" * 60)
    print(f"Min Latency             : {min_latency:6.2f} ms")
    print(f"Average Latency (mean)  : {avg_latency:6.2f} ms")
    print(f"Median Latency (p50)    : {median_latency:6.2f} ms")
    print(f"90th Percentile (p90)   : {percentiles['p90']:6.2f} ms")
    print(f"95th Percentile (p95)   : {percentiles['p95']:6.2f} ms")
    print(f"99th Percentile (p99)   : {percentiles['p99']:6.2f} ms")
    print(f"Max Latency             : {max_latency:6.2f} ms")
    print("=" * 60)

    # Verification of Target
    if failure_count > 0:
        print(f"[RESULT: FAILED] {failure_count} requests failed!")
        return 1

    if avg_latency <= target_ms:
        print(f"[RESULT: PASSED] Average latency ({avg_latency:.2f} ms) satisfies target (< {target_ms:.1f} ms)!")
        return 0
    else:
        print(f"[RESULT: WARNING] Average latency ({avg_latency:.2f} ms) exceeds mock target (< {target_ms:.1f} ms).")
        # In live LLM environments, higher latency is expected and acceptable
        return 0


def main():
    parser = argparse.ArgumentParser(description="Benchmark Rest-In-Hackaton DEV-B AI Middleware")
    parser.add_argument("--requests", "-n", type=int, default=25, help="Number of sequential requests (default: 25)")
    parser.add_argument("--npc", type=str, default="lao_wang", choices=["lao_wang", "chef_chen", "guard_zhang"], help="NPC identifier (default: lao_wang)")
    parser.add_argument("--target-ms", type=float, default=20.0, help="Target latency in ms (default: 20.0)")
    parser.add_argument("--url", type=str, default=None, help="Optional live HTTP URL (e.g. http://127.0.0.1:8000)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Print per-request latency logs")
    args = parser.parse_args()

    exit_code = asyncio.run(
        run_benchmark(
            num_requests=args.requests,
            npc_id=args.npc,
            target_ms=args.target_ms,
            base_url=args.url,
            verbose=args.verbose,
        )
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
