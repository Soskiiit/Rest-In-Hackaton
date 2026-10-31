# 🗓️ PLAN.md — Итеративный план реализации

> **DEV-A, этапы 0–8:** сервер реализован в `server/`. Актуальные команды запуска и контракты REST/WS/AI — в [server/README.md](server/README.md). Примеры ниже — исходный проектный план; фактические интерфейсы уточнены в README. Полные визуальные чекпоинты требуют интеграции с DEV-B/DEV-C.

> **Правило №1:** Каждый этап — это **рабочий вертикальный срез** от БД до экрана.  
> **Правило №2:** В любой момент можно нажать «стоп» и показать жюри последний ✅ этап.  
> **Правило №3:** DEV-B запускает `ollama pull` **в самую первую минуту** — модель качается фоном.

---

## ⚙️ ЭТАП 0 — Старт (первые 20 минут, все вместе)

```bash
# DEV-B: ПЕРВОЕ ДЕЙСТВИЕ — качать модель фоном пока все настраиваются
ollama pull qwen3.5:4b   # ~2.5 GB, займёт 5-15 мин

# DEV-A: Инициализация Go сервера
mkdir -p server/cmd/server server/internal/{db,hub,game,handler} server/world/chunks
cd server
go mod init hackaton/server   # go 1.26
go get github.com/gorilla/websocket
go get github.com/mattn/go-sqlite3
go get github.com/golang-jwt/jwt/v5
go get golang.org/x/crypto

# DEV-C: Инициализация клиента
npm create vite@latest client -- --template vanilla-ts
cd client && npm install three

# DEV-D: Git + структура + генератор чанков
git checkout -b dev
mkdir -p ai/prompts ops
python ops/gen_chunks.py   # 100 JSON чанков за секунду
```

**✅ Чекпоинт 0:** Репо создан, модель качается, у каждого открыт свой каталог.

---

## 🟢 ЭТАП 1 — «Живое соединение» (~1 час)
> **Цель:** Два браузера подключены к серверу, видят друг друга в 3D.

### DEV-A: Go сервер — Auth + WebSocket Hub

```go
// server/cmd/server/main.go
package main

import (
    "log"
    "net/http"
    "hackaton/server/internal/db"
    "hackaton/server/internal/hub"
    "hackaton/server/internal/handler"
)

func main() {
    database := db.Init("game.db")
    defer database.Close()

    h := hub.NewHub(database)
    go h.Run()

    mux := http.NewServeMux()
    mux.HandleFunc("POST /auth/register", handler.Register(database))
    mux.HandleFunc("POST /auth/login",    handler.Login(database))
    mux.HandleFunc("GET  /health",        handler.Health())
    mux.HandleFunc("/ws",                 handler.WS(h))

    log.Println("🚀 :3000")
    log.Fatal(http.ListenAndServe(":3000", cors(mux)))
}
```

```go
// server/internal/hub/hub.go — горутинный WS Hub
package hub

import (
    "encoding/json"
    "sync"
    "github.com/gorilla/websocket"
)

type Packet struct {
    Type    string          `json:"type"`
    Payload json.RawMessage `json:"payload"`
}

type Client struct {
    Hub      *Hub
    Conn     *websocket.Conn
    Send     chan []byte
    PlayerID int64
    Token    string
    PosX, PosZ float64
}

type Hub struct {
    clients    map[*Client]bool
    broadcast  chan []byte
    register   chan *Client
    unregister chan *Client
    mu         sync.RWMutex
    // db, chunkManager, etc.
}

func NewHub(db any) *Hub {
    return &Hub{
        clients:    make(map[*Client]bool),
        broadcast:  make(chan []byte, 256),
        register:   make(chan *Client),
        unregister: make(chan *Client),
    }
}

func (h *Hub) Run() {
    for {
        select {
        case c := <-h.register:
            h.mu.Lock()
            h.clients[c] = true
            h.mu.Unlock()
        case c := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.clients[c]; ok {
                delete(h.clients, c)
                close(c.Send)
            }
            h.mu.Unlock()
        case msg := <-h.broadcast:
            h.mu.RLock()
            for c := range h.clients {
                select {
                case c.Send <- msg:
                default:
                    close(c.Send)
                    delete(h.clients, c)
                }
            }
            h.mu.RUnlock()
        }
    }
}
```

