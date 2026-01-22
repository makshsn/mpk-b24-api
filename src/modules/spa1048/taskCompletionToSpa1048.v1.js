'use strict';

const fs = require('fs/promises');
const path = require('path');

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { ensureObjectBody, extractTaskIdDetailed } = require('../../services/bitrix/b24Outbound.v1');

const COMPLETED_STATUS = 5;
const PDF_FILES_FIELD = 'UF_CRM_8_1768219060503';

// ====== helpers ======
function parseNumber(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pickFirstNumber(values) {
  for (const v of values) {
    const n = parseNumber(v);
    if (n !== null) return n;
  }
  return null;
}

function extractStatusAfter(req) {
  const b = ensureObjectBody(req);
  return pickFirstNumber([
    req?.query?.status,
    req?.query?.STATUS,
    req?.query?.statusAfter,
    req?.query?.STATUS_AFTER,
    b?.status,
    b?.STATUS,
    b?.statusAfter,
    b?.STATUS_AFTER,
    b?.data?.FIELDS_AFTER?.STATUS,
    b?.data?.FIELDS_AFTER?.status,
    b?.data?.FIELDS?.STATUS,
    b?.data?.FIELDS?.status,
    b?.FIELDS_AFTER?.STATUS,
    b?.FIELDS_AFTER?.status,
    b?.FIELDS?.STATUS,
    b?.FIELDS?.status,
  ]);
}

function extractStatusBefore(req) {
  const b = ensureObjectBody(req);
  return pickFirstNumber([
    req?.query?.statusBefore,
    req?.query?.STATUS_BEFORE,
    b?.statusBefore,
    b?.STATUS_BEFORE,
    b?.data?.FIELDS_BEFORE?.STATUS,
    b?.data?.FIELDS_BEFORE?.status,
    b?.FIELDS_BEFORE?.STATUS,
    b?.FIELDS_BEFORE?.status,
  ]);
}

function normalizeBindings(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/**
 * UF_CRM_TASK для SPA: тип в HEX после 'T', itemId — decimal.
 * Пример: T418_58 => entityTypeId = 0x418 = 1048, itemId = 58
 */
function parseCrmTaskBindings(ufCrmTask) {
  const bindings = normalizeBindings(ufCrmTask);
  const parsed = [];

  const reT = /T(?:_|:|-)?([0-9a-f]+)[_:|-](\d+)/gi;
  const reD = /D(?:_|:|-)?(\d+)[_:|-](\d+)/gi;

  for (const raw of bindings) {
    const text = String(raw || '').trim();
    if (!text) continue;

    let match;

    while ((match = reT.exec(text)) !== null) {
      const hexStr = String(match[1] || '').trim();
      const itemId = parseNumber(match[2]);
      const typeId = Number.isFinite(parseInt(hexStr, 16)) ? parseInt(hexStr, 16) : null;

      if (typeId && itemId) {
        parsed.push({
          typeId,
          itemId,
          raw: text,
          kind: 'T',
          typeHex: hexStr.toLowerCase(),
        });
      }
    }

    while ((match = reD.exec(text)) !== null) {
      const typeId = parseNumber(match[1]);
      const itemId = parseNumber(match[2]);
      if (typeId && itemId) parsed.push({ typeId, itemId, raw: text, kind: 'D' });
    }
  }

  return parsed;
}

function findSpaItemId(ufCrmTask, preferredTypeIds) {
  const bindings = parseCrmTaskBindings(ufCrmTask);
  if (!bindings.length) return null;

  const preferred = preferredTypeIds.filter(Number.isFinite);
  return bindings.find(binding => preferred.includes(binding.typeId)) || null;
}

function unwrapTaskGet(resp) {
  return resp?.result?.task || resp?.task || resp?.result || null;
}

async function fetchTask(taskId) {
  const result = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: [
      'ID',
      'STATUS',
      'UF_CRM_TASK',
      'TITLE',
      'DESCRIPTION',
      'CLOSED_DATE',
      'CHANGED_DATE',
      PDF_FILES_FIELD,
    ],
  });
  return unwrapTaskGet(result);
}

async function updateSpaStage({ itemId, stageId, entityTypeId }) {
  return await bitrix.call('crm.item.update', {
    entityTypeId,
    id: Number(itemId),
    fields: { stageId },
  });
}

