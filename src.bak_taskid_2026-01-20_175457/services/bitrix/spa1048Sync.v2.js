const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureChecklistForTask } = require('./taskChecklistSync.v1');
const { normalizeSpaFiles } = require('./spa1048Files.v1');
const { createPaymentTaskIfMissing } = require('./spa1048PaymentTask.v1');

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

async function getItem(entityTypeId, itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    select: ['*'],
  }, { ctx: { step: 'crm_item_get', itemId } });
  const u = unwrap(r);
  return u?.item || u;
}

/**
 * Основная синхронизация: задача -> чеклист -> файлы
 */
async function syncSpa1048Item({ itemId, debug = false }) {
  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const filesEnabled = process.env.SPA1048_FILES_ENABLED !== '0';

  const item = await getItem(entityTypeId, itemId);
  if (!item?.id) return { ok: false, error: 'item_not_found', itemId };

  const stageId = normalizeStageId(item.stageId || item.STAGE_ID);

  // дедлайн у тебя может быть в другом UF — оставляем как было/пусто
  const deadline = dateOnly(item.ufCrm8_1768219591855 || item.UF_CRM_8_1768219591855 || null);

  // ВАЖНО: taskId хранится в UF_CRM_8_TASK_ID (в ответе приходит ufCrm8TaskId)
  const taskId = Number(item.ufCrm8TaskId || item.UF_CRM_8_TASK_ID || item.uf_crm_8_task_id || 0) || 0;

  // чеклист
  let checklist = { ok: false, error: 'no_task' };
  if (taskId) {
    checklist = await ensureChecklistForTask({ taskId });
  }

  // файлы (ZIP->PDF, reupload)
  let files = { ok: true, action: 'skipped' };
  if (filesEnabled) {
    files = await normalizeSpaFiles({ entityTypeId, itemId });
  }

  // --- payment task + checklist by PDF names ---
  const accountantId = Number(process.env.SPA1048_ACCOUNTANT_ID || cfg.accountantId || 70);
  let taskCreate = null;
  if (!taskId) {
    const pdfNames = files?.pdfNames || [];
    taskCreate = await createPaymentTaskIfMissing({
      entityTypeId,
      itemId,
      itemTitle: item.title || item.TITLE || '',
      deadline,
      taskId: 0,
      pdfNames,
      responsibleId: Number(item.assignedById || item.ASSIGNED_BY_ID || accountantId),
    });
  }

  return {
    ok: true,
    itemId: Number(itemId),
    stageId,
    deadline,
    ensuredDeadline: false,
    action: 'no_change',
    taskId: taskId || taskCreate?.taskId || null,
    taskCreate,
    checklist,
    files,
    debug: debug ? { filesEnabled, entityTypeId } : undefined,
  };
}

/**
 * Express handler: /b24/spa-event?itemId=50&debug=1
 */
async function handleSpaEvent(req, res) {
  try {


    const p = req?.params || {};
    const b = req.body || {};
    const q = req.query || {};
    const raw = (
      req.query?.itemId ??
      req.query?.id ??
      req.body?.data?.FIELDS?.ID ??
      req.body?.data?.FIELDS?.id ??
      req.body?.FIELDS?.ID ??
      req.body?.FIELDS?.id ??
      req.body?.itemId ??
      req.body?.id
    );
    const itemId = Number(raw);

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return res.status(400).json({ ok: false, error: `invalid_itemId:${raw}` });
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
