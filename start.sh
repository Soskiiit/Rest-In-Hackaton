#!/usr/bin/env bash
# start.sh — Единый скрипт запуска всех компонентов Rest-In-Hackaton (dev mode, без Docker)
#
# Порядок запуска:
#   1. PostgreSQL (docker-compose db)
#   2. AI сервис (uvicorn на :8000)
#   3. Go сервер (на :3000)
#   4. Vite клиент (dev-server на :5173)
#
# Использование: ./start.sh [--no-client] [--mock-ai]
# Остановка: Ctrl+C (завершает все дочерние процессы)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/.run/logs"
mkdir -p "$LOG_DIR"

MOCK_AI=false
NO_CLIENT=false

for arg in "$@"; do
  case "$arg" in
    --mock-ai) MOCK_AI=true ;;
    --no-client) NO_CLIENT=true ;;
  esac
done

# Цвета для вывода
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[start.sh]${NC} $*"; }
ok()  { echo -e "${GREEN}[✓]${NC} $*"; }
err() { echo -e "${RED}[✗]${NC} $*" >&2; }

PIDS=()

cleanup() {
  log "Завершение всех процессов..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Остановить базу данных
  docker compose -f "$ROOT_DIR/server/compose.yaml" --env-file "$ROOT_DIR/server/.env" stop db 2>/dev/null || true
  log "Готово."
}
trap cleanup EXIT INT TERM

# ── 1. Проверить/создать server/.env ──────────────────────────────────────────
if [ ! -f "$ROOT_DIR/server/.env" ]; then
  log "Генерация server/.env..."
  cd "$ROOT_DIR/server" && python3 scripts/setup_env.py
  cd "$ROOT_DIR"
fi
ok "server/.env готов"

# Загрузить переменные окружения
set -a; source "$ROOT_DIR/server/.env"; set +a

# ── 2. PostgreSQL через docker compose ────────────────────────────────────────
log "Запуск PostgreSQL (docker compose)..."
docker compose -f "$ROOT_DIR/server/compose.yaml" --env-file "$ROOT_DIR/server/.env" up -d db
# Ждать готовности
for i in $(seq 1 30); do
  if docker compose -f "$ROOT_DIR/server/compose.yaml" --env-file "$ROOT_DIR/server/.env" exec -T db pg_isready -U postgres -d postgres -q 2>/dev/null; then
    break
  fi
  sleep 1
done
ok "PostgreSQL готов на 127.0.0.1:5433"

# ── 3. AI сервис ──────────────────────────────────────────────────────────────
log "Запуск AI сервиса (uvicorn :8000)..."
cd "$ROOT_DIR/ai"
if [ -d ".venv" ]; then
  source .venv/bin/activate
fi

if [ "$MOCK_AI" = "true" ]; then
  export USE_MOCK_ENGINE=true
  log "Режим мок-движка включён (--mock-ai)"
fi

TTS_ENGINE="${TTS_ENGINE:-formant}" uvicorn middleware:app \
  --host 127.0.0.1 --port 8000 \
  --log-level warning \
  > "$LOG_DIR/ai.log" 2>&1 &
PIDS+=($!)
cd "$ROOT_DIR"

# Ждать AI
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1; then break; fi
  sleep 1
done
ok "AI сервис готов на http://127.0.0.1:8000"

# ── 4. Go сервер ──────────────────────────────────────────────────────────────
log "Сборка и запуск Go сервера (:3000)..."
cd "$ROOT_DIR/server"
go build -o .run_server ./cmd/server > "$LOG_DIR/server_build.log" 2>&1
./.run_server > "$LOG_DIR/server.log" 2>&1 &
PIDS+=($!)
cd "$ROOT_DIR"

# Ждать Go сервер
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then break; fi
  sleep 1
done
ok "Go сервер готов на http://127.0.0.1:3000"

# ── 5. Vite клиент ────────────────────────────────────────────────────────────
if [ "$NO_CLIENT" != "true" ]; then
  log "Запуск Vite dev-сервера (:5173)..."
  cd "$ROOT_DIR/client"
  npm install --silent > /dev/null 2>&1
  npm run dev > "$LOG_DIR/client.log" 2>&1 &
  PIDS+=($!)
  cd "$ROOT_DIR"
  sleep 3
  ok "Клиент готов на http://localhost:5173"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅  REST IN HACKATON — все сервисы запущены!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐 Клиент:      http://localhost:5173"
echo -e "  ⚙️  Go сервер:   http://127.0.0.1:3000"
echo -e "  🤖 AI сервис:   http://127.0.0.1:8000"
echo -e "  🗄️  PostgreSQL:  127.0.0.1:5433"
echo ""
echo -e "  Логи: $LOG_DIR/"
echo -e "  Остановка: ${YELLOW}Ctrl+C${NC}"
echo ""

# Держать скрипт запущенным
wait
