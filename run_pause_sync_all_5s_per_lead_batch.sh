#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:3000/api/v1/bitrix/leads/pause-sync"
BATCH="${1:-20}"              # сколько лидов за один прогон
PER_LEAD_SEC="${2:-5}"        # 5 секунд на лид (как ты просил)
WITH_IDS="${3:-0}"
ID_LIMIT="${4:-20}"

LOCK="/tmp/pause_sync_full_5s_batch.lock"
LOG="var/pause_sync_full_5s_batch.log"
mkdir -p var

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Already running (lock $LOCK)"
  exit 1
fi

echo "==> Start: batch=$BATCH, perLead=${PER_LEAD_SEC}s (sleep between calls = $((BATCH*PER_LEAD_SEC))s)" | tee -a "$LOG"

ITER=0
while true; do
  ITER=$((ITER+1))
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  RESP="$(curl -sS --connect-timeout 10 --max-time 30 \
    "${URL}?maxLeads=${BATCH}&withIds=${WITH_IDS}&idLimit=${ID_LIMIT}")"

  echo "[$TS] iter=$ITER $(echo "$RESP" | jq -c '{ok,error,startFrom,processed,movedToPause,restoredFromPause,commentsToPause,commentsRestore,skippedMeasure,skippedNoTaskId,skippedTaskNotFound,skippedWrongTaskTitle,skippedNoPrevStage,errors,nextCursor}')" | tee -a "$LOG"

  OK="$(echo "$RESP" | jq -r '.ok')"
  ERR="$(echo "$RESP" | jq -r '.error // ""')"

  # если Bitrix сказал "Too many requests" — отступаем сильнее
  if [[ "$OK" != "true" && "$ERR" == *"QUERY_LIMIT_EXCEEDED"* ]]; then
    echo "[$TS] Bitrix rate limit hit -> sleep 60s" | tee -a "$LOG"
    sleep 60
    continue
  fi

  START_FROM="$(echo "$RESP" | jq -r '.startFrom // 0')"
  NEXT_CURSOR="$(echo "$RESP" | jq -r '.nextCursor // 0')"

  # дошли до конца: курсор сброшен в 0
  if [[ "$NEXT_CURSOR" == "0" && "$START_FROM" != "0" ]]; then
    echo "[$TS] DONE: reached end, cursor reset to 0" | tee -a "$LOG"
    break
  fi

  sleep "$((BATCH * PER_LEAD_SEC))"
done

echo "==> Finished" | tee -a "$LOG"
