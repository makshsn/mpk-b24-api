const cfg = require('./config');
const bitrix = require('../..//services/bitrix/bitrixClient');

function nowIso() {
  return new Date().toISOString();
}

function toDateOnly(value) {
  if (!value) return null;
  // value может быть "2026-01-20" или "2026-01-20T03:00:00+03:00"
  return String(value).slice(0, 10);
}

function addDays(dateOnly, days) {
  const d = new Date(dateOnly + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function defaultMonthDayDateOnly(day = 25) {
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


function makeTaskDeadline(dateOnly) {
  // делаем "YYYY-MM-DDT12:00:00+03:00"
  // +03:00 фиксируем (у тебя портал MSK/МСК)
  return `${dateOnly}T${String(cfg.taskDeadlineHour).padStart(2,'0')}:00:00+03:00`;
}

function isFreshSync(syncAtValue) {
  if (!syncAtValue) return false;
  const t = Date.parse(syncAtValue);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs >= 0 && ageMs < cfg.antiLoopSeconds * 1000;
}

async function getItem(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
  });

  const item = r?.result?.item || r?.item || r?.result;
  if (!item) throw new Error('[spa1048] crm.item.get: item not found');
  return item;
}

async function updateItem(itemId, fields) {
  return bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields,
  });
}

// Привязка задачи к SPA через UF_CRM_TASK.
// Формат для SPA в облаке бывает разный в зависимости от окружения,
// поэтому кладём несколько вариантов — Bitrix лишнее игнорирует.
function buildCrmBindings(entityTypeId, categoryId, itemId) {
  const id = Number(itemId);
  const cat = Number(categoryId);

  return [
    `DYNAMIC_${entityTypeId}_${id}`,
    `DYNAMIC_${entityTypeId}:${id}`,
    `DYNAMIC_${entityTypeId}_${cat}_${id}`,
    `DYNAMIC_${entityTypeId}_${cat}:${id}`,
  ];
}

async function ensureDeadline(item) {
  const f = cfg.fields.deadlinePay;

  if (item[f]) {
    return { item, ensured: false };
  }

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayOnly = `${yyyy}-${mm}-${dd}`;

  const deadline = defaultMonthDayDateOnly(Number(process.env.SPA1048_DEFAULT_MONTH_DAY || 25));

  await updateItem(item.id, {
    [f]: deadline,
    [cfg.fields.syncAt]: nowIso(),
    [cfg.fields.syncSrc]: 'server_deadline_default',
  });

  const fresh = await getItem(item.id);
  return { item: fresh, ensured: true };
}

async function createTaskForItem(item) {
  const accountantId = Number(process.env[cfg.accountantIdEnv] || 0) || 1;

  const dateOnly = toDateOnly(item[cfg.fields.deadlinePay]);
  const deadline = makeTaskDeadline(dateOnly);

  const bindings = buildCrmBindings(cfg.entityTypeId, item.categoryId, item.id);

  const r = await bitrix.call('tasks.task.add', {
    fields: {
      TITLE: `Оплатить счёт #${item.id}`,
      DESCRIPTION: `Открыть счёт: https://b24-mg3u3i.bitrix24.ru/crm/type/${cfg.entityTypeId}/details/${item.id}/`,
      RESPONSIBLE_ID: accountantId,
      DEADLINE: deadline,
      UF_CRM_TASK: bindings,
    },
  });

  const taskId = Number(r?.result?.task?.id || r?.task?.id || r?.result?.id || r?.id);
  if (!taskId) throw new Error('[spa1048] tasks.task.add: taskId not found');

  await updateItem(item.id, {
    [cfg.fields.taskId]: taskId,
    [cfg.fields.syncAt]: nowIso(),
    [cfg.fields.syncSrc]: 'server_task_create',
  });

  return { taskId };
}

async function getTask(taskId) {
  // ВНИМАНИЕ: UF_* поля нужно явно просить через select :contentReference[oaicite:2]{index=2}
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'TITLE', 'DEADLINE', 'UF_CRM_TASK'],
  });
  return r?.result?.task || r?.task || r?.result;
}

async function updateTaskDeadline(taskId, dateOnly) {
  return bitrix.call('tasks.task.update', {
    taskId: Number(taskId),
    fields: { DEADLINE: makeTaskDeadline(dateOnly) },
  });
}

async function handleSpaEvent({ itemId }) {
  if (!itemId) throw new Error('itemId is required');

  let item = await getItem(itemId);

  // анти-петля: если мы сами только что писали — выходим
  if (isFreshSync(item[cfg.fields.syncAt])) {
    return { ok: true, itemId: Number(itemId), action: 'skip_anti_loop', stageId: item.stageId };
  }

  const ensured = await ensureDeadline(item);
  item = ensured.item;

  const stageId = item.stageId;
  const dateOnly = toDateOnly(item[cfg.fields.deadlinePay]);

  // финальные стадии — задачу не создаём/не трогаем
  if (cfg.stages.final.includes(stageId)) {
    return {
      ok: true,
      itemId: item.id,
      stageId,
      deadline: dateOnly,
      ensuredDeadline: ensured.ensured,
      action: 'final_skip',
      taskId: item[cfg.fields.taskId] || null,
    };
  }

  // активные — задача нужна
  if (!cfg.stages.active.includes(stageId)) {
    return {
      ok: true,
      itemId: item.id,
      stageId,
      deadline: dateOnly,
      ensuredDeadline: ensured.ensured,
      action: 'not_active_skip',
      taskId: item[cfg.fields.taskId] || null,
    };
  }

  const taskId = Number(item[cfg.fields.taskId] || 0);

  // если taskId пуст — создаём
  if (!taskId) {
    const created = await createTaskForItem(item);
    return {
      ok: true,
      itemId: item.id,
      stageId,
      deadline: dateOnly,
      ensuredDeadline: ensured.ensured,
      action: 'task_created',
      taskId: created.taskId,
    };
  }

  // taskId есть — проверяем, что задача реально существует и можно читать
  let task;
  try {
    task = await getTask(taskId);
  } catch (e) {
    // если задачу удалили/нет доступа — создаём новую и перезаписываем taskId в SPA
    const created = await createTaskForItem(item);
    return {
      ok: true,
      itemId: item.id,
      stageId,
      deadline: dateOnly,
      ensuredDeadline: ensured.ensured,
      action: 'task_recreated',
      oldTaskId: taskId,
      taskId: created.taskId,
      note: String(e?.message || e),
    };
  }

  const taskDateOnly = toDateOnly(task?.deadline);

  if (taskDateOnly !== dateOnly) {
    await updateTaskDeadline(taskId, dateOnly);

    await updateItem(item.id, {
      [cfg.fields.syncAt]: nowIso(),
      [cfg.fields.syncSrc]: 'server_task_deadline_sync',
    });

    return {
      ok: true,
      itemId: item.id,
      stageId,
      deadline: dateOnly,
      ensuredDeadline: ensured.ensured,
      action: 'task_deadline_updated',
      taskId,
      from: taskDateOnly,
      to: dateOnly,
    };
  }

  return {
    ok: true,
    itemId: item.id,
    stageId,
    deadline: dateOnly,
    ensuredDeadline: ensured.ensured,
    action: 'no_change',
    taskId,
  };
}

module.exports = { handleSpaEvent };
