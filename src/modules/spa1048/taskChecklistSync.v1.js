'use strict';

const fs = require('fs/promises');
const path = require('path');

const bitrix = require('../../services/bitrix/bitrixClient');

// ===== helpers =====
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function unwrap(resp) {
  return resp?.result ?? resp;
}

function normalizeTitle(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getField(item, name) {
  if (!item || typeof item !== 'object') return undefined;
  const lower = String(name).toLowerCase();
  return (
    item?.[name] ??
    item?.[lower] ??
    item?.FIELDS?.[name] ??
    item?.FIELDS?.[lower] ??
    item?.fields?.[name] ??
    item?.fields?.[lower]
  );
}

function unwrapChecklistList(resp) {
  const u = unwrap(resp);
  const items =
    u?.items ??
    u?.result?.items ??
    u?.result ??
    u?.items ??
    u ??
    [];
  if (Array.isArray(items)) return items;
  if (items && typeof items === 'object') return Object.values(items);
  return [];
}

function unwrapChecklistAddId(resp) {
  const u = unwrap(resp);
  const direct = toNum(u);
  if (direct) return direct;
  return (
    toNum(u?.ID) ||
    toNum(u?.id) ||
    toNum(u?.item?.id) ||
    toNum(u?.result?.ID) ||
    toNum(u?.result?.id) ||
    0
  );
}

function isRootItem(item) {
  const p = getField(item, 'PARENT_ID');
  return p === undefined || p === null || String(p).trim() === '' || String(p).trim() === '0';
}

function isDone(item) {
  const v = getField(item, 'IS_COMPLETE') ?? getField(item, 'isComplete') ?? getField(item, 'COMPLETE');
  return String(v).toUpperCase() === 'Y' || String(v) === '1' || v === true;
}

function normalizePdfList(pdfList) {
  if (!Array.isArray(pdfList)) return [];
  const out = [];
  const seen = new Set();

  for (const it of pdfList) {
    let name = '';
    if (typeof it === 'string') name = it;
    else if (it && typeof it === 'object') {
      name = it.name || it.fileName || it.filename || it.originalName || it.title || '';
    }
    name = String(name || '').trim();
    if (!name) continue;
    // В реальности имя может временно приходить без расширения.
    // Мы не фильтруем строго по ".pdf", иначе новые пункты могут не попасть в чеклист.
    if (name.toLowerCase().endsWith('.zip')) continue;

    const key = normalizeTitle(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, key });
  }

  return out;
}

// ===== bitrix calls =====
async function getChecklistItems(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', {
    TASKID: Number(taskId),
    ORDER: { ID: 'asc' },
    FILTER: {},
  }, { ctx: { taskId: Number(taskId), step: 'checklist_getlist' } });

  return unwrapChecklistList(r);
}

async function addChecklistItem(taskId, title, parentId = 0) {
  const r = await bitrix.call('task.checklistitem.add', {
    TASKID: Number(taskId),
    FIELDS: {
      TITLE: String(title || '').trim(),
      PARENT_ID: Number(parentId) || 0,
    },
  }, { ctx: { taskId: Number(taskId), step: 'checklist_add', parentId: Number(parentId) || 0 } });

  return { id: unwrapChecklistAddId(r), raw: r };
}

// ===== locking (межпроцессный, чтобы не плодить root при бурсте) =====
const LOCK_DIR = '/tmp';
const STALE_MS = 30_000;

function lockPathForTask(taskId) {
  return path.join(LOCK_DIR, `mpk-b24-checklist-${String(taskId)}.lock`);
}

async function withProcessFileLock(taskId, fn) {
  const p = lockPathForTask(taskId);

  try {
    const h = await fs.open(p, 'wx');
    try {
      await h.writeFile(String(Date.now()));
      return await fn();
    } finally {
      await h.close().catch(() => {});
      await fs.unlink(p).catch(() => {});
    }
  } catch (e) {
    if (e?.code === 'EEXIST') {
      try {
        const st = await fs.stat(p);
        const age = Date.now() - st.mtimeMs;
        if (age > STALE_MS) {
          await fs.unlink(p).catch(() => {});
          return await withProcessFileLock(taskId, fn);
        }
      } catch {}
      return { ok: true, action: 'skip_lock_busy', taskId: Number(taskId) };
    }
    throw e;
  }
}

// ===== public API =====
function isChecklistFullyComplete(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(isDone);
}

async function getChecklistSummary(taskId) {
  const listTitle = String(process.env.TASK_PDF_CHECKLIST_TITLE || 'PDF-файлы').trim();
  const listKey = normalizeTitle(listTitle);

  const all = await getChecklistItems(taskId);

  const roots = all.filter(isRootItem);
  const matching = roots
    .filter((it) => normalizeTitle(getField(it, 'TITLE') || '') === listKey)
    .map((it) => ({ id: toNum(getField(it, 'ID')), raw: it }))
    .filter((x) => x.id > 0)
    .sort((a, b) => a.id - b.id);

  const rootId = matching[0]?.id || 0;
  if (!rootId) return { total: 0, done: 0, isAllDone: false, rootId: 0, listTitle };

  const children = all.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));
  const total = children.length;
  const done = children.filter(isDone).length;

  return { total, done, isAllDone: total > 0 && total === done, rootId, listTitle };
}

