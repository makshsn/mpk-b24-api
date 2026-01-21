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

function parseTaskCrmBindings(task) {
  const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;
  const bindings = normalizeBindings(ufCrmTask);
  const matchers = [];
  let itemId = null;
  let matched = null;

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const match = /^T\d+_(\d+)$/i.exec(text);
    if (match) {
      itemId = parseNumber(match[1]);
      matched = text;
      matchers.push({ raw: text, match: match[0], itemId });
      break;
    }
    matchers.push({ raw: text, match: null, itemId: null });
  }

  return {
    ufCrmTask,
    bindings,
    itemId,
    matched,
    matchers,
  };
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['*', 'UF_*'],
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
  try {
    ensureObjectBody(req);

    if (req.method === 'POST') {
      const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
      if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
    }

    const taskId = extractTaskId(req);
    const statusAfter = extractStatusAfter(req);
    const statusBefore = extractStatusBefore(req);
    const debug = req.method === 'GET' || req.query?.debug === '1';

    console.log('[task-event] incoming', {
      taskId,
      statusAfter,
      statusBefore,
      method: req.method,
    });

    if (!taskId) {
      return res.json({ ok: true, action: 'skip_no_taskId', debug });
    }

    const task = await fetchTask(taskId);
    if (!task) {
      return res.status(500).json({ ok: false, action: 'error', error: 'task_not_found', taskId, debug });
    }

    const bindingsInfo = parseTaskCrmBindings(task);

    if (statusBefore === COMPLETED_STATUS) {
      return res.json({
        ok: true,
        action: 'skip_already_completed',
        taskId,
        statusBefore,
        statusAfter,
        debug,
        ...(debug ? { ufCrmTask: bindingsInfo.ufCrmTask, bindingMatch: bindingsInfo } : {}),
      });
    }

    if (statusAfter !== COMPLETED_STATUS) {
      return res.json({
        ok: true,
        action: 'skip_status_not_completed',
        taskId,
        statusAfter,
        itemId: bindingsInfo.itemId,
        debug,
        ...(debug ? { ufCrmTask: bindingsInfo.ufCrmTask, bindingMatch: bindingsInfo } : {}),
      });
    }

    if (!bindingsInfo.itemId) {
      return res.json({
        ok: true,
        action: 'skip_no_spa_binding',
        taskId,
        statusAfter,
        debug,
        ...(debug ? { ufCrmTask: bindingsInfo.ufCrmTask, bindingMatch: bindingsInfo } : {}),
      });
    }

    const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
    const stageId = process.env.SPA1048_STAGE_PAID || cfg.stagePaid || 'DT1048_14:SUCCESS';

    const updateResult = await updateSpaStage({
      itemId: bindingsInfo.itemId,
      stageId,
      entityTypeId,
    });

    console.log('[task-event] spa_stage_updated', {
      taskId,
      itemId: bindingsInfo.itemId,
      stageId,
      updateResult,
    });

    return res.json({
      ok: true,
      action: 'spa_mark_success',
      taskId,
      itemId: bindingsInfo.itemId,
      stageAfter: stageId,
      debug,
      ...(debug ? { ufCrmTask: bindingsInfo.ufCrmTask, bindingMatch: bindingsInfo } : {}),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      action: 'error',
      error: String(error?.message || error),
    });
  }
}

module.exports = { handleTaskCompletionEvent, parseTaskCrmBindings };
