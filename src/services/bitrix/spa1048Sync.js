'use strict';

const bitrix = require('./bitrixClient');

const cfg = {
  entityTypeId: 1048,

  // READ keys (как возвращает crm.item.get)
  readDeadline: 'ufCrm8_1768219591855',
  readTaskId: 'ufCrm8TaskId',
  readSyncAt: 'ufCrm8SyncAt',
  readSyncSrc: 'ufCrm8SyncSrc',

  // WRITE keys (как надо передавать в crm.item.update)
  apiDeadline: 'UF_CRM_8_1768219591855',
  apiTaskId: 'UF_CRM_8_TASK_ID',
  apiSyncAt: 'UF_CRM_8_SYNC_AT',
  apiSyncSrc: 'UF_CRM_8_SYNC_SRC',

  accountantId: Number(process.env.SPA1048_ACCOUNTANT_ID || 1),

  stagesActive: new Set(['DT1048_14:NEW', 'DT1048_14:PREPARATION', 'DT1048_14:CLIENT']),
  stagesFinal: new Set(['DT1048_14:SUCCESS', 'DT1048_14:FAIL']),

  antiLoopSeconds: 4,
  defaultDeadlineDays: 7,
  taskTime: 'T12:00:00+03:00',

  portalBase: 'https://b24-mg3u3i.bitrix24.ru',
};

let cachedSymbolCodeShort = null;

function toDateOnly(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function nowIso() {
  // можно оставлять ISO, Bitrix нормально ест
  return new Date().toISOString();
}

function addDaysDateOnly(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function monthDayDeadlineDateOnly(day = 25) {
  const today = new Date();
  let y = today.getFullYear();
  let m = today.getMonth(); // 0..11

  if (today.getDate() > day) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }

  const target = new Date(y, m, day);
  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}


function isFresh(syncAt, seconds) {
  if (!syncAt) return false;
  const t = Date.parse(syncAt);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) < (seconds * 1000);
}

function pick(item, ...keys) {
  for (const k of keys) {
    if (item && item[k] !== undefined) return item[k];
  }
  return undefined;
}

async function getItem(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
  });

  const item = r?.result?.item || r?.item || r?.result;
  if (!item) {
    const safe = (() => { try { return JSON.stringify(r).slice(0, 2000); } catch { return String(r); } })();
    throw new Error('[spa1048] crm.item.get: item not found in response: ' + safe);
  }
  return item;
}

async function updateItem(itemId, fields) {
  return bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields,
  });
}

// SYMBOL_CODE_SHORT для UF_CRM_TASK
async function resolveSymbolCodeShort() {
  if (cachedSymbolCodeShort) return cachedSymbolCodeShort;

  if (process.env.SPA1048_SYMBOL_CODE_SHORT) {
    cachedSymbolCodeShort = String(process.env.SPA1048_SYMBOL_CODE_SHORT).trim();
    return cachedSymbolCodeShort;
  }

  const r = await bitrix.call('crm.enum.ownertype', {});
  const list = r?.result || r;
  const arr = Array.isArray(list) ? list : (list?.items || list?.result || []);

  const found = (Array.isArray(arr) ? arr : []).find(x => Number(x.ID || x.Id || x.id) === cfg.entityTypeId);
  const sym = found?.SYMBOL_CODE_SHORT || found?.symbolCodeShort || found?.SYMBOL_CODE || found?.symbol;

  if (!sym) {
    const safe = (() => { try { return JSON.stringify(r).slice(0, 2000); } catch { return String(r); } })();
    throw new Error('[spa1048] Cannot resolve SYMBOL_CODE_SHORT for entityTypeId=1048 via crm.enum.ownertype. ' +
      'Set env SPA1048_SYMBOL_CODE_SHORT manually. Raw: ' + safe);
  }

  cachedSymbolCodeShort = String(sym).trim();
  return cachedSymbolCodeShort;
}

async function buildCrmTaskBinding(itemId) {
  const sym = await resolveSymbolCodeShort();
  return `${sym}_${Number(itemId)}`;
}