```go
// server/internal/db/db.go
package db

import (
    "database/sql"
    _ "github.com/mattn/go-sqlite3"
)

func Init(path string) *sql.DB {
    db, err := sql.Open("sqlite3", path+"?_journal=WAL&_timeout=5000")
    if err != nil { panic(err) }

    db.Exec(`PRAGMA foreign_keys = ON`)
    db.Exec(`CREATE TABLE IF NOT EXISTS players (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        token         TEXT,
        pos_x         REAL DEFAULT 0,
        pos_z         REAL DEFAULT 0,
        balance       INTEGER DEFAULT 500,
        profile       TEXT DEFAULT 'tourist'
    )`)
    db.Exec(`CREATE TABLE IF NOT EXISTS known_words (
        player_id INTEGER, word_id TEXT,
        learned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (player_id, word_id)
    )`)
    db.Exec(`CREATE TABLE IF NOT EXISTS npc_relations (
        npc_id TEXT, player_id INTEGER,
        mianzi INTEGER DEFAULT 50, aggro INTEGER DEFAULT 0,
        price_floor INTEGER DEFAULT 120,
        history_json TEXT DEFAULT '[]',
        PRIMARY KEY (npc_id, player_id)
    )`)
    db.Exec(`CREATE TABLE IF NOT EXISTS inventory (
        player_id INTEGER, item_id TEXT, price_paid INTEGER,
        PRIMARY KEY (player_id, item_id)
    )`)
    return db
}
```

### DEV-C: Three.js + WASD + WS соединение

```typescript
// client/src/main.ts — минимальная сцена
import * as THREE from 'three'
import { WSClient } from './net/WSClient'

const scene = new THREE.Scene()
scene.fog = new THREE.FogExp2(0x1a0a00, 0.06)
scene.background = new THREE.Color(0x1a0a00)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 100)
camera.position.set(0, 1.7, 0)

// Пол
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x333333 })
)
floor.rotation.x = -Math.PI / 2
scene.add(floor)

// Освещение
scene.add(new THREE.AmbientLight(0xff4400, 0.3))
const pointLight = new THREE.PointLight(0xff6600, 2, 20)
pointLight.position.set(0, 5, 0)
scene.add(pointLight)

// WASD контроллер (PlayerController.ts — DEV-C пишет)
// WS клиент
const ws = new WSClient('ws://localhost:3000?token=' + localStorage.token)
ws.on('PLAYER_MOVE', (p) => updateOtherPlayer(p))

function animate() {
  requestAnimationFrame(animate)
  // обновить позицию, отправить MOVE раз в 50ms
  renderer.render(scene, camera)
}
animate()
```

**✅ Чекпоинт 1:** `go run ./cmd/server` стартует → авторизация работает → два браузера в 3D мире видят друг друга.

---

## 🟢 ЭТАП 2 — «Чанки и правило 10%» (~1 час)
> **Цель:** Мир разбит на чанки, HUD показывает «Кеш: 9% ✅»

### DEV-A: Go ChunkManager + AOI

```go
// server/internal/game/chunk.go
package game

import (
    "encoding/json"
    "fmt"
    "os"
)

type ChunkData struct {
    ID        string     `json:"id"`
    Buildings []Building `json:"buildings"`
    Lanterns  []Vec3     `json:"lanterns"`
    NpcID     string     `json:"npc_id,omitempty"`
}

type ChunkManager struct {
    chunks map[string]*ChunkData // все 100 в памяти сервера
}

func NewChunkManager() *ChunkManager {
    cm := &ChunkManager{chunks: make(map[string]*ChunkData)}
    for x := range 10 {
        for z := range 10 {
            id := fmt.Sprintf("%d_%d", x, z)
            data, _ := os.ReadFile(fmt.Sprintf("world/chunks/%s.json", id))
            var cd ChunkData
            json.Unmarshal(data, &cd)
            cm.chunks[id] = &cd
        }
    }
    return cm
}

// AOI — максимум 9 чанков из 100 = 9% ✅
func (cm *ChunkManager) GetAOI(px, pz float64) []string {
    cx, cz := int(px/20), int(pz/20)
    var ids []string
    for dx := -1; dx <= 1; dx++ {
        for dz := -1; dz <= 1; dz++ {
            x, z := cx+dx, cz+dz
            if x >= 0 && x < 10 && z >= 0 && z < 10 {
                ids = append(ids, fmt.Sprintf("%d_%d", x, z))
            }
        }
    }
    return ids // len ≤ 9
}
```