/**
 * Создаёт (или дополняет) чеклист "PDF-файлы" так, чтобы в нём
 * присутствовали ВСЕ PDF по названиям. Дубликаты по названию не добавляет.
 *
 * Важно: ничего не удаляет. Если пунктов уже больше — всё равно добавляем
 * недостающие названия (если каких‑то PDF ещё нет в чеклисте).
 */
async function ensureChecklistForTask(taskId, pdfList = []) {
  const listTitle = String(process.env.TASK_PDF_CHECKLIST_TITLE || 'PDF-файлы').trim();
  const listKey = normalizeTitle(listTitle);

  const desired = normalizePdfList(pdfList);
  const desiredCount = desired.length;

  if (!toNum(taskId)) return { ok: false, action: 'invalid_taskId' };
  if (!desiredCount) {
    return { ok: true, action: 'skip_no_pdf', enabled: true, desiredCount: 0, listTitle };
  }

  return await withProcessFileLock(taskId, async () => {
    // 1) читаем все пункты
    let all = await getChecklistItems(taskId);

    // 2) ищем root(ы) с нужным названием
    const roots = all.filter(isRootItem);
    const matchingRoots = roots.filter((it) => normalizeTitle(getField(it, 'TITLE') || '') === listKey);

    const rootIds = matchingRoots
      .map((it) => toNum(getField(it, 'ID')))
      .filter((id) => id > 0)
      .sort((a, b) => a - b);

    let rootId = rootIds[0] || 0;
    const rootsFound = matchingRoots.length;

    // если root существует, но id не распарсился — не создаём новый (иначе будет плодиться)
    if (!rootId && rootsFound > 0) {
      return {
        ok: true,
        action: 'skip_root_exists_but_id_unparsed',
        enabled: true,
        taskId: Number(taskId),
        listTitle,
        desiredCount,
        rootsFound,
        rootId: 0,
      };
    }

    // 3) если нет root — создаём один раз
    let rootCreated = false;
    if (!rootId) {
      const created = await addChecklistItem(taskId, listTitle, 0);
      rootId = toNum(created?.id);
      rootCreated = Boolean(rootId);

      // Перечитываем, чтобы выбрать минимальный rootId (на случай гонок)
      all = await getChecklistItems(taskId);
      const roots2 = all.filter(isRootItem);
      const matching2 = roots2.filter((it) => normalizeTitle(getField(it, 'TITLE') || '') === listKey);
      const ids2 = matching2
        .map((it) => toNum(getField(it, 'ID')))
        .filter((id) => id > 0)
        .sort((a, b) => a - b);

      if (ids2[0]) rootId = ids2[0];
    }

    if (!rootId) {
      return {
        ok: false,
        action: 'cannot_create_or_find_root',
        enabled: true,
        taskId: Number(taskId),
        listTitle,
        desiredCount,
      };
    }

    // 4) дети под root
    const children = all.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));
    const existingCount = children.length;

    const existingTitles = new Set(
      children
        .map((it) => normalizeTitle(getField(it, 'TITLE') || ''))
        .filter(Boolean)
    );

    // Быстрый критерий "не трогаем": если кол-во файлов == кол-ву пунктов
    // И при этом ВСЕ нужные названия уже присутствуют.
    const desiredKeys = desired.map((d) => d.key).filter(Boolean);
    const allDesiredPresent = desiredKeys.every((k) => existingTitles.has(k));
    if (existingCount === desiredCount && allDesiredPresent) {
      return {
        ok: true,
        action: 'skip_already_in_sync',
        enabled: true,
        taskId: Number(taskId),
        listTitle,
        desiredCount,
        pdfFound: desiredCount,
        existingCount,
        added: 0,
        skippedExisting: desiredCount,
        rootId,
        rootCreated,
        rootsFound,
        duplicatesRoots: rootsFound > 1 ? rootsFound : 0,
        items: children,
        summary: { total: existingCount, done: children.filter(isDone).length, isAllDone: isChecklistFullyComplete(children) },
      };
    }

    let added = 0;
    let skippedExisting = 0;

    // Главное правило: добавляем ВСЕ отсутствующие названия PDF,
    // даже если в чеклисте уже больше пунктов (могли остаться старые/ручные).
    for (const it of desired) {
      const title = String(it.name || '').trim();
      const key = it.key || normalizeTitle(title);
      if (!key) continue;

      if (existingTitles.has(key)) {
        skippedExisting++;
        continue;
      }

      await addChecklistItem(taskId, title, rootId);
      existingTitles.add(key);
      added++;
    }

    // Перечитываем итоговые пункты (для summary и чтобы spa-event мог оценить completion)
    const allAfter = await getChecklistItems(taskId);
    const childrenAfter = allAfter.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));

    return {
      ok: true,
      action: added > 0 ? 'added_missing_items' : 'skip_already_in_sync_titles',
      enabled: true,
      taskId: Number(taskId),
      listTitle,
      desiredCount,
      pdfFound: desiredCount,
      existingCount,
      added,
      skippedExisting,
      rootId,
      rootCreated,
      rootsFound,
      duplicatesRoots: rootsFound > 1 ? rootsFound : 0,
      items: childrenAfter,
      summary: { total: childrenAfter.length, done: childrenAfter.filter(isDone).length, isAllDone: isChecklistFullyComplete(childrenAfter) },
    };
  });
}

module.exports = {
  ensureChecklistForTask,
  getChecklistItems,
  getChecklistSummary,
  isChecklistFullyComplete,
};
