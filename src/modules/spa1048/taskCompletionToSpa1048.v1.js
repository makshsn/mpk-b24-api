'use strict';

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureObjectBody, extractTaskIdDetailed } = require('../../services/bitrix/b24Outbound.v1');

const COMPLETED_STATUS = 5;
const PDF_FILES_FIELD = 'UF_CRM_8_1768219060503';

// ===== helpers =====
function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
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
 * UF_CRM_TASK для SPA: тип в HEX после 'T', itemId — decimal.
 * Пример: T418_58 => entityTypeId = 0x418 = 1048, itemId = 58
 */
function parseCrmTaskBindings(ufCrmTask) {
  const bindings = normalizeBindings(ufCrmTask);
  const parsed = [];

  const reT = /T(?:_|:|-)?([0-9a-f]+)[_:|-](\d+)/gi;
  const reD = /D(?:_|:|-)?(\d+)[_:|-](\d+)/gi;

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match;
    while ((match = reT.exec(text)) !== null) {
      const hexStr = String(match[1] || '').trim();
      const itemId = parseNumber(match[2]);
      const typeId = Number.isFinite(parseInt(hexStr, 16)) ? parseInt(hexStr, 16) : null;

      if (typeId && itemId) {
        parsed.push({
          typeId,
          itemId,
          raw: text,
          kind: 'T',
          typeHex: hexStr.toLowerCase(),
        });
      }
    }

    while ((match = reD.exec(text)) !== null) {
      const typeId = parseNumber(match[1]);
      const itemId = parseNumber(match[2]);
      if (typeId && itemId) parsed.push({ typeId, itemId, raw: text, kind: 'D' });
    }
  }

  return parsed;
}

function findSpaItemId(ufCrmTask, preferredTypeIds) {
  const bindings = parseCrmTaskBindings(ufCrmTask);
  if (!bindings.length) return null;

  const preferred = preferredTypeIds.filter(Number.isFinite);
  return bindings.find(binding => preferred.includes(binding.typeId)) || null;
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: [
      'ID',
      'STATUS',
      'UF_CRM_TASK',
      'TITLE',
      'DESCRIPTION',
      'CLOSED_DATE',
      'CHANGED_DATE',
      PDF_FILES_FIELD, // оставляем select — поле может пригодиться в debug
    ],
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

// ===== main handler =====
async function handleTaskCompletionEvent(req, res) {
  try {
    ensureObjectBody(req);

    const { taskId, source: taskIdSource } = extractTaskIdDetailed(req);
    const statusAfter = extractStatusAfter(req);
    const statusBefore = extractStatusBefore(req);
    const debug = req?.query?.debug === '1';
    const event = req?.body?.event || req?.body?.EVENT || req?.body?.data?.event || null;

    if (debug) console.log('[task-event] taskId_source', { taskId, source: taskIdSource });
    console.log('[task-event] incoming', { event, taskId, statusAfter, statusBefore, method: req.method });

    const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
    const stageId =
      process.env.SPA1048_STAGE_PAID ||
      process.env.SPA1048_STAGE_SUCCESS ||
      cfg.stagePaid ||
      `DT${entityTypeId}_14:SUCCESS`;

    if (!taskId) {
      console.log('[task-event] skip_no_taskId', { event, statusAfter, statusBefore, method: req.method });
      return res.json({ ok: true, action: 'skip_no_taskId', debug, event, statusAfter, statusBefore, taskIdSource });
    }

    const task = await fetchTask(taskId);
    if (!task) {
      console.log('[task-event] task_not_found', { taskId });
      return res.json({ ok: true, action: 'skip_task_not_found', taskId, debug, event });
    }

    const taskStatus = parseNumber(task?.status || task?.STATUS);
    const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;

    console.log('[task-event] fetched_task', {
      taskId,
      taskStatus,
      ufCrmTask: ufCrmTask || null,
    });

    // обновляем SPA только при выполненной задаче
    if (taskStatus !== COMPLETED_STATUS) {
      console.log('[task-event] skip_not_completed', { taskId, taskStatus });
      return res.json({
        ok: true,
        action: 'skip_not_completed',
        taskId,
        taskStatus,
        statusAfter,
        statusBefore,
        debug,
        checklist: { enabled: false, reason: 'disabled_in_task_event' },
      });
    }

    const preferredTypeIds = [...new Set([entityTypeId, cfg.entityTypeId].filter(Number.isFinite))];
    const binding = findSpaItemId(ufCrmTask, preferredTypeIds);
    const parsedBindings = parseCrmTaskBindings(ufCrmTask);

    console.log('[task-event] bindings', {
      taskId,
      ufCrmTask,
      preferredTypeIds,
      foundItemId: binding?.itemId || null,
      bindings: parsedBindings,
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
        entityTypeId,
        checklist: { enabled: false, reason: 'disabled_in_task_event' },
      });
    }

    const updateResult = await updateSpaStage({ itemId: binding.itemId, stageId, entityTypeId });

    console.log('[task-event] spa_stage_updated', { taskId, itemId: binding.itemId, stageId, updateResult });

    return res.json({
      ok: true,
      action: 'spa_stage_updated',
      taskId,
      itemId: binding.itemId,
      statusAfter,
      stageId,
      debug,
      ufCrmTask,
      entityTypeId,
      checklist: { enabled: false, reason: 'disabled_in_task_event' },
    });

  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[task-event] ERROR:', msg, e?.data ? JSON.stringify(e.data) : '');
    return res.json({ ok: false, error: msg });
  }
}

module.exports = { handleTaskCompletionEvent };
