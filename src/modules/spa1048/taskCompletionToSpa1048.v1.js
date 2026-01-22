'use strict';

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureObjectBody, verifyOutboundToken, extractTaskIdDetailed } = require('../../services/bitrix/b24Outbound.v1');

const COMPLETED_STATUS = 5;

// ====== simple dedupe cache for polling mode ======
const processed = new Map(); // taskId -> expireTs
function remember(taskId, ttlMs) {
  processed.set(String(taskId), Date.now() + ttlMs);
}
function seen(taskId) {
  const key = String(taskId);
  const exp = processed.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    processed.delete(key);
    return false;
  }
  return true;
}

// ====== helpers ======
function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(values) {
  for (const v of values) {
    const n = parseNumber(v);
    if (n !== null) return n;
  }
  return null;
}

function extractStatusAfter(req) {
  const b = ensureObjectBody(req);
  return pickFirstNumber([
    req?.query?.status,
    req?.query?.STATUS,
    req?.query?.statusAfter,
    req?.query?.STATUS_AFTER,
    b?.status,
    b?.STATUS,
    b?.statusAfter,
    b?.STATUS_AFTER,
    b?.data?.FIELDS_AFTER?.STATUS,
    b?.data?.FIELDS_AFTER?.status,
    b?.data?.FIELDS?.STATUS,
    b?.data?.FIELDS?.status,
    b?.FIELDS_AFTER?.STATUS,
    b?.FIELDS_AFTER?.status,
    b?.FIELDS?.STATUS,
    b?.FIELDS?.status,
  ]);
}

function extractStatusBefore(req) {
  const b = ensureObjectBody(req);
  return pickFirstNumber([
    req?.query?.statusBefore,
    req?.query?.STATUS_BEFORE,
    b?.statusBefore,
    b?.STATUS_BEFORE,
    b?.data?.FIELDS_BEFORE?.STATUS,
    b?.data?.FIELDS_BEFORE?.status,
    b?.FIELDS_BEFORE?.STATUS,
    b?.FIELDS_BEFORE?.status,
  ]);
}

function normalizeBindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function parseCrmTaskBindings(ufCrmTask) {
  const bindings = normalizeBindings(ufCrmTask);
  const parsed = [];

  // T418_58, T418:58, T418-58
  const reT = /T(?:_|:|-)?(\d+)[_:|-](\d+)/gi;
  // D1048_58, D_1048_58, D1048:58 etc
  const reD = /D(?:_|:|-)?(\d+)[_:|-](\d+)/gi;

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match;
    while ((match = reT.exec(text)) !== null) {
      const typeId = parseNumber(match[1]);
      const itemId = parseNumber(match[2]);
      if (typeId && itemId) parsed.push({ typeId, itemId, raw: text, kind: 'T' });
    }

    while ((match = reD.exec(text)) !== null) {
      const typeId = parseNumber(match[1]);
      const itemId = parseNumber(match[2]);
      if (typeId && itemId) parsed.push({ typeId, itemId, raw: text, kind: 'D' });
    }
  }

  return parsed;
}

/**
 * UF_CRM_TASK обычно содержит массив строк.
 * У тебя пример: ['T418_58'] где 418 = entityTypeId SPA, 58 = itemId
 *
 * Также поддержим D1048_58 / D_1048_58 etc (если где-то осталось).
 */
function findSpaItemId(ufCrmTask, preferredTypeIds) {
  const bindings = parseCrmTaskBindings(ufCrmTask);
  if (!bindings.length) return null;

  const preferred = preferredTypeIds.filter(Number.isFinite);

  const matched = bindings.find(binding => preferred.includes(binding.typeId));
  if (matched) return matched;

  return null;
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS', 'UF_CRM_TASK', 'TITLE', 'CLOSED_DATE', 'CHANGED_DATE'],
  });
  return unwrapTaskGet(result);
}

async function updateSpaStage({ itemId, stageId, entityTypeId }) {
  return await bitrix.call('crm.item.update', {
    entityTypeId,
    id: Number(itemId),
    fields: { stageId },
  });
}

// ====== polling mode (for empty GET webhook) ======
function isoMinusSeconds(sec) {
  return new Date(Date.now() - sec * 1000).toISOString();
}

function unwrapTaskList(resp) {
  // Bitrix обычно: { result: { tasks: [...] } }
  return resp?.result?.tasks || resp?.tasks || resp?.result || [];
}

/**
 * Выбираем недавно изменённые/закрытые задачи со статусом 5.
 * CHANGED_DATE для фильтра — чтобы быстро и надежно.
 */
async function listRecentlyCompletedTasks({ windowSec, limit }) {
  const since = isoMinusSeconds(windowSec);

  const r = await bitrix.call('tasks.task.list', {
    order: { CHANGED_DATE: 'DESC' },
    filter: { '>=CHANGED_DATE': since, STATUS: COMPLETED_STATUS },
    select: ['ID', 'STATUS', 'UF_CRM_TASK', 'TITLE', 'CHANGED_DATE', 'CLOSED_DATE'],
    start: 0,
  });

  const tasks = unwrapTaskList(r);
  return tasks.slice(0, limit);
}