### DEV-C: ChunkStreamer + HUD

```typescript
// client/src/engine/ChunkStreamer.ts
export class ChunkStreamer {
  private loaded = new Set<string>()
  readonly TOTAL = 100

  get percent() { return Math.round(this.loaded.size / this.TOTAL * 100) }

  load(id: string, data: any, scene: THREE.Scene) {
    if (this.loaded.has(id)) return
    const group = buildChunkMesh(data) // строит геометрию
    scene.add(group)
    this.loaded.add(id)
  }

  unload(id: string, scene: THREE.Scene) {
    const group = scene.getObjectByName(`chunk_${id}`) as THREE.Group
    if (!group) return
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        ;(obj.material as THREE.Material).dispose()
      }
    })
    scene.remove(group)
    this.loaded.delete(id)
  }
}

// client/src/ui/HUD.ts
export class HUD {
  private el = document.getElementById('hud')!
  update(fps: number, percent: number, balance: number) {
    this.el.innerHTML = `
      <div>FPS: ${fps} | Кеш: <b>${percent}%</b> ✅ (лимит 10%)</div>
      <div>Чанков: ${Math.round(percent)} / 100</div>
      <div>💰 ${balance} ¥</div>
    `
  }
}
```

### DEV-D: Генерирует JSON для чанков (быстро, скриптом)

```python
# ops/gen_chunks.py — генератор заглушечных чанков
import json, os, random

os.makedirs('server/game/world/chunks', exist_ok=True)

for x in range(10):
    for z in range(10):
        chunk = {
            "id": f"{x}_{z}",
            "buildings": [
                {"type": "stall", "x": random.randint(0,18), "z": random.randint(0,18)}
                for _ in range(random.randint(2, 5))
            ],
            "lanterns": [
                {"x": random.uniform(0,20), "y": 3, "z": random.uniform(0,20)}
                for _ in range(random.randint(5, 15))
            ],
            "npc_id": "lao_wang" if (x == 5 and z == 5) else None,
            "signs": []
        }
        with open(f'server/game/world/chunks/{x}_{z}.json', 'w') as f:
            json.dump(chunk, f)

print(f'✅ Сгенерировано 100 чанков')
```

**✅ Чекпоинт 2:** Двигаешься по рынку → HUD показывает ≤9% → при уходе чанки пропадают из памяти → DevTools → Memory: объекты удаляются.

---

## 🟢 ЭТАП 3 — «AI говорит» (~1.5 часа)
> **Цель:** Подходишь к Лао Вану → нажимаешь F → он отвечает через LLM.

### DEV-B: Ollama + FastAPI (параллельно с этапом 1-2)

```bash
# Пока DEV-A и DEV-C строят этапы 1-2, DEV-B:
# 1. Убедился что модель скачалась
ollama list  # должен быть qwen3.5:4b

# 2. Быстрый тест в терминале
ollama run qwen3.5:4b "Ты торговец на китайском рынке. Ответь на русском с китайскими вставками."

# 3. Запустил FastAPI
cd ai
pip install fastapi httpx uvicorn pydantic
uvicorn middleware:app --host 0.0.0.0 --port 8000 --reload

# 4. Тест через curl
curl -X POST http://localhost:8000/dialogue \
  -H "Content-Type: application/json" \
  -d '{"npc_id":"lao_wang","player_message":"Сколько стоит нефрит?","context":{"price":800,"price_floor":120,"mianzi":50,"aggro":0,"history":"[]"}}'
```

### DEV-A: Go — роутинг диалогов → AI middleware

