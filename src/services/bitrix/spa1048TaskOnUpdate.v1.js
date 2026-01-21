const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');

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

function dateOnly(x) {
  if (!x) return null;
  return String(x).slice(0, 10);
}

// UF_CRM_8_176... -> ufCrm8_176...
function ufToCamel(uf) {
  const s = String(uf || '').trim();
  if (!s) return '';
  if (!/^UF_/i.test(s)) return s;

  const lower = s.toLowerCase();
  const parts = lower.split('_').filter(Boolean);
  if (!parts.length) return '';

  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === 1) { out += p.charAt(0).toUpperCase() + p.slice(1); continue; }
    if (/^\d+$/.test(p) && i === 2) { out += p; continue; }
    out += '_' + p;
  }
  return out;
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'TITLE', 'RESPONSIBLE_ID', 'UF_CRM_TASK', 'DEADLINE'],
  });
  return unwrap(r)?.task || unwrap(r);
}

async function getSpaItem(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    select: ['*'],
  });
  return unwrap(r)?.item || unwrap(r);
}

async function writeTaskIdToSpa({ itemId, taskId }) {
  const origField = String(process.env.SPA1048_TASK_ID_FIELD_ORIG || cfg.taskIdField || 'UF_CRM_8_TASK_ID');
  const camel = ufToCamel(origField) || 'ufCrm8TaskId';

  await bitrix.call('crm.item.update', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    useOriginalUfNames: 'Y',
    fields: {
      [origField]: Number(taskId),
      [camel]: Number(taskId),
    },
  });
}

async function syncSpaDeadlineFromTask({ itemId, taskYmd }) {
  if (!taskYmd) return { ok: true, action: 'skip_no_task_deadline' };

  const item = await getSpaItem(itemId);
  const origField = String(process.env.SPA1048_DEADLINE_FIELD_ORIG || cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const camel = ufToCamel(origField) || 'ufCrm8_1768219591855';
  const spaYmd = dateOnly(item?.[camel] || item?.[origField] || null);

  if (spaYmd === taskYmd) {
    return { ok: true, action: 'no_change', deadline: taskYmd };
  }

  await bitrix.call('crm.item.update', {
    entityTypeId: SPA_ENTITY_TYPE_ID,
    id: Number(itemId),
    useOriginalUfNames: 'Y',
    fields: {
      [origField]: taskYmd,
      [camel]: taskYmd,
    },
  });

  return { ok: true, action: 'spa_deadline_updated_from_task', from: spaYmd || null, to: taskYmd };
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

    await writeTaskIdToSpa({ itemId: parsed.itemId, taskId });

    const cl = await getChecklist(taskId);
    let deadlineSync = { ok: true, action: 'skipped' };
    try {
      const taskYmd = dateOnly(task?.deadline || task?.DEADLINE || null);
      deadlineSync = await syncSpaDeadlineFromTask({ itemId: parsed.itemId, taskYmd });
    } catch (e) {
      deadlineSync = { ok: false, action: 'error', error: e?.message || String(e) };
    }

    // логи в ответе
    const base = {
      ok: true,
      taskId,
      bind: bindStr,
      itemId: parsed.itemId,
      checklist: { total: cl.total, done: cl.done },
      deadlineSync,
    };

    if (cl.total === 0) return res.json({ ...base, action: 'no_checklist' });
    if (cl.done < cl.total) return res.json({ ...base, action: 'not_fully_paid' });

    await moveSpaToSuccess(parsed.itemId);
    return res.json({ ...base, action: 'moved_to_success', stageId: SUCCESS_STAGE });
  });
}

module.exports = { handleTaskUpdateWebhook };
