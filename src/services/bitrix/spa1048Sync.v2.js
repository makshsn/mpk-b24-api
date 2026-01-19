const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');

// ---- simple in-process lock to avoid double-create on burst webhooks ----
const itemLocks = new Map();

async function withItemLock(itemId, fn) {
  const key = String(itemId);
  if (itemLocks.has(key)) {
    return await itemLocks.get(key);
  }
  const p = (async () => {
    try { return await fn(); }
    finally { itemLocks.delete(key); }
  })();
  itemLocks.set(key, p);
  return await p;
}


function unwrap(resp) {
  return resp?.result ?? resp;
}

function dateOnly(x) {
  if (!x) return null;
  return String(x).slice(0, 10);
}

function normalizeStageId(x) {
  if (!x) return '';
  return String(x).trim().replace(/^['"]+|['"]+$/g, '');
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

// В crm.item.get поля приходят в camelCase
const F_DEADLINE = 'ufCrm8_1768219591855'; // "Крайний срок оплаты счёта"
const F_TASK_ID  = 'ufCrm8TaskId';         // UF_CRM_8_TASK_ID
const F_SYNC_AT  = 'ufCrm8SyncAt';         // UF_CRM_8_SYNC_AT
const F_SYNC_SRC = 'ufCrm8SyncSrc';        // UF_CRM_8_SYNC_SRC

const TASK_STATUS_COMPLETED = 5; // завершена

async function getItem(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    select: ['*'],
  });
  const u = unwrap(r);
  const item = u?.item || u?.result?.item || u?.result || u;
  if (!item) throw new Error(`[spa1048] crm.item.get: item not found, raw=${JSON.stringify(r).slice(0, 2000)}`);
  return item;
}

async function updateItem(itemId, fields) {
  const r = await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields,
  });
  return unwrap(r);
}

function isFinal(stageId) {
  return (cfg.stageFinal || []).includes(stageId);
}
function isActive(stageId) {
  return (cfg.stageActive || []).includes(stageId);
}

// Привязка задачи к SPA: Bitrix хранит связи в UF_CRM_TASK.
// Для SPA entityTypeId=1048, hex=418, префикс T418_
function bindingCandidates(item) {
  const hex = Number(cfg.entityTypeId).toString(16).toUpperCase(); // 1048 -> 418
  const prefix = `T${hex}_`; // T418_
  const id = Number(item.id);
  const cid = Number(item.categoryId);

  // Встречаются схемы:
  // - T418_<itemId>
  // - T418_<categoryId>_<itemId>
  return [
    [`${prefix}${id}`],
    [`${prefix}${cid}_${id}`],
  ];
}

function taskDeadlineIsoFromDate(dateYmd) {
  // фиксируем время 12:00 МСК
  return `${dateYmd}T12:00:00+03:00`;
}

