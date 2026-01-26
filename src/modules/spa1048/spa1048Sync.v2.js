'use strict';

const fs = require('fs');
const path = require('path');
const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { normalizeSpaFiles } = require('./spa1048Files.v1');
const { createPaymentTaskIfMissing, syncPaymentTaskContent } = require('./spa1048PaymentTask.v1');

const checklistModulePath = path.join(__dirname, 'taskChecklistSync.v1.js');
const checklistModule = fs.existsSync(checklistModulePath) ? require('./taskChecklistSync.v1') : null;
const ensureChecklistForTask = checklistModule?.ensureChecklistForTask;
const getChecklistItems = checklistModule?.getChecklistItems;
const isChecklistFullyCompleteExternal = checklistModule?.isChecklistFullyComplete;
const getChecklistSummary = checklistModule?.getChecklistSummary;

// ---- simple in-process lock to avoid double-create on burst webhooks ----
const itemLocks = new Map();
async function withItemLock(itemId, fn) {
  const key = String(itemId);
  if (itemLocks.has(key)) return await itemLocks.get(key);
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

function isChecklistFullyCompleteLocal(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((it) => String(it?.IS_COMPLETE ?? '').toUpperCase() === 'Y');
}

// UF_CRM_8_176... -> ufCrm8_176...
function ufToCamel(uf) {
  const s = String(uf || '').trim();
  if (!s) return '';
  if (!/^UF_/i.test(s)) return s;

  const lower = s.toLowerCase();
  const parts = lower.split('_').filter(Boolean); // ['uf','crm','8','176...']
  if (!parts.length) return '';

  let out = parts[0]; // uf
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === 1) { out += p.charAt(0).toUpperCase() + p.slice(1); continue; } // crm -> Crm
    if (/^\d+$/.test(p) && i === 2) { out += p; continue; } // 8
    out += '_' + p; // остальное
  }
  return out;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ТЗ: если пусто:
// - если сегодня < 25 -> 25-е текущего месяца
// - если сегодня >= 25 -> 25-е следующего месяца
function computeDefaultDeadlineYmd(now = new Date()) {
  const day = now.getDate();

  if (day < 25) {
    const d = new Date(now.getFullYear(), now.getMonth(), 25);
    return ymdFromDate(d);
  }

  const d = new Date(now.getFullYear(), now.getMonth() + 1, 25);
  return ymdFromDate(d);
}

// для задачи DEADLINE лучше слать datetime
function taskDeadlineIso(ymd) {
  if (!ymd) return null;
  const t = String(process.env.SPA1048_TASK_DEADLINE_TIME || 'T18:00:00+03:00').trim();
  if (t.startsWith('T')) return ymd + t;
  if (/^\d{2}:\d{2}/.test(t)) return `${ymd}T${t}`;
  return `${ymd}T18:00:00+03:00`;
}

async function getItem(entityTypeId, itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    select: ['*'],
  }, { ctx: { step: 'crm_item_get', itemId } });

  const u = unwrap(r);
  return u?.item || u;
}

async function getTask(taskId, ctxStep) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'DEADLINE', 'STATUS', 'UF_CRM_TASK'],
  }, { ctx: { step: ctxStep || 'task_get', taskId } });

  const u = unwrap(r);
  return u?.task || u?.result?.task || u?.result || u;
}

// Проверяем: taskId существует и задача НЕ выполнена
async function ensureActiveTaskId(taskId) {
  const tid = Number(taskId) || 0;
  if (!tid) return { activeTaskId: 0, reason: 'no_task_id' };

  try {
    const t = await getTask(tid, 'task_check_get');
    const status = Number(t?.status || t?.STATUS || 0) || 0;

    // 5 = completed
    if (status === 5) {
      return { activeTaskId: 0, reason: 'task_completed', status };
    }

    // если вдруг API вернул без ID
    const realId = Number(t?.id || t?.ID || 0) || 0;
    if (!realId) {
      return { activeTaskId: 0, reason: 'task_missing_id', status };
    }

    return { activeTaskId: tid, reason: 'task_active', status };
  } catch (e) {
    // удалена / не найдена / нет доступа и т.п.
    return { activeTaskId: 0, reason: 'task_get_failed', error: e?.message || String(e) };
  }
}