async function tryGetTask(taskId) {
  try {
    const r = await bitrix.call('tasks.task.get', { taskId: Number(taskId) });
    const task = r?.result?.task || r?.task || r?.result;
    if (!task) return { ok: false, reason: 'no_task_in_response', raw: r };
    return { ok: true, task };
  } catch (e) {
    const status = e?.response?.status;
    const desc = e?.response?.data?.error_description || e?.response?.data?.error || e?.message;
    return { ok: false, reason: 'get_failed', status, desc };
  }
}

async function tryUpdateTask(taskId, fields) {
  try {
    await bitrix.call('tasks.task.update', { taskId: Number(taskId), fields });
    return { ok: true };
  } catch (e) {
    const status = e?.response?.status;
    const desc = e?.response?.data?.error_description || e?.response?.data?.error || e?.message;
    return { ok: false, status, desc };
  }
}

async function createTaskForItem(itemId, deadlineDateOnly) {
  const binding = await buildCrmTaskBinding(itemId);
  const link = `${cfg.portalBase}/crm/type/${cfg.entityTypeId}/details/${Number(itemId)}/`;
  const title = `Оплатить счёт #${Number(itemId)}`;

  const r = await bitrix.call('tasks.task.add', {
    fields: {
      TITLE: title,
      DESCRIPTION: `Открыть счёт: ${link}
  
  Отмечайте пункты чек-листа — в течение ~5 минут задача закроется автоматически.
  Если нужно быстрее, нажмите «Завершить задачу» вручную — счёт будет помечен как оплаченный и перейдёт в раздел «Оплаченные».`,
      RESPONSIBLE_ID: cfg.accountantId,
      DEADLINE: `${deadlineDateOnly}${cfg.taskTime}`,
      UF_CRM_TASK: [binding], // привязка
    },
  });

  const taskId = Number(
    r?.result?.task?.id ||
    r?.task?.id ||
    r?.result?.taskId ||
    r?.result
  );

  if (!taskId) {
    const safe = (() => { try { return JSON.stringify(r).slice(0, 2000); } catch { return String(r); } })();
    throw new Error('[spa1048] tasks.task.add: cannot extract taskId: ' + safe);
  }

  return { taskId, binding };
}

