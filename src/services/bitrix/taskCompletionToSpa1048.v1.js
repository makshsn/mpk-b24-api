'use strict';

const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureObjectBody, verifyOutboundToken, extractTaskId } = require('./b24Outbound.v1');
const qs = require('qs');

const COMPLETED_STATUS = 5;

function parseQueryFromUrl(req) {
  const u = String(req?.originalUrl || req?.url || '');
  const i = u.indexOf('?');
  if (i < 0) return {};
  return qs.parse(u.slice(i + 1));
}

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

function normalizeBindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * Bitrix может слать:
 * - query: taskId/status
 * - body (x-www-form-urlencoded): data[FIELDS_AFTER][ID], data[FIELDS_AFTER][STATUS], ...
 * - body (json): data: { FIELDS_AFTER: { ID, STATUS } }
 * - иногда: { ID, STATUS } на верхнем уровне
 */
function extractStatusAfter(req) {
  const b = ensureObjectBody(req);
  const q2 = parseQueryFromUrl(req);
  return pickFirstNumber([
    req?.query?.status,
    req?.query?.STATUS,
    req?.query?.statusAfter,
    req?.query?.STATUS_AFTER,

    q2?.status,
    q2?.STATUS,
    q2?.statusAfter,
    q2?.STATUS_AFTER,

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

    // иногда Bitrix кладёт в "event"/"data" иначе
    b?.event?.data?.FIELDS_AFTER?.STATUS,
    b?.event?.data?.FIELDS_AFTER?.status,
  ]);
}

function extractStatusBefore(req) {
  const b = ensureObjectBody(req);
  const q2 = parseQueryFromUrl(req);
  return pickFirstNumber([
    req?.query?.statusBefore,
    req?.query?.STATUS_BEFORE,
    q2?.statusBefore,
    q2?.STATUS_BEFORE,

    b?.statusBefore,
    b?.STATUS_BEFORE,

    b?.data?.FIELDS_BEFORE?.STATUS,
    b?.data?.FIELDS_BEFORE?.status,
    b?.FIELDS_BEFORE?.STATUS,
    b?.FIELDS_BEFORE?.status,

    b?.event?.data?.FIELDS_BEFORE?.STATUS,
    b?.event?.data?.FIELDS_BEFORE?.status,
  ]);
}

/**
 * taskId тоже может прилетать как:
 * - query.taskId / query.id
 * - body.data.FIELDS_AFTER.ID
 * - body.data.FIELDS.ID
 * - body.ID
 */
function extractTaskIdRobust(req) {
  const b = ensureObjectBody(req);
  const q2 = parseQueryFromUrl(req);

  // сначала пусть отработает ваш общий helper
  const fromHelper = extractTaskId(req);
  const nHelper = parseNumber(fromHelper);
  if (nHelper) return nHelper;

  return pickFirstNumber([
    req?.query?.taskId,
    req?.query?.TASK_ID,
    req?.query?.id,
    req?.query?.ID,

    q2?.taskId,
    q2?.TASK_ID,
    q2?.id,
    q2?.ID,

    b?.taskId,
    b?.TASK_ID,
    b?.id,
    b?.ID,

    b?.data?.FIELDS_AFTER?.ID,
    b?.data?.FIELDS_AFTER?.id,
    b?.data?.FIELDS?.ID,
    b?.data?.FIELDS?.id,

    b?.FIELDS_AFTER?.ID,
    b?.FIELDS_AFTER?.id,
    b?.FIELDS?.ID,
    b?.FIELDS?.id,

    b?.event?.data?.FIELDS_AFTER?.ID,
    b?.event?.data?.FIELDS_AFTER?.id,
  ]);
}

/**
 * В UF_CRM_TASK может быть:
 * - D_123 (сделка)
 * - L_456 (лид)
 * - C_789 (контакт)
 * - T418_58 (смарт-процесс/SPA item) <-- твой случай
 * - D1048_58 / D_1048_58 (варианты)
 *
 * Мы хотим достать itemId.
 */
