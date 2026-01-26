#!/usr/bin/env bash
set -euo pipefail

# Сначала чистим PM2-логи
pm2 flush

# Потом чистим файловые логи проекта
cd "$(dirname "$0")/.."
rm -rf logs
mkdir -p logs

echo "Logs cleaned: PM2 + ./logs"
