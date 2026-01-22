'use strict';

const bitrix = require('../services/bitrix/bitrixClient');
const cfg = require('../config/spa1048');

const ENTITY_TYPE_ID = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
const STAGE_PAID = String(process.env.SPA1048_STAGE_PAID || 'DT1048_14:SUCCESS');

const FINAL_STAGES_RAW = String(process.env.SPA1048_STAGE_FINAL || '');
const FINAL_STAGES = FINAL_STAGES_RAW
  .split(',')
  .map(s => s.trim().replace(/^['"]+|['"]+$/g, ''))
  .filter(Boolean);

const TASK_FIELD_ORIG = String(process.env.SPA1048_TASK_ID_FIELD_ORIG || cfg.taskIdFieldOrig || 'UF_CRM_8_TASK_ID');
const TASK_FIELD_CAMEL = String(process.env.SPA1048_TASK_ID_FIELD_CAMEL || cfg.taskIdFieldCamel || '');

const INTERVAL_MS = Number(process.env.SPA1048_TASK_STATUS_WATCHER_INTERVAL_MS || 60 * 60 * 1000);
const PAGE_SIZE = Number(process.env.SPA1048_TASK_STATUS_WATCHER_PAGE_SIZE || 50);
const MAX_PAGES = Number(process.env.SPA1048_TASK_STATUS_WATCHER_MAX_PAGES || 200);

const COMPLETED_STATUS = 5;

function nowIso() { return new Date().toISOString(); }

function pickTaskIdFromItem(item) {
  const raw = item?.[TASK_FIELD_ORIG] ?? item?.[TASK_FIELD_CAMEL];
  if (raw === undefined || raw === null || raw === '') return null;

  // Битрикс может вернуть строку/число
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isFinalStage(stageId) {
  const s = String(stageId || '').trim();
  return FINAL_STAGES.includes(s);
}

async function crmItemListPage(start) {
  // В crm.item.list у Bitrix фильтры по "не равно" бывают капризные,
  // поэтому проще фильтровать финальные стадии в коде.
  return await bitrix.call('crm.item.list', {
    entityTypeId: ENTITY_TYPE_ID,
    select: ['id', 'stageId', TASK_FIELD_ORIG, TASK_FIELD_CAMEL].filter(Boolean),
    order: { id: 'asc' },
    start,
  });
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS', 'CLOSED_DATE', 'TITLE'],
  });
  return r?.result?.task || r?.task || r?.result || null;
}

async function updateStage(itemId) {
  return await bitrix.call('crm.item.update', {
    entityTypeId: ENTITY_TYPE_ID,
    id: Number(itemId),
    fields: { stageId: STAGE_PAID },
  });
}

let running = false;

async function runOnce() {
  if (running) return;
  running = true;

  const stats = {
    ts: nowIso(),
    scanned: 0,
    skippedFinal: 0,
    skippedNoTask: 0,
    taskNotFound: 0,
    taskNotCompleted: 0,
    updated: 0,
    errors: 0,
  };

  try {
    let start = 0;
    let page = 0;

    while (page < MAX_PAGES) {
      page++;

      const resp = await crmItemListPage(start);
      const result = resp?.result || resp;
      const items = result?.items || [];
      const next = result?.next;

      if (!Array.isArray(items) || items.length === 0) break;

      for (const it of items) {
        stats.scanned++;

        const itemId = Number(it?.id || it?.ID);
        const stageId = it?.stageId;

        if (isFinalStage(stageId)) {
          stats.skippedFinal++;
          continue;
        }

        const taskId = pickTaskIdFromItem(it);
        if (!taskId) {
          stats.skippedNoTask++;
          continue;
        }

        let task;
        try {
          task = await getTask(taskId);
        } catch (e) {
          stats.errors++;
          console.log('[spa1048-task-status] task.get error', { itemId, taskId, err: String(e?.message || e) });
          continue;
        }

        if (!task) {
          stats.taskNotFound++;
          continue;
        }

        const status = Number(task?.status || task?.STATUS);
        if (status !== COMPLETED_STATUS) {
          stats.taskNotCompleted++;
          continue;
        }

        try {
          await updateStage(itemId);
          stats.updated++;
          console.log('[spa1048-task-status] updated', { itemId, taskId, to: STAGE_PAID });
        } catch (e) {
          stats.errors++;
          console.log('[spa1048-task-status] item.update error', { itemId, taskId, err: String(e?.message || e) });
        }
      }

      if (next === undefined || next === null) break;
      start = Number(next) || 0;
      if (!start) break;
    }
  } catch (e) {
    stats.errors++;
    console.log('[spa1048-task-status] fatal error', { err: String(e?.message || e) });
  } finally {
    console.log('[spa1048-task-status] done', stats);
    running = false;
  }
}

async function main() {
  console.log('[spa1048-task-status] started', {
    entityTypeId: ENTITY_TYPE_ID,
    paidStage: STAGE_PAID,
    finalStages: FINAL_STAGES,
    taskFieldOrig: TASK_FIELD_ORIG,
    taskFieldCamel: TASK_FIELD_CAMEL || null,
    intervalMs: INTERVAL_MS,
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  });

  // запуск сразу
  await runOnce();

  // потом раз в час
  setInterval(() => {
    runOnce().catch(() => {});
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error('[spa1048-task-status] crash', e);
  process.exit(1);
});
//http://mpk-b24-webhooks.online/b24/task-event