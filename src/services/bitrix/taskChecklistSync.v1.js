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

function hashName(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function pdfMarker(fileId) {
  const id = toNum(fileId);
  const nameKey = normalizeNameKey(name);
  const nameHash = nameKey ? hashName(nameKey) : '';
  if (id > 0 && nameHash) return `pdf:${id}|${nameHash}`;
  if (id > 0) return `pdf:${id}`;
  if (nameHash) return `pdfname:${nameHash}`;
  return 'pdfname:unknown';
}

function buildPdfTitle({ name, fileId }) {
  const marker = pdfMarker(fileId);
  return marker ? `Оплатить: ${name} [${marker}]` : `Оплатить: ${name}`;
}

function parsePdfMarkerFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\[(pdf|file):([0-9]+)(?:[^\]]*)\]\s*$/i);
  if (!match) return 0;
  return toNum(match[2]);
}

function parseStaticMarkerFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\[static:([^\]]+)\]\s*$/i);
  return match ? String(match[1]).trim().toLowerCase() : '';
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

function extractNameFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/^Оплатить:\s*(.+?)(?:\s*\[|$)/i);
  return match ? match[1].trim() : '';
}

function parsePdfMarkerFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\[([^\]]+)\]\s*$/);
  if (!match) return { fileId: 0, nameHash: '' };
  const marker = match[1].trim();

  const legacy = marker.match(/^file:(\d+)$/i);
  if (legacy) return { fileId: toNum(legacy[1]), nameHash: '' };

  const pdfMatch = marker.match(/^pdf:(.+)$/i);
  if (pdfMatch) {
    const parts = pdfMatch[1].split('|');
    const fileId = toNum(parts[0]);
    const nameHash = parts[1] ? String(parts[1]).trim() : '';
    return { fileId, nameHash };
  }

  const nameMatch = marker.match(/^pdfname:(.+)$/i);
  if (nameMatch) return { fileId: 0, nameHash: String(nameMatch[1]).trim() };

  return { fileId: 0, nameHash: '' };
}

