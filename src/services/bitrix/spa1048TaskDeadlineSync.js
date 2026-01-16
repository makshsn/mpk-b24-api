const bitrix = require('./bitrixClient');

const cfg = {
  entityTypeId: 1048,
  categoryId: 14,

  // SPA fields (в ответе crm.item.get они camelCase)
  fDeadline: 'ufCrm8_1768219591855',
  fTaskId: 'ufCrm8TaskId',
  fSyncAt: 'ufCrm8SyncAt',
  fSyncSrc: 'ufCrm8SyncSrc',

  // stages
  activeStages: new Set(['DT1048_14:NEW', 'DT1048_14:PREPARATION', 'DT1048_14:CLIENT']),
  finalStages: new Set(['DT1048_14:SUCCESS', 'DT1048_14:FAIL']),
};

function isoNow() {
  return new Date().toISOString();
}

function dateOnly(value) {
  if (!value) return null;
  const s = String(value);
  // "2026-01-20" or "2026-01-20T12:00:00+03:00"
  return s.slice(0, 10);
}

// Tb14_4 => {categoryId:14, itemId:4}
function parseUfCrmTaskBind(bind) {
  const s = String(bind || '').trim();
  const m = s.match(/^Tb(\d+)_(\d+)$/i);
  if (!m) return null;
  return { categoryId: Number(m[1]), itemId: Number(m[2]) };
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', { taskId: Number(taskId) });
  const task = r?.result?.task || r?.task || r?.result;
  if (!task) throw new Error('[spa1048] tasks.task.get: task not found in response');
  return task;
}

async function getSpaItem(itemId) {
  const r = await bitrix.call('crm.item.get', { entityTypeId: cfg.entityTypeId, id: Number(itemId) });
  const item = r?.result?.item || r?.item || r?.result;
  if (!item) throw new Error('[spa1048] crm.item.get: item not found in response');
  return item;
}

async function updateSpaDeadline(itemId, newDateYmd, syncSrc) {
  await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields: {
      [cfg.fDeadline]: newDateYmd,     // Bitrix сам приведёт к своему времени (у тебя это 03:00)
      [cfg.fSyncAt]: isoNow(),
      [cfg.fSyncSrc]: syncSrc,
    },
  });
}

async function handleTaskEvent({ taskId }) {
  if (!taskId) return { ok: false, error: 'taskId is required' };

  // 1) забираем задачу
  const task = await getTask(taskId);
  const taskDeadlineYmd = dateOnly(task.deadline);

  // 2) понимаем к какому SPA привязана задача (UF_CRM_TASK)
  const binds = task.ufCrmTask || task.UF_CRM_TASK || [];
  const bind = Array.isArray(binds) ? binds.find(x => /^Tb\d+_\d+$/i.test(String(x))) : null;
  const parsed = parseUfCrmTaskBind(bind);
  if (!parsed || parsed.categoryId !== cfg.categoryId) {
    return { ok: true, taskId: Number(taskId), action: 'skip_not_bound_to_spa1048', ufCrmTask: binds };
  }

  const itemId = parsed.itemId;

  // 3) забираем SPA item
  const item = await getSpaItem(itemId);

  // если уже финал — можешь не трогать (по ТЗ задача “не нужна” на финале)
  if (cfg.finalStages.has(item.stageId)) {
    return { ok: true, taskId: Number(taskId), itemId, action: 'skip_final_stage', stageId: item.stageId };
  }

  // 4) анти-петля (если мы сами только что писали в SPA — не дёргаем обратно)
  const syncAt = item?.[cfg.fSyncAt];
  const syncSrc = String(item?.[cfg.fSyncSrc] || '');
  if (syncAt) {
    const ageMs = Date.now() - new Date(syncAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 4000 && syncSrc.startsWith('server_')) {
      return { ok: true, taskId: Number(taskId), itemId, action: 'skip_antiloop', syncAt, syncSrc };
    }
  }

  // 5) сравниваем дату в SPA и в задаче
  const spaDeadlineYmd = dateOnly(item?.[cfg.fDeadline]);

  // если у задачи нет дедлайна — ничего не делаем
  if (!taskDeadlineYmd) {
    return { ok: true, taskId: Number(taskId), itemId, action: 'skip_no_task_deadline' };
  }

  // если совпадает — ок
  if (spaDeadlineYmd === taskDeadlineYmd) {
    return { ok: true, taskId: Number(taskId), itemId, action: 'no_change', deadline: taskDeadlineYmd };
  }

  // 6) задача → SPA (перезаписываем поле счета)
  await updateSpaDeadline(itemId, taskDeadlineYmd, 'server_task_to_spa_deadline_sync');

  return {
    ok: true,
    taskId: Number(taskId),
    itemId,
    action: 'spa_deadline_updated_from_task',
    from: spaDeadlineYmd,
    to: taskDeadlineYmd,
  };
}

module.exports = { handleTaskEvent };