```go
// server/internal/handler/ws.go — обработчик DIALOGUE
case "DIALOGUE":
    var p struct {
        NpcID    string `json:"npc_id"`
        ChoiceID int    `json:"choice_id"`
    }
    json.Unmarshal(msg.Payload, &p)

    // Достать состояние NPC из БД
    var rel NPCRelation
    db.QueryRow(`SELECT mianzi, aggro, price_floor, history_json
        FROM npc_relations WHERE npc_id=? AND player_id=?`,
        p.NpcID, client.PlayerID).Scan(
        &rel.Mianzi, &rel.Aggro, &rel.PriceFloor, &rel.HistoryJSON)

    // Запрос к AI middleware (Python FastAPI)
    aiResp, err := callAI(p.NpcID, choiceText, rel)
    if err != nil {
        // fallback: FSM без LLM
        client.sendFSMResponse(p.NpcID, rel)
        return
    }

    // Обновить БД (upsert)
    db.Exec(`INSERT INTO npc_relations VALUES (?,?,?,?,?,?)
        ON CONFLICT(npc_id,player_id) DO UPDATE SET
        mianzi=mianzi+excluded.mianzi,
        aggro=aggro+excluded.aggro,
        price_floor=excluded.price_floor,
        history_json=excluded.history_json`,
        p.NpcID, client.PlayerID,
        aiResp.MianziDelta, aiResp.AggroDelta,
        aiResp.PriceNew, aiResp.NewHistory)

    // Отфильтровать токены под словарь игрока → [???]
    tokens := filterVocab(aiResp.Tokens, client.PlayerID, db)

    client.send(Packet{Type: "NPC_SPEECH", Payload: mustMarshal(map[string]any{
        "npc_id":  p.NpcID,
        "tokens":  tokens,
        "choices": aiResp.Choices,
        "emotion": aiResp.Emotion,
        "mianzi":  rel.Mianzi + aiResp.MianziDelta,
        "aggro":   rel.Aggro + aiResp.AggroDelta,
        "price":   aiResp.PriceNew,
    })})
```

### DEV-C: Диалоговый UI (заглушка без [???])

```typescript
// client/src/ui/DialogueUI.ts
export class DialogueUI {
  private overlay = document.getElementById('dialogue')!

  show(data: NPCSpeechPayload) {
    const line1 = data.tokens.map(t => `${t.zh} (${t.py})`).join(' ')
    const line2 = data.tokens.map(t => t.ru).join(' ') // пока без [???]
    const choices = data.choices.map((c, i) =>
      `<button onclick="pickChoice(${c.id})">[${i+1}] ${c.zh} — ${c.ru}</button>`
    ).join('')

    this.overlay.innerHTML = `
      <div class="line1">${line1}</div>
      <div class="line2">${line2}</div>
      <div class="bars">
        😠 Ярость: ${data.aggro}%  🎭 Уважение: ${data.mianzi}%
      </div>
      <div class="choices">${choices}</div>
    `
    this.overlay.style.display = 'block'
  }
}
```

**✅ Чекпоинт 3:** F у NPC → диалог открылся → выбрал реплику → Лао Ван отвечает по-русски с китайскими вставками. Шкалы Aggro/Mianzi меняются.

---

## 🟢 ЭТАП 4 — «Магия субтитров [???]» (~1 час)
> **Цель:** Два игрока видят РАЗНЫЕ строки 2 — у каждого свои `[???]`.

### DEV-A: Go VocabFilter + квиз предмета

```go
// server/internal/game/vocab.go
package game

import "database/sql"

func FilterTokens(db *sql.DB, playerID int64, tokens []Token) []Token {
    rows, _ := db.Query(
        `SELECT word_id FROM known_words WHERE player_id=?`, playerID)
    defer rows.Close()

    known := make(map[string]bool)
    for rows.Next() {
        var wid string
        rows.Scan(&wid)
        known[wid] = true
    }

    result := make([]Token, len(tokens))
    for i, t := range tokens {
        result[i] = t
        if !known[t.ID] {
            result[i].Ru = "[???]"
        }
    }
    return result
}

// handler: INSPECT → проверить ответ → записать слово
case "INSPECT":
    var p struct {
        ItemID   string `json:"item_id"`
        AnswerID int    `json:"answer_id"`
    }
    json.Unmarshal(msg.Payload, &p)
    item := items[p.ItemID]
    if p.AnswerID == item.CorrectID {
        db.Exec(`INSERT OR IGNORE INTO known_words VALUES (?,?)`,
            client.PlayerID, item.WordID)
        client.send(Packet{Type: "WORD_LEARNED", Payload: mustMarshal(item)})
    }
```

### DEV-C: QuizPanel UI + обновление строки 2 в реальном времени

```typescript
// При получении WORD_LEARNED — перерисовать текущий диалог
ws.on('WORD_LEARNED', ({ word_id, word }) => {
  knownWords.add(word_id) // локальный кеш
  showWordLearned(word)   // анимация «+1 слово!»
  dialogueUI.refresh(knownWords) // перерисовать строку 2
})
```

