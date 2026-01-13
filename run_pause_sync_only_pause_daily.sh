#!/usr/bin/env bash
set -euo pipefail

SLEEP="${1:-5}"

mkdir -p var

echo "==> Daily pause-only sync. sleep=${SLEEP}s"
echo "==> Build pause list..."

# Получаем список ID лидов в паузе
node - <<'NODE' > var/pause_leads_ids_daily.txt
const axios=require('axios'); require('dotenv').config({path:'.env'});
const base=(process.env.BITRIX_WEBHOOK_BASE||process.env.BITRIX_WEBHOOK_URL||'').replace(/\/$/,'');
const PAUSE='UC_79QMBF';

async function call(method, params){
  const r=await axios.post(`${base}/${method}.json`, params||{}, {timeout:20000});
  return r.data;
}

(async()=>{
  let start=0;
  const ids=[];
  while (true) {
    const data = await call('crm.lead.list', {
      order: { ID:'ASC' },
      filter: { STATUS_ID: PAUSE },
      select: ['ID'],
      start
    });
    for (const it of (data.result||[])) ids.push(Number(it.ID));
    if (data.next == null) break;
    start = data.next;
  }
  console.log(`PAUSE=${PAUSE} count=${ids.length}`);
  for (const id of ids) console.log(id);
})().catch(e=>{
  console.log('ERR', e.response?.status, e.response?.data?.error, e.response?.data?.error_description||e.message);
});
NODE

echo "==> Pause list ready: $(wc -l < var/pause_leads_ids_daily.txt) lines"

# Прогоняем каждый лид через точечный эндпоинт
echo "==> Run per-lead pause-sync..."
OUT="var/pause_sync_only_pause_daily.jsonl"
: > "$OUT"

tail -n +2 var/pause_leads_ids_daily.txt | tr -d '\r' | while read -r raw; do
  id="$(echo "$raw" | tr -d '[:space:]')"
  [[ -z "$id" ]] && continue
  [[ ! "$id" =~ ^[0-9]+$ ]] && echo "[skip] bad id: '$raw'" && continue

  resp="$(curl -sS --max-time 60 "http://127.0.0.1:3000/api/v1/bitrix/leads/${id}/pause-sync" || true)"

  if echo "$resp" | grep -q "QUERY_LIMIT_EXCEEDED"; then
    echo "{\"leadId\":$id,\"ok\":false,\"error\":\"QUERY_LIMIT_EXCEEDED\"}" >> "$OUT"
    echo "[lead=$id] Bitrix rate limit -> sleep 60s"
    sleep 60
  else
    echo "$resp" >> "$OUT"
    sleep "$SLEEP"
  fi
done

echo "==> Done. Results: $OUT"

# Короткая сводка в лог
node - <<'NODE' "$OUT"
const fs=require('fs');
const path=process.argv[1];
const lines=fs.readFileSync(path,'utf8').trim().split('\n').filter(Boolean);
const by={};
for (const line of lines){
  let o; try{o=JSON.parse(line);}catch{continue;}
  let key=o.action||'no_action';
  if(o.ok===false) key=o.error?`error:${o.error}`:'error';
  if(o.skipped) key=`skipped:${o.skipped}`;
  by[key]=(by[key]||0)+1;
}
console.log("==> SUMMARY");
Object.entries(by).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`${k}: ${v}`));
NODE
