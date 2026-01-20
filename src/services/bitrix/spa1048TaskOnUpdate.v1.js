const bitrix = require('./bitrixClient');

const SPA_ENTITY_TYPE_ID = 1048;
const SPA_TYPE_HEX = Number(SPA_ENTITY_TYPE_ID).toString(16); // 418
const SUCCESS_STAGE = 'DT1048_14:SUCCESS';

// антидубль на всплесках
const locks = new Map();
async function withLock(key, fn) {
  const k = String(key);
  if (locks.has(k)) return await locks.get(k);
  const p = (async () => {
    try { return await fn(); }
    finally { locks.delete(k); }
  })();
  locks.set(k, p);
  return await p;
}

function pickTaskId(payload) {
  // максимально “живучий” парсер под разные payload-формы
  const b = payload || {};
  return (
    b?.data?.FIELDS?.ID ||
    b?.data?.FIELDS?.TASK_ID ||
    b?.data?.ID ||
    b?.data?.taskId ||
    b?.taskId ||
    b?.id ||
    b?.FIELDS?.ID ||
    null
  );
}

function pickToken(payload, req) {
  // можно проверять токен из query (?token=) или application_token из body
  const qToken = req?.query?.token;
  const appToken =
    payload?.auth?.application_token ||
    payload?.data?.auth?.application_token ||
    payload?.AUTH?.application_token ||
    payload?.auth?.APPLICATION_TOKEN ||
    payload?.data?.auth?.APPLICATION_TOKEN ||
    payload?.data?.AUTH?.APPLICATION_TOKEN;

  return { qToken, appToken };
}

function parseSpaBinding(b) {
  // ждём "T418_50"
  const m = /^T([0-9a-fA-F]+)_(\d+)$/.exec(String(b || ''));
  if (!m) return null;
  return { entityTypeId: parseInt(m[1], 16), itemId: Number(m[2]) };
}

function unwrap(r) { return r?.result ?? r; }

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'UF_CRM_TASK'],
  });
  return unwrap(r)?.task || unwrap(r);
}

async function getChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) });
  const items = unwrap(r) || [];
  const total = items.length;
  const done = items.filter(x => String(x.IS_COMPLETE || x.isComplete || '').toUpperCase() === 'Y').length;
  return { items, total, done };
}

async function moveSpaToSuccess(itemId) {
  return await bitrix.call('crm.item.update', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    fields: { stageId: SUCCESS_STAGE },
  });
}

async function handleTaskUpdateWebhook(req, res) {
  const payload = req.body || {};
  const taskIdRaw = pickTaskId(payload);

  if (!taskIdRaw || isNaN(Number(taskIdRaw))) {
    return res.status(400).json({ ok: false, error: 'taskId_not_found_in_payload' });
  }
  const taskId = Number(taskIdRaw);

  // защита: токен (рекомендую включить)
  const { qToken, appToken } = pickToken(payload, req);
  const EXPECT = process.env.B24_TASK_OUT_TOKEN || '';
  if (EXPECT) {
    const ok = (qToken && qToken === EXPECT) || (appToken && appToken === EXPECT);
    if (!ok) return res.status(403).json({ ok: false, error: 'bad_token' });
  }

  return await withLock(`task:${taskId}`, async () => {
    const task = await getTask(taskId);

    const binds = task?.ufCrmTask || task?.UF_CRM_TASK || [];
    const arr = Array.isArray(binds) ? binds : [binds];
    const wantPrefix = `T${SPA_TYPE_HEX}_`;
    const bindStr = arr.map(String).find(x => x.startsWith(wantPrefix));

    if (!bindStr) {
      return res.json({
        ok: true,
        action: 'skip_not_bound_to_spa1048',
        taskId,
        ufCrmTask: arr,
      });
    }

    const parsed = parseSpaBinding(bindStr);
    if (!parsed || parsed.entityTypeId !== SPA_ENTITY_TYPE_ID) {
      return res.json({ ok: true, action: 'skip_wrong_binding', taskId, bind: bindStr });
    }

    const cl = await getChecklist(taskId);

    // логи в ответе
    const base = {
      ok: true,
      taskId,
      bind: bindStr,
      itemId: parsed.itemId,
      checklist: { total: cl.total, done: cl.done },
    };

    if (cl.total === 0) return res.json({ ...base, action: 'no_checklist' });
    if (cl.done < cl.total) return res.json({ ...base, action: 'not_fully_paid' });

    await moveSpaToSuccess(parsed.itemId);
    return res.json({ ...base, action: 'moved_to_success', stageId: SUCCESS_STAGE });
  });
}

module.exports = { handleTaskUpdateWebhook };