function safeText(x, max = 80) {
  if (!x) return '';
  const s = String(x).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function taskTitle(item) {
  // item.title приходит из crm.item.get
  const name = safeText(item.title || item.TITLE || '');
  if (name) return `Оплатить счёт "${name}" (#${item.id})`;
  return `Оплатить счёт #${item.id}`;
}

function taskDescription(itemId) {
  return `Открыть счёт: https://b24-mg3u3i.bitrix24.ru/crm/type/${cfg.entityTypeId}/details/${itemId}/

Отмечайте пункты чек-листа — в течение ~5 минут задача закроется автоматически.
Если нужно быстрее, нажмите «Завершить задачу» вручную — счёт будет помечен как оплаченный и перейдёт в раздел «Оплаченные».`;
}

async function addSpaTimelineComment(itemId, text) {
  const et = Number(cfg.entityTypeId);
  const id = Number(itemId);

  const tries = [
    // вариант 1
    {
      method: 'crm.timeline.comment.add',
      params: { fields: { ENTITY_TYPE_ID: et, ENTITY_ID: id, COMMENT: text } },
    },
    // вариант 2
    {
      method: 'crm.timeline.comment.add',
      params: { fields: { ENTITY_TYPE: `DYNAMIC_${et}`, ENTITY_ID: id, COMMENT: text } },
    },
  ];

  let lastErr = null;
  for (const t of tries) {
    try {
      await bitrix.call(t.method, t.params);
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = lastErr?.response?.data?.error_description || lastErr?.message || String(lastErr);
  return { ok: false, error: msg };
}

async function createTaskBoundToItem(item, deadlineYmd) {
  const baseFields = {
    TITLE: taskTitle(item),
    DESCRIPTION: taskDescription(item.id),
    RESPONSIBLE_ID: Number(cfg.accountantId || 1),
    DEADLINE: taskDeadlineIsoFromDate(deadlineYmd),
  };

  const tries = bindingCandidates(item);

  // 1) пробуем с привязкой UF_CRM_TASK
  for (const uf of tries) {
    try {
      const r = await bitrix.call('tasks.task.add', {
        fields: {
          ...baseFields,
          UF_CRM_TASK: uf,
        },
      });
      const u = unwrap(r);
      const taskId = Number(u?.task?.id || u?.result?.task?.id || u?.id || u?.result);
      if (!taskId) throw new Error(`[spa1048] tasks.task.add ok, but taskId not found: ${JSON.stringify(r).slice(0, 2000)}`);
      return { taskId, bind: uf };
    } catch (_e) {
      // пробуем следующий формат
    }
  }

  // 2) если привязка не зашла — создаём без неё (хотя бы задача будет)
  const r = await bitrix.call('tasks.task.add', { fields: baseFields });
  const u = unwrap(r);
  const taskId = Number(u?.task?.id || u?.result?.task?.id || u?.id || u?.result);
  if (!taskId) throw new Error(`[spa1048] tasks.task.add (no bind) ok, but taskId not found: ${JSON.stringify(r).slice(0, 2000)}`);
  return { taskId, bind: null };
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'TITLE', 'DEADLINE', 'STATUS', 'CLOSED_DATE', 'UF_CRM_TASK'],
  });
  const u = unwrap(r);
  const task = u?.task || u?.result?.task || u?.result || u;
  if (!task) throw new Error(`[spa1048] tasks.task.get: task not found, raw=${JSON.stringify(r).slice(0, 2000)}`);
  return task;
}

async function updateTaskDeadline(taskId, deadlineYmd) {
  return unwrap(await bitrix.call('tasks.task.update', {
    taskId: Number(taskId),
    fields: { DEADLINE: taskDeadlineIsoFromDate(deadlineYmd) },
  }));
}


async function listTasksByBinding(binding) {
  const r = await bitrix.call('tasks.task.list', {
    filter: { UF_CRM_TASK: binding },
    select: ['ID', 'STATUS', 'DEADLINE', 'CREATED_DATE', 'TITLE'],
    order: { ID: 'DESC' },
  });

  const u = unwrap(r);
  const tasks = u?.tasks || u?.result?.tasks || u || [];
  return Array.isArray(tasks) ? tasks : [];
}

function isCompletedTask(task) {
  // Bitrix: 5 = completed
  return String(task?.status ?? task?.STATUS) === '5';
}

async function findExistingBoundTask(item) {
  for (const arr of bindingCandidates(item)) {
    const binding = arr?.[0];
    if (!binding) continue;

    try {
      const tasks = await listTasksByBinding(binding);
      if (!tasks.length) continue;

      const alive = tasks.find(t => !isCompletedTask(t));
      const pick = alive || tasks[0];

      const id = Number(pick?.id || pick?.ID);
      if (id) return { taskId: id, binding, task: pick };
    } catch (_e) {}
  }
  return null;
}


