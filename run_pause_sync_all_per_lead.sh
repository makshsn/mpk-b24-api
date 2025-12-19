#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:3000/api/v1/bitrix/leads/pause-sync"
SLEEP_SEC="${1:-5}"       # 5 секунд на лид
WITH_IDS="${2:-0}"        # 1 если хочешь ids в ответе (тяжелее)
ID_LIMIT="${3:-20}"

LOCK="/tmp/pause_sync_full_per_lead.lock"
LOG="var/pause_sync_full_per_lead.log"
mkdir -p var

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "Already running (lock $LOCK)"
  exit 1
fi

echo "==> Start per-lead run (maxLeads=1, sleep=${SLEEP_SEC}s)" | tee -a "$LOG"
ITER=0

while true; do
  ITER=$((ITER+1))
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  RESP="$(curl -fsS "${URL}?maxLeads=1&withIds=${WITH_IDS}&idLimit=${ID_LIMIT}")"

  echo "[$TS] iter=$ITER $(echo "$RESP" | jq -c '{startFrom,processed,movedToPause,restoredFromPause,commentsToPause,commentsRestore,skippedFinal,skippedStageNotAllowed,skippedPrevStageNotAllowed,skippedMeasure,skippedNoTaskId,skippedTaskNotFound,skippedWrongTaskTitle,skippedNoPrevStage,errors,nextCursor}')" | tee -a "$LOG"

  START_FROM="$(echo "$RESP" | jq -r '.startFrom')"
  NEXT_CURSOR="$(echo "$RESP" | jq -r '.nextCursor')"

  # дошли до конца — курсор сбросился в 0
  if [[ "$NEXT_CURSOR" == "0" && "$START_FROM" != "0" ]]; then
    echo "[$TS] DONE: reached end, cursor reset to 0" | tee -a "$LOG"
    break
  fi

  sleep "$SLEEP_SEC"
done

echo "==> Finished" | tee -a "$LOG"
