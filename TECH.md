# 🛠️ TECH.md — Техническая архитектура: «Трудности Перевода: Шэньчжэньский Экспресс»

> **Реализация DEV-A:** актуальная схема SQLite и согласованный серверный контракт находятся в [server/README.md](server/README.md). В реализованной схеме JWT не хранится в `players`, текущая цена отделена от `price_floor`, общий торг хранится в `npc_scenes`, квитанции — в `purchases`; кошельки и инвентари личные; примеры кода ниже остаются архитектурными набросками.

> **Деплой:** Один ноутбук (32 GB RAM, мощный CPU) — все сервисы на нём.  
> **Команда:** 4 разработчика, каждый отвечает за свой слой стека.  
> **Принцип:** Итеративные вертикальные срезы — в любой момент можно остановить и показать жюри рабочее демо.

---

## 🖥️ Деплой на одном ноутбуке

```
┌──────────────────────────────────────────────────────┐
│                  НОУТБУК (localhost)                  │
│  32 GB RAM · Мощный CPU                              │
│                                                       │
│  :3000  ← WS + REST  (Backend / Game Logic)          │
│  :8000  ← FastAPI    (AI Middleware → Ollama)        │
│  :11434 ← Ollama     (qwen3.5:4b — CPU inference)   │
│  :5173  ← Vite Dev   (Three.js клиент)               │
└──────────────┬───────────────────────────────────────┘
               │ LAN / Wi-Fi
    ┌──────────┴──────────┐
    │                     │
  [Ноут]              [Другие ПК команды]
  localhost            http://192.168.1.X:5173
  (основной)           (открывают браузер и играют)
```

Все игроки подключаются браузером к ноуту по LAN — ноут сервер + хост одновременно.

---

## 👥 4 РОЛИ — 4 РАЗРАБОТЧИКА

Каждый разработчик ведёт свой слой. Работаем в одном git-репо, каждый в своей папке и ветке.

---

### 🟦 DEV-A — «Backend + GameLogic»

**Папка:** `server/`  
**Запускает:** `go run ./cmd/server` → `:3000`  
**Стек:** Go 1.26 · gorilla/websocket · mattn/go-sqlite3 · golang-jwt/jwt · net/http

#### Почему Go:
- Горутины → тысячи WS-соединений без боли, один бинарник
- `net/http` из стандартной библиотеки — никаких Express
- CGO + go-sqlite3 → SQLite без лишних зависимостей
- Компилируется в один бинарник: `go build -o server ./cmd/server`

#### Что делает:
- WebSocket-сервер — центр всех событий игры (gorilla/websocket Hub)
- REST: `POST /auth/register`, `POST /auth/login`, `GET /health`
- SQLite БД — всё состояние мира
- **FSM движок NPC** — конечный автомат (IDLE → HAGGLING → FLATTERED → AGGRO)
- **Chunk Manager** — мастер-карта 10×10, выдаёт только AOI-чанки (≤9 из 100)
- **Vocabulary Filter** — фильтрует JSON-токены NPC под словарь каждого игрока → `[???]`

#### Схема БД:

```sql
-- Игроки
CREATE TABLE players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  token         TEXT,
  pos_x         REAL DEFAULT 0,
  pos_z         REAL DEFAULT 0,
  balance       INTEGER DEFAULT 500,   -- юани на старте
  profile       TEXT DEFAULT 'tourist' -- 'business' | 'culture'
);

-- Личный словарь (известные слова → не [???])
CREATE TABLE known_words (
  player_id  INTEGER,
  word_id    TEXT,
  learned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, word_id)
);

-- Память NPC о каждом игроке
CREATE TABLE npc_relations (
  npc_id      TEXT,
  player_id   INTEGER,
  mianzi      INTEGER DEFAULT 50,  -- 0..100 Уважение / «Лицо»
  aggro       INTEGER DEFAULT 0,   -- 0..100 Ярость
  price_floor INTEGER DEFAULT 120, -- минимум, до которого сторгуется
  history_json TEXT DEFAULT '[]',  -- последние 6 реплик
  PRIMARY KEY (npc_id, player_id)
);

-- Инвентарь
CREATE TABLE inventory (
  player_id  INTEGER,
  item_id    TEXT,
  price_paid INTEGER,
  bought_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, item_id)
);
```

