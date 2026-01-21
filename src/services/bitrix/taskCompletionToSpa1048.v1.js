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

function parseBindingToken(token) {
  const text = String(token || '').trim();
  if (!text) return null;

  const exactT = /^T(\d+)_(\d+)$/i.exec(text);
  if (exactT) {
    return { prefix: 'T', entityTypeId: parseNumber(exactT[1]), itemId: parseNumber(exactT[2]), raw: text };
  }

  const exactD = /^D[_:|-]?(\d+)[_:|-](\d+)$/i.exec(text);
  if (exactD) {
    return { prefix: 'D', entityTypeId: parseNumber(exactD[1]), itemId: parseNumber(exactD[2]), raw: text };
  }

  const exactL = /^L[_:|-]?(\d+)$/i.exec(text);
  if (exactL) return { prefix: 'L', entityTypeId: null, itemId: parseNumber(exactL[1]), raw: text };
  const exactC = /^C[_:|-]?(\d+)$/i.exec(text);
  if (exactC) return { prefix: 'C', entityTypeId: null, itemId: parseNumber(exactC[1]), raw: text };
  const exactCO = /^CO[_:|-]?(\d+)$/i.exec(text);
  if (exactCO) return { prefix: 'CO', entityTypeId: null, itemId: parseNumber(exactCO[1]), raw: text };

  return null;
}

function parseTaskCrmBindings(task) {
  const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;
  const bindings = normalizeBindings(ufCrmTask);
  const parsed = [];

  for (const raw of bindings) {
    const token = parseBindingToken(raw);
    if (token) parsed.push(token);
  }

  return { ufCrmTask, bindings, parsed };
}

function findSpaItemId(parsedBindings, entityTypeId) {
  if (!parsedBindings?.length) return null;

  const exact = parsedBindings.find(
    (b) => b.prefix && b.prefix.toUpperCase() === 'T' && b.entityTypeId === entityTypeId && b.itemId,
  );
  if (exact) return { itemId: exact.itemId, raw: exact.raw, mode: 'exact_t' };

  const exactD = parsedBindings.find(
    (b) => b.prefix && b.prefix.toUpperCase() === 'D' && b.entityTypeId === entityTypeId && b.itemId,
  );
  if (exactD) return { itemId: exactD.itemId, raw: exactD.raw, mode: 'exact_d' };

  return null;
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
    const debug = req.method === 'GET';

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
      return res.json({ ok: true, action: 'skip_already_completed', taskId, statusBefore, statusAfter, debug });
    }

    if (statusAfter !== COMPLETED_STATUS) {
      return res.json({ ok: true, action: 'skip_status', taskId, statusBefore, statusAfter, debug });
    }

    const task = await fetchTask(taskId);
    if (!task) {
      return res.status(500).json({ ok: false, action: 'error', error: 'task_not_found', taskId, debug });
    }

    const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
    const stageId = process.env.SPA1048_STAGE_PAID || 'DT1048_14:SUCCESS';

    const bindingsInfo = parseTaskCrmBindings(task);
    const binding = findSpaItemId(bindingsInfo.parsed, entityTypeId);

    console.log('[task-event] bindings', {
      taskId,
      ufCrmTask: bindingsInfo.ufCrmTask,
      parsedBindings: bindingsInfo.parsed,
      foundItemId: binding?.itemId || null,
      foundMode: binding?.mode || null,
    });

    if (!binding?.itemId) {
      const tBinding = bindingsInfo.parsed.find(
        (item) => item.prefix && item.prefix.toUpperCase() === 'T' && item.itemId,
      );
      if (!tBinding?.itemId) {
        return res.json({
          ok: true,
          action: 'skip_no_spa_binding',
          taskId,
          statusAfter,
          debug,
          bindings: bindingsInfo.parsed,
        });
      }

      try {
        const fallbackItem = await bitrix.call('crm.item.get', {
          entityTypeId,
          id: Number(tBinding.itemId),
        });
        const item = fallbackItem?.result?.item || fallbackItem?.item || null;
        if (!item) {
          return res.json({
            ok: true,
            action: 'skip_no_spa_binding',
            taskId,
            statusAfter,
            debug,
            bindings: bindingsInfo.parsed,
            fallback: { used: true, reason: 'item_not_found', binding: tBinding },
          });
        }

        const updateResult = await updateSpaStage({
          itemId: tBinding.itemId,
          stageId,
          entityTypeId,
        });

        return res.json({
          ok: true,
          action: 'crm_item_update_success',
          taskId,
          itemId: tBinding.itemId,
          statusAfter,
          stageId,
          debug,
          bindings: bindingsInfo.parsed,
          fallback: { used: true, binding: tBinding, updateResult },
        });
      } catch (fallbackError) {
        return res.status(500).json({
          ok: false,
          action: 'error',
          error: String(fallbackError?.message || fallbackError),
          taskId,
          debug,
          bindings: bindingsInfo.parsed,
          fallback: { used: true, binding: tBinding },
        });
      }
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
      binding,
      bindings: bindingsInfo.parsed,
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