// ====== checklist-from-pdf (idempotent + no duplicates) ======
function normalizeChecklistTitle(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function decodeUrlSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function filenameFromUrl(url) {
  const clean = String(url || '').split('#')[0];
  const noQuery = clean.split('?')[0];
  const last = noQuery.split('/').pop() || '';
  const decoded = decodeUrlSafe(last);
  return decoded || null;
}

function extractPdfItemsFromDescription(description) {
  const text = String(description || '');
  if (!text.trim()) return [];

  const found = new Map(); // key -> { title, url? }

  const urlRe = /(https?:\/\/[^\s"'<>]+?\.pdf)(\?[^\s"'<>]*)?/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const fullUrl = (m[1] || '') + (m[2] || '');
    const name = filenameFromUrl(m[1]) || 'file.pdf';
    const title = name;
    const key = normalizeChecklistTitle(title);
    if (!found.has(key)) found.set(key, { title, url: fullUrl });
  }

  const phraseRe = /([^\n\r<>]{1,200}\.pdf)\b/giu;
  while ((m = phraseRe.exec(text)) !== null) {
    let title = String(m[1] || '').trim();
    if (!title) continue;
    if (/^https?:\/\//i.test(title)) continue;

    title = title.replace(/^\s*\d+\s*[.)-]\s*/u, '');
    title = title.replace(/^\s*[-–•]\s*/u, '');
    title = title.replace(/\s+/gu, ' ').trim();
    title = title.replace(/^[«“"']+|[»”"']+$/gu, '').trim();

    if (!/\.pdf$/iu.test(title)) continue;

    const key = normalizeChecklistTitle(title);
    if (!found.has(key)) found.set(key, { title });
  }

  return Array.from(found.values());
}

function extractPdfFromFilesField(fieldValue) {
  const items = [];

  const pushCandidate = (v) => {
    if (v === undefined || v === null) return;
    let s = '';

    if (typeof v === 'string' || typeof v === 'number') {
      s = String(v).trim();
    } else if (typeof v === 'object') {
      s = String(
        v.name || v.fileName || v.filename || v.originalName || v.title || v.downloadUrl || v.url || ''
      ).trim();
    }

    if (!s) return;

    let name = s;
    if (/^https?:\/\//i.test(s)) name = filenameFromUrl(s) || s;

    if (/\.zip$/i.test(name)) return;
    if (/\.pdf$/i.test(name)) items.push({ title: name });
  };

  if (Array.isArray(fieldValue)) for (const v of fieldValue) pushCandidate(v);
  else pushCandidate(fieldValue);

  const map = new Map();
  for (const it of items) {
    const key = normalizeChecklistTitle(it.title);
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

function unwrapChecklistList(resp) {
  const r = resp?.result?.items ?? resp?.result ?? resp?.items ?? [];
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') return Object.values(r);
  return [];
}

function getItemField(item, name) {
  if (!item || typeof item !== 'object') return null;
  const lower = String(name).toLowerCase();
  return (
    item?.[name] ??
    item?.[lower] ??
    item?.FIELDS?.[name] ??
    item?.FIELDS?.[lower] ??
    item?.fields?.[name] ??
    item?.fields?.[lower] ??
    null
  );
}

function isRootItem(i) {
  const p = getItemField(i, 'PARENT_ID');
  // на разных порталах root может быть 0, "0", null, "", undefined
  return p === undefined || p === null || String(p).trim() === '' || String(p).trim() === '0';
}

async function getChecklistItems(taskId) {
  try {
    const r = await bitrix.call('task.checklistitem.getlist', {
      TASKID: Number(taskId),
      ORDER: { ID: 'asc' },
      FILTER: {},
    });
    return unwrapChecklistList(r);
  } catch {
    const r2 = await bitrix.call('task.checklistitem.getlist', { TASKID: Number(taskId) });
    return unwrapChecklistList(r2);
  }
}

async function addChecklistItem(taskId, title, parentId = 0) {
  return await bitrix.call('task.checklistitem.add', {
    TASKID: Number(taskId),
    FIELDS: {
      TITLE: String(title || '').trim(),
      PARENT_ID: Number(parentId) || 0,
    },
  });
}

function unwrapChecklistAddId(resp) {
  const r = resp?.result ?? resp;
  const direct = parseNumber(r);
  if (direct) return direct;
  return (
    parseNumber(r?.ID) ??
    parseNumber(r?.id) ??
    parseNumber(r?.result?.ID) ??
    parseNumber(r?.result?.id) ??
    null
  );
}

// ---- межпроцессный lock (чтобы 2 инстанса PM2 не плодили root) ----
const LOCK_DIR = '/tmp';
function lockPathForTask(taskId) {
  return path.join(LOCK_DIR, `mpk-b24-checklist-${taskId}.lock`);
}

async function withProcessFileLock(taskId, fn) {
  const p = lockPathForTask(taskId);

  // если lock завис — считаем stale через 30 секунд
  const STALE_MS = 30_000;

  try {
    // попытка создать lock "атомарно"
    const handle = await fs.open(p, 'wx');
    try {
      await handle.writeFile(String(Date.now()));
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.unlink(p).catch(() => {});
    }
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      // проверим stale
      try {
        const st = await fs.stat(p);
        const age = Date.now() - st.mtimeMs;
        if (age > STALE_MS) {
          await fs.unlink(p).catch(() => {});
          // повторим один раз
          return await withProcessFileLock(taskId, fn);
        }
      } catch {}
      return { enabled: true, action: 'skip_lock_busy' };
    }
    throw e;
  }
}

// ---- лок в рамках процесса (дополнительно) ----
const taskLocks = new Map();
async function withTaskLock(taskId, fn) {
  const key = String(taskId);
  const prev = taskLocks.get(key) || Promise.resolve();
  let release;
  const cur = new Promise((resolve) => { release = resolve; });
  taskLocks.set(key, prev.then(() => cur));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    setTimeout(() => {
      if (taskLocks.get(key) === cur) taskLocks.delete(key);
    }, 5000);
  }
}

async function syncChecklistFromPdfSmart({ taskId, description, filesFieldValue }) {
  const listTitle = String(process.env.TASK_PDF_CHECKLIST_TITLE || 'PDF-файлы').trim();
  const listKey = normalizeChecklistTitle(listTitle);

  // desired: сначала поле файлов, потом описание
  let desiredItems = extractPdfFromFilesField(filesFieldValue);
  if (!desiredItems.length) desiredItems = extractPdfItemsFromDescription(description);

  const desiredCount = desiredItems.length;

  // если ещё нет PDF (например, пока zip) — ничего не делаем
  if (!desiredCount) {
    return { enabled: true, desiredCount: 0, pdfFound: 0, action: 'skip_no_pdf_yet' };
  }

  // берём текущий список
  const all = await getChecklistItems(taskId);

  // root'ы с нужным названием
  const roots = all.filter(isRootItem);
  const matchingRoots = roots.filter(i => normalizeChecklistTitle(getItemField(i, 'TITLE') || '') === listKey);

  // если root'ов несколько — используем ТОЛЬКО один (минимальный ID), новые не создаём
  const rootIds = matchingRoots
    .map(i => parseNumber(getItemField(i, 'ID')))
    .filter(Boolean)
    .sort((a, b) => a - b);

  let rootId = rootIds[0] || null;

  // если root существует, но ID не распарсился — ничего не создаём и выходим (иначе будет плодиться)
  if (!rootId && matchingRoots.length > 0) {
    return {
      enabled: true,
      desiredCount,
      pdfFound: desiredCount,
      action: 'skip_root_exists_but_id_unparsed',
      listTitle,
      rootId: null,
    };
  }

  // если root нет — создаём один раз, затем перечитываем и выбираем минимальный ID
  let rootCreated = false;
  if (!rootId) {
    const addRes = await addChecklistItem(taskId, listTitle, 0);
    rootId = unwrapChecklistAddId(addRes) || null;

    // всегда перечитываем (для нормализации и чтобы поймать ID)
    const all2 = await getChecklistItems(taskId);
    const roots2 = all2.filter(isRootItem);
    const matching2 = roots2.filter(i => normalizeChecklistTitle(getItemField(i, 'TITLE') || '') === listKey);

    const ids2 = matching2
      .map(i => parseNumber(getItemField(i, 'ID')))
      .filter(Boolean)
      .sort((a, b) => a - b);

    rootId = ids2[0] || rootId;
    rootCreated = true;
  }

  if (!rootId) {
    return { enabled: true, desiredCount, pdfFound: desiredCount, action: 'error_root_id_not_found', listTitle, rootId: null };
  }

  // дети внутри выбранного root
  const children = all.filter(i => String(getItemField(i, 'PARENT_ID') ?? '').trim() === String(rootId));
  const existingCount = children.length;

  // если уже достаточно или больше — ничего не делаем
  if (existingCount >= desiredCount) {
    return {
      enabled: true,
      desiredCount,
      pdfFound: desiredCount,
      existingCount,
      added: 0,
      skippedExisting: 0,
      action: 'skip_counts_ok_or_more',
      listTitle,
      rootId,
      rootCreated,
      rootsFound: rootIds.length || (matchingRoots.length ? 'unparsed' : 0),
    };
  }

  // добавляем только недостающее по title
  const existingTitles = new Set(
    children
      .map(i => getItemField(i, 'TITLE') || '')
      .filter(Boolean)
      .map(normalizeChecklistTitle)
  );

  let added = 0;
  let skippedExisting = 0;

  for (const it of desiredItems) {
    const title = String(it.title || '').trim();
    const key = normalizeChecklistTitle(title);
    if (!key) continue;

    if (existingTitles.has(key)) {
      skippedExisting++;
      continue;
    }

    await addChecklistItem(taskId, title, rootId);
    existingTitles.add(key);
    added++;

    if ((existingCount + added) >= desiredCount) break;
  }

  return {
    enabled: true,
    desiredCount,
    pdfFound: desiredCount,
    existingCount,
    added,
    skippedExisting,
    action: 'added_missing_items',
    listTitle,
    rootId,
    rootCreated,
    rootsFound: rootIds.length || (matchingRoots.length ? 'unparsed' : 0),
  };
}

// ====== main handler ======
async function handleTaskCompletionEvent(req, res) {
  try {
    ensureObjectBody(req);

    const { taskId, source: taskIdSource } = extractTaskIdDetailed(req);
    const statusAfter = extractStatusAfter(req);
    const statusBefore = extractStatusBefore(req);
    const debug = req?.query?.debug === '1';
    const event = req?.body?.event || req?.body?.EVENT || req?.body?.data?.event || null;

    if (debug) console.log('[task-event] taskId_source', { taskId, source: taskIdSource });
    console.log('[task-event] incoming', { event, taskId, statusAfter, statusBefore, method: req.method });

    const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
    const stageId =
      process.env.SPA1048_STAGE_PAID ||
      process.env.SPA1048_STAGE_SUCCESS ||
      cfg.stagePaid ||
      `DT${entityTypeId}_14:SUCCESS`;

    if (!taskId) {
      console.log('[task-event] skip_no_taskId', { event, statusAfter, statusBefore, method: req.method });
      return res.json({ ok: true, action: 'skip_no_taskId', debug, event, statusAfter, statusBefore, taskIdSource });
    }

    const task = await fetchTask(taskId);
    if (!task) {
      console.log('[task-event] task_not_found', { taskId });
      return res.json({ ok: true, action: 'skip_task_not_found', taskId, debug, event });
    }

    const taskStatus = parseNumber(task?.status || task?.STATUS);
    const description = task?.description ?? task?.DESCRIPTION ?? '';
    const filesFieldValue = task?.[PDF_FILES_FIELD];

    console.log('[task-event] fetched_task', {
      taskId,
      taskStatus,
      ufCrmTask: task?.ufCrmTask || task?.UF_CRM_TASK || null,
      hasDescription: Boolean(String(description || '').trim()),
      hasFilesField: filesFieldValue !== undefined && filesFieldValue !== null,
    });

    // 1) чеклист — строго идемпотентно и с межпроцессным lock'ом
    const checklistSync = await withTaskLock(taskId, async () => {
      return await withProcessFileLock(taskId, async () => {
        return await syncChecklistFromPdfSmart({ taskId, description, filesFieldValue });
      });
    });

    console.log('[task-event] checklist_sync', { taskId, ...checklistSync });

    // 2) SPA stage update — только при выполненной задаче
    if (taskStatus !== COMPLETED_STATUS) {
      console.log('[task-event] skip_not_completed', { taskId, taskStatus });
      return res.json({
        ok: true,
        action: 'skip_not_completed',
        taskId,
        taskStatus,
        statusAfter,
        statusBefore,
        debug,
        checklist: checklistSync,
      });
    }

    const ufCrmTask = task?.ufCrmTask || task?.UF_CRM_TASK;
    const preferredTypeIds = [...new Set([entityTypeId, cfg.entityTypeId].filter(Number.isFinite))];
    const binding = findSpaItemId(ufCrmTask, preferredTypeIds);
    const parsedBindings = parseCrmTaskBindings(ufCrmTask);

    console.log('[task-event] bindings', {
      taskId,
      ufCrmTask,
      preferredTypeIds,
      foundItemId: binding?.itemId || null,
      bindings: parsedBindings,
    });

    if (!binding?.itemId) {
      return res.json({
        ok: true,
        action: ufCrmTask ? 'skip_not_spa1048' : 'skip_no_spa_binding',
        taskId,
        statusAfter,
        taskStatus,
        debug,
        ufCrmTask,
        bindings: parsedBindings,
        preferredTypeIds,
        entityTypeId,
        checklist: checklistSync,
      });
    }

    const updateResult = await updateSpaStage({ itemId: binding.itemId, stageId, entityTypeId });

    console.log('[task-event] spa_stage_updated', { taskId, itemId: binding.itemId, stageId, updateResult });

    return res.json({
      ok: true,
      action: 'spa_stage_updated',
      taskId,
      itemId: binding.itemId,
      statusAfter,
      stageId,
      debug,
      ufCrmTask,
      entityTypeId,
      checklist: checklistSync,
    });

  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[task-event] ERROR:', msg, e?.data ? JSON.stringify(e.data) : '');
    return res.json({ ok: false, error: msg });
  }
}

module.exports = { handleTaskCompletionEvent };