async function handleSpaEvent({ itemId }) {
  if (!itemId) throw new Error('itemId is required');

  let item = await getItem(itemId);

  // анти-петля — только на наши записи в SPA
  const syncAt = pick(item, cfg.readSyncAt, cfg.apiSyncAt);
  if (isFresh(syncAt, cfg.antiLoopSeconds)) {
    return { ok: true, itemId: Number(itemId), stageId: item.stageId, action: 'anti_loop_skip' };
  }

  // 1) гарантируем дедлайн в SPA
  let ensuredDeadline = false;
  let deadlineDateOnly = toDateOnly(pick(item, cfg.readDeadline, cfg.apiDeadline));

  if (!deadlineDateOnly) {
    deadlineDateOnly = monthDayDeadlineDateOnly(Number(process.env.SPA1048_DEFAULT_MONTH_DAY || 25));
    ensuredDeadline = true;

    await updateItem(itemId, {
      [cfg.apiDeadline]: deadlineDateOnly,
      [cfg.apiSyncAt]: nowIso(),
      [cfg.apiSyncSrc]: 'server_deadline_default',
    });

    item = await getItem(itemId);
    deadlineDateOnly = toDateOnly(pick(item, cfg.readDeadline, cfg.apiDeadline));
  }

  // ensured accountant on SPA item (responsible)
  let ensuredAccountant = false;
  const accId = Number(process.env.SPA1048_ACCOUNTANT_ID || cfg.accountantId || 1);
  const curAssigned = Number(item.assignedById || item.ASSIGNED_BY_ID || 0);
  if (accId && curAssigned !== accId) {
    await updateItem(itemId, {
      assignedById: accId,
      [cfg.apiSyncAt]: nowIso(),
      [cfg.apiSyncSrc]: 'server_set_accountant',
    });
    ensuredAccountant = true;
    item = await getItem(itemId);
  }

  const stageId = item.stageId;

  // финальные — ничего не делаем
  if (cfg.stagesFinal.has(stageId)) {
    return { ok: true, itemId: Number(itemId), stageId, deadline: deadlineDateOnly, ensuredDeadline, action: 'final_skip' };
  }

  // не в активных — не ставим задачу
  if (!cfg.stagesActive.has(stageId)) {
    return { ok: true, itemId: Number(itemId), stageId, deadline: deadlineDateOnly, ensuredDeadline, action: 'not_active_skip' };
  }

  // 2) задача нужна: берём taskId из SPA
  const existingTaskIdRaw = pick(item, cfg.readTaskId, cfg.apiTaskId);
  const existingTaskId = existingTaskIdRaw ? Number(existingTaskIdRaw) : null;

  // если taskId нет — создаём и пишем в SPA
  if (!existingTaskId) {
    const { taskId } = await createTaskForItem(itemId, deadlineDateOnly);

    await updateItem(itemId, {
      [cfg.apiTaskId]: taskId,
      [cfg.apiSyncAt]: nowIso(),
      [cfg.apiSyncSrc]: 'server_task_create',
    });

    return { ok: true, itemId: Number(itemId), stageId, deadline: deadlineDateOnly, ensuredDeadline, action: 'task_created', taskId };
  }

  // 3) синхронизируем дедлайн задачи с полем в SPA (SPA — источник правды)
  const t = await tryGetTask(existingTaskId);
  if (!t.ok) {
    const { taskId } = await createTaskForItem(itemId, deadlineDateOnly);

    await updateItem(itemId, {
      [cfg.apiTaskId]: taskId,
      [cfg.apiSyncAt]: nowIso(),
      [cfg.apiSyncSrc]: 'server_task_recreate_missing',
    });

    return {
      ok: true,
      itemId: Number(itemId),
      stageId,
      deadline: deadlineDateOnly,
      ensuredDeadline,
      action: 'task_recreated',
      oldTaskId: existingTaskId,
      taskId,
      note: `old_task_get_failed: ${t.status || ''} ${t.desc || t.reason}`,
    };
  }

  const task = t.task;
  const taskDeadlineDateOnly = toDateOnly(task.deadline);

  if (taskDeadlineDateOnly !== deadlineDateOnly) {
    const upd = await tryUpdateTask(existingTaskId, {
      DEADLINE: `${deadlineDateOnly}${cfg.taskTime}`,
    });

    if (!upd.ok) {
      const { taskId } = await createTaskForItem(itemId, deadlineDateOnly);

      await updateItem(itemId, {
        [cfg.apiTaskId]: taskId,
        [cfg.apiSyncAt]: nowIso(),
        [cfg.apiSyncSrc]: 'server_task_recreate_no_permission',
      });

      return {
        ok: true,
        itemId: Number(itemId),
        stageId,
        deadline: deadlineDateOnly,
        ensuredDeadline,
        action: 'task_recreated',
        oldTaskId: existingTaskId,
        taskId,
        note: `task_update_failed: ${upd.status || ''} ${upd.desc || ''}`,
      };
    }

    await updateItem(itemId, {
      [cfg.apiSyncAt]: nowIso(),
      [cfg.apiSyncSrc]: 'server_task_deadline_sync',
    });

    return {
      ok: true,
      itemId: Number(itemId),
      stageId,
      deadline: deadlineDateOnly,
      ensuredDeadline,
      action: 'task_deadline_updated',
      taskId: existingTaskId,
      from: taskDeadlineDateOnly,
      to: deadlineDateOnly,
    };
  }

  // 4) если дедлайны равны — просто гарантируем привязку UF_CRM_TASK
  const binding = await buildCrmTaskBinding(itemId);
  const uf = task.ufCrmTask || task.UF_CRM_TASK || [];
  const hasBinding = Array.isArray(uf) ? uf.includes(binding) : String(uf) === binding;
  if (!hasBinding) {
    await tryUpdateTask(existingTaskId, { UF_CRM_TASK: [binding] });
  }

  return {
    ok: true,
    itemId: Number(itemId),
    stageId,
    deadline: deadlineDateOnly,
    ensuredDeadline,
    action: 'ok_no_changes',
    taskId: existingTaskId,
  };
}

module.exports = { handleSpaEvent };
