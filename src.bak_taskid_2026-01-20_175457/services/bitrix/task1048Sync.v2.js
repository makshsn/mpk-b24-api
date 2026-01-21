const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');

// ВАЖНО: в crm.item.get поля приходят camelCase
const F_DEADLINE = 'ufCrm8_1768219591855'; // крайний срок оплаты
const F_TASK_ID  = 'ufCrm8TaskId';         // id задачи
const F_SYNC_AT  = 'ufCrm8SyncAt';
const F_SYNC_SRC = 'ufCrm8SyncSrc';

const _taskDebounce = new Map(); // taskId -> lastMs

function unwrap(resp) {
  return resp?.result ?? resp;
}

function dateOnly(x) {
  if (!x) return null;
  return String(x).slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function msBetween(aIso, bIso) {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b);
}

async function getItem(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    select: ['*'],
  });
  const u = unwrap(r);
  const item = u?.item || u?.result?.item || u?.result || u;
  if (!item) throw new Error(`[task1048] crm.item.get: item not found, raw=${JSON.stringify(r).slice(0, 2000)}`);
  return item;
}

async function moveItemToPaid(itemId) {
  const stagePaid = String(cfg.stagePaid || process.env.SPA1048_STAGE_PAID || '').trim();
  if (!stagePaid) return { ok: false, error: 'SPA1048_STAGE_PAID не задан' };

  await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields: {
      stageId: stagePaid,
      [F_SYNC_AT]: nowIso(),
      [F_SYNC_SRC]: 'server_paid_from_task_event',
    },
  });

  try {
    await bitrix.call('crm.timeline.comment.add', {
      fields: {
        ENTITY_TYPE: `DYNAMIC_${cfg.entityTypeId}`,
        ENTITY_ID: Number(itemId),
        COMMENT: 'Все пункты чеклиста закрыты — задача завершена, счёт переведён в "успешно оплаченные".',
      },
    });
  } catch (_e) {}

  return { ok: true, stagePaid };
}


async function updateItem(itemId, fields) {
  const r = await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields,
  });
  return unwrap(r);
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'TITLE', 'DEADLINE', 'STATUS', 'UF_CRM_TASK'],
  });
  const u = unwrap(r);
  const task = u?.task || u?.result?.task || u?.result || u;
  if (!task) throw new Error(`[task1048] tasks.task.get: task not found, raw=${JSON.stringify(r).slice(0, 2000)}`);
  return task;
}

function extractTaskId(req) {
  // ручной тест: ?taskId=123
  const q = Number(req.query?.taskId);
  if (q) return q;

  // стандартный urlencoded: data[FIELDS][ID]
  const id1 = Number(req.body?.data?.FIELDS?.ID);
  if (id1) return id1;

  // реальные события Bitrix по задачам часто приходят так:
  // data[FIELDS_BEFORE][ID], data[FIELDS_AFTER][ID]
  const id2 = Number(req.body?.data?.FIELDS_AFTER?.ID);
  if (id2) return id2;

  const id3 = Number(req.body?.data?.FIELDS_BEFORE?.ID);
  if (id3) return id3;

  // запасные варианты
  const id4 = Number(req.body?.taskId || req.body?.id);
  if (id4) return id4;

  return 0;
}

function extractSpaItemIdFromUfCrmTask(ufCrmTask) {
  // ufCrmTask обычно массив строк:
  // ["DYNAMIC_1048_4"] или ["DYNAMIC_1048_14_4"] и т.п.
  const arr = Array.isArray(ufCrmTask) ? ufCrmTask : (ufCrmTask ? [ufCrmTask] : []);
  if (!arr.length) return 0;

  const et = String(cfg.entityTypeId);

  for (const raw of arr) {
    const s = String(raw);

    // DYNAMIC_1048_4
    let m = s.match(new RegExp(`^DYNAMIC_${et}_(\\d+)$`));
    if (m) return Number(m[1]);

    // DYNAMIC_1048_14_4 (categoryId внутри)
    m = s.match(new RegExp(`^DYNAMIC_${et}_\\d+_(\\d+)$`));
    if (m) return Number(m[1]);

    // DYNAMIC_1048:4
    m = s.match(new RegExp(`^DYNAMIC_${et}:(\\d+)$`));
    if (m) return Number(m[1]);

    // супер-запасной: последняя группа цифр
    m = s.match(/(\d+)\s*$/);
    if (m) return Number(m[1]);
  }

  return 0;
}

async function handleTaskEvent(req) {
  const taskId = extractTaskId(req);
  if (!taskId) return { ok: true, action: 'skip_no_task_id' };

  // debounce (Bitrix может присылать несколько ONTASKUPDATE подряд)
  const nowMs = Date.now();
  const lastMs = _taskDebounce.get(taskId) || 0;
  if (nowMs - lastMs < 1500) {
    return { ok: true, action: 'skip_debounce_task_event', taskId, debounce_task_event: true };
  }
  _taskDebounce.set(taskId, nowMs);

  const task = await getTask(taskId);

  // Bitrix вернёт ufCrmTask (camelCase) даже если select был UF_CRM_TASK
  const bind = task.ufCrmTask ?? task.UF_CRM_TASK;

  const itemId = extractSpaItemIdFromUfCrmTask(bind);
  if (!itemId) {
    return { ok: true, action: 'skip_no_bind', taskId, ufCrmTask: bind || null };
  }

  const item = await getItem(itemId);

  // если задачу закрыли вручную — сразу двигаем счёт
  const status = Number(task.status || task.STATUS || task.realStatus || task.REAL_STATUS || 0);
  if (status === 5) {
    const moved = await moveItemToPaid(itemId);
    return { ok: true, action: 'task_already_completed', taskId, itemId, moved };
  }

  // анти-петля: если мы сами только что писали в карточку — не дёргаем лишний раз
  if (item[F_SYNC_AT]) {
    const delta = msBetween(item[F_SYNC_AT], nowIso());
    if (delta < 4000 && String(item[F_SYNC_SRC] || '').startsWith('server_')) {
      return {
        ok: true,
        action: 'skip_anti_loop',
        taskId,
        itemId,
        syncAt: item[F_SYNC_AT],
        syncSrc: item[F_SYNC_SRC] || '',
      };
    }
  }

  // моментальная проверка чеклиста при любом обновлении задачи (в т.ч. клики по чеклисту)
  if (checklist?.closed) {
    return { ok: true, action: 'paid_by_checklist', taskId, itemId, checklist };
  }

  const taskYmd = dateOnly(task.deadline);
  const spaYmd = dateOnly(item[F_DEADLINE]);

  if (!taskYmd) {
    return { ok: true, action: 'skip_no_task_deadline', taskId, itemId };
  }

  if (taskYmd === spaYmd) {
    return { ok: true, action: 'no_change', taskId, itemId, deadline: taskYmd };
  }

  const upd = {};
  upd[F_DEADLINE] = taskYmd;
  upd[F_SYNC_AT] = nowIso();
  upd[F_SYNC_SRC] = 'server_spa_updated_from_task';

  const r = await updateItem(itemId, upd);

  return {
    ok: true,
    action: 'spa_updated_from_task',
    taskId,
    itemId,
    from: spaYmd,
    to: taskYmd,
    updated: Object.keys(upd),
    result: r ? 'ok' : 'ok',
  };
}

module.exports = { handleTaskEvent };