#### WebSocket пакеты (JSON через gorilla/websocket):

```go
// Все пакеты — единая структура
type Packet struct {
    Type    string          `json:"type"`
    Payload json.RawMessage `json:"payload"`
}

// Клиент → Сервер (type →)
// "MOVE"       { "x":1.2, "z":-3.4, "rotation":0.5 }
// "DIALOGUE"   { "npc_id":"lao_wang", "choice_id":2 }
// "INSPECT"    { "item_id":"teapot", "answer_id":1 }
// "CALCULATOR" { "npc_id":"lao_wang", "amount":150 }

// Сервер → Клиент (type →)
// "CHUNK_LOAD"   { "chunk_id":"5_5", "objects":[...], "npcs":[...] }
// "CHUNK_UNLOAD" { "chunk_ids":["2_3","2_4"] }
// "NPC_SPEECH"   { "npc_id":"lao_wang", "tokens":[...], "choices":[...] }
// "NPC_STATE"    { "npc_id":"lao_wang", "state":"AGGRO", "mianzi":30, "aggro":80 }
// "PLAYER_MOVE"  { "player_id":42, "x":1.2, "z":-3.4, "rotation":0.5 }
// "WORD_LEARNED" { "word_id":"word_expensive", "zh":"太贵了", "ru":"слишком дорого" }
// "BALANCE"      { "balance":320, "delta":-180 }
```

#### Итеративные слои DEV-A:

| # | Что готово | Показываем жюри |
|---|-----------|----------------|
| A1 | Auth + WS handshake + SQLite init | Коннект, логин |
| A2 | Chunk Manager + AOI раздача | DevTools Network: только 9 чанков |
| A3 | FSM NPC без LLM (хардкод-заглушка) | NPC реагирует мгновенно |
| A4 | Vocabulary Filter → `[???]` | Разные субтитры у игроков |
| A5 | npc_relations persist | Лао Ван помнит воришку |
| A6 | Calculator QTE validation | Полный торговый флоу |

---

### 🟥 DEV-B — «AI / NPC Intelligence»

**Папка:** `ai/`  
**Запускает:** Ollama `:11434` + `uvicorn ai/middleware:app --port 8000`  
**Стек:** Ollama · qwen3.5:4b · Python · FastAPI · Pydantic

#### Почему qwen3.5:4b на CPU с 32 GB RAM:

| Параметр | Значение |
|----------|----------|
| Модель | Qwen3.5-4B (GGUF Q4_K_M) |
| Размер на диске | ~2.5 GB |
| RAM при работе | ~3–4 GB |
| Свободно для остального | ~28 GB ✅ |
| Время ответа (CPU) | 3–8 сек — приемлемо для диалога |
| Китайский язык | Нативная поддержка |
| JSON output | Через `format: "json"` в Ollama |

> **32 GB RAM — идеальный вариант для CPU-инференса 4B модели.** Модель полностью помещается в RAM, свопа нет — скорость максимальная для CPU.

#### Установка и запуск:

```bash
# Установить Ollama (один раз)
curl -fsSL https://ollama.com/install.sh | sh

# Скачать модель (~2.5 GB)
ollama pull qwen3.5:4b   # или qwen2.5:4b если такого тега нет

# Запустить (слушает localhost:11434)
ollama serve

# Запустить AI middleware
cd ai
pip install fastapi httpx uvicorn pydantic
uvicorn middleware:app --host 0.0.0.0 --port 8000 --reload
```

#### FastAPI Middleware (`ai/middleware.py`):

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx, json, logging

app = FastAPI()
OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "qwen3.5:4b"

