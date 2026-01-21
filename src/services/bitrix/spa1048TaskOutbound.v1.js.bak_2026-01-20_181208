const axios = require('axios');
const bitrix = require('./bitrixClient');
const { verifyOutboundToken, extractTaskId, ensureObjectBody } = require('./b24Outbound.v1');

const SPA_ENTITY_TYPE_ID = 1048;
const SUCCESS_STAGE = 'DT1048_14:SUCCESS';
const SPA_TASK_ID_FIELD = process.env.SPA1048_TASK_ID_FIELD_ORIG || 'UF_CRM_8_TASK_ID';

async function writeTaskIdToSpa({ itemId, taskId }) {
  await bitrix.call('crm.item.update', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    fields: {
      [SPA_TASK_ID_FIELD]: Number(taskId),
    },
  });
}
function parseSpaBinding(ufCrmTask) {
  const arr = Array.isArray(ufCrmTask) ? ufCrmTask : (ufCrmTask ? [ufCrmTask] : []);
  const bind = arr.map(String).find(x => /^T[0-9a-fA-F]+_\d+$/.test(x));
  if (!bind) return null;

  const m = /^T([0-9a-fA-F]+)_(\d+)$/.exec(bind);
  if (!m) return null;

  const typePart = m[1];
  const base = /[a-fA-F]/.test(typePart) ? 16 : 10;
  const entityTypeId = parseInt(typePart, base);
  const itemId = Number(m[2]);

  return { bind, entityTypeId, itemId };
}

function unwrapTaskGet(resp) {
  // bitrixClient.call() у тебя может возвращать по-разному: result.task / task / result
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function tasksTaskGet(taskId) {
  // 1) нормальный путь через bitrix.call (обычно надёжнее, чем GET+query)
  try {
    const r = await bitrix.call('tasks.task.get', {
      taskId: Number(taskId),
      select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'UF_CRM_TASK'],
    });
    const task = unwrapTaskGet(r);
    if (task && (task.ID || task.id)) return task;
  } catch (e) {
    // упадём в fallback ниже
  }

  // 2) fallback: сырой GET (на случай если bitrixClient.call где-то сериализует параметры не так)
  const base = (process.env.BITRIX_WEBHOOK_BASE || '').replace(/\/+$/, '');
  if (!base) return { __error: 'BITRIX_WEBHOOK_BASE_missing' };

  const sp = new URLSearchParams();
  sp.set('taskId', String(taskId));
  ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'UF_CRM_TASK'].forEach(f => sp.append('select[]', f));
  const url = `${base}/tasks.task.get.json?${sp.toString()}`;

  try {
    const r = await axios.get(url, { timeout: 20000 });
    // tasks.task.get должен отдавать result.task, но если вдруг прилетает иначе — покажем raw
    const task = r?.data?.result?.task || null;
    if (task) return task;
    return { __error: 'no_task_in_response', url, raw: r?.data ?? null };
  } catch (e) {
    return { __error: 'raw_get_failed', url, msg: e?.message || String(e) };
  }
}

async function getChecklist(taskId) {
  // В Bitrix для checklist getlist часто параметр именно TASKID (uppercase)
  // Поэтому делаем попытку так, и fallback на taskId если портал принимает и так.
  let r;
  try {
    r = await bitrix.call('task.checklistitem.getlist', { TASKID: Number(taskId) });
  } catch (e) {
    r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) });
  }

  const items = r?.result ?? r ?? [];
  const list = Array.isArray(items) ? items : (items?.items || items?.list || []);
  const total = list.length;
  const done = list.filter(x => String(x.IS_COMPLETE || x.isComplete || '').toUpperCase() === 'Y').length;
  return { total, done };
}

async function moveSpaToSuccess(itemId) {
  return await bitrix.call('crm.item.update', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    fields: { stageId: SUCCESS_STAGE },
  });
}

async function handleTaskEvent(req, res) {
  ensureObjectBody(req);

  if (req.method === 'POST') {
    const tok = verifyOutboundToken(req, 'B24_OUTBOUND_TASK_TOKEN');
    if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
  }

  const taskId = extractTaskId(req);
  if (!taskId) return res.status(400).json({ ok: false, error: 'invalid_taskId' });

  const task = await tasksTaskGet(taskId);
  if (task?.__error) {
    return res.status(500).json({ ok: false, error: `[spa1048][task] tasks.task.get: ${task.__error}`, debug: task });
  }

  const uf = task?.UF_CRM_TASK || task?.ufCrmTask;
  const binding = parseSpaBinding(uf);

  if (!binding) {
    return res.json({
      ok: true,
      action: 'skip_no_spa_binding',
      taskId,
      debug: { hasUfCrmTask: !!uf, ufPreview: uf || null }
    });
  }
// Пишем ID задачи в карточку SPA (чтобы поле "Task ID" всегда было заполнено)
await writeTaskIdToSpa({ itemId: binding.itemId, taskId });

  if (binding.entityTypeId !== SPA_ENTITY_TYPE_ID) {
    return res.json({ ok: true, action: 'skip_other_entityType', taskId, binding });
  }

  const cl = await getChecklist(taskId);
  if (cl.total === 0) return res.json({ ok: true, action: 'no_checklist', taskId, binding, checklist: cl });
  if (cl.done < cl.total) return res.json({ ok: true, action: 'not_fully_paid', taskId, binding, checklist: cl });

  await moveSpaToSuccess(binding.itemId);
  return res.json({ ok: true, action: 'moved_to_success', taskId, binding, checklist: cl, stageId: SUCCESS_STAGE });
}

module.exports = { handleTaskEvent };
