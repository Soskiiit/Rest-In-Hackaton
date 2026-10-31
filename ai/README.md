# 🤖 AI Middleware (DEV-B) — Rest-In-Hackaton

Микросервис на базе **FastAPI**, обеспечивающий интеграцию игрового сервера (Go DEV-A) и 3D-клиента (Three.js DEV-C) с локальной большой языковой моделью через **`llama-server`** (или автономным mock-движком в fallback-режиме).

---

## 🏛️ Архитектура

```
                       ┌───────────────────────────────┐
                       │  Go Backend (DEV-A)           │
                       │  POST /dialogue (:3000 -> :8000)
                       └───────────────┬───────────────┘
                                       │ HTTP JSON
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ FastAPI Middleware (ai/middleware.py, port 8000)                             │
│                                                                             │
│  1. Валидация Pydantic v2 (models.py)                                       │
│  2. Безопасная интерполяция контекста в промпт (prompt_engine.py)          │
│  3. Запрос к LLM (llm_client.py)                                            │
│       ├── Успех ────────► llama-server (:8080)                              │
│       └── Сбой/Оффлайн ──► Mock Engine (mock_engine.py)                     │
│  4. Санитизация JSON + очистка markdown тегов                               │
│  5. Бизнес-правила: клампинг цен, mianzi/aggro [0, 100], триггер AGGRO > 75 │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                       ┌───────────────────────────────┐
                       │ llama-server (port 8080)      │
                       │ unsloth/Qwen3.5-4B-MTP-GGUF   │
                       └───────────────────────────────┘
```

---

## 📁 Структура каталога