# Системные промпты для каждого NPC
NPC_PROMPTS = {
    "lao_wang": """\
Ты — Лао Ван, хитрый торговец нефритом на ночном рынке Шэньчжэня.
Говоришь смесью китайского, ломаного русского и Chinglish.

ТЕКУЩИЙ КОНТЕКСТ:
- Цена сейчас: {price} юаней (минимум на который согласишься: {price_floor})
- Уважение (Mianzi): {mianzi}/100  
- Ярость (Aggro): {aggro}/100
- Что уже знаешь об этом игроке: {history}

ПРАВИЛА ПОВЕДЕНИЯ:
- Mianzi > 70 → дай скидку 10%, добавь тёплую реплику на русском
- Aggro > 75 → кричи КАПСОМ, прекрати торг, состояние=AGGRO
- Игрок упомянул «тётушку Ли» / «конкурент» → нервничай, сбавь цену -20%
- Игрок указал на «Made in Yiwu» / дефект → смущайся, -300 от цены
- Игрок назвал товар «假货» (подделкой) → обидься, Aggro +25

СТИЛЬ РЕЧИ: «Hello friend! Качество люкс, брат! Дешево отдаю — плакать буду!»

ФОРМАТ ОТВЕТА — строго валидный JSON без markdown:
{{
  "speech_tokens": [
    {{"zh": "这是", "py": "Zhè shì", "ru": "Это", "id": "word_this"}},
    {{"zh": "正宗的", "py": "zhèngzōng de", "ru": "настоящий", "id": "word_authentic"}}
  ],
  "emotion": "neutral",
  "price_new": {price},
  "mianzi_delta": 0,
  "aggro_delta": 0,
  "fsm_state": "HAGGLING",
  "choices": [
    {{"id":1,"zh":"老板，便宜点","py":"Lǎobǎn piányi diǎn","ru":"Босс, сделай скидку","type":"polite"}},
    {{"id":2,"zh":"太贵了！","py":"Tài guì le!","ru":"Слишком дорого!","type":"haggle"}},
    {{"id":3,"zh":"这是假货","py":"Zhè shì jiǎhuò","ru":"Это подделка","type":"provoke"}},
    {{"id":4,"zh":"我再想想","py":"Wǒ zài xiǎngxiang","ru":"Дай подумаю","type":"leave"}}
  ]
}}""",

    "chef_chen": """\
Ты — Повар Чэнь, суровый мастер острой лапши без меню с картинками.
Говоришь только на китайском с редкими русскими словами.
Контекст: {history}
Aggro: {aggro}/100
Отвечай строго JSON: speech_tokens[], emotion, aggro_delta, choices[4]""",

    "guard_zhang": """\
Ты — Охранник Чжан у входа в метро. Строгий законник, не берёшь взяток.
На взятку → Aggro сразу 100, задержание.
Принимаешь только: вежливость, правильные документы, честные ответы.
Контекст: {history}
Отвечай строго JSON: speech_tokens[], emotion, aggro_delta, choices[4]"""
}

class DialogueRequest(BaseModel):
    npc_id: str
    player_message: str
    context: dict  # price, price_floor, mianzi, aggro, history

class DialogueResponse(BaseModel):
    raw: str
    parsed: dict | None = None

@app.post("/dialogue")
async def dialogue(req: DialogueRequest):
    prompt_template = NPC_PROMPTS.get(req.npc_id)
    if not prompt_template:
        raise HTTPException(404, f"NPC '{req.npc_id}' not found")
    
    system_prompt = prompt_template.format(**req.context)
    
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(OLLAMA_URL, json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": req.player_message}
            ],
            "format": "json",   # форсируем JSON-вывод
            "stream": False,
            "options": { "temperature": 0.7, "num_predict": 512 }
        })
    
    content = resp.json()["message"]["content"]
    try:
        parsed = json.loads(content)
    except Exception:
        parsed = None
        logging.warning(f"JSON parse failed for npc={req.npc_id}: {content[:200]}")
    
    return {"raw": content, "parsed": parsed}

