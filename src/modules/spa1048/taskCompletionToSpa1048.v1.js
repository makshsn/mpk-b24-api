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

function dateOnly(x) {
  if (!x) return null;
  return String(x).slice(0, 10); // YYYY-MM-DD
}

// UF_CRM_8_1768219591855 -> ufCrm8_1768219591855
function ufToCamel(uf) {
  const s = String(uf || '').trim();
  if (!s) return '';
  if (!/^UF_/i.test(s)) return s;

  const lower = s.toLowerCase();
  const parts = lower.split('_').filter(Boolean);
  if (!parts.length) return '';

  let out = parts[0]; // uf
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === 1) { out += p.charAt(0).toUpperCase() + p.slice(1); continue; } // Crm
    if (/^\d+$/.test(p) && i === 2) { out += p; continue; } // 8
    out += '_' + p; // _176821...
  }
  return out;
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
      'DEADLINE', // <-- важно для синка
      PDF_FILES_FIELD,
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

function normalizeStageId(v) {
  return String(v ?? '').trim();
}

function parseCsvEnv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isFailStage({ stageId, stageSemantics }) {
  const s = normalizeStageId(stageId);
  const sem = String(stageSemantics ?? '').trim().toUpperCase();

  const explicit = new Set([
    ...parseCsvEnv(process.env.SPA1048_STAGE_FAILED),
    ...parseCsvEnv(process.env.SPA1048_STAGE_FAIL),
    ...parseCsvEnv(process.env.SPA1048_STAGE_CANCELED),
    ...parseCsvEnv(process.env.SPA1048_STAGE_CANCELLED),
  ]);
  if (explicit.size && explicit.has(s)) return true;

  if (sem && ['F', 'FAIL', 'FAILED'].includes(sem)) return true;

  const up = s.toUpperCase();
  if (up.includes(':SUCCESS')) return false;
  if (up.includes(':FAIL') || up.includes('FAIL') || up.includes('CANCEL') || up.includes('DECLINE') || up.includes('LOSE')) {
    return true;
  }

  return false;
}

function unwrapCrmItemGet(resp) {
  return resp?.result?.item || resp?.item || resp?.result || null;
}

async function fetchSpaItemStage({ entityTypeId, itemId }) {
  const result = await bitrix.call('crm.item.get', {
    entityTypeId,
    id: Number(itemId),
    select: ['id', 'stageId', 'STAGE_ID', 'stageSemantic', 'STAGE_SEMANTIC', 'stageSemantics'],
  }, { ctx: { step: 'crm_item_get_stage', entityTypeId, itemId } });

  const item = unwrapCrmItemGet(result);
  const stageId = item?.stageId || item?.STAGE_ID || null;
  const stageSemantics = item?.stageSemantic || item?.STAGE_SEMANTIC || item?.stageSemantics || null;

  return { stageId, stageSemantics };
}

async function fetchSpaDeadlineYmd({ entityTypeId, itemId, origField }) {
  const camel = ufToCamel(origField);
  const r = await bitrix.call('crm.item.get', {
    entityTypeId,
    id: Number(itemId),
    select: ['id', origField, camel].filter(Boolean),
  }, { ctx: { step: 'crm_item_get_deadline', entityTypeId, itemId } });

  const item = unwrapCrmItemGet(r);
  const raw = item?.[camel] || item?.[origField] || null;
  return dateOnly(raw);
}

async function syncSpaDeadlineFromTask({ entityTypeId, itemId, taskDeadlineRaw }) {
  const taskYmd = dateOnly(taskDeadlineRaw);
  if (!taskYmd) return { ok: true, action: 'skip_no_task_deadline' };

  const origField = String(process.env.SPA1048_DEADLINE_FIELD_ORIG || cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const camel = ufToCamel(origField) || 'ufCrm8_1768219591855';

  const spaYmd = await fetchSpaDeadlineYmd({ entityTypeId, itemId, origField });

  if (spaYmd === taskYmd) return { ok: true, action: 'no_change', deadline: taskYmd };

  await bitrix.call('crm.item.update', {
    entityTypeId,
    id: Number(itemId),
    useOriginalUfNames: 'Y',
    fields: {
      [origField]: taskYmd,
      [camel]: taskYmd,
    },
  }, { ctx: { step: 'crm_item_update_deadline', entityTypeId, itemId } });

  return { ok: true, action: 'spa_deadline_updated_from_task', from: spaYmd || null, to: taskYmd };
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
      deadline: task?.deadline || task?.DEADLINE || null,
    });

    // ==== ВАЖНО: синк дедлайна делаем всегда, даже если задача не завершена ====
    const preferredTypeIds = [...new Set([entityTypeId, cfg.entityTypeId].filter(Number.isFinite))];
    const binding = findSpaItemId(ufCrmTask, preferredTypeIds);
    const parsedBindings = parseCrmTaskBindings(ufCrmTask);

    if (debug) {
      console.log('[task-event] bindings', {
        taskId,
        ufCrmTask,
        preferredTypeIds,
        foundItemId: binding?.itemId || null,
        bindings: parsedBindings,
      });
    }

    let deadlineSync = { ok: true, action: 'skipped' };
    if (binding?.itemId) {
      deadlineSync = await syncSpaDeadlineFromTask({
        entityTypeId,
        itemId: binding.itemId,
        taskDeadlineRaw: task?.deadline || task?.DEADLINE || null,
      });
    } else {
      deadlineSync = { ok: true, action: 'skip_no_spa_binding' };
    }
    // ========================================================================

    // обновляем стадию SPA только при выполненной задаче
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
        deadlineSync,
        checklist: { enabled: false, reason: 'disabled_in_task_event' },
      });
    }

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
        deadlineSync,
        checklist: { enabled: false, reason: 'disabled_in_task_event' },
      });
    }

    // Если элемент SPA уже в финальной "провалено/отмена" — не трогаем стадию.
    try {
      const current = await fetchSpaItemStage({ entityTypeId, itemId: binding.itemId });
      const currentStageId = normalizeStageId(current?.stageId);
      if (currentStageId && isFailStage({ stageId: currentStageId, stageSemantics: current?.stageSemantics })) {
        console.log('[task-event] skip_spa_failed_stage', { taskId, itemId: binding.itemId, currentStageId });
        return res.json({
          ok: true,
          action: 'skip_spa_failed_stage',
          taskId,
          itemId: binding.itemId,
          taskStatus,
          currentStageId,
          debug,
          ufCrmTask,
          entityTypeId,
          deadlineSync,
        });
      }
    } catch (e) {
      console.log('[task-event] warn_spa_stage_check_failed', { taskId, itemId: binding.itemId, error: e?.message || String(e) });
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
      deadlineSync,
      checklist: { enabled: false, reason: 'disabled_in_task_event' },
    });

  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[task-event] ERROR:', msg, e?.data ? JSON.stringify(e.data) : '');
    return res.json({ ok: false, error: msg });
  }
}

module.exports = { handleTaskCompletionEvent };
