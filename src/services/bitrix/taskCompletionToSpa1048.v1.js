'use strict';

const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureObjectBody, verifyOutboundToken, extractTaskId } = require('./b24Outbound.v1');

const COMPLETED_STATUS = 5;

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

/**
 * Из ufCrmTask / UF_CRM_TASK вытаскиваем кандидатов itemId из формата:
 *  - "T418_58"
 *  - "T1048_58"
 *  - "t418-58" (на всякий)
 *  - "T418:58"
 * Берём только itemId (вторая часть), префикс игнорируем.
 */
function parseCandidateItemIds(ufCrmTask) {
  const bindings = normalizeBindings(ufCrmTask);

  // базовый формат Bitrix: T<любые цифры>_<id>
  const re = /T(\d+)[_:|-](\d+)/gi;
  const ids = [];

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      const itemId = parseNumber(match[2]);
      if (itemId && itemId > 0) ids.push(itemId);
    }
  }

  // unique
  return Array.from(new Set(ids));
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS', 'UF_CRM_TASK', 'TITLE', 'UF_*', '*'],
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

/**
 * Проверяем кандидатов через crm.item.get(entityTypeId=1048)
 * чтобы не обновить случайно не тот объект.
 */
async function resolveSpaItemIdFromTask(ufCrmTask, entityTypeId) {
  const candidates = parseCandidateItemIds(ufCrmTask);
  for (const id of candidates) {
    try {
      const r = await bitrix.call('crm.item.get', {
        entityTypeId: Number(entityTypeId),
        id: Number(id),
        select: ['id'],
      });
      const item = r?.result?.item || r?.item || null;
      if (item?.id || item?.ID) return Number(id);
    } catch (e) {
      // кандидат не подошёл — пробуем следующий
    }
  }
  return null;
}

async function handleTaskCompletionEvent(req, res) {
  ensureObjectBody(req);

  if (req.method === 'POST') {
    const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
    if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
  }

  const taskId = extractTaskId(req);
  const statusAfter = extractStatusAfter(req);
  const statusBefore = extractStatusBefore(req);
  const debug = req.method === 'GET' || String(req?.query?.debug || '') === '1';

  console.log('[task-event] incoming', {
    taskId,
    statusAfter,
    statusBefore,
    method: req.method,
  });

  if (!taskId) {
    return res.json({ ok: true, action: 'skip_no_taskId', debug });
  }

  if (statusBefore === COMPLETED_STATUS) {
    return res.json({
      ok: true,
      action: 'skip_already_completed',
      taskId,
      statusBefore,
      statusAfter,
      debug,
    });
  }

  if (statusAfter !== COMPLETED_STATUS) {
    return res.json({
      ok: true,
      action: 'skip_status_not_completed',
      taskId,
      statusBefore,
      statusAfter,
      debug,
    });
  }

  const task = await fetchTask(taskId);
  if (!task) {
    return res.status(500).json({ ok: false, error: 'task_not_found', taskId, debug });
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const stageId = process.env.SPA1048_STAGE_PAID || 'DT1048_14:SUCCESS';

  const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK || task?.uf_crm_task;
  const candidates = parseCandidateItemIds(ufCrmTask);
  const resolvedItemId = await resolveSpaItemIdFromTask(ufCrmTask, entityTypeId);

  console.log('[task-event] bindings', {
    taskId,
    ufCrmTask,
    candidates,
    resolvedItemId,
  });

  if (!resolvedItemId) {
    return res.json({
      ok: true,
      action: 'skip_no_spa_binding',
      taskId,
      statusAfter,
      debug,
      ...(debug ? { ufCrmTask, candidates, resolvedItemId: null } : {}),
    });
  }

  const updateResult = await updateSpaStage({
    itemId: resolvedItemId,
    stageId,
    entityTypeId,
  });

  console.log('[task-event] spa_stage_updated', {
    taskId,
    itemId: resolvedItemId,
    stageId,
    updateResult,
  });

  return res.json({
    ok: true,
    action: 'spa_stage_updated',
    taskId,
    itemId: resolvedItemId,
    statusAfter,
    stageId,
    debug,
    ...(debug ? { ufCrmTask, candidates, resolvedItemId } : {}),
  });
}

module.exports = { handleTaskCompletionEvent };
