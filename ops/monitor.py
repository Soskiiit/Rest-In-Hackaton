#!/usr/bin/env python3
"""DEV-D: статус всех сервисов в реальном времени. Запуск: python ops/monitor.py"""
import os, socket, time
import requests

SERVICES = {
    "Backend WS":    "http://localhost:3000/health",
    "AI Middleware": "http://localhost:8000/health",
    "LLM":           "http://localhost:8080/health",   # llama-server (ai/llm_client.py)
    "Frontend":      "http://localhost:5173",
}
POSTGRES = ("127.0.0.1", 5433)  # server/compose.yaml
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


def port_open(addr):
    try:
        with socket.create_connection(addr, timeout=2):
            return True
    except OSError:
        return False


def check():
    now = time.strftime('%H:%M:%S')
    statuses = []
    for name, url in SERVICES.items():
        try:
            r = requests.get(url, timeout=2)
            icon = "✅" if r.status_code < 400 else "⚠️"
            # AI без живой модели отвечает из mock_engine — для демо это не норма
            if name == "AI Middleware" and r.ok and r.json().get("mock_mode"):
                icon, name = "⚠️", "AI Middleware (mock)"
        except (requests.RequestException, ValueError):
            icon = "❌"
        statuses.append(f"{icon} {name}")
    statuses.append(f"{'✅' if port_open(POSTGRES) else '❌'} PostgreSQL")
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
