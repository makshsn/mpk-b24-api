'use strict';

const fs = require('fs');
const path = require('path');
const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');
const { normalizeSpaFiles } = require('./spa1048Files.v1');
const { createPaymentTaskIfMissing } = require('./spa1048PaymentTask.v1');

const checklistModulePath = path.join(__dirname, 'taskChecklistSync.v1.js');
const checklistModule = fs.existsSync(checklistModulePath) ? require('./taskChecklistSync.v1') : null;
const ensureChecklistForTask = checklistModule?.ensureChecklistForTask;

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
// - если сегодня >= 25 -> +7 дней от сегодня
function computeDefaultDeadlineYmd() {
  const now = new Date();
  const day = now.getDate();

  if (day < 25) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-25`;
  }

  const d = new Date(now);
  d.setDate(d.getDate() + 7);
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

  // файлы (ZIP -> PDF)
  let files = { ok: true, action: 'skipped' };
  if (filesEnabled) {
    try {
      files = await normalizeSpaFiles({ entityTypeId, itemId });
    } catch (e) {
      files = { ok: false, action: 'error', error: e?.message || String(e) };
    }
  }

  // чеклист (опционален)
  let checklist = { ok: false, action: 'skipped', reason: 'no_task' };
  if (activeTaskId && ensureChecklistForTask) {
    try {
      const pdfList = Array.isArray(files?.pdfList) ? files.pdfList : [];
      checklist = await ensureChecklistForTask(activeTaskId, pdfList);
    } catch (e) {
      checklist = { ok: false, action: 'error', error: e?.message || String(e) };
    }
  } else if (!ensureChecklistForTask) {
    checklist = { ok: false, action: 'skipped', reason: 'module_missing' };
  }

  // --- Создание задачи, если нет активной (в т.ч. удалена/выполнена) ---
  const accountantId = Number(process.env.SPA1048_ACCOUNTANT_ID || cfg.accountantId || 70);
  let taskCreate = null;

  if (!activeTaskId) {
    const pdfNames = Array.isArray(files?.pdfNames) ? files.pdfNames : [];
    taskCreate = await createPaymentTaskIfMissing({
      entityTypeId,
      itemId,
      itemTitle: item.title || item.TITLE || '',
      deadline: taskDeadlineIso(deadline),
      taskId: 0,
      pdfNames,
      responsibleId: Number(item.assignedById || item.ASSIGNED_BY_ID || accountantId),
    });

    if (taskCreate?.taskId && ensureChecklistForTask) {
      try {
        const pdfList = Array.isArray(files?.pdfList) ? files.pdfList : [];
        checklist = await ensureChecklistForTask(taskCreate.taskId, pdfList);
      } catch (e) {
        checklist = { ok: false, action: 'error', error: e?.message || String(e) };
      }
    }
  }

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
    checklist,
    files,
    debug: debug ? { filesEnabled, entityTypeId, deadlineOrig, deadlineCamel } : undefined,
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
