#!/bin/bash
# DEV-D: автокоммит. Cron раз в 30 мин:
#   */30 * * * * /bin/bash /path/to/repo/ops/backup.sh >> /tmp/hackaton-backup.log 2>&1
# Только код: server/data/ (game.db) и server/.env в .gitignore.
# Копию game.db делать после штатной остановки сервера (WAL, см. server/README.md).
cd "$(dirname "$0")/.." || exit 1
git add -A
git commit -m "auto: backup $(date '+%H:%M')" >/dev/null 2>&1 && echo "✅ Backup OK" || echo "ℹ️ No changes"
