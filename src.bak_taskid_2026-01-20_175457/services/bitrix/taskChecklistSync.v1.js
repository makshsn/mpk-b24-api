const bitrix = require('./bitrixClient');

function unwrap(resp) {
  return resp?.result ?? resp;
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

async function getChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) }, { ctx: { taskId, step: 'checklist_getlist' } });
  const u = unwrap(r);
  const items = u?.items || u?.result?.items || u || [];
  return Array.isArray(items) ? items : [];
}

function normTitle(x) {
  return String(x || '').trim().toLowerCase();
}

function isDone(it) {
  const v = it?.IS_COMPLETE ?? it?.isComplete ?? it?.COMPLETE ?? it?.complete;
  return String(v).toUpperCase() === 'Y' || String(v) === '1' || v === true;
}

async function ensureChecklistForTask(taskId) {
  const desired = parseChecklistTitles();
  const existing = await getChecklist(taskId);

  const byTitle = new Map();
  for (const it of existing) {
    const title = normTitle(it?.TITLE || it?.title);
    if (title) byTitle.set(title, it);
  }

  const added = [];

  // add missing items
  for (const t of desired) {
    const key = normTitle(t);
    if (!key) continue;
    if (byTitle.has(key)) continue;

    const r = await bitrix.call('task.checklistitem.add', {
      taskId: Number(taskId),
      fields: { TITLE: t },
    }, { ctx: { taskId, step: 'checklist_add' } });

    const u = unwrap(r);
    const id = Number(u?.item?.id || u?.ID || u?.id || u);
    added.push({ id, title: t });
  }

  const after = await getChecklist(taskId);
  const total = after.length;
  const done = after.filter(isDone).length;

  return { ok: true, total, done, added, items: after };
}

async function getChecklistSummary(taskId) {
  const items = await getChecklist(taskId);
  const total = items.length;
  const done = items.filter(isDone).length;
  return { total, done, isAllDone: total > 0 && total === done };
}

module.exports = {
  ensureChecklistForTask,
  getChecklistSummary,
};
