# DEV-A: Backend + GameLogic, этапы 0–8

Go 1.26, net/http, gorilla/websocket, PostgreSQL 18.6 (pgx/v5/stdlib через database/sql), bcrypt, JWT HS256.
Сервер реализует авторизацию, мир, словарь, общий торг NPC и покупки. Кошельки и инвентари личные.
Three.js, визуальный QTE, TTS и FastAPI/Ollama интегрируются отдельно разработчиками C/B.

## Запуск в WSL

Рабочая директория — Linux-каталог репозитория, не Windows UNC.

```bash
cd /home/klumaks/hack_2026/Rest-In-Hackaton/server
export PATH="/usr/local/go/bin:$PATH"
python3 scripts/setup_env.py
# В .env дополнить ALLOWED_ORIGINS точным адресом клиента, например http://192.168.1.10:5173.
docker compose pull db
docker compose up -d --wait db
set -a
source .env
set +a
go mod download
go run ./cmd/server
```

.env автоматически не загружается: используйте source или переменные процесса.
Сохраняйте один JWT_SECRET между перезапусками, иначе ранее выданные токены станут недействительными.
Используйте Docker Compose V2 (`docker compose version`), не устаревший docker-compose V1.
Драйвер БД не требует CGO; для go test -race нужен C-компилятор. Go найден в /usr/local/go/bin/go.

```bash
go test -count=1 -timeout 90s ./...
go test -race -count=1 -timeout 120s ./...
go vet ./...
CGO_ENABLED=0 go build -o bin/server ./cmd/server
python3 scripts/process_smoke.py --restart-db
./bin/server
```

Скачайте образ postgres:18.6, зависимости Go и соберите бинарник до отключения интернета.
Тестам необходимы TEST_DATABASE_URL и запущенная БД; Python smoke-проверке нужен psql.
Каждый DB/REST/WS-тест создаёт временную схему в hackaton_test и удаляет её после проверки.
Флаг --restart-db перезапускает контейнер этого Compose-проекта; используйте его вне активной игры. В runtime нет внешних CDN/API.
По умолчанию сервер слушает :3000; браузеры других устройств используют IP хост-ноутбука.
При WSL NAT доступ из LAN также зависит от Windows Firewall и проброса порта; физическая LAN-проверка проводится с DEV-D.
Остановка Ctrl+C / SIGTERM закрывает WS и сохраняет изменённые позиции.

Переменные: SERVER_ADDR, обязательный DATABASE_URL, WORLD_DIR, CATALOG_PATH, AI_URL, JWT_SECRET, ALLOWED_ORIGINS.
TEST_DATABASE_URL используется только тестами и должен указывать на hackaton_test.
POSTGRES_PASSWORD и APP_DB_PASSWORD нужны Compose при первоначальной инициализации.
Секреты находятся в игнорируемом .env; setup_env.py генерирует недостающие, сохраняя уже заданные.
Пути по умолчанию относительны директории server/. AI_URL по умолчанию http://127.0.0.1:8000.
Пустой/короткий JWT_SECRET, неверные Origin, каталог, отсутствующие чанки или ошибка миграции останавливают запуск.

## PostgreSQL