@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}
```

#### Итеративные слои DEV-B:

| # | Что готово | Показываем жюри |
|---|-----------|----------------|
| B1 | Ollama запущен, модель загружена | `ollama run qwen3.5:4b` — отвечает |
| B2 | FastAPI `/health` и `/dialogue` | curl тест → JSON ответ |
| B3 | Промпт Лао Вана → колоритный стиль | Диалог с рынком |
| B4 | speech_tokens + choices → двухстрочные субтитры | `[???]` работает end-to-end |
| B5 | Промпты Повара Чэня + Охранника | 3 сценария |
| B6 | Тюнинг temperature/num_predict | Быстрее и точнее |

---

### 🟩 DEV-C — «Frontend / 3D World»

**Папка:** `client/`  
**Запускает:** `npm run dev -- --host` → `:5173` (доступен всем в LAN)  
**Стек:** Vite · TypeScript · Three.js · WebSocket · Web Speech API

#### Архитектура клиента:

```
client/src/
├── main.ts                 # точка входа, инициализация
├── engine/
│   ├── World.ts            # Three.js сцена, рендерер, цикл
│   ├── ChunkStreamer.ts     # load/unload чанков, счётчик %
│   ├── PlayerController.ts # WASD + мышь, капсульный коллайдер
│   └── NpcRenderer.ts      # 3D модели NPC, LookAt, анимации
├── ui/
│   ├── DialogueUI.ts       # двухстрочные субтитры + панель 4 вариантов
│   ├── CalculatorQTE.ts    # мини-игра торга (анимация пальца + Space)
│   ├── QuizPanel.ts        # осмотр предмета (E) + 4 варианта ответа
│   └── HUD.ts              # FPS, % кеша, баланс, Mianzi/Aggro
├── net/
│   └── WSClient.ts         # WS клиент, авто-реконнект
└── audio/
    └── TTS.ts              # Web Speech API (zh-CN, оффлайн)
```

#### World.ts — чанки и правило 10%:

```typescript
export class World {
  private scene = new THREE.Scene();
  private loadedChunks = new Map<string, THREE.Group>();
  readonly TOTAL_CHUNKS = 100; // 10×10

  get cachePercent(): number {
    // ВСЕГДА показываем жюри — никогда не превышает 10%
    return Math.round((this.loadedChunks.size / this.TOTAL_CHUNKS) * 100);
  }

  addChunk(id: string, data: ChunkData): void {
    const group = ChunkBuilder.build(data); // строит геометрию
    this.scene.add(group);
    this.loadedChunks.set(id, group);
  }

  removeChunk(id: string): void {
    const group = this.loadedChunks.get(id);
    if (!group) return;
    // ОБЯЗАТЕЛЬНО — реальная очистка GPU памяти
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material))
          obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
    });
    this.scene.remove(group);
    this.loadedChunks.delete(id);
  }
}
```

#### GPU Acceleration в браузере (Three.js):

```typescript
// 1. WebGPU если поддерживается, иначе WebGL
import { WebGPURenderer } from 'three/addons/renderers/WebGPURenderer.js';

const renderer = navigator.gpu
  ? new WebGPURenderer({ antialias: true })
  : new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });

// 2. InstancedMesh — 1000 фонариков = 1 draw call на GPU
const lanterns = new THREE.InstancedMesh(lanternGeo, lanternMat, count);
data.positions.forEach((p, i) => {
  lanterns.setMatrixAt(i, new THREE.Matrix4().setPosition(p.x, p.y, p.z));
});
lanterns.instanceMatrix.needsUpdate = true;

// 3. UnrealBloom — неоновое свечение вывесок через GPU шейдер
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.8,  // strength
  0.3,  // radius
  0.5   // threshold
);

