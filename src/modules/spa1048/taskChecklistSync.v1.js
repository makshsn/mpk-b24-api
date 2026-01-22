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
    if (!name.toLowerCase().endsWith('.pdf')) continue;

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

async function deleteChecklistItem(taskId, itemId) {
  const tid = Number(taskId);
  const iid = Number(itemId);
  if (!tid || !iid) return { ok: false, action: 'invalid_delete_params', taskId: tid, itemId: iid };

  // Docs: task.checklistitem.delete expects TASKID + ITEMID and parameter order matters.
  // Some endpoints accept ID instead of ITEMID; keep a fallback.
  try {
    const r = await bitrix.call('task.checklistitem.delete', {
      TASKID: tid,
      ITEMID: iid,
    }, { ctx: { taskId: tid, step: 'checklist_delete', itemId: iid } });
    return { ok: true, raw: r };
  } catch (e) {
    const msg = String(e?.message || e || '');
    // Fallback for older/alternate param name.
    const r2 = await bitrix.call('task.checklistitem.delete', {
      TASKID: tid,
      ID: iid,
    }, { ctx: { taskId: tid, step: 'checklist_delete_fallback', itemId: iid, err: msg.slice(0, 200) } });
    return { ok: true, raw: r2, fallback: true };
  }
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
 * Строгая синхронизация чеклиста "PDF-файлы" с PDF-списком:
 * - если PDF стало меньше — лишние пункты удаляются
 * - если PDF стало больше — недостающие пункты добавляются
 * - если существуют дубли root-чеклистов с таким названием — удаляем лишние, оставляя один
 * - дубликаты пунктов (одинаковый TITLE) схлопываются до одного
 */
async function ensureChecklistForTask(taskId, pdfList = []) {
  const listTitle = String(process.env.TASK_PDF_CHECKLIST_TITLE || 'PDF-файлы').trim();
  const listKey = normalizeTitle(listTitle);

  const desired = normalizePdfList(pdfList);
  const desiredCount = desired.length;

  if (!toNum(taskId)) return { ok: false, action: 'invalid_taskId' };

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

    // 3) если PDF нет — удаляем весь наш чеклист (строгая синхронизация)
    //    (и его дубли, если они были)
    if (!desiredCount) {
      if (!rootId && rootsFound === 0) {
        return {
          ok: true,
          action: 'in_sync_no_pdf',
          enabled: true,
          taskId: Number(taskId),
          listTitle,
          desiredCount: 0,
          pdfFound: 0,
          rootsFound,
          rootsDeleted: 0,
          itemsDeleted: 0,
        };
      }

      if (!rootId && rootsFound > 0) {
        return {
          ok: true,
          action: 'skip_root_exists_but_id_unparsed',
          enabled: true,
          taskId: Number(taskId),
          listTitle,
          desiredCount: 0,
          pdfFound: 0,
          rootsFound,
          rootId: 0,
        };
      }

      let itemsDeleted = 0;
      let rootsDeleted = 0;
      const rootsToDelete = rootIds.length ? rootIds : (rootId ? [rootId] : []);

      for (const rid of rootsToDelete) {
        const children = all.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rid));
        for (const ch of children) {
          const cid = toNum(getField(ch, 'ID'));
          if (!cid) continue;
          await deleteChecklistItem(taskId, cid);
          itemsDeleted++;
        }
        await deleteChecklistItem(taskId, rid);
        rootsDeleted++;
      }

      return {
        ok: true,
        action: 'deleted_all_no_pdf',
        enabled: true,
        taskId: Number(taskId),
        listTitle,
        desiredCount: 0,
        pdfFound: 0,
        rootsFound,
        rootsDeleted,
        itemsDeleted,
      };
    }

    // 4) если нет root — создаём один раз
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

    // 5) удаляем дубли root-чеклистов, если они есть
    let rootsDeleted = 0;
    let duplicateRoots = 0;
    if (rootIds.length > 1) {
      duplicateRoots = rootIds.length - 1;
      const toDeleteRoots = rootIds.filter((id) => id !== rootId);
      for (const rid of toDeleteRoots) {
        const children = all.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rid));
        for (const ch of children) {
          const cid = toNum(getField(ch, 'ID'));
          if (!cid) continue;
          await deleteChecklistItem(taskId, cid);
        }
        await deleteChecklistItem(taskId, rid);
        rootsDeleted++;
      }
      // перечитываем после чистки
      all = await getChecklistItems(taskId);
    }

    // 6) дети под canonical root
    const children = all.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));
    const existingCount = children.length;

    const desiredKeys = new Set(desired.map((x) => x.key).filter(Boolean));

    // группируем существующие по title
    const byKey = new Map();
    for (const ch of children) {
      const id = toNum(getField(ch, 'ID'));
      const title = String(getField(ch, 'TITLE') || '').trim();
      const key = normalizeTitle(title);
      if (!id || !key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ id, title, raw: ch });
    }

    // определяем, что удалять:
    // - всё, чего нет в desired
    // - дубликаты (если 2+ одинаковых ключа)
    const idsToDelete = [];
    for (const [key, list] of byKey.entries()) {
      const sorted = list.sort((a, b) => a.id - b.id);
      if (!desiredKeys.has(key)) {
        // удаляем все
        for (const it of sorted) idsToDelete.push(it.id);
        continue;
      }
      // desired содержит этот ключ — оставляем один, удаляем остальные
      if (sorted.length > 1) {
        for (const it of sorted.slice(1)) idsToDelete.push(it.id);
      }
    }

    let deleted = 0;
    for (const id of idsToDelete) {
      await deleteChecklistItem(taskId, id);
      deleted++;
    }

    // перечитываем после удаления (важно для корректного добавления)
    const allAfterDelete = deleted ? await getChecklistItems(taskId) : all;
    const childrenAfterDelete = allAfterDelete.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));
    const existingAfterDeleteKeys = new Set(childrenAfterDelete.map((it) => normalizeTitle(getField(it, 'TITLE') || '')).filter(Boolean));

    let added = 0;
    let skippedExisting = 0;
    for (const it of desired) {
      const title = String(it.name || '').trim();
      const key = it.key || normalizeTitle(title);
      if (!key) continue;
      if (existingAfterDeleteKeys.has(key)) {
        skippedExisting++;
        continue;
      }
      await addChecklistItem(taskId, title, rootId);
      existingAfterDeleteKeys.add(key);
      added++;
    }

    // итоговое состояние
    const allFinal = (deleted || added || rootsDeleted) ? await getChecklistItems(taskId) : allAfterDelete;
    const childrenFinal = allFinal.filter((it) => String(getField(it, 'PARENT_ID') ?? '').trim() === String(rootId));
    const finalKeys = childrenFinal.map((it) => normalizeTitle(getField(it, 'TITLE') || '')).filter(Boolean);
    const finalKeySet = new Set(finalKeys);
    const inSync = childrenFinal.length === desiredCount && finalKeySet.size === desiredCount && [...desiredKeys].every((k) => finalKeySet.has(k));

    const action = (deleted || added || rootsDeleted) ? 'synced_strict' : 'in_sync_strict';

    return {
      ok: true,
      action: inSync ? action : 'synced_strict_mismatch',
      enabled: true,
      taskId: Number(taskId),
      listTitle,
      desiredCount,
      pdfFound: desiredCount,
      existingCount,
      added,
      deleted,
      skippedExisting,
      rootId,
      rootCreated,
      rootsFound,
      rootsDeleted,
      duplicatesRoots: duplicateRoots,
      items: childrenFinal,
      summary: { total: childrenFinal.length, done: childrenFinal.filter(isDone).length, isAllDone: isChecklistFullyComplete(childrenFinal) },
    };
  });
}

module.exports = {
  ensureChecklistForTask,
  getChecklistItems,
  getChecklistSummary,
  isChecklistFullyComplete,
};