**✅ Чекпоинт 4:** Игрок 1 знает «дорого», игрок 2 знает «нефрит» → строка 2 у каждого своя → E у чайника → квиз → ответил → слово выучено → строка 2 обновилась мгновенно.

---

## 🟢 ЭТАП 5 — «COOP + полный торг» (~1 час)
> **Цель:** Два игрока координируют торг. Полный цикл от подхода до покупки.

### DEV-A: Broadcast spatial (Go горутины)

```go
// Рассылать только игрокам в радиусе 15 юнитов от NPC
func (h *Hub) BroadcastNearby(npcX, npcZ float64, pkt Packet) {
    data, _ := json.Marshal(pkt)
    h.mu.RLock()
    defer h.mu.RUnlock()
    for c := range h.clients {
        dx := c.PosX - npcX
        dz := c.PosZ - npcZ
        if dx*dx+dz*dz < 15*15 {
            select {
            case c.Send <- data:
            default:
            }
        }
    }
}
```

### DEV-C: Calculator QTE мини-игра

```typescript
// client/src/ui/CalculatorQTE.ts
export class CalculatorQTE {
  private fingerPos = 0  // 0..9 (позиция над кнопками)
  private speed = 3      // скорость движения пальца
  private digits: number[] = []

  start(startPrice: number) {
    this.overlay.style.display = 'block'
    this.animate()
  }

  private animate() {
    // Палец движется туда-сюда
    this.fingerPos = (this.fingerPos + this.speed * 0.016) % 10
    renderFinger(this.fingerPos)

    // Слушаем Space
    document.onkeydown = (e) => {
      if (e.code === 'Space') {
        const digit = Math.floor(this.fingerPos) // 0-9
        this.digits.push(digit)
        playBeep(digit)
        TTS.speak(['零','一','二','三','四','五','六','七','八','九'][digit])
        renderDisplay(this.digits)
        if (this.digits.length === 3) this.confirm()
      }
    }
    if (this.active) requestAnimationFrame(() => this.animate())
  }

  private confirm() {
    const amount = parseInt(this.digits.join(''))
    ws.send({ type: 'CALCULATOR', payload: { npc_id: 'lao_wang', amount } })
    this.hide()
  }
}
```

### DEV-D: Тестирует полный цикл как игрок 2

- Подключается с другого устройства или вкладки
- Проходит весь сценарий «Лавка Лао Вана»
- Фиксирует баги → сообщает DEV-A/C

**✅ Чекпоинт 5:** Полный игровой цикл работает — два игрока торгуются с Лао Ваном, один давит, другой хвалит, калькулятор QTE, покупка за правильную цену. **Это уже финальный MVP для жюри!**

---

## 🟡 ЭТАП 6 — «Атмосфера» (~45 минут)
> **Цель:** Красиво. Неон, звук, анимации, эмоции NPC.

### DEV-C: Bloom + анимации эмоций

```typescript
// Bloom на неоновых вывесках
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.8, 0.3, 0.5))

// NPC эмоции — менять цвет/анимацию модели
function setNpcEmotion(npcMesh: THREE.Group, emotion: string) {
  const colors = { neutral: 0xffcc88, angry: 0xff4400, happy: 0x88ff88, suspicious: 0xffff00 }
  // Обновить emissive material NPC
}
```

### DEV-B: TTS озвучка в диалоге

```typescript
// При получении NPC_SPEECH — озвучить первые 2-3 токена
const zhText = tokens.slice(0, 3).map(t => t.zh).join('')
TTS.speak(zhText, 'zh-CN')
```

**✅ Чекпоинт 6:** Неоновый рынок с bloom, Лао Ван краснеет при Aggro, звучит китайская речь. Выглядит как продукт.

---

## 🟡 ЭТАП 7 — «Сценарий 2 + 3» (~1 час)
> **Цель:** Добавить Повара Чэня и Охранника Чжана — доказать модульность жюри.

### DEV-B: Добавить промпты в middleware.py

```python
# ai/prompts/chef_chen.txt → загружается в NPC_PROMPTS['chef_chen']
# ai/prompts/guard_zhang.txt → загружается в NPC_PROMPTS['guard_zhang']
```

### DEV-A: Разместить NPC в чанках