// 4. Туман для ограничения видимости (GPU fragment shader)
scene.fog = new THREE.FogExp2(0x1a0a00, 0.08); // ночной рынок
```

#### Диалоговый UI — как выглядит:

```
┌─────────────────────────────────────────────────────────────┐
│ 🏮  ЛАО ВАН                                                 │
│ ────────────────────────────────────────────────────────── │
│ СТРОКА 1 (оригинал):                                        │
│   Hello friend! 这太贵了？这是正宗的玉！                      │
│   (Nǐ hǎo! Zhè tài guì le? Zhè shì zhèngzōng de yù!)      │
│                                                              │
│ СТРОКА 2 (словарь ТВОЕГО игрока):                           │
│   Hello friend! [???] слишком дорого? Это настоящий [???]! │
│                                                              │
│   😠 Ярость  ████████░░ 80%      🎭 Уважение ████░░░░ 40%  │
│                                                              │
│  [1] 老板，便宜点吧！  «Босс, сделай скидку!»    🟢 ДИПЛОМАТИЯ│
│  [2] 太贵了，三百！    «Слишком дорого, за 300!»  🟡 ТОРГ    │
│  [3] 这是假货！        «Это подделка!»            🟠 ПРОВОКАЦИЯ│
│  [4] 对不起，再看看。  «Извините, ещё посмотрю.» ⚫ ВЫЙТИ   │
└─────────────────────────────────────────────────────────────┘
```

#### HUD (правый верхний угол) — для жюри:

```
┌─────────────────────────────────┐
│  FPS: 62      RAM-кеш: 9% ✅    │
│  Чанков: 9 / 100 (лимит 10%)   │
│  Позиция: (34, 0, -12)          │
│  🌐 WS: ●  🤖 AI: ●  💾 DB: ●  │
│  💰 Баланс: 320 ¥               │
└─────────────────────────────────┘
```

#### TTS — китайское произношение оффлайн:

```typescript
// audio/TTS.ts — Web Speech API, полностью оффлайн
export class TTS {
  static speak(text: string, lang = 'zh-CN') {
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang;
    utt.rate = 0.85; // чуть медленнее — для обучения
    const voice = speechSynthesis.getVoices()
      .find(v => v.lang.startsWith('zh'));
    if (voice) utt.voice = voice;
    speechSynthesis.speak(utt);
  }
}
// Использование:
TTS.speak('太贵了'); // произносит "Tài guì le" оффлайн
```

#### Итеративные слои DEV-C:

| # | Что готово | Показываем жюри |
|---|-----------|----------------|
| C1 | Three.js сцена + WASD движение | Базовый 3D мир |
| C2 | WebSocket подключение + авторизация | Логин → мир |
| C3 | Chunk load/unload + HUD «9% ✅» | Лимит 10% — доказано |
| C4 | Ночной рынок: туман, неон, Bloom | Атмосфера Шэньчжэня |
| C5 | NPC 3D + Dialogue UI + выборы | Живой Лао Ван |
| C6 | Двухстрочные субтитры `[???]` | Разные у 2 игроков |
| C7 | Calculator QTE мини-игра | Торг на калькуляторе |
| C8 | Квиз предмета (E) + TTS озвучка | Учим слова в игре |

---

### 🟨 DEV-D — «QA + Ops + Pitch»

**Папка:** `ops/`  
**Задача:** Второй игрок в COOP + следит за качеством + готовит защиту

#### Зона ответственности:
- **Тестировщик** — постоянно играет как игрок №2, находит баги
- **Git-мастер** — коммит каждые 30 мин, merge-конфликты
- **monitor.py** — видит статус всех сервисов в реальном времени
- **Питч + демо-скрипт** — сценарий защиты перед жюри
- **DevTools** — заготовленные экраны для вопросов жюри

#### monitor.py:

```python
#!/usr/bin/env python3
import requests, time, os

SERVICES = {
    "Backend WS":  "http://localhost:3000/health",
    "AI Middleware": "http://localhost:8000/health",
    "Ollama":      "http://localhost:11434/api/tags",
    "Frontend":    "http://localhost:5173",
}

def check():
    now = time.strftime('%H:%M:%S')
    statuses = []
    for name, url in SERVICES.items():
        try:
            r = requests.get(url, timeout=2)
            icon = "✅" if r.status_code < 400 else "⚠️"
        except:
            icon = "❌"
        statuses.append(f"{icon} {name}")
    print(f"[{now}] " + " | ".join(statuses))

while True:
    check()
    time.sleep(5)