async function pollAndUpdateSpa({ entityTypeId, stageId, windowSec, limit }) {
  const ttlSec = Number(process.env.TASK_EVENT_POLL_TTL_SEC || Math.max(120, windowSec * 2));
  const ttlMs = ttlSec * 1000;

  const tasks = await listRecentlyCompletedTasks({ windowSec, limit });

  const updated = [];
  let processedCount = 0;

  for (const t of tasks) {
    const taskId = Number(t?.id || t?.ID);
    if (!taskId) continue;
    if (seen(taskId)) continue;

    const ufCrmTask = t?.ufCrmTask || t?.UF_CRM_TASK;
    const binding = findSpaItemId(ufCrmTask, [entityTypeId, cfg.entityTypeId]);

    // помечаем как обработанную даже если без привязки — чтобы не долбить бесконечно
    remember(taskId, ttlMs);

    if (!binding?.itemId) continue;

    await updateSpaStage({ itemId: binding.itemId, stageId, entityTypeId });
    processedCount++;
    updated.push({ taskId, itemId: binding.itemId, ufCrmTask });
  }

  return { candidates: tasks.length, processed: processedCount, updated };
}

// ====== main handler ======
async function handleTaskCompletionEvent(req, res) {
  ensureObjectBody(req);

  // Если токен задан в env, будет проверяться; если env пуст — проверка пропускается.
  if (req.method === 'POST') {
    const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
    if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
  }

  /**
   * Bitrix Outgoing Webhook for tasks приходит как application/x-www-form-urlencoded.
   * Поля лежат в data[FIELDS_AFTER][TASK_ID] (например, ONTASKCOMMENTADD), поэтому
   * первым делом достаем TASK_ID из FIELDS_AFTER.
   */
  const { taskId, source: taskIdSource } = extractTaskIdDetailed(req);
  const statusAfter = extractStatusAfter(req);
  const statusBefore = extractStatusBefore(req);
  const debug = req?.query?.debug === '1';

  if (debug) {
    console.log('[task-event] taskId_source', { taskId, source: taskIdSource });
  }

  console.log('[task-event] incoming', {
    taskId,
    statusAfter,
    statusBefore,
    method: req.method,
  });

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const stageId = process.env.SPA1048_STAGE_PAID || 'DT1048_14:SUCCESS';
  const preferredTypeIds = [...new Set([entityTypeId, cfg.entityTypeId].filter(Number.isFinite))];

  // ==== EMPTY GET from Bitrix Outgoing Webhook ====
  // Bitrix иногда дергает URL без параметров. Тогда мы сами опрашиваем последние закрытые задачи.
  if (!taskId) {
    const windowSec = Number(process.env.TASK_EVENT_POLL_WINDOW_SEC || 120);
    const limit = Number(process.env.TASK_EVENT_POLL_LIMIT || 20);

    try {
      console.log('[task-event] poll_start', { windowSec, limit });
      const r = await pollAndUpdateSpa({ entityTypeId, stageId, windowSec, limit });
      console.log('[task-event] poll_done', r);

      return res.json({
        ok: true,
        action: 'polled',
        debug,
        ...r,
        hint: 'Bitrix sent empty GET; polling recent completed tasks.',
      });
    } catch (e) {
      const msg = e?.message || String(e);
      return res.status(500).json({ ok: false, action: 'poll_error', error: msg, debug });
    }
  }

  // ==== Normal mode (taskId present) ====
  const task = await fetchTask(taskId);
  if (!task) {
    return res.status(500).json({ ok: false, error: 'task_not_found', taskId, debug });
  }

  const taskStatus = parseNumber(task?.status || task?.STATUS);
  if (taskStatus !== COMPLETED_STATUS) {
    return res.json({
      ok: true,
      action: 'skip_not_completed',
      taskId,
      statusAfter,
      statusBefore,
      taskStatus,
      debug,
    });
  }

  const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;
  const binding = findSpaItemId(ufCrmTask, preferredTypeIds);
  const parsedBindings = parseCrmTaskBindings(ufCrmTask);

  console.log('[task-event] bindings', {
    taskId,
    ufCrmTask,
    foundItemId: binding?.itemId || null,
  });

  if (!binding?.itemId) {
    return res.json({
      ok: true,
      action: ufCrmTask ? 'skip_not_spa1048' : 'skip_no_spa_binding',
      taskId,
      statusAfter,
      taskStatus,
      debug,
      ufCrmTask,
      bindings: parsedBindings,
      preferredTypeIds,
    });
  }

  const updateResult = await updateSpaStage({
    itemId: binding.itemId,
    stageId,
    entityTypeId,
  });

  console.log('[task-event] spa_stage_updated', {
    taskId,
    itemId: binding.itemId,
    stageId,
    updateResult,
  });

  return res.json({
    ok: true,
    action: 'spa_stage_updated',
    taskId,
    itemId: binding.itemId,
    statusAfter,
    stageId,
    debug,
    ufCrmTask,
  });
}

module.exports = { handleTaskCompletionEvent };