- **[`middleware.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/middleware.py)** — точка входа FastAPI (`GET /health`, `POST /dialogue`), CORS, валидация бизнес-правил.
- **[`models.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/models.py)** — схемы Pydantic v2 (`SpeechToken`, `Choice`, `DialogueContext`, `DialogueRequest`, `DialogueResponse`).
- **[`prompt_engine.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompt_engine.py)** — безопасный шаблонизатор контекста (`{price}`, `{price_floor}`, `{mianzi}`, `{aggro}`, `{history}`).
- **[`mock_engine.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/mock_engine.py)** — автономный детерминированный движок ответов персонажей для оффлайн-разработки и fallback при недоступности модели.
- **[`llm_client.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/llm_client.py)** — асинхронный клиент к `llama-server` с поддержкой спекулятивного декодирования и очисткой markdown fences.
- **[`prompts/`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts)** — системные ролевые промпты торговцев ночного рынка:
  - [`lao_wang.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/lao_wang.txt) — торговец нефритом и сувенирами Лао Ван («Hello friend! Качество люкс!»).
  - [`auntie_li.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/auntie_li.txt) — чайная лавка Тётушки Ли (Улун, Да Хун Пао, заклятый конкурент Лао Вана).
  - [`electronics_zhang.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/electronics_zhang.txt) — мастер электроники Хуацянбэй (квестовые сетевые переходники `转换插头`, кабели, чипы).
  - [`chef_chen.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/chef_chen.txt) — суровый повар острой сычуаньской лапши Dan Dan («Не острое не готовлю!»).
  - [`granny_liu.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/granny_liu.txt) — травница традиционной китайской медицины (дикий женьшень, ягоды годжи, целебные сборы).
  - [`guard_zhang.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/prompts/guard_zhang.txt) — неподкупный охранник метро и рынка.
- **[`test_middleware.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/test_middleware.py)** — тестовый сьют (65 тестов, 100% pass rate).
- **[`benchmark.py`](file:///home/archi/Projects/Rest-In-Hackaton/ai/benchmark.py)** — скрипт нагрузочного тестирования и замера задержек/RPS.
- **[`requirements.txt`](file:///home/archi/Projects/Rest-In-Hackaton/ai/requirements.txt)** — зависимости проекта.

---

## ⚡ Быстрый старт

### 1. Подготовка окружения (через `uv`)

```bash
# Создание venv на Python 3.12 (если еще не создан)
uv venv --python 3.12 ai/.venv

# Установка зависимостей
uv pip install --python ai/.venv -r ai/requirements.txt
```

### 2. Запуск локальной LLM (`llama-server`)

Используется спекулятивное декодирование (MTP Draft):

```bash
llama-server \
  -hf unsloth/Qwen3.5-4B-MTP-GGUF:Q5_K_M \
  -ngl 99 \
  -c 32768 \
  --spec-type draft-mtp \
  --spec-draft-n-max 2
```
*По умолчанию `llama-server` слушает порт `http://127.0.0.1:8080`.*

### 3. Запуск AI Middleware (порт 8000)

```bash
ai/.venv/bin/uvicorn ai.middleware:app --host 0.0.0.0 --port 8000 --reload
```

> **Примечание:** Если `llama-server` не запущен, middleware автоматически переходит в режим **mock fallback**, не прерывая работу игры и возвращая корректные ролевые ответы персонажей.

---

## 📡 API Спецификация

### 1. `GET /health`
Проверка состояния сервиса и доступности LLM-бэкенда.

**Пример ответа:**
```json
{
  "status": "ok",
  "backend_mode": "live",
  "llama_server_url": "http://127.0.0.1:8080/v1/chat/completions",
  "llama_connected": true
}
```

---

### 2. `POST /dialogue`
Основной эндпоинт генерации реплики NPC.

**Пример запроса:**
```bash
curl -X POST http://localhost:8000/dialogue \
  -H "Content-Type: application/json" \
  -d '{
    "npc_id": "lao_wang",
    "player_message": "Босс, отдай нефрит за 200!",
    "context": {
      "price": 800,
      "price_floor": 150,
      "mianzi": 50,
      "aggro": 10,
      "history": "[]"
    }
  }'
```

**Формат ответа (строгий JSON):**
```json
{
  "speech_tokens": [
    {"zh": "这是", "py": "Zhè shì", "ru": "Это", "id": "word_this"},
    {"zh": "正宗的", "py": "zhèngzōng de", "ru": "настоящий", "id": "word_authentic"},
    {"zh": "翡翠", "py": "fěicuì", "ru": "нефрит", "id": "word_jade"}
  ],
  "emotion": "neutral",
  "price_new": 720,
  "mianzi_delta": 2,
  "aggro_delta": 0,
  "fsm_state": "HAGGLING",
  "choices": [
    {"id": 1, "zh": "老板，便宜点", "py": "Lǎobǎn piányi diǎn", "ru": "Босс, сделай скидку", "type": "polite"},
    {"id": 2, "zh": "太贵了！", "py": "Tài guì le!", "ru": "Слишком дорого!", "type": "haggle"},
    {"id": 3, "zh": "这是假货", "py": "Zhè shì jiǎhuò", "ru": "Это подделка", "type": "provoke"},
    {"id": 4, "zh": "我再想想", "py": "Wǒ zài xiǎngxiang", "ru": "Дай подумаю", "type": "leave"}
  ]
}
```

---

## 🎮 Игровая механика и субтитры `[???]`

- **Токенизация (`speech_tokens`)**: Каждая фраза NPC разбивается на атомарные лексемы с уникальным идентификатором `id`. Go-сервер сверяет `id` с изученными словами игрока (`known_words`). Неизученные слова заменяются на `[???]`.
- **FSM Состояния**: `TALKING`, `HAGGLING`, `AGGRO`, `DEAL`, `REFUSED`, `LEAVE`.
- **Защитные правила**:
  - `price_new` никогда не опускается ниже `price_floor`;
  - `mianzi` и `aggro` строго ограничены диапазоном $[0, 100]$;
  - При `aggro > 75` NPC автоматически переходит в состояние `AGGRO` и прекращает торг.

---

## 🧪 Тестирование и бенчмарки

### Запуск тестов
```bash
ai/.venv/bin/python -m unittest ai/test_middleware.py
```
*Все 65 тестов работают 100% оффлайн через ASGI транспорт httpx.*

### Запуск бенчмарка
```bash
ai/.venv/bin/python ai/benchmark.py
```
*Замеряет задержки (RTT, p50, p95, p99) и пропускную способность (RPS).*
