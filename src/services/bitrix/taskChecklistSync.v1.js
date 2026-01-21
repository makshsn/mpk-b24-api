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

function hashName(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function pdfMarker(fileId, name) {
  const id = toNum(fileId);
  if (id > 0) return `file:${id}`;
  return `file:${hashName(name)}`;
}

function buildPdfTitle({ name, fileId }) {
  return `Оплатить: ${name} [${pdfMarker(fileId, name)}]`;
}

async function getChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) }, { ctx: { taskId, step: 'checklist_getlist' } });
  const u = unwrap(r);
  const items = u?.items || u?.result?.items || u || [];
  return Array.isArray(items) ? items : [];
}

async function addChecklistItem(taskId, title, sortIndex) {
  const r = await bitrix.call('task.checklistitem.add', {
    taskId: Number(taskId),
    fields: { TITLE: String(title), SORT_INDEX: Number(sortIndex || 0) },
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
    const key = `${name.toLowerCase()}|${fileId || '0'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, fileId });
  }
  return out;
}

async function ensureChecklistForTask(taskId, pdfList = []) {
  try {
    const existing = await getChecklist(taskId);
    const normalizedPdfList = normalizePdfList(pdfList);
    const removed = [];
    const added = [];

    if (normalizedPdfList.length > 0) {
      let softIndex = 10000;
      for (const it of existing) {
        removed.push(await safeRemoveChecklistItem(taskId, it, softIndex++));
      }

      let sortIndex = 1;
      for (const pdf of normalizedPdfList) {
        const title = buildPdfTitle(pdf);
        const addedItem = await addChecklistItem(taskId, title, sortIndex++);
        added.push(addedItem);
      }

      const items = await getChecklist(taskId);
      return {
        ok: true,
        mode: 'pdf',
        desiredTotal: normalizedPdfList.length,
        removed,
        added,
        items,
      };
    }

    const desired = parseChecklistTitles();
    const desiredMap = new Map(desired.map((t) => [normTitle(t), t]));
    const kept = new Set();
    let softIndex = 10000;

    for (const it of existing) {
      const title = String(it?.TITLE || it?.title || '').trim();
      const key = normTitle(title);
      if (!key || !desiredMap.has(key) || kept.has(key)) {
        removed.push(await safeRemoveChecklistItem(taskId, it, softIndex++));
        continue;
      }
      kept.add(key);

      const desiredTitle = desiredMap.get(key);
      if (title !== desiredTitle) {
        const itemId = toNum(it?.ID || it?.id);
        if (itemId) {
          try {
            await updateChecklistItem(taskId, itemId, { TITLE: desiredTitle });
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
      const addedItem = await addChecklistItem(taskId, t, sortIndex++);
      added.push(addedItem);
    }

    const items = await getChecklist(taskId);
    return {
      ok: true,
      mode: 'static',
      desiredTotal: desired.length,
      removed,
      added,
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
