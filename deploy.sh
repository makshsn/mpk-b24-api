#!/usr/bin/env bash
set -euo pipefail

cd /var/www/mpk-b24-api

echo "==> Git status"
git status --porcelain || true

echo "==> Add + commit (если есть изменения)"
if [ -n "$(git status --porcelain)" ]; then
  git add .
  git commit -m "deploy: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
else
  echo "Нет изменений — коммит не нужен"
fi

echo "==> Push"
git push

echo "==> Install deps (prod)"
npm ci --omit=dev

echo "==> Restart pm2"
pm2 restart mpk-b24-api --update-env
pm2 save

echo "==> Health"
curl -s -i http://127.0.0.1:3000/health | head -n 20