async function safeMoveSpaToSuccess({ entityTypeId, itemId, taskId }) {
  try {
    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { stageId: 'DT1048_14:SUCCESS' },
    }, { ctx: { step: 'crm_move_success_from_task', itemId, taskId } });
    return { ok: true, action: 'moved_to_success' };
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'SPA1048_MOVE_SUCCESS_FAIL',
      itemId,
      taskId,
      error: e?.message || String(e),
    }));
    return { ok: false, action: 'move_success_failed', error: e?.message || String(e) };
  }
}

async function autoCloseTaskByChecklist({
  entityTypeId,
  itemId,
  taskId,
  stageId,
  checklistSummary,
  checklistItems,
  taskStatus,
}) {
  const stageBefore = normalizeStageId(stageId);
  const stageSuccess = 'DT1048_14:SUCCESS';

  // Если элемент уже в финальной стадии "провалено/отмена" —
  // не выполняем авто-закрытие по чеклисту и не переносим в SUCCESS.
  // Закрытие задачи в этом сценарии делается отдельным роботом через /b24/task-close.
  const failedStagesEnv = String(
    process.env.SPA1048_STAGE_FAILED || process.env.SPA1048_STAGE_FAIL || ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const isFailedStage = (sid) => {
    const s = String(sid || '').trim();
    if (!s) return false;
    if (failedStagesEnv.length && failedStagesEnv.includes(s)) return true;
    // дефолт для SPA1048: DT1048_14:FAIL
    return /(^|:)(FAIL|FAILED|CANCEL|CANCELED|DECLINE|DECLINED|LOSE|LOST)(:|$)/i.test(s);
  };

  if (isFailedStage(stageBefore)) {
    return {
      ok: true,
      action: 'skip_spa_failed_stage',
      taskId: Number(taskId) || 0,
      stageBefore,
      stageAfter: stageBefore,
    };
  }

  if (!taskId) {
    return { ok: true, action: 'skip_no_task', taskId: null, stageBefore, stageAfter: stageBefore };
  }

  if (Number(taskStatus) === 5) {
    if (stageBefore === stageSuccess) {
      return { ok: true, action: 'skip_task_already_completed', taskId: Number(taskId), stageBefore, stageAfter: stageBefore };
    }
    const moveResult = await safeMoveSpaToSuccess({ entityTypeId, itemId, taskId });
    return {
      ok: moveResult.ok,
      action: moveResult.ok ? 'skip_task_already_completed_move_success' : 'task_completed_move_success_failed',
      taskId: Number(taskId),
      stageBefore,
      stageAfter: moveResult.ok ? stageSuccess : stageBefore,
      error: moveResult.ok ? undefined : moveResult.error,
    };
  }

  if (!checklistSummary || !checklistSummary.total) {
    return { ok: true, action: 'skip_checklist_empty', taskId: Number(taskId), stageBefore, stageAfter: stageBefore };
  }

  const checklistComplete = isChecklistFullyCompleteExternal || isChecklistFullyCompleteLocal;
  if (!checklistComplete(checklistItems || [])) {
    return { ok: true, action: 'skip_checklist_not_complete', taskId: Number(taskId), stageBefore, stageAfter: stageBefore };
  }

  try {
    await bitrix.call('tasks.task.complete', {
      taskId: Number(taskId),
    }, { ctx: { step: 'task_auto_complete', taskId, itemId } });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'SPA1048_TASK_COMPLETE_FAIL',
      itemId,
      taskId,
      error: e?.message || String(e),
    }));
    return {
      ok: false,
      action: 'task_complete_failed',
      taskId: Number(taskId),
      stageBefore,
      stageAfter: stageBefore,
      error: e?.message || String(e),
    };
  }

  if (stageBefore === stageSuccess) {
    return {
      ok: true,
      action: 'closed_task_skip_already_success',
      taskId: Number(taskId),
      stageBefore,
      stageAfter: stageBefore,
    };
  }

  const moveResult = await safeMoveSpaToSuccess({ entityTypeId, itemId, taskId });
  return {
    ok: moveResult.ok,
    action: moveResult.ok ? 'closed_task_and_marked_success' : 'move_success_failed',
    taskId: Number(taskId),
    stageBefore,
    stageAfter: moveResult.ok ? stageSuccess : stageBefore,
    error: moveResult.ok ? undefined : moveResult.error,
  };
}