```

#### backup.sh (запускать через cron раз в 30 мин):

```bash
#!/bin/bash
cd /home/archi/Projects/Rest-In-Hackaton
git add -A
git commit -m "auto: backup $(date '+%H:%M')" 2>/dev/null && echo "✅ Backup OK" || echo "ℹ️ No changes"
```

#### Демо-скрипт для защиты жюри:

```
=== ПИТЧ (2 минуты) ===
1. Открыть localhost:5173 → авторизация → войти в мир
2. Второй игрок с другого устройства → тот же мир
3. Подойти к Лао Вану → диалог запускается
4. Показать: СТРОКА 2 у игрока 1 ≠ СТРОКА 2 у игрока 2 (разные [???])
5. Игрок 1: выбрать «Это подделка!» → Aggro вырастает → LLM обижается
6. Игрок 2: извиниться → Aggro падает → снова торгуются
7. Calculator QTE: Space → промахнулся → торговец хватает деньги (смех в зале)
8. Нажать E у чайника → квиз → ответил верно → слово 茶壶 стало понятным

=== ВОПРОС «10% кеша?» ===
→ Показать HUD: «Кеш: 9% ✅»
→ DevTools → Memory → Heap Snapshot до/после перехода чанков
→ В консоли: Array.from(world.loadedChunks.keys()) — максимум 9 элементов

=== ВОПРОС «Оффлайн?» ===
→ Физически выдернуть кабель / отключить Wi-Fi на роутере от интернета
→ Все продолжает работать → LAN только

=== ВОПРОС «Персистентность?» ===
→ Обновить страницу F5 → игрок появился на том же месте с тем же балансом
→ Подойти к Лао Вану → он помнит: «Опять ты, воришка?!»

=== ВОПРОС «Адаптивность NPC?» ===
→ Диалог 1: грубить → Aggro растёт → кричит
→ Диалог 2: извиниться + похвалить → Mianzi растёт → даёт скидку
→ «История хранится в SQLite npc_relations, LLM видит её в системном промпте»
```

#### Итеративные слои DEV-D:

| # | Что готово | Показываем жюри |
|---|-----------|----------------|
| D1 | Git repo + ветки A/B/C/D | Структура кода |
| D2 | monitor.py — все сервисы зелёные | Система жива |
| D3 | COOP: второй игрок подключён | Кооп работает |
| D4 | Демо-скрипт отрепетирован | Уверенная защита |
| D5 | DevTools сценарии готовы | Отвечаем на вопросы |

---

## 🔄 Итеративные вертикальные срезы

> **Главное правило хакатона:** В любой момент «стоп» → последний зелёный срез → показываем жюри.

```
ЧАС   СРЕЗ   ЧТО ДЕМОНСТРИРУЕМ
────  ─────  ────────────────────────────────────────────────────────
+1    🟢 A1  Авторизация + WS соединение + SQLite
+2    🟢 A2  3D мир + WASD движение + LAN соединение двух игроков
+3    🟢 B1  LLM запущена → консольный диалог с Лао Ваном работает
+4    🟢 C3  Chunk streaming + HUD «9% ✅» — правило 10% доказано
+5    🟢 AC  NPC в 3D + диалоговый UI + выбор реплик → FSM реагирует
+6    🟢 ABC Двухстрочные субтитры [???] — у двух игроков разные!
+7    🟢 ABC COOP: «хороший/плохой полицейский» — торг двумя игроками
+8    🟢 ALL Calculator QTE: мини-игра на Space → смешной промах
+9    🟡 ALL Квиз предмета (E) + TTS озвучка → слово учится!
+10   🟡 ALL Сценарий 2: Повар Чэнь + острая лапша
+11   🟡 ALL Сценарий 3: Охранник Чжан + досмотр
+12   🟠 VFX Bloom неон, туман, анимации, звуки — финальный полиш
+12+  🔵 EXT Задание Дня 2 — добавляем новый чанк с NPC за ~10 минут
```

---

## 📦 Структура репозитория

```
Rest-In-Hackaton/
├── IDEA.md
├── TASK.md
├── TECH.md              ← этот файл
├── PLAN.md
│
├── server/              ← DEV-A (Go 1.26)
│   ├── go.mod
│   ├── go.sum
│   ├── cmd/server/
│   │   └── main.go          # точка входа: http.ListenAndServe :3000
│   ├── internal/
│   │   ├── db/
│   │   │   ├── db.go        # sql.Open + migrate
│   │   │   └── schema.sql
│   │   ├── hub/
│   │   │   ├── hub.go       # WS Hub: Register/Unregister/Broadcast
│   │   │   └── client.go    # Client: горутины read/write
│   │   ├── game/
│   │   │   ├── chunk.go     # ChunkManager + AOI (≤9/100)
│   │   │   ├── fsm.go       # NPC FSM: IDLE→HAGGLING→AGGRO
│   │   │   └── vocab.go     # VocabFilter → [???]
│   │   └── handler/
│   │       ├── auth.go      # POST /auth/register, /auth/login
│   │       ├── ws.go        # GET /ws → upgrade
│   │       └── health.go    # GET /health
│   └── world/chunks/        # 100 JSON файлов чанков
│
├── ai/                  ← DEV-B
│   ├── middleware.py    # FastAPI → Ollama
│   ├── requirements.txt # fastapi httpx uvicorn pydantic
│   └── prompts/
│       ├── lao_wang.txt
│       ├── chef_chen.txt
│       └── guard_zhang.txt
│
├── client/              ← DEV-C
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts
│       ├── engine/
│       │   ├── World.ts
│       │   ├── ChunkStreamer.ts
│       │   ├── PlayerController.ts
│       │   └── NpcRenderer.ts
│       ├── ui/
│       │   ├── DialogueUI.ts
│       │   ├── CalculatorQTE.ts
│       │   ├── QuizPanel.ts
│       │   └── HUD.ts
│       ├── net/WSClient.ts
│       └── audio/TTS.ts
│
└── ops/                 ← DEV-D
    ├── monitor.py
    ├── backup.sh
    └── demo-script.md
