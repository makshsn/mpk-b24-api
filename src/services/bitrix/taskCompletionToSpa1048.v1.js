'use strict';

const qs = require('querystring');

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

function parseQueryFromUrl(req) {
  const u = String(req.originalUrl || req.url || '');
  const i = u.indexOf('?');
  if (i < 0) return {};
  return qs.parse(u.slice(i + 1));
}

function coerceBody(req) {
  // ensureObjectBody уже пытается нормализовать, но на всякий:
  const b = ensureObjectBody(req);
  if (typeof b === 'string') {
    const s = b.trim();
    if (!s) return {};
    // попробуем JSON
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return JSON.parse(s); } catch (_) {}
    }
    // попробуем x-www-form-urlencoded
    try { return qs.parse(s); } catch (_) {}
    return {};
  }
  return b || {};
}

function pickFromAny(req, keys) {
  const q = req.query || {};
  const q2 = parseQueryFromUrl(req);
  const b = coerceBody(req);

  for (const k of keys) {
    if (q[k] != null && q[k] !== '') return q[k];
    if (q2[k] != null && q2[k] !== '') return q2[k];
    if (b[k] != null && b[k] !== '') return b[k];
  }

  // deep-пути (Bitrix часто шлёт именно так)
  const deep = [
    () => b?.data?.FIELDS_AFTER?.ID,
    () => b?.data?.FIELDS_AFTER?.id,
    () => b?.data?.FIELDS?.ID,
    () => b?.data?.FIELDS?.id,
    () => b?.FIELDS_AFTER?.ID,
    () => b?.FIELDS_AFTER?.id,
    () => b?.FIELDS?.ID,
    () => b?.FIELDS?.id,
  ];
  for (const fn of deep) {
    try {
      const v = fn();
      if (v != null && v !== '') return v;
    } catch (_) {}
  }

  return null;
}

function extractStatusAfter(req) {
  // кроме STATUS бывает REAL_STATUS
  const v = pickFromAny(req, [
    'status', 'STATUS', 'statusAfter', 'STATUS_AFTER',
    'REAL_STATUS', 'real_status', 'realStatus',
    'data[FIELDS_AFTER][STATUS]',
    'data[FIELDS_AFTER][REAL_STATUS]',
    'data[FIELDS][STATUS]',
    'data[FIELDS][REAL_STATUS]',
    'FIELDS_AFTER[STATUS]',
    'FIELDS_AFTER[REAL_STATUS]',
  ]);
  return pickFirstNumber([v]);
}

function extractStatusBefore(req) {
  const v = pickFromAny(req, [
    'statusBefore', 'STATUS_BEFORE',
    'data[FIELDS_BEFORE][STATUS]',
    'data[FIELDS_BEFORE][REAL_STATUS]',
    'FIELDS_BEFORE[STATUS]',
    'FIELDS_BEFORE[REAL_STATUS]',
  ]);
  return pickFirstNumber([v]);
}

function normalizeBindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function extractCandidatesFromBindings(ufCrmTask) {
  // ufCrmTask у тебя вида ['T418_58'] — нам важен сам itemId (58)
  const bindings = normalizeBindings(ufCrmTask);
  const out = new Set();

  for (const raw of bindings) {
    const s = String(raw || '').trim();
    if (!s) continue;

    // самый надёжный для твоего кейса: *_<digits> в конце
    let m = s.match(/[_:|-](\d+)\s*$/);
    if (m) out.add(Number(m[1]));

    // на всякий: D1048_58 / T1048_58 / D-1048-58 etc
    const re = /[DT](\d+)[_:|-](\d+)/gi;
    let mm;
    while ((mm = re.exec(s)) !== null) {
      const itemId = parseNumber(mm[2]);
      if (itemId) out.add(itemId);
    }
  }

  return Array.from(out).filter((n) => Number.isFinite(n) && n > 0);
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

async function existsSpaItem(entityTypeId, id) {
  try {
    const r = await bitrix.call('crm.item.get', { entityTypeId, id: Number(id), select: ['ID'] });
    const item = r?.result?.item || r?.item || r?.result;
    return !!(item && (item.id || item.ID));
  } catch (_) {
    return false;
  }
}

async function handleTaskCompletionEvent(req, res) {
  coerceBody(req);
  console.log('[task-event] RAW', {
    method: req.method,
    url: req.originalUrl || req.url,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
    },
    query: req.query,
    bodyType: typeof req.body,
    body: req.body,
  });
  

  // debug включаем и по GET, и по ?debug=1
  const debug = req.method === 'GET' || String(req?.query?.debug || '') === '1';

  if (req.method === 'POST') {
    const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
    if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
  }

  // 1) taskId/status пытаемся вытащить максимально широко
  let taskId = extractTaskId(req);
  if (!taskId) {
    taskId = pickFirstNumber([
      pickFromAny(req, [
        'taskId', 'TASK_ID', 'id', 'ID',
        'data[FIELDS_AFTER][ID]',
        'data[FIELDS][ID]',
        'FIELDS_AFTER[ID]',
        'FIELDS[ID]',
      ]),
    ]);
  }

  const statusAfter = extractStatusAfter(req);
  const statusBefore = extractStatusBefore(req);

  if (debug) {
    const q2 = parseQueryFromUrl(req);
    console.log('[task-event] dbg', {
      method: req.method,
      url: req.originalUrl || req.url,
      queryKeys: Object.keys(req.query || {}),
      q2Keys: Object.keys(q2 || {}),
      bodyType: typeof req.body,
      bodyKeys: Object.keys((typeof req.body === 'object' && req.body) ? req.body : {}),
      taskId,
      statusAfter,
      statusBefore,
    });
  }

  console.log('[task-event] incoming', { taskId, statusAfter, statusBefore, method: req.method });

  if (!taskId) {
    // тут уже нечего делать: Bitrix прислал пустой запрос
    return res.json({
      ok: true,
      action: 'skip_no_taskId',
      taskId,
      statusAfter,
      statusBefore,
      debug,
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
  const candidates = extractCandidatesFromBindings(ufCrmTask);

  let resolvedItemId = null;
  for (const cand of candidates) {
    // чтобы не уехать в чужую сущность — проверяем что item реально существует в SPA1048
    // (если это не SPA — crm.item.get вернёт ошибку/пусто)
    // можно отключить, если хочешь скорость: но так безопаснее
    // eslint-disable-next-line no-await-in-loop
    const ok = await existsSpaItem(entityTypeId, cand);
    if (ok) { resolvedItemId = cand; break; }
  }

  if (debug) {
    console.log('[task-event] bindings', { taskId, ufCrmTask, candidates, resolvedItemId });
  }

  if (!resolvedItemId) {
    return res.json({
      ok: true,
      action: 'skip_no_spa_binding',
      taskId,
      statusAfter,
      debug,
      ufCrmTask,
      candidates,
      resolvedItemId,
    });
  }

  const updateResult = await updateSpaStage({
    itemId: resolvedItemId,
    stageId,
    entityTypeId,
  });

  if (debug) {
    console.log('[task-event] spa_stage_updated', { taskId, itemId: resolvedItemId, stageId });
  }

  return res.json({
    ok: true,
    action: 'spa_stage_updated',
    taskId,
    itemId: resolvedItemId,
    statusAfter,
    stageId,
    debug,
    ufCrmTask,
    candidates,
    resolvedItemId,
    updateResult,
  });
}

module.exports = { handleTaskCompletionEvent };