async function syncSpa1048Item({ itemId, debug = false }) {
  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const filesEnabled = process.env.SPA1048_FILES_ENABLED !== '0';

  const item = await getItem(entityTypeId, itemId);
  if (!item?.id) return { ok: false, error: 'item_not_found', itemId };

  const stageId = normalizeStageId(item.stageId || item.STAGE_ID);

  // Дедлайн (поле в CRM)
  const deadlineOrig = String(cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const deadlineCamel = ufToCamel(deadlineOrig) || 'ufCrm8_1768219591855';

  let deadline = dateOnly(item?.[deadlineCamel] || item?.[deadlineOrig] || null);
  let ensuredDeadline = false;

  if (!deadline) {
    deadline = computeDefaultDeadlineYmd();
    ensuredDeadline = true;

    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      useOriginalUfNames: 'Y',
      fields: {
        [deadlineOrig]: deadline,
        [deadlineCamel]: deadline,
      },
    }, { ctx: { step: 'crm_set_default_deadline', itemId, deadline } });
  }

  // taskId из карточки
  const taskId = Number(item.ufCrm8TaskId || item.UF_CRM_8_TASK_ID || item.uf_crm_8_task_id || 0) || 0;

  // ✅ проверяем активность (существует и не выполнена)
  const taskCheck = await ensureActiveTaskId(taskId);
  const activeTaskId = Number(taskCheck.activeTaskId || 0) || 0;

  // --- СИНХРА ДЕДЛАЙНА SPA -> TASK (если активная задача есть) ---
  let taskDeadlineSync = { ok: true, action: 'skipped' };
  if (activeTaskId && deadline) {
    const task = await getTask(activeTaskId, 'task_get_for_deadline_sync');
    const taskYmd = dateOnly(task?.deadline || task?.DEADLINE || null);

    if (taskYmd !== deadline) {
      await bitrix.call('tasks.task.update', {
        taskId: Number(activeTaskId),
        fields: { DEADLINE: taskDeadlineIso(deadline) },
      }, { ctx: { step: 'task_deadline_sync_from_spa', taskId: activeTaskId, itemId, from: taskYmd || null, to: deadline } });

      taskDeadlineSync = { ok: true, action: 'task_updated_from_spa', from: taskYmd || null, to: deadline };
    } else {
      taskDeadlineSync = { ok: true, action: 'no_change', deadline };
    }
  }

  // файлы (ZIP -> распаковка всех файлов)
  let files = { ok: true, action: 'skipped' };
  if (filesEnabled) {
    try {
      files = await normalizeSpaFiles({ entityTypeId, itemId });
    } catch (e) {
      files = { ok: false, action: 'error', error: e?.message || String(e) };
    }
  }

  // --- СИНХРА КОНТЕНТА ЗАДАЧИ (TITLE/DESCRIPTION) под актуальные файлы ---
  // Важно: обновляем только когда меняется набор файлов (см. syncPaymentTaskContent),
  // чтобы не триггерить лишние ONTASKUPDATE.
  let taskContentSync = { ok: true, action: 'skipped', reason: 'no_task' };
  if (activeTaskId && typeof syncPaymentTaskContent === 'function') {
    try {
      const fileNames = Array.isArray(files?.fileNames) ? files.fileNames : [];
      taskContentSync = await syncPaymentTaskContent({
        taskId: activeTaskId,
        itemId,
        itemTitle: item.title || item.TITLE || '',
        fileNames,
        deadline: deadline ? taskDeadlineIso(deadline) : null,
      });
    } catch (e) {
      taskContentSync = { ok: false, action: 'error', error: e?.message || String(e) };
    }
  }

  // чеклист (опционален)
  let checklist = { ok: false, action: 'skipped', reason: 'no_task' };
  let checklistItems = [];
  let checklistSummary = null;
  if (activeTaskId && ensureChecklistForTask) {
    try {
      const fileList = Array.isArray(files?.fileList) ? files.fileList : (Array.isArray(files?.pdfList) ? files.pdfList : []);
      checklist = await ensureChecklistForTask(activeTaskId, fileList);
      checklistItems = Array.isArray(checklist?.items) ? checklist.items : [];
      if (!checklistItems.length && getChecklistItems) {
        checklistItems = await getChecklistItems(activeTaskId);
      }
      checklistSummary = checklist?.summary || (getChecklistSummary ? await getChecklistSummary(activeTaskId) : null);
    } catch (e) {
      checklist = { ok: false, action: 'error', error: e?.message || String(e) };
    }
  } else if (!ensureChecklistForTask) {
    checklist = { ok: false, action: 'skipped', reason: 'module_missing' };
  }

  // --- Создание задачи, если нет активной (в т.ч. удалена/выполнена) ---
  const accountantId = Number(process.env.SPA1048_ACCOUNTANT_ID || cfg.accountantId || 70);
  let taskCreate = null;

  if (!activeTaskId && taskCheck?.reason !== 'task_completed') {
    const fileNames = Array.isArray(files?.fileNames) ? files.fileNames : [];
    taskCreate = await createPaymentTaskIfMissing({
      entityTypeId,
      itemId,
      itemTitle: item.title || item.TITLE || '',
      deadline: taskDeadlineIso(deadline),
      taskId,
      fileNames,
      responsibleId: Number(accountantId),
      stageId,
    });

    if (taskCreate?.taskId && ensureChecklistForTask) {
      try {
        const fileList = Array.isArray(files?.fileList) ? files.fileList : (Array.isArray(files?.pdfList) ? files.pdfList : []);
        checklist = await ensureChecklistForTask(taskCreate.taskId, fileList);
        checklistItems = Array.isArray(checklist?.items) ? checklist.items : [];
        if (!checklistItems.length && getChecklistItems) {
          checklistItems = await getChecklistItems(taskCreate.taskId);
        }
        checklistSummary = checklist?.summary || (getChecklistSummary ? await getChecklistSummary(taskCreate.taskId) : null);
      } catch (e) {
        checklist = { ok: false, action: 'error', error: e?.message || String(e) };
      }
    }
  }

  const autoCloseTargetTaskId = activeTaskId || taskId || taskCreate?.taskId || null;
  const taskAutoClose = await autoCloseTaskByChecklist({
    entityTypeId,
    itemId,
    taskId: autoCloseTargetTaskId,
    stageId,
    checklistSummary,
    checklistItems,
    taskStatus: taskCheck?.status,
  });

  return {
    ok: true,
    itemId: Number(itemId),
    stageId,
    deadline,
    ensuredDeadline,
    taskId: activeTaskId || taskCreate?.taskId || null,
    taskCheck,
    taskCreate,
    taskDeadlineSync,
    taskContentSync,
    checklist,
    checklistSummary,
    files,
    taskAutoClose: debug ? taskAutoClose : undefined,
    debug: debug ? {
      filesEnabled,
      entityTypeId,
      deadlineOrig,
      deadlineCamel,
      checklistSummary,
      taskAutoClose,
      stageBefore: stageId,
      stageAfter: taskAutoClose?.stageAfter,
    } : undefined,
  };
}

function extractItemIdFromReq(req) {
  const q = req?.query || {};
  const b = req?.body || {};

  const raw = (
    q.itemId ??
    q.id ??
    b?.data?.FIELDS?.ID ??
    b?.data?.FIELDS?.id ??
    b?.FIELDS?.ID ??
    b?.FIELDS?.id ??
    b?.itemId ??
    b?.id
  );

  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function handleSpaEvent(req, res) {
  try {
    const b = req.body || {};
    const q = req.query || {};

    const itemId = extractItemIdFromReq(req);

    if (!itemId) {
      return res.status(400).json({ ok: false, error: 'invalid_itemId' });
    }

    const debug = String(q.debug ?? b.debug ?? '0') === '1';

    const result = await withItemLock(itemId, async () => {
      return await syncSpa1048Item({ itemId, debug });
    });

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

module.exports = { handleSpaEvent, syncSpa1048Item, withItemLock };
