#!/usr/bin/env python3
"""DEV-D: статус всех сервисов в реальном времени. Запуск: python ops/monitor.py"""
import os, socket, time
import requests

SERVICES = {
    "Backend WS":    "http://localhost:3000/health",
    "AI Middleware": "http://localhost:8000/health",
    "Ollama":        "http://localhost:11434/api/tags",
    "Frontend":      "http://localhost:5173",
}
ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "server", ".env")
INTERVAL = 5


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
    # server/README.md: без LAN-origin игрок 2 получит 403 ORIGIN_DENIED, без секрета сервер не стартует
    if not os.path.exists(ENV_PATH):
        print("⚠️  Нет server/.env → cp server/.env.example server/.env")
        return
    env = {}
    with open(ENV_PATH, encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v
    if len(env.get("JWT_SECRET", "")) < 32:
        print("⚠️  JWT_SECRET < 32 символов → openssl rand -hex 32")
    origin = f"http://{ip}:5173"
    if origin not in env.get("ALLOWED_ORIGINS", "").split(","):
        print(f"⚠️  ALLOWED_ORIGINS без {origin} → игрок 2 получит 403 ORIGIN_DENIED")


def check():
    now = time.strftime('%H:%M:%S')
    statuses = []
    db = "❌"
    for name, url in SERVICES.items():
        try:
            r = requests.get(url, timeout=2)
            icon = "✅" if r.status_code < 400 else "⚠️"
            if name == "Backend WS" and r.ok and r.json().get("db") == "ok":
                db = "✅"
        except (requests.RequestException, ValueError):
            icon = "❌"
        statuses.append(f"{icon} {name}")
    statuses.append(f"{db} DB")
    print(f"[{now}] " + " | ".join(statuses), flush=True)


if __name__ == "__main__":
    ip = lan_ip()
    print(f"🎮 Игрок 2 (COOP): http://{ip}:5173")
    check_env(ip)
    try:
        while True:
            check()
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        pass
