#!/usr/bin/env bash
set -euo pipefail

SLEEP="${1:-5}"
IDS_FILE="${2:-var/pause_leads_ids.txt}"
OUT_JSONL="${3:-var/pause_audit_results.jsonl}"
OUT_SUMMARY="${4:-var/pause_audit_summary.txt}"

mkdir -p var

if [[ ! -f "$IDS_FILE" ]]; then
  echo "No ids file: $IDS_FILE" >&2
  exit 1
fi

: > "$OUT_JSONL"

echo "==> Audit pause leads. sleep=${SLEEP}s ids_file=${IDS_FILE}"
echo "==> Writing results: $OUT_JSONL"

# читаем ids, убираем \r, пробелы, фильтруем только числа
tail -n +2 "$IDS_FILE" | tr -d '\r' | while read -r raw; do
  id="$(echo "$raw" | tr -d '[:space:]')"
  [[ -z "$id" ]] && continue
  [[ ! "$id" =~ ^[0-9]+$ ]] && echo "[skip] bad id line: '$raw'" && continue

  resp="$(curl -sS --max-time 60 "http://127.0.0.1:3000/api/v1/bitrix/leads/${id}/pause-sync" || true)"

  if echo "$resp" | grep -q "QUERY_LIMIT_EXCEEDED"; then
    echo "{\"leadId\":$id,\"ok\":false,\"error\":\"QUERY_LIMIT_EXCEEDED\"}" >> "$OUT_JSONL"
    echo "[lead=$id] Bitrix rate limit -> sleep 60s"
    sleep 60
  else
    echo "$resp" >> "$OUT_JSONL"
    sleep "$SLEEP"
  fi
done

echo "==> Done. Building summary: $OUT_SUMMARY"

node - "$OUT_JSONL" > "$OUT_SUMMARY" <<'NODE'
const fs=require('fs');
const path=process.argv[2]; // <-- вот тут теперь правильно
const lines=fs.readFileSync(path,'utf8').trim().split('\n').filter(Boolean);

const by={};
let total=0;

for (const line of lines) {
  total++;
  let o;
  try { o=JSON.parse(line); } catch { continue; }

  let key = o.action || 'no_action';
  if (o.ok === false) key = o.error ? `error:${o.error}` : 'error';
  if (o.skipped) key = `skipped:${o.skipped}`;

  by[key] = by[key] || { count: 0, ids: [] };
  by[key].count++;
  if (o.leadId) by[key].ids.push(o.leadId);
}

const keys = Object.keys(by).sort((a,b)=>by[b].count-by[a].count);

let out = `TOTAL=${total}\n\n`;
for (const k of keys) {
  out += `${k}: ${by[k].count}\n`;
  out += `ids_sample: ${by[k].ids.slice(0,50).join(', ')}\n\n`;
}
process.stdout.write(out);
NODE

echo "==> Summary ready: $OUT_SUMMARY"