```

---

## ⚡ Быстрый старт — первые 15 минут

```bash
# ШАГ 1: DEV-B — ПЕРВЫМ запускает AI (качает модель ~2.5 GB!)
ollama pull qwen3.5:4b
ollama serve &
cd ai && pip install -r requirements.txt
uvicorn middleware:app --host 0.0.0.0 --port 8000

# ШАГ 2: DEV-A — Go сервер
cd server
go mod tidy           # скачает gorilla/websocket, go-sqlite3, jwt
go run ./cmd/server   # → :3000 (или go build -o srv ./cmd/server && ./srv)

# ШАГ 3: DEV-C — клиент (доступен всем в LAN по IP ноута!)
cd client && npm install && npm run dev -- --host
# → http://192.168.1.X:5173

# ШАГ 4: DEV-D — мониторинг
python ops/monitor.py
```

---

## 🎯 Матрица: критерий жюри → техническое решение

| Критерий жюри | Решение | Кто | Доказательство |
|--------------|---------|-----|---------------|
| LAN без интернета | Все зависимости локальны, npm/pip кеш | DEV-A+C | Выдернуть кабель → работает |
| < 10% мира на клиенте | AOI + ChunkStreamer + `dispose()` | DEV-C | HUD + DevTools Memory |
| WebSocket, не polling | `gorilla/websocket`, Hub-паттерн | DEV-A | Network tab → WS фреймы |
| Авторизация | JWT (`golang-jwt/jwt`) + bcrypt | DEV-A | `POST /auth/login` |
| Персистентность | SQLite — всё состояние | DEV-A | F5 → на месте с прогрессом |
| Адаптивный AI | Qwen3.5:4b + npc_relations + history | DEV-B | Лао Ван помнит воришку |
| Нет хардкода в NPC | FSM + LLM + динамический промпт | DEV-A+B | Разные ответы на одну фразу |
| 60 FPS | InstancedMesh + WebGL + Fog culling | DEV-C | Stats.js в правом углу |
| Социальная польза | Словарь, субтитры, квиз, TTS | DEV-B+C | Слова учатся в реальном времени |
| Модульность (День 2) | Каждый чанк = отдельный JSON + промпт | DEV-A+B | Новый NPC за 10 минут |