function getPdfIdentityFromItem(item) {
  const title = String(item?.TITLE || item?.title || '').trim();
  const name = extractNameFromTitle(title);
  const nameKey = normalizeNameKey(name);
  const { fileId, nameHash } = parsePdfMarkerFromTitle(title);
  return {
    title,
    name,
    nameKey,
    fileId,
    nameHash,
  };
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
    const nameKey = normalizeNameKey(name);
    const key = `${nameKey}|${fileId || '0'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, fileId, nameKey });
  }
  return out;
}

async function ensureRoot(taskId, existingItems) {
  let root = existingItems.find((it) => {
    const title = String(it?.TITLE || it?.title || '').trim();
    const parentId = toNum(it?.PARENT_ID || it?.parentId);
    return parentId === 0 && title.startsWith('BX_CHECKLIST_');
  });

  if (!root) {
    const createdRoot = await addChecklistItem(taskId, 'BX_CHECKLIST_1', 1, 0);
    root = { ID: createdRoot?.id, TITLE: 'BX_CHECKLIST_1', PARENT_ID: 0 };
  }

  return { rootId: root ? toNum(root?.ID || root?.id) : 0, root };
}

function buildChecklistSummary(items, rootId, managedOnly = true) {
  if (!Array.isArray(items) || !rootId) {
    return { total: 0, done: 0, isAllDone: false };
  }
  const children = items.filter((it) => toNum(it?.PARENT_ID || it?.parentId) === rootId);
  const scoped = managedOnly
    ? children.filter((it) => getManagedKeyFromTitle(it?.TITLE || it?.title))
    : children;
  const total = scoped.length;
  const done = scoped.filter(isDone).length;
  return { total, done, isAllDone: total > 0 && total === done };
}

async function ensureChecklistForTask(taskId, pdfList = []) {
  try {
    const existing = await getChecklist(taskId);
    const root = existing.find((it) => {
      const title = String(it?.TITLE || it?.title || '').trim();
      const parentId = toNum(it?.PARENT_ID || it?.parentId);
      return parentId === 0 && title.startsWith('BX_CHECKLIST_');
    });
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
      const otherItems = [];
      for (const it of existing) {
        const identity = getPdfIdentityFromItem(it);
        if (identity.fileId || identity.nameHash || identity.nameKey) {
          pdfItems.push({ item: it, identity });
        } else {
          otherItems.push(it);
        }
      }

      const existingByFileId = new Map();
      const existingByNameKey = new Map();
      for (const entry of pdfItems) {
        const itemId = toNum(entry.item?.ID || entry.item?.id);
        if (!itemId) continue;
        if (entry.identity.fileId && !existingByFileId.has(entry.identity.fileId)) {
          existingByFileId.set(entry.identity.fileId, entry);
        }
        if (entry.identity.nameKey && !existingByNameKey.has(entry.identity.nameKey)) {
          existingByNameKey.set(entry.identity.nameKey, entry);
        }
      }

      const usedItemIds = new Set();
      let sortIndex = 1;

      for (const pdf of normalizedPdfList) {
        let matched = null;
        if (pdf.fileId && existingByFileId.has(pdf.fileId)) {
          matched = existingByFileId.get(pdf.fileId);
        } else if (pdf.nameKey && existingByNameKey.has(pdf.nameKey)) {
          matched = existingByNameKey.get(pdf.nameKey);
        }

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
          const addedItem = await addChecklistItem(taskId, desiredTitle, sortIndex);
          added.push(addedItem);
        }
        sortIndex++;
      }

      let softIndex = 10000;
      for (const entry of pdfItems) {
        const itemId = toNum(entry.item?.ID || entry.item?.id);
        if (!itemId || usedItemIds.has(itemId)) continue;
        removed.push(await safeRemoveChecklistItem(taskId, entry.item, softIndex++));
      }

      for (const it of otherItems) {
        removed.push(await safeRemoveChecklistItem(taskId, it, softIndex++));
      }

      const items = await getChecklist(taskId);
      const summary = buildChecklistSummary(items, rootId, true);
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
        summary,
      };
    }

    const desired = parseChecklistTitles();
    const desiredKeys = desired.map((t) => `static:${normTitle(t)}`);
    const desiredMap = new Map(desired.map((t) => [`static:${normTitle(t)}`, t]));
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
      const markerKey = parseStaticMarkerFromTitle(title);
      const pdfId = parsePdfMarkerFromTitle(title);
      const titleKey = normTitle(title);
      const desiredTitle = desiredMap.get(markerKey || titleKey);
      if (!desiredTitle || kept.has(markerKey || titleKey)) {
        if (markerKey || pdfId) {
          removed.push(await safeRemoveChecklistItem(taskId, it, softIndex++));
        }
        continue;
      }
      kept.add(markerKey || titleKey);

      const withMarker = buildStaticTitle(desiredTitle);
      if (title !== withMarker) {
        const itemId = toNum(it?.ID || it?.id);
        if (itemId) {
          try {
            await updateChecklistItem(taskId, itemId, { TITLE: desiredTitle });
            updated.push({ id: itemId, title: desiredTitle });
          } catch (e) {
            log('error', 'CHECKLIST_UPDATE_FAIL', { taskId, itemId, error: e?.message || String(e) });
          }
        }
      }
    }

    let sortIndex = 1;
    for (const t of desired) {
      const key = `static:${normTitle(t)}`;
      if (!key || kept.has(key)) {
        sortIndex++;
        continue;
      }
      const addedItem = await addChecklistItem(taskId, buildStaticTitle(t), sortIndex++);
      added.push(addedItem);
    }

    const existingKeySet = new Set(existingKeys);
    const toAddKeys = desiredKeys.filter((key) => !existingKeySet.has(key));
    const items = await getChecklist(taskId);
    const summary = buildChecklistSummary(items, rootId, true);
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
      summary,
    };
  } catch (e) {
    log('error', 'CHECKLIST_ENSURE_FAIL', { taskId, error: e?.message || String(e) });
    return { ok: false, action: 'error', error: e?.message || String(e) };
  }
}

async function getChecklistSummary(taskId) {
  const items = await getChecklist(taskId);
  const root = items.find((it) => {
    const title = String(it?.TITLE || it?.title || '').trim();
    const parentId = toNum(it?.PARENT_ID || it?.parentId);
    return parentId === 0 && title.startsWith('BX_CHECKLIST_');
  });
  const rootId = root ? toNum(root?.ID || root?.id) : 0;
  return buildChecklistSummary(items, rootId, true);
}

module.exports = {
  ensureChecklistForTask,
  isChecklistFullyComplete,
  getChecklistItems: getChecklist,
  getChecklistSummary,
  buildPdfTitle,
  getManagedKeyFromTitle,
  buildChecklistSummary,
};