```json
// server/game/world/chunks/3_5.json
{ "npc_id": "chef_chen", "buildings": [...] }

// server/game/world/chunks/7_2.json
{ "npc_id": "guard_zhang", "buildings": [...] }
```

**✅ Чекпоинт 7:** Три сценария работают. Жюри видит модульность — «Мы добавили нового NPC за 10 минут».

---

## 🟠 ЭТАП 8 — «Полишинг» (~оставшееся время)
> **Цель:** Убрать все баги, оптимизировать FPS, подготовить питч.

### Все вместе:
- [ ] FPS < 50 → профилировать, убрать лишние draw calls, увеличить InstancedMesh
- [ ] WS ошибки → добавить реконнект в WSClient
- [ ] Длинный ответ LLM (>15 сек) → показывать спиннер «Лао Ван думает...»
- [ ] Слова в квизе → наполнить 20-30 реальными словами с правильными id
- [ ] CSS → сделать UI ненавязчивым но читаемым
- [ ] DevTools сценарий → DEV-D репетирует ответы на вопросы жюри

---

## 📊 Сводная таблица этапов

| Этап | Время | DEV-A | DEV-B | DEV-C | DEV-D | Демо жюри |
|------|-------|-------|-------|-------|-------|-----------|
| **0** | 20 мин | `go mod init` + `go get` | `ollama pull` | `vite init` | `git init` + `gen_chunks.py` | — |
| **1** | +60 мин | Auth + WS Hub + SQLite (Go) | Тестирует LLM вручную | Three.js + WASD + WS | Мониторинг запущен | Два игрока в мире ✅ |
| **2** | +60 мин | ChunkManager + AOI (Go) | FastAPI middleware | ChunkStreamer + HUD % | Баги этапа 1 | HUD «9% ✅» ✅ |
| **3** | +90 мин | AI роутинг (Go → FastAPI) | Промпт Лао Вана | DialogueUI (без [???]) | Тест диалога | LLM отвечает ✅ |
| **4** | +60 мин | VocabFilter + квиз (Go) | Промпт тюнинг | QuizPanel + [???] реалтайм | Тест двух игроков | Разные субтитры ✅ |
| **5** | +60 мин | BroadcastNearby + покупка | — | Calculator QTE | Полный цикл как игрок 2 | **MVP готов ✅** |
| **6** | +45 мин | Fallback FSM если LLM медленно | TTS озвучка | Bloom + эмоции NPC | CSS полиш | Красиво ✅ |
| **7** | +60 мин | NPC placement в чанках | Повар + Охранник промпты | Мелкие баги | Тест 3 сценариев | Модульность ✅ |
| **8** | остаток | Оптимизация | — | FPS / реконнект | Питч репетиция | Финал ✅ |

---

## 🚨 Правила экстренной остановки

Если время заканчивается раньше — приоритет демо:

```
Готово ≥ Этапа 5 → ПОЛНОЦЕННЫЙ MVP → показываем всё
Готово = Этап 3 → Диалог работает → делаем акцент на AI и субтитры
Готово = Этап 2 → Показываем 10% кеш + 3D мир + объясняем архитектуру
Готово = Этап 1 → Показываем LAN multiplayer + говорим про план
```

---

## 🔧 Git-процесс (DEV-D следит)

```bash
# Каждые 30 минут автоматически:
bash ops/backup.sh

# Когда этап завершён — тег:
git tag -a "checkpoint-2" -m "Chunk streaming + HUD 10%"

# Ветки:
main          ← только стабильный код (после каждого чекпоинта)
dev           ← текущая разработка
feature/xxx   ← крупные фичи (Calculator QTE и т.п.)
```

---

## ⚡ Быстрый старт прямо сейчас

```bash
# 1. DEV-B — НЕМЕДЛЕННО:
ollama pull qwen3.5:4b

# 2. DEV-A — инит Go модуля:
mkdir -p server/cmd/server server/internal/{db,hub,game,handler} server/world/chunks
cd server && go mod init hackaton/server
go get github.com/gorilla/websocket github.com/mattn/go-sqlite3 github.com/golang-jwt/jwt/v5 golang.org/x/crypto

# 3. DEV-D — генерирует чанки:
python ops/gen_chunks.py

# 4. DEV-C:
cd client && npm install

# 5. DEV-D — мониторинг:
python ops/monitor.py
```
