# Rest-In-Hackaton — integrated stack

Ветка `integration-max` объединяет frontend, Go backend, PostgreSQL, FastAPI и ассеты NPC. `main` не изменяется.

## Запуск в WSL

Из Linux-каталога `/home/klumaks/hack_2026/Rest-In-Hackaton`:

```bash
python3 -m venv ai/.venv
ai/.venv/bin/pip install -r ai/requirements.txt
npm ci --prefix client
python3 ops/dev.py --mock
```

Открыть `http://localhost:5173`. Нужны Docker с Compose V2, Go 1.26 (`/usr/local/go/bin/go`), Node.js 20+ и Python 3.12. Скрипт создаёт отсутствующий `server/.env`, поднимает только PostgreSQL данного проекта, собирает Go и запускает три сервиса. Ctrl+C штатно останавливает дочерние процессы; БД и том остаются. Логи — `.integration/{client,server,ai}.log`, в Git не попадают.

`--mock` задаёт `MOCK_MODE=1`: FastAPI не обращается к LLM, а TTS использует формантный синтез без Kokoro. Скрипт никогда не запускает Ollama/llama-server, не скачивает веса и не поднимает нейросети. Для подключения к уже доступному внешнему inference-серверу запускать без `--mock` и задать `LLAMA_SERVER_URL`, `LLAMA_HEALTH_URL`, `LLM_MODEL` в окружении. `TTS_BACKEND=formant` отдельно запрещает загрузку нейросетевого TTS.

Для изолированной проверки вместо рабочих игровых данных:

```bash
python3 ops/dev.py --mock --test-db
# В другом терминале:
python3 ops/integration_smoke.py
```

`--test-db` создаёт временную схему в `hackaton_test`, переключает Go на неё и удаляет схему при штатной остановке. Нужен `psql` для создания/очистки схемы. Не завершать проверочный процесс через SIGKILL, если нужна автоматическая очистка.

## Соединения и настройки

| Слой | Адрес | Назначение |
|---|---|---|
| Vite | `:5173` | Клиент, прокси `/ai/*` к FastAPI |
| Go | `:3000` | `/health`, `/auth/register`, `/auth/login`, `/ws?token=…` |
| FastAPI | `127.0.0.1:8000` | `/health`, `/dialogue`, GET/POST `/tts` |
| PostgreSQL | `127.0.0.1:5433` | `hackaton` / `hackaton_test` |

Настройки Go и БД находятся в `server/.env`; примеры — `server/.env.example`. Секреты не коммитить. `AI_URL` указывает на FastAPI, а не непосредственно на LLM. Адрес AI-прокси Vite — `127.0.0.1:8000`.

Для LAN добавить точный `http://<IP-хоста>:5173` в `ALLOWED_ORIGINS` в `server/.env` до запуска. Клиент использует имя хоста страницы для Go; FastAPI доступен браузеру через Vite-прокси. Доступ из LAN к WSL зависит от проброса портов и Windows Firewall; проверка на двух физических устройствах здесь не проводилась. Для статического production-хостинга настроить такой же `/ai` reverse proxy; `vite preview` уже содержит его для локальной проверки сборки.

`?demo=true` / `?mock=true` включает самостоятельное клиентское демо. Онлайн-сессия после сетевой ошибки остаётся отключённой и переподключается к Go; её состояние не подменяется локальным MockServer.

## Игровые действия

- Регистрация/вход получают JWT; WELCOME восстанавливает позицию, баланс, словарь и инвентарь.
- F — диалог с ближайшим NPC из загруженных серверных чанков. Первый запрос без `choice_id`, следующие — с серверным `turn_id`. Варианты используют `zh/py/ru`.
- E — квиз ближайшего предмета: сервер отдаёт варианты и `quiz_id`, проверяет ответ и сообщает `QUIZ_RESULT` / `WORD_LEARNED`.
- Enter открывает ввод локального чата. В панели игроков — чат, инвентарь и доступные покупки. «Купить» получает `TRADE_OPEN`; подтверждение суммы передаёт `trade_id`, NPC и товар. Срок предложения — 30 секунд; баланс и предметы обновляются только по ответам Go. Это форма суммы; отдельная визуальная QTE-мини-игра ещё не реализована.
- Онлайн-геометрия строится только для `CHUNK_LOAD`, выгружается с GPU-ресурсами по `CHUNK_UNLOAD`. HUD показывает серверный `WORLD_STATS.data_percent`, а не оценку всей RAM/VRAM. Полная декоративная карта и глобальное мощение из фронтенд-ветки доступны в самостоятельном демо, онлайн используются объекты серверных чанков.
- Модели Лао Вана и повара берутся из `models`; копии runtime-ассетов расположены в `client/public/models/vendors`. Исходники, манифест и описание — `assets/models/vendors`.
- Реплики и новые слова озвучиваются через `/ai/tts`, при недоступности аудио остаётся браузерный синтез.

## Проверки

```bash
cd client
npm run build
npm test
cd ../server
set -a
source .env
set +a
/usr/local/go/bin/go test -count=1 -timeout 90s ./...
/usr/local/go/bin/go vet ./...
python3 scripts/process_smoke.py
```

Go-тестам нужны PostgreSQL и `TEST_DATABASE_URL`. Они используют временные схемы. `process_smoke.py` проверяет SIGTERM, рестарт Go, сохранность покупки/сцены и повтор квитанции; без `--restart-db` работающий контейнер не перезапускается. `ops/integration_smoke.py` проверяет живые HTTP/WS-сервисы в mock-режиме: auth/ошибки, каталог и оболочку AI, WAV, двух игроков, движение, чат, диалог, квиз, покупку, выгрузку чанков и повторный вход. Эти проверки не запускают и не оценивают модель.

## Включённые ветки

База: `origin/main` (`d15a5e7`), уже содержит `feature/auth`, PostgreSQL из `role_A_back` и обновлённый AI. Дополнительно объединены `models` (`ba24562`), frontend `с` — имя кириллицей (`d37babc`) и `role_D_QA` (`6e2af9c`). Конфликт `ops/demo-script.md` разрешён с сохранением QA-сценариев и актуального PostgreSQL вместо SQLite.
