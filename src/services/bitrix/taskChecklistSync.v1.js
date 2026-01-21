const bitrix = require('./bitrixClient');

function unwrap(resp) {
  return resp?.result ?? resp;
}

function log(level, event, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...payload });
  if (level === 'error') console.error(line);
  else console.log(line);
}

function parseChecklistTitles() {
  // comma-separated list in .env, e.g. "Счёт выставлен,Согласовано,Оплачено"
  const raw = process.env.SPA1048_CHECKLIST_TITLES;
  if (!raw) {
    return [
      'Счёт выставлен',
      'Согласование получено',
      'Поступление денег подтверждено',
    ];
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function normTitle(x) {
  return String(x || '').trim().toLowerCase();
}

function isPdfName(name) {
  return String(name || '').toLowerCase().endsWith('.pdf');
}

function normalizeNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function pdfMarker(fileId) {
  const id = toNum(fileId);
  if (id > 0) return `pdf:${id}`;
  return '';
}

function buildPdfTitle({ name, fileId }) {
  const marker = pdfMarker(fileId);
  return marker ? `Оплатить: ${name} [${marker}]` : `Оплатить: ${name}`;
}

function parsePdfKeyFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\[pdf:(\d+)/i);
  return match ? `pdf:${match[1]}` : '';
}

function parseStaticKeyFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\[static:([^\]\|]+)/i);
  return match ? `static:${String(match[1]).trim().toLowerCase()}` : '';
}

function isRootChecklistItem(item) {
  const title = String(item?.TITLE || item?.title || '').trim();
  if (title.startsWith('BX_CHECKLIST_')) return true;
  const parentId = toNum(item?.PARENT_ID || item?.parentId);
  return parentId === 0;
}

function buildStaticTitle(title) {
  const key = normTitle(title);
  return key ? `${title} [static:${key}]` : title;
}

function getManagedKeyFromTitle(title) {
  return parsePdfKeyFromTitle(title) || parseStaticKeyFromTitle(title) || '';
}

async function getChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) }, { ctx: { taskId, step: 'checklist_getlist' } });
  const u = unwrap(r);
  const items = u?.items || u?.result?.items || u || [];
  return Array.isArray(items) ? items : [];
}

async function addChecklistItem(taskId, title, sortIndex, parentId) {
  const fields = {
    TITLE: String(title),
    SORT_INDEX: Number(sortIndex || 0),
  };
  if (Number.isFinite(Number(parentId)) && Number(parentId) >= 0) {
    fields.PARENT_ID = Number(parentId);
  }
  const r = await bitrix.call('task.checklistitem.add', {
    taskId: Number(taskId),
    fields,
  }, { ctx: { taskId, step: 'checklist_add' } });
  const u = unwrap(r);
  const id = Number(u?.item?.id || u?.ID || u?.id || u);
  return { id, title };
}

async function updateChecklistItem(taskId, itemId, fields) {
  await bitrix.call('task.checklistitem.update', {
    taskId: Number(taskId),
    id: Number(itemId),
    fields,
  }, { ctx: { taskId, step: 'checklist_update', itemId } });
}

async function deleteChecklistItem(taskId, itemId) {
  await bitrix.call('task.checklistitem.delete', {
    taskId: Number(taskId),
    id: Number(itemId),
  }, { ctx: { taskId, step: 'checklist_delete', itemId } });
}

function isDone(it) {
  const v = it?.IS_COMPLETE ?? it?.isComplete ?? it?.COMPLETE ?? it?.complete;
  return String(v).toUpperCase() === 'Y' || String(v) === '1' || v === true;
}

function isChecklistFullyComplete(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((it) => String(it?.IS_COMPLETE ?? '').toUpperCase() === 'Y');
}