async function handleSpaEvent(req) {
  const _itemId =
    Number(req.query?.itemId) ||
    Number(req.body?.data?.FIELDS?.ID) ||
    Number(req.body?.data?.FIELDS?.Id) ||
    Number(req.body?.data?.id) ||
    0;

  if (!_itemId) return { ok: true, action: 'skip_no_item_id' };

  return await withItemLock(_itemId, async () => {
    const itemId = _itemId;


  const item0 = await getItem(itemId);

  // анти-петля: если мы сами только что писали — выходим
  if (item0[F_SYNC_AT]) {
    const delta = msBetween(item0[F_SYNC_AT], nowIso());
    if (delta < 4000) {
      return {
        ok: true,
        itemId,
        action: 'skip_anti_loop',
        syncAt: item0[F_SYNC_AT],
        syncSrc: item0[F_SYNC_SRC] || '',
      };
    }
  }

  // deadline: если пуст — ставим +7 дней
  let ensuredDeadline = false;
  let item = item0;

  if (!item[F_DEADLINE]) {
    const today = new Date();
    const day = Number(process.env.SPA1048_DEFAULT_MONTH_DAY || 25);

    let y = today.getFullYear();
    let m = today.getMonth(); // 0..11

    // если уже позже "дня месяца" — ставим на следующий месяц, чтобы не получить дату в прошлом
    if (today.getDate() > day) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
    }

  // ensured accountant on SPA item (responsible)
  let ensuredAccountant = false;
  const accId = Number(cfg.accountantId || process.env.SPA1048_ACCOUNTANT_ID || 1);
  const curAssigned = Number(item.assignedById || item.ASSIGNED_BY_ID || 0);
  if (accId && curAssigned !== accId) {
    await updateItem(itemId, {
      assignedById: accId,
      [F_SYNC_AT]: nowIso(),
      [F_SYNC_SRC]: 'server_set_accountant',
    });
    ensuredAccountant = true;
    item = await getItem(itemId);
  }

    const target = new Date(y, m, day);
    const yyyy = target.getFullYear();
    const mm = String(target.getMonth() + 1).padStart(2, '0');
    const dd = String(target.getDate()).padStart(2, '0');
    const ymd = `${yyyy}-${mm}-${dd}`;await updateItem(itemId, {
      [F_DEADLINE]: ymd,
      [F_SYNC_AT]: nowIso(),
      [F_SYNC_SRC]: 'server_deadline_default',
    });

    ensuredDeadline = true;
    item = await getItem(itemId);
  }

  const stageId = normalizeStageId(item.stageId);
  const deadlineYmd = dateOnly(item[F_DEADLINE]);

  if (isFinal(stageId)) {
    return { ok: true, itemId, stageId, deadline: deadlineYmd, ensuredDeadline, action: 'final_skip' };
  }

  if (!isActive(stageId)) {
    return { ok: true, itemId, stageId, deadline: deadlineYmd, ensuredDeadline, action: 'not_active_skip' };
  }

  let taskId = item[F_TASK_ID] ? Number(item[F_TASK_ID]) : null;

  if (taskId) {
    let task;
    try {
      task = await getTask(taskId);
    } catch (_e) {
      // задача могла быть удалена → пересоздаём
      const created = await createTaskBoundToItem(item, deadlineYmd);
      await updateItem(itemId, {
        [F_TASK_ID]: created.taskId,
        [F_SYNC_AT]: nowIso(),
        [F_SYNC_SRC]: 'server_task_recreate',
      });

      return {
        ok: true,
        itemId,
        stageId,
        deadline: deadlineYmd,
        ensuredDeadline,
        action: 'task_recreated',
        oldTaskId: taskId,
        taskId: created.taskId,
        bind: created.bind,
        checklist,
      };
    }

    const status = Number(task.status || task.STATUS || 0);

    // ✅ НОВОЕ: если задача завершена — дедлайн НЕ трогаем, пишем коммент в счёт
    if (status === TASK_STATUS_COMPLETED || task.closedDate || task.CLOSED_DATE) {
      const text =
        `Задача #${taskId} завершена. ` +
        `Дедлайн по счёту изменён на ${deadlineYmd}, но дедлайн завершённой задачи обновлять нельзя.`;

      const c = await addSpaTimelineComment(itemId, text);

      return {
        ok: true,
        itemId,
        stageId,
        deadline: deadlineYmd,
        ensuredDeadline,
        action: 'task_closed_skip',
        taskId,
        comment: c.ok ? 'added' : `failed: ${c.error}`,
      };
    }

    const taskDeadlineYmd = dateOnly(task.deadline);

    if (deadlineYmd && taskDeadlineYmd !== deadlineYmd) {
      await updateTaskDeadline(taskId, deadlineYmd);
      await updateItem(itemId, {
        [F_SYNC_AT]: nowIso(),
        [F_SYNC_SRC]: 'server_task_deadline_sync',
      });


      return {
        ok: true,
        itemId,
        stageId,
        deadline: deadlineYmd,
        ensuredDeadline,
        action: 'task_deadline_updated',
        taskId,
        from: taskDeadlineYmd,
        to: deadlineYmd,
        checklist,
      };
    }


    return { ok: true, itemId, stageId, deadline: deadlineYmd, ensuredDeadline, action: 'no_change', taskId, checklist };
  }

  // taskId пуст — создаём
  const created = await createTaskBoundToItem(item, deadlineYmd);

  await updateItem(itemId, {
    [F_TASK_ID]: created.taskId,
    [F_SYNC_AT]: nowIso(),
    [F_SYNC_SRC]: 'server_task_create',
  });


  return {
    ok: true,
    itemId,
    stageId,
    deadline: deadlineYmd,
    ensuredDeadline,
    action: 'task_created',
    taskId: created.taskId,
    bind: created.bind,
    checklist,
  };
  });
}


module.exports = { handleSpaEvent };