Compose-проект rest-in-hackaton использует postgres:18.6 и именованный том rest-in-hackaton_pgdata.
Порт только 127.0.0.1:5433; системный PostgreSQL на 5432 не изменяется. Go запускается в WSL на хосте.
При первом старте создаются базы hackaton/hackaton_test и роль hackaton без SUPERUSER/CREATEDB/CREATEROLE.
Миграции internal/db/migrations/*.sql встроены в бинарник, применяются одной транзакцией под
advisory lock до открытия HTTP-порта и учитываются в schema_migrations. Ошибка подключения или миграции останавливает запуск.
Пул: до 10 соединений, 2 простаивающих; connect_timeout 5 с, statement_timeout 10 с,
lock_timeout 5 с; миграции имеют отдельный лимит 30 с. ID — identity, координаты — DOUBLE PRECISION,
время — TIMESTAMPTZ, истории и сохранённые ответы — JSONB.

Остановка `docker compose down` сохраняет том; `down -v` удаляет данные.
Пароли из .env применяются init-скриптом только для нового тома: изменение .env не меняет пароль существующей роли.

- players: уникальный case-sensitive login, bcrypt-хэш, профиль business/culture, координаты, поворот и баланс 500.
- known_words: уникальная пара player_id + word_id и время изучения. Регистрация и стартовые слова — одна транзакция.
- npc_relations: личная история последних 6 сообщений и снимок состояния при последнем действии этого игрока.
- npc_scenes: общее актуальное состояние NPC, цена, агрессия/уважение, версия хода, последние 6 сообщений сцены и текущие варианты.
- inventory: уникальный item_id на игрока и цена покупки.
- purchases: подтверждённые квитанции с уникальным trade_id, покупателем, товаром и суммой. Повтор запроса не списывает деньги.
- Версия хода, личная история и ответ NPC фиксируются одной транзакцией; покупка атомарно меняет кошелёк, инвентарь, квитанцию и версию сцены.
- Все дочерние player_id имеют FK с ON DELETE CASCADE. На значения установлены CHECK и NOT NULL.

Миграция PostgreSQL 001 → 002 сохраняет данные предыдущей версии схемы PostgreSQL.
При переходе локальная SQLite-база не обнаружена: PostgreSQL инициализируется пустым.
Импорт SQLite и автоматическое переключение на неё не реализуются; старые файлы БД не удаляются. Новые общие сцены создаются из каталога, без объединения старых личных отношений.
Незавершённые сделки хранятся только в памяти соединения; подтверждённые покупки и сцены переживают рестарт.

Начальный спавн (110,110). Лао Ван стоит в центральном павильоне (100,124) в чанке 5_6.
Текущие позиции хранятся в памяти и записываются раз в 2 секунды,
при отключении и штатной остановке. При аварии возможно потерять последние 2 секунды движения.
Слова и ответы NPC подтверждаются только после записи в БД. AI ожидается вне транзакции и сетевого игрового цикла.
Покупка сначала блокирует строку NPC, затем кошелёк игрока (FOR UPDATE), повторно проверяет квитанцию,
версию сцены, баланс и владение предметом. Изменения фиксируются одной транзакцией.
При повторе подтверждённого запроса возвращается прежняя квитанция, включая повтор после рестарта.

Резервная копия из server/ (pg_dump делает согласованный снимок работающей БД):

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U hackaton -d hackaton -Fc > backups/hackaton.dump
docker compose exec -T db pg_restore --list < backups/hackaton.dump
```

Храните копии отдельно от рабочего тома и Git. Восстановление выполняйте в отдельную пустую базу через pg_restore;
перед заменой рабочей БД остановите сервер и сохраните текущую копию.

## REST

Все ответы JSON; ошибка: {"error":"CODE"}. Регистрация/вход не принимают неизвестные поля.
Логин: 3–32 символа после TrimSpace; пароль: 8–72 байта; профиль по умолчанию business.

| Метод | Путь | Тело / результат |
|---|---|---|
| POST | /auth/register | {login,password,profile?}; 201, JWT и состояние |
| POST | /auth/login | {login,password}; 200, JWT и состояние |
| GET | /health | {status:"ok",db:"ok",total_chunks:100} |

Успех auth: {token,expires_at,player,known_words,inventory}.
player: {id,login,profile,x,z,rotation,balance}; хэш никогда не возвращается.
JWT живёт 8 часов. При истечении WS закрывается. /health проверяет БД, а не готовность Ollama.
Дублирование логина → 409 LOGIN_TAKEN; неверный пароль → 401 INVALID_CREDENTIALS.
Список ALLOWED_ORIGINS содержит точные http(s) origins без завершающего слеша; неизвестный Origin → 403.
Без Origin разрешены CLI/тестовые подключения с действительным токеном.

## WebSocket: контракт для DEV-C

GET /ws?token=<JWT>; для CLI также Authorization: Bearer <JWT>. Проверка до upgrade.
Один аккаунт — одна активная WS-сессия; второе соединение закрывается с кодом 1008.
Все игровые сообщения: {"type":"NAME","payload":{...}}. Максимальный входящий пакет 8 KiB.
До 60 сообщений/сек на соединение (MOVE рекомендуется 20 Гц), чат — одно сообщение/сек, максимум 500 символов.
Ping каждые 20 секунд; клиент должен отвечать Pong. Браузер делает это автоматически.

### Клиент → сервер

| type | payload |
|---|---|
| MOVE | {x,z,rotation}; обязательные конечные числа, 0 ≤ x,z < 200, rotation в радианах |
| CHAT | {text}; локальная рассылка игрокам, видящим отправителя |
| DIALOGUE | {npc_id}; начать/повторно открыть разговор в радиусе 5 |
| DIALOGUE | {npc_id,choice_id,turn_id}; выбрать актуальную серверную реплику |
| INSPECT | {item_id}; получить квиз в радиусе 5 |
| INSPECT | {item_id,answer_id,quiz_id}; ответить на активный квиз |
| TRADE_START | {npc_id,item_id}; открыть персональное предложение покупки |
| CALCULATOR | {npc_id,item_id,trade_id,amount}; подтвердить сумму калькулятора |

Повторный ответ квиза с использованным quiz_id → STALE_QUIZ.
Во время AI-запроса следующий DIALOGUE → DIALOGUE_BUSY; движение и чат продолжаются.
Устаревший turn_id → STALE_CHOICE. Чужой/несуществующий вариант отклоняется.
DIALOGUE без choice_id возвращает существующий общий ход, если он уже есть. Не передавайте шкалы, произвольный текст диалога или признак правильного ответа.
В CALCULATOR передаётся предложенная сумма; её допустимость определяет сервер.

### Сервер → клиент

| type | payload |
|---|---|
| WELCOME | {player,known_words,inventory,world:{total_chunks,total_bytes,chunk_size,max_percent}} |
| CHUNK_LOAD | {chunk_id,buildings,lanterns,signs,npcs,items} |
| CHUNK_UNLOAD | {chunk_ids:[...]} |
| WORLD_STATS | {loaded_chunks,total_chunks,loaded_bytes,total_bytes,data_percent,chunk_percent} |
| PLAYER_JOIN | {id,login,profile,x,z,rotation,balance} |
| PLAYER_LEAVE | {player_id} |
| PLAYER_MOVE | {player_id,x,z,rotation} |
| CHAT | {player_id,login,text} |
| DIALOGUE_PENDING | {npc_id,player_id}; один запрос AI для NPC |
| DIALOGUE_DONE | {npc_id,status,scene_version}; status: completed, cancelled, error |
| NPC_SPEECH | {npc_id,player_id,tokens,choices,turn_id,emotion,mianzi,aggro,price,state,fallback,offers,scene_version} |
| NPC_STATE | {npc_id,state,mianzi,aggro,price,scene_version,turn_id,offers,busy} |
| NPC_LEAVE | {npc_id}; выход за радиус 15 |
| TRADE_OPEN | {trade_id,npc_id,item_id,price,balance,expires_at,scene_version,word} |
| TRADE_RESULT | {status:"purchased",receipt,replayed} либо {status:"rejected",trade_id,reason:"PRICE_TOO_LOW"} |
| BALANCE | {balance,delta}; при повторе квитанции delta=0 |
| INVENTORY | {items:[{item_id,price_paid}]} |
| PURCHASE | {player_id,npc_id,item_id,amount}; публичное событие, без личного баланса |
| QUIZ | {quiz_id,item_id,audio_text,options:[{id,zh,py,ru}]} |
| QUIZ_RESULT | {correct,item_id,new?} |
| WORD_LEARNED | {word_id,zh,py,ru} |
| ERROR | {code} |

Ошибки: INVALID_MOVE, INVALID_CHAT, CHAT_RATE_LIMIT, RATE_LIMIT, UNKNOWN_PACKET,
INVALID_DIALOGUE, NPC_OUT_OF_RANGE, DIALOGUE_BUSY, STALE_CHOICE, INVALID_CHOICE,
INVALID_INSPECT, ITEM_OUT_OF_RANGE, STALE_QUIZ, INVALID_ANSWER, DB_ERROR,
INVALID_TRADE, INVALID_PRODUCT, DIALOGUE_REQUIRED, NPC_AGGRO, ITEM_ALREADY_OWNED,
TRADE_EXPIRED, STALE_TRADE, INSUFFICIENT_FUNDS.
При сетевой ошибке или DB_ERROR после подтверждения повторяйте CALCULATOR с тем же trade_id и параметрами:
квитанция позволяет узнать результат без повторного списания. Для устаревшей/просроченной сделки нужен новый TRADE_START.
Текст чата и NPC выводите через textContent, без интерпретации HTML.

### Мир и память

Мир: 10×10 чанков, каждый 20×20 единиц. chunk_id = xIndex_zIndex.
Координаты объектов внутри чанка локальные: прибавлять (xIndex*20,zIndex*20).
buildings: [{type,x,z}], lanterns: [{x,y,z}], signs: [{text,x,y,z}], npcs: [{npc_id,x,y,z}], items: [{item_id,x,y,z}]. Предметы для осмотра приходят в чанках; полный каталог и правильные ответы остаются на сервере.
Каталог и весь мир клиенту не выдаются.

AOI — текущий и ближайшие соседние чанки, максимум 9; при разном размере набор сокращается,
чтобы сумма размеров не превышала 10% всех чанков. Чанк, который один превышает бюджет, отклоняется при старте.
CHUNK_UNLOAD всегда предшествует CHUNK_LOAD. Сначала освободите старую геометрию, текстуры и ссылки, затем создавайте новую.

loaded_bytes/total_bytes — размер канонического JSON содержимого чанков в UTF-8, без WS-оболочки.
Это метрика переданных данных мира, а не измерение RAM/GPU. Если C добавляет модели/текстуры, их размеры и жизненный цикл
нужно включить в общий бюджет отдельно; 9 чанков само по себе не доказывает 9% RAM.
WORLD_STATS должен отображаться без подмены data_percent значением chunk_percent.

### Словарь и диалоги

world/catalog.json — канонический каталог слов, NPC, предметов и стартовых профилей.
business знает цифры/торг, culture — предметы/этикет; word_teapot открывается через квиз teapot.
Token: {id?,zh,py,ru}. Неизвестный id имеет ru="[???]"; ID-less токены — открытый связующий текст без китайских иероглифов; китайские слова требуют ID.
Четыре выбора: {id,zh,py,ru,type}, всегда с переводом для удобства новичка.

NPC_SPEECH получают игроки в радиусе 15 с индивидуальной фильтрацией. В радиусе 5 все участники получают
одни варианты и turn_id; на расстоянии 5–15 choices:[] и turn_id:"". player_id — автор последнего действия.
Новый игрок и игрок после реконнекта получают актуальную сцену. Любой участник может продолжить торг и снизить агрессию,
но каждый платит из собственного кошелька и получает предмет в собственный инвентарь.
После WORD_LEARNED обновляется только актуальная реплика; старая реплика после покупки/отмены не возвращается.
На NPC_STATE с пустым turn_id очищайте старые кнопки. DIALOGUE_DONE снимает ожидание и при ошибке/отключении инициатора.
fallback:true означает резервный FSM; это нужно отображать в отладке, не выдавая его за работающую LLM.

## AI: контракт для DEV-B

Go → POST AI_URL/dialogue, Content-Type: application/json:

```json
{
  "npc_id":"lao_wang",
  "player_message":"老板，便宜点吧！ — Босс, сделай скидку!",
  "context":{
    "price":800,"price_floor":120,"mianzi":50,"aggro":0,
    "history":[{"role":"user","content":"Привет!"},{"role":"assistant","content":"Hello friend!"}],
    "scene_history":[{"role":"user","content":"alice: Привет!"},{"role":"assistant","content":"Hello friend!"}],
    "npc_kind":"merchant"
  }
}
```

Ожидается оболочка {"raw":"...","parsed":{...}}. В parsed обязательны:
speech_tokens[], emotion, price_new, mianzi_delta, aggro_delta, fsm_state, choices[4].
price_new — целое число ≥ price_floor и ≤100000. Дельты целые в [-30,30].
fsm_state: IDLE, CALLING, HAGGLING, FLATTERED, SUSPICIOUS, AGGRO.
emotion: neutral, angry, happy, suspicious.
choice.type: polite, haggle, provoke, leave, bluff, order, documents, bribe, directions; choice.id — уникальное положительное число.
Тексты непустые; токены с id должны точно соответствовать каталогу zh/py/ru. Китайские иероглифы без id отклоняются, чтобы не обходить словарный фильтр.
Промпт B должен получать канонические слова из world/catalog.json; новые слова сначала добавляются в каталог.
Все обязательные поля должны присутствовать даже при нулевых дельтах.

Таймаут 15 секунд, предел ответа 64 KiB. HTTP-ошибка, неверный JSON, неизвестные слова или нарушение схемы → FSM fallback.
Выборы и допустимость действий проверяет Go. После ответа шкалы ограничиваются 0–100; Aggro>75 переводит NPC в AGGRO,
Mianzi>70 при активном торге — в FLATTERED. price_floor из ответа модели не принимается.
history — личные последние 6 сообщений, scene_history — последние 6 сообщений общего разговора с именами участников;
npc_kind: merchant, chef или guard. Состояние/цена общие, история об игроке отдельная.
Попытка взятки guard даёт Aggro=100 и AGGRO независимо от ответа модели.
История, новый статус, цена и версия записываются до отправки NPC_SPEECH.

## Что проверяют тесты

Транзакционный откат регистрации, FK/CHECK/cascade, уникальность слов, миграции и настройки PostgreSQL;
персистентность после закрытия/повторного открытия; JWT/Origin/пароли;
AOI у границ и при неравных размерах; FSM и AI-контракт/отмена;
два реальных WS-клиента, движение при медленном AI без удержания БД, персональные субтитры,
квиз и обновление перевода, порядок выгрузки/загрузки и восстановление после рестарта.

Настоящая Ollama/FastAPI, Three.js, GPU-память и два физических устройства проверяются отдельно после готовности B/C.

## Торговля: последовательность для DEV-C

1. Открыть DIALOGUE у NPC. Из NPC_STATE/NPC_SPEECH взять offers — доступные item_id.
2. Отправить TRADE_START с npc_id/item_id. Новый TRADE_START заменяет предыдущее неподтверждённое предложение игрока.
3. Сохранить TRADE_OPEN: trade_id, scene_version и expires_at. price — текущая цена продавца.
   Минимальный порог скрыт и остаётся на сервере. Показать QTE и локальный таймер 30 секунд.
4. Передать целую сумму 1–100000 в CALCULATOR вместе с исходными npc_id/item_id/trade_id.
5. При успехе обновить инвентарь/баланс и закрыть калькулятор. receipt имеет поля:
   {trade_id,player_id,npc_id,item_id,amount,balance_after}. balance_after — исторический баланс;
   для текущего HUD используйте BALANCE, особенно при повторе старой квитанции.
6. Сумма ниже порога даёт rejected без списания, повышает агрессию и закрывает предложение.
   INSUFFICIENT_FUNDS сохраняет предложение: можно повторить меньшую сумму до expires_at.
7. Следующая реплика, покупка или смена версии NPC делает старую сделку недействительной.
   После выхода из радиуса взаимодействия, отключения либо рестарта неподтверждённое предложение закрыто.
8. Подтверждённую квитанцию можно запросить повтором того же CALCULATOR после реконнекта/рестарта,
   без требования повторно подойти к NPC. Другой игрок или изменённые параметры не принимаются.

Если два игрока одновременно подтверждают одну версию сцены, проходит первая покупка,
вторая получает STALE_TRADE и должна открыть новое предложение. У каждого свой экземпляр товара:
после нового открытия второй игрок также может купить предмет. Один item_id покупается один раз на аккаунт.
Сервер проверяет итог суммы, но не тайминг нажатий Space; визуальную часть QTE делает C.

## NPC и товары

| NPC | kind | Чанк / мировые координаты | Товар | Старт / минимум |
|---|---|---|---|---|
| Лао Ван (lao_wang) | merchant | 5_6 / (100,124) | jade_amulet | 800 / 120 |
| Повар Чэнь (chef_chen) | chef | 3_5 / (70,110) | noodles | 150 / 40 |
| Охранник Чжан (guard_zhang) | guard | 7_2 / (150,50) | не продаёт | 0 / 0 |

Каталог содержит 28 слов. Предметы для INSPECT: teapot, jade_amulet, noodles, ticket.
Повар предлагает варианты «без острого/арахиса», охранник — документы/дорогу/взятку/извинение.
Эти варианты управляют диалогом и FSM; отдельной симуляции аллергии, проверки настоящего билета или прохода через турникет пока нет.
Локальные резервные реплики различаются; полноценные генеративные промпты этих NPC обеспечивает B.

Дополнительные тесты этапов 5–8: совместное снижение агрессии, личные кошельки, конкурирующие покупки,
недостаток денег, ошибки записи после списания, повторы и чужие квитанции, просроченные сделки,
переподключение без рестарта, восстановление сцены и покупки после рестарта,
радиус рассылки 15 / действий 5, таймаут и освобождение занятого NPC после отключения.