async function safeRemoveChecklistItem(taskId, item, softIndex) {
  const itemId = toNum(item?.ID || item?.id);
  if (!itemId) return { ok: false, action: 'skip_no_id' };
  try {
    await deleteChecklistItem(taskId, itemId);
    return { ok: true, action: 'deleted', id: itemId };
  } catch (e) {
    const title = String(item?.TITLE || item?.title || '').trim();
    const softTitle = title.startsWith('[REMOVED]') ? title : `[REMOVED] ${title || 'item'}`;
    try {
      await updateChecklistItem(taskId, itemId, {
        TITLE: softTitle,
        SORT_INDEX: Number(softIndex || 9999),
      });
      return { ok: true, action: 'soft_deleted', id: itemId };
    } catch (err) {
      log('error', 'CHECKLIST_REMOVE_FAIL', { taskId, itemId, error: err?.message || String(err) });
      return { ok: false, action: 'remove_failed', id: itemId, error: err?.message || String(err) };
    }
  }
}

function normalizePdfList(pdfList) {
  if (!Array.isArray(pdfList)) return [];
  const out = [];
  const seen = new Set();
  for (const it of pdfList) {
    const name = String(it?.name || '').trim();
    if (!name || !isPdfName(name)) continue;
    const fileId = toNum(it?.fileId || it?.id || it?.FILE_ID);
    if (!fileId) continue;
    const nameKey = normalizeNameKey(name);
    const key = `${nameKey}|${fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, fileId, nameKey });
  }
  return out;
}

async function ensureChecklistForTask(taskId, pdfList = []) {
  try {
    const existing = await getChecklist(taskId);
    let root = existing.find((it) => {
      const title = String(it?.TITLE || it?.title || '').trim();
      const parentId = toNum(it?.PARENT_ID || it?.parentId);
      return parentId === 0 && title.startsWith('BX_CHECKLIST_');
    });
    if (!root) {
      const createdRoot = await addChecklistItem(taskId, 'BX_CHECKLIST_1', 1, 0);
      root = { ID: createdRoot?.id, TITLE: 'BX_CHECKLIST_1', PARENT_ID: 0 };
    }

    const rootId = root ? toNum(root?.ID || root?.id) : 0;
    const scopedItems = rootId
      ? existing.filter((it) => toNum(it?.PARENT_ID || it?.parentId) === rootId)
      : existing.filter((it) => !isRootChecklistItem(it));
    const normalizedPdfList = normalizePdfList(pdfList);
    const removed = [];
    const added = [];
    const updated = [];

    if (normalizedPdfList.length > 0) {
      const pdfItems = [];
      for (const it of scopedItems) {
        const title = String(it?.TITLE || it?.title || '').trim();
        const key = parsePdfKeyFromTitle(title);
        if (key) {
          pdfItems.push({ item: it, key });
        }
      }

      const existingByFileId = new Map();
      for (const entry of pdfItems) {
        const itemId = toNum(entry.item?.ID || entry.item?.id);
        if (!itemId) continue;
        if (entry.key && !existingByFileId.has(entry.key)) {
          existingByFileId.set(entry.key, entry);
        }
      }

      const usedItemIds = new Set();
      const desiredKeys = normalizedPdfList.map((pdf) => pdfMarker(pdf.fileId)).filter(Boolean);
      const existingKeys = Array.from(existingByFileId.keys());
      const toDeleteIds = [];
      const toAddKeys = desiredKeys.filter((key) => !existingByFileId.has(key));
      let sortIndex = 1;

      for (const pdf of normalizedPdfList) {
        const key = pdfMarker(pdf.fileId);
        const matched = key ? existingByFileId.get(key) : null;

        const desiredTitle = buildPdfTitle(pdf);
        if (matched) {
          const itemId = toNum(matched.item?.ID || matched.item?.id);
          usedItemIds.add(itemId);
          const currentTitle = String(matched.item?.TITLE || matched.item?.title || '').trim();
          if (currentTitle !== desiredTitle || Number(matched.item?.SORT_INDEX || 0) !== sortIndex) {
            await updateChecklistItem(taskId, itemId, { TITLE: desiredTitle, SORT_INDEX: sortIndex });
            updated.push({ id: itemId, title: desiredTitle });
          }
        } else {
          const addedItem = await addChecklistItem(taskId, desiredTitle, sortIndex, rootId);
          added.push(addedItem);
        }
        sortIndex++;
      }

      let softIndex = 10000;
      for (const entry of pdfItems) {
        const itemId = toNum(entry.item?.ID || entry.item?.id);
        if (!itemId || usedItemIds.has(itemId)) continue;
        toDeleteIds.push(itemId);
        removed.push(await safeRemoveChecklistItem(taskId, entry.item, softIndex++));
      }

      const items = await getChecklist(taskId);
      return {
        ok: true,
        mode: 'pdf',
        rootId,
        desiredKeys,
        existingKeys,
        toDeleteIds,
        toAddKeys,
        desiredTotal: normalizedPdfList.length,
        removed,
        added,
        updated,
        items,
      };
    }

    const desired = parseChecklistTitles();
    const desiredMap = new Map(desired.map((t) => [normTitle(t), t]));
    const kept = new Set();
    const desiredKeys = desired.map((t) => `static:${normTitle(t)}`);
    const existingKeys = scopedItems
      .map((it) => getManagedKeyFromTitle(it?.TITLE || it?.title))
      .filter(Boolean);
    const existingKeySet = new Set(existingKeys);
    const toDeleteIds = [];
    const toAddKeys = desiredKeys.filter((key) => !existingKeySet.has(key));
    let softIndex = 10000;

    for (const it of scopedItems) {
      const title = String(it?.TITLE || it?.title || '').trim();
      const markerKey = parseStaticKeyFromTitle(title);
      const pdfKey = parsePdfKeyFromTitle(title);
      const titleKey = normTitle(title);
      const key = markerKey || titleKey;
      const desiredTitle = desiredMap.get(key);
      if (!desiredTitle || kept.has(key)) {
        if (markerKey || pdfKey) {
          const itemId = toNum(it?.ID || it?.id);
          if (itemId) toDeleteIds.push(itemId);
          removed.push(await safeRemoveChecklistItem(taskId, it, softIndex++));
        }
        continue;
      }
      kept.add(key);

      const withMarker = buildStaticTitle(desiredTitle);
      if (title !== withMarker) {
        const itemId = toNum(it?.ID || it?.id);
        if (itemId) {
          try {
            await updateChecklistItem(taskId, itemId, { TITLE: withMarker });
            updated.push({ id: itemId, title: withMarker });
          } catch (e) {
            log('error', 'CHECKLIST_UPDATE_FAIL', { taskId, itemId, error: e?.message || String(e) });
          }
        }
      }
    }

    let sortIndex = 1;
    for (const t of desired) {
      const key = normTitle(t);
      if (!key || kept.has(key)) {
        sortIndex++;
        continue;
      }
      const addedItem = await addChecklistItem(taskId, buildStaticTitle(t), sortIndex++, rootId);
      added.push(addedItem);
    }

    const items = await getChecklist(taskId);
    return {
      ok: true,
      mode: 'static',
      rootId,
      desiredKeys,
      existingKeys,
      toDeleteIds,
      toAddKeys,
      desiredTotal: desired.length,
      removed,
      added,
      updated,
      items,
    };
  } catch (e) {
    log('error', 'CHECKLIST_ENSURE_FAIL', { taskId, error: e?.message || String(e) });
    return { ok: false, action: 'error', error: e?.message || String(e) };
  }
}

async function getChecklistSummary(taskId) {
  const items = await getChecklist(taskId);
  const total = items.length;
  const done = items.filter(isDone).length;
  return { total, done, isAllDone: total > 0 && total === done };
}

module.exports = {
  ensureChecklistForTask,
  isChecklistFullyComplete,
  getChecklistItems: getChecklist,
  getChecklistSummary,
  buildPdfTitle,
};