function resolveSpaItemIdFromUf(ufCrmTask, entityTypeId) {
  const bindings = normalizeBindings(ufCrmTask);

  const candidates = [];
  const candidatesMatchedType = [];

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;

    // T418_58 / T418:58 / T418-58
    let m = text.match(/^T(\d+)[_:|-](\d+)$/i);
    if (m) {
      const typeId = parseNumber(m[1]);
      const itemId = parseNumber(m[2]);
      if (itemId) {
        candidates.push(itemId);
        if (typeId === entityTypeId) candidatesMatchedType.push(itemId);
      }
      continue;
    }

    // D1048_58 / D_1048_58 / D:1048:58 / D-1048-58
    m = text.match(/^D(?:_|:|-)?(\d+)[_:|-](\d+)$/i);
    if (m) {
      const typeId = parseNumber(m[1]);
      const itemId = parseNumber(m[2]);
      if (itemId) {
        candidates.push(itemId);
        if (typeId === entityTypeId) candidatesMatchedType.push(itemId);
      }
      continue;
    }

    // на всякий: просто вытащим хвост _число если это Txxx_yyy в составе строки
    const m2 = text.match(/T(\d+)[_:|-](\d+)/i);
    if (m2) {
      const typeId = parseNumber(m2[1]);
      const itemId = parseNumber(m2[2]);
      if (itemId) {
        candidates.push(itemId);
        if (typeId === entityTypeId) candidatesMatchedType.push(itemId);
      }
    }
  }

  // приоритет: совпало по entityTypeId
  if (candidatesMatchedType.length === 1) {
    return { itemId: candidatesMatchedType[0], candidates, resolvedBy: 'matched_type' };
  }
  if (candidatesMatchedType.length > 1) {
    return { itemId: candidatesMatchedType[0], candidates, resolvedBy: 'matched_type_first' };
  }

  // иначе если ровно один кандидат — берём его (как у тебя T418_58)
  const uniq = Array.from(new Set(candidates));
  if (uniq.length === 1) {
    return { itemId: uniq[0], candidates: uniq, resolvedBy: 'single_candidate' };
  }
  if (uniq.length > 1) {
    return { itemId: uniq[0], candidates: uniq, resolvedBy: 'multiple_candidates_first' };
  }

  return { itemId: 0, candidates: [], resolvedBy: 'none' };
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS', 'UF_CRM_TASK', 'TITLE', 'UF_*'],
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

async function handleTaskCompletionEvent(req, res) {
  // Важно: если Bitrix реально шлёт POST form-urlencoded,
  // ensureObjectBody должен уметь прочитать req.body (через express.urlencoded middleware).
  ensureObjectBody(req);

  if (req.method === 'POST') {
    const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
    if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
  }

  const debug = req.method === 'GET' || String(req?.query?.debug || '').trim() === '1';

  const taskId = extractTaskIdRobust(req);
  const statusAfter = extractStatusAfter(req);
  const statusBefore = extractStatusBefore(req);

  if (debug) {
    const q2 = parseQueryFromUrl(req);
    console.log('[task-event] RAW', {
      method: req.method,
      url: req.originalUrl || req.url,
      headers: {
        'content-type': req.headers?.['content-type'],
        'user-agent': req.headers?.['user-agent'],
        'x-forwarded-for': req.headers?.['x-forwarded-for'],
      },
      query: req.query,
      q2,
      bodyType: typeof req.body,
      body: req.body,
    });

    console.log('[task-event] dbg', {
      method: req.method,
      url: req.originalUrl || req.url,
      queryKeys: Object.keys(req.query || {}),
      q2Keys: Object.keys(q2 || {}),
      bodyType: typeof req.body,
      bodyKeys: Object.keys(req.body || {}),
      taskId,
      statusAfter,
      statusBefore,
    });
  }

  console.log('[task-event] incoming', { taskId, statusAfter, statusBefore, method: req.method });

  if (!taskId) {
    // Это твой кейс сейчас: Bitrix присылает пустой GET. Тут без taskId сделать ничего нельзя.
    return res.json({
      ok: true,
      action: 'skip_no_taskId',
      debug,
      hint: 'Bitrix did not send taskId/status. Configure outgoing webhook to include them or use POST event payload.',
    });
  }

  if (statusBefore === COMPLETED_STATUS) {
    return res.json({ ok: true, action: 'skip_already_completed', taskId, statusBefore, statusAfter, debug });
  }

  if (statusAfter !== COMPLETED_STATUS) {
    return res.json({ ok: true, action: 'skip_status', taskId, statusBefore, statusAfter, debug });
  }

  const task = await fetchTask(taskId);
  if (!task) {
    return res.status(500).json({ ok: false, error: 'task_not_found', taskId, debug });
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const stageId = process.env.SPA1048_STAGE_PAID || 'DT1048_14:SUCCESS';

  const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;
  const resolved = resolveSpaItemIdFromUf(ufCrmTask, entityTypeId);

  if (debug) {
    console.log('[task-event] bindings', {
      taskId,
      ufCrmTask,
      candidates: resolved.candidates,
      resolvedItemId: resolved.itemId || null,
      resolvedBy: resolved.resolvedBy,
    });
  }

  if (!resolved.itemId) {
    return res.json({
      ok: true,
      action: 'skip_no_spa_binding',
      taskId,
      statusAfter,
      debug,
      ufCrmTask,
      candidates: resolved.candidates,
      resolvedItemId: 0,
      resolvedBy: resolved.resolvedBy,
    });
  }

  const updateResult = await updateSpaStage({
    itemId: resolved.itemId,
    stageId,
    entityTypeId,
  });

  console.log('[task-event] spa_stage_updated', { taskId, itemId: resolved.itemId, stageId });

  return res.json({
    ok: true,
    action: 'spa_stage_updated',
    taskId,
    itemId: resolved.itemId,
    statusAfter,
    stageId,
    debug,
    ufCrmTask,
    candidates: resolved.candidates,
    resolvedItemId: resolved.itemId,
    resolvedBy: resolved.resolvedBy,
  });
}

module.exports = { handleTaskCompletionEvent };
