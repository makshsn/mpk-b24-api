'use strict';

const bitrix = require('../../services/bitrix/bitrixClient');

function parsePositiveIntLoose(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;

  // Fast path for clean numeric strings / numbers
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);

  // Bitrix robots sometimes send values like "2584_" or "ID:2584".
  // Extract the first integer sequence.
  const m = s.match(/(\d{1,12})/);
  if (!m) return 0;
  const nn = Number(m[1]);
  return Number.isFinite(nn) && nn > 0 ? Math.trunc(nn) : 0;
}

function extractTaskId(req) {
  // primary: URL param, query
  const fromParams = parsePositiveIntLoose(req?.params?.taskId);
  if (fromParams) return fromParams;

  const q = req?.query || {};
  const fromQuery = parsePositiveIntLoose(
    q.task_id ?? q.taskId ?? q.id ?? q.TASK_ID ?? q.TASKID
  );
  if (fromQuery) return fromQuery;

  // fallback: body (form-urlencoded / json)
  const b = req?.body || {};
  const fromBody = parsePositiveIntLoose(
    b.task_id ?? b.taskId ?? b.id ??
    b?.data?.taskId ?? b?.data?.TASK_ID ?? b?.data?.FIELDS?.ID
  );
  if (fromBody) return fromBody;

  return 0;
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTaskMinimal(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS', 'TITLE'],
  }, { ctx: { step: 'task_close_get', taskId } });
  return unwrapTaskGet(result);
}

async function completeTask(taskId) {
  // 1) normal close
  try {
    await bitrix.call('tasks.task.complete', {
      taskId: Number(taskId),
    }, { ctx: { step: 'task_close_complete', taskId } });
    return { ok: true, method: 'tasks.task.complete' };
  } catch (e) {
    // 2) for tasks under "control" Bitrix may require approve
    const bErr = e?.data?.error || e?.data?.ERROR || '';
    const msg = String(e?.message || '').toLowerCase();
    const canTryApprove =
      String(bErr).toUpperCase().includes('ACTION_NOT_ALLOWED') ||
      msg.includes('approve') ||
      msg.includes('accept') ||
      msg.includes('not allowed');

    if (!canTryApprove) throw e;

    await bitrix.call('tasks.task.approve', {
      taskId: Number(taskId),
    }, { ctx: { step: 'task_close_approve', taskId } });
    return { ok: true, method: 'tasks.task.approve' };
  }
}

async function handleTaskCloseWebhook(req, res) {
  const debug = req?.query?.debug === '1';
  const taskId = extractTaskId(req);

  console.log('[task-close] incoming', {
    method: req.method,
    url: req.originalUrl || req.url,
    taskId,
    rawTaskId: req?.query?.task_id ?? req?.query?.taskId ?? req?.params?.taskId ?? req?.body?.task_id ?? req?.body?.taskId ?? null,
  });

  if (!taskId) {
    // 200 instead of 400: robots/outbound webhooks may retry on non-2xx.
    return res.json({
      ok: true,
      action: 'skip_invalid_taskId',
      taskId: 0,
      hint: 'use /b24/task-close?task_id=123 or /b24/task-close/123',
      debug,
    });
  }

  try {
    const task = await fetchTaskMinimal(taskId);
    if (!task) {
      console.log('[task-close] task_not_found', { taskId });
      return res.json({ ok: true, action: 'skip_task_not_found', taskId, debug });
    }

    const status = parsePositiveIntLoose(task?.status || task?.STATUS);
    if (status === 5) {
      return res.json({ ok: true, action: 'skip_already_completed', taskId, status, debug });
    }

    const r = await completeTask(taskId);
    console.log('[task-close] completed', { taskId, method: r.method });

    return res.json({ ok: true, action: 'task_closed', taskId, method: r.method, debug });
  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[task-close] ERROR:', msg, e?.data ? JSON.stringify(e.data) : '');
    return res.status(500).json({ ok: false, error: msg, taskId, debug });
  }
}

module.exports = { handleTaskCloseWebhook };
