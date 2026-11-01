#!/usr/bin/env python3
"""DEV-D: статус и задержки всех сервисов в реальном времени. Запуск: python ops/monitor.py
Ctrl+C — сводка доступности и задержек за сессию (метрики для защиты)."""
import os, socket, time
import requests

SERVICES = {
    "Backend WS":    ["http://localhost:3000/health"],
    "AI Middleware": ["http://localhost:8000/health"],
    "Frontend":      ["http://localhost:5173", "http://localhost:8080"],  # Vite dev | docker-compose
}
POSTGRES = ("127.0.0.1", 5433)  # docker-compose.yml
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
INTERVAL = 5

stats = {}  # имя → {"ok": n, "total": n, "ms": [..]}


def lan_ip():
    # UDP-connect не шлёт пакетов — просто узнаём IP интерфейса в LAN
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.1.1", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def check_env(ip):
    # server/README.md: без секретов сервер не стартует, без LAN-origin игрок 2 получит 403 ORIGIN_DENIED
    if not os.path.exists(ENV_PATH):
        print("⚠️  Нет server/.env → python3 server/scripts/setup_env.py")
        return
    env = {}
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v
    for key in ("JWT_SECRET", "DATABASE_URL"):
        value = env.get(key, "")
        if not value or "REPLACE" in value or (key == "JWT_SECRET" and len(value) < 32):
            print(f"⚠️  {key} не задан → python3 server/scripts/setup_env.py")
    origin = f"http://{ip}:5173"
    if origin not in env.get("ALLOWED_ORIGINS", "").split(","):
        print(f"⚠️  ALLOWED_ORIGINS без {origin} → игрок 2 получит 403 ORIGIN_DENIED")


def record(name, ok, ms=None):
    s = stats.setdefault(name, {"ok": 0, "total": 0, "ms": []})
    s["total"] += 1
    if ok:
        s["ok"] += 1
        if ms is not None:
            s["ms"].append(ms)


def probe(urls):
    """Первый ответивший URL → (response, мс); никто не ответил → (None, None)."""
    for url in urls:
        start = time.perf_counter()
        try:
            r = requests.get(url, timeout=2)
            return r, (time.perf_counter() - start) * 1000
        except requests.RequestException:
            continue
    return None, None


def port_ms(addr):
    start = time.perf_counter()
    try:
        with socket.create_connection(addr, timeout=2):
            return (time.perf_counter() - start) * 1000
    except OSError:
        return None


def check():
    now = time.strftime('%H:%M:%S')
    statuses = []
    for name, urls in SERVICES.items():
        r, ms = probe(urls)
        ok = r is not None and r.status_code < 400
        statuses.append(f"{'✅' if ok else ('⚠️' if r is not None else '❌')} {name}{f' {ms:.0f}ms' if ok else ''}")
        record(name, ok, ms)
        # LLM видна только через AI: бэкенд модели (Ollama / llama-server) выбирается в ai/llm_client.py
        if name == "AI Middleware":
            try:
                llm = ok and r.json().get("llm_alive", False)
            except ValueError:
                llm = False
            statuses.append(f"{'✅' if llm else '❌'} LLM{'' if llm or not ok else ' (AI в mock)'}")
            record("LLM", llm)
    ms = port_ms(POSTGRES)
    statuses.append(f"{'✅' if ms is not None else '❌'} PostgreSQL{f' {ms:.0f}ms' if ms is not None else ''}")
    record("PostgreSQL", ms is not None, ms)
    print(f"[{now}] " + " | ".join(statuses), flush=True)


def summary():
    print("\n── Сводка за сессию ──")
    print(f"{'Сервис':<15}{'Доступность':>12}{'Ср. мс':>9}{'Макс. мс':>10}")
    for name, s in stats.items():
        avail = 100 * s["ok"] / s["total"] if s["total"] else 0
        avg = f"{sum(s['ms']) / len(s['ms']):.0f}" if s["ms"] else "—"
        top = f"{max(s['ms']):.0f}" if s["ms"] else "—"
        print(f"{name:<15}{avail:>11.0f}%{avg:>9}{top:>10}")


if __name__ == "__main__":
    ip = lan_ip()
    print(f"🎮 Игрок 2 (COOP): http://{ip}:5173")
    check_env(ip)
    try:
        while True:
            check()
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        summary()
