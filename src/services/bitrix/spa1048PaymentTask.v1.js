const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');
const checklistSync = require('./taskChecklistSync.v1');

/**
 * Создаём задачу на оплату всех PDF + чеклист по именам PDF.
 * После полной отметки чеклиста — переводим SPA в SUCCESS.
 */

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = String(x || '').trim();
    if (!k) continue;
    const key = k.toLowerCase();
    if (s.has(key)) continue;
    s.add(key);
    out.push(k);
  }
  return out;
}

function parseChecklistTitles() {
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

function normalizePdfList(pdfList) {
  if (!Array.isArray(pdfList)) return [];
  const seen = new Set();
  const out = [];
  for (const it of pdfList) {
    const name = String(it?.name || '').trim();
    const fileId = toNum(it?.fileId || it?.id || it?.FILE_ID);
    if (!name || !fileId || !name.toLowerCase().endsWith('.pdf')) continue;
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    out.push({ fileId, name });
  }
  return out;
}

function buildPdfTitle({ fileId, name }) {
  return `Оплатить: ${name} [file:${fileId}]`;
}

function extractFileIdFromTitle(title) {
  const match = String(title || '').match(/\[file:(\d+)\]/i);
  return match ? toNum(match[1]) : 0;
}

async function addTask({ title, description, responsibleId, deadline, crmBindings }) {
  const fields = {
    TITLE: String(title || ''),
    RESPONSIBLE_ID: Number(responsibleId || 0),
    DESCRIPTION: String(description || ''),
  };

  if (Array.isArray(crmBindings) && crmBindings.length) {
    fields.UF_CRM_TASK = crmBindings;
  }

  // DEADLINE опционально
  if (deadline) fields.DEADLINE = String(deadline);

  const r = await bitrix.call('tasks.task.add', { fields }, { ctx: { step: 'task_add' } });
  const t = r?.task || r?.result?.task || r?.result;
  const taskId = toNum(t?.id || t?.ID);
  if (!taskId) throw new Error('[spa1048] tasks.task.add: cannot extract taskId');
  return taskId;
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', {
    taskId: Number(taskId),
    select: ['ID', 'STATUS'],
  }, { ctx: { step: 'task_get_for_create', taskId } });
  const t = r?.task || r?.result?.task || r?.result;
  return t || null;
}

async function bindTaskToCrm(taskId, crmBindings) {
  if (!Array.isArray(crmBindings) || !crmBindings.length) return;
  await bitrix.call('tasks.task.update', {
    taskId: Number(taskId),
    fields: { UF_CRM_TASK: crmBindings },
  }, { ctx: { step: 'task_bind_crm', taskId } });
}

async function setSpaTaskId({ entityTypeId, itemId, taskId }) {
  // пишем taskId в поле (по умолчанию UF_CRM_8_TASK_ID)
  // Важно: для update надёжнее использовать ORIGINAL (UPPER) имя поля.
  const taskIdField = String(process.env.SPA1048_TASK_ID_FIELD_ORIG || cfg.taskIdField || 'UF_CRM_8_TASK_ID');
  await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: { [taskIdField]: Number(taskId) , ufCrm8TaskId: Number(taskId) },
  }, { ctx: { step: 'crm_set_task_id', itemId, taskId, taskIdField } });
}

async function getChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', { taskId: Number(taskId) }, { ctx: { step: 'checklist_getlist', taskId } });
  const list = r?.result || r?.items || r;
  if (Array.isArray(list)) return list;
  if (Array.isArray(list?.items)) return list.items;
  return [];
}

async function addChecklistItem(taskId, title, sortIndex) {
  // task.checklistitem.add: { taskId, fields: { TITLE, SORT_INDEX } }
  await bitrix.call('task.checklistitem.add', {
    taskId: Number(taskId),
    fields: { TITLE: String(title), SORT_INDEX: Number(sortIndex || 0) },
  }, { ctx: { step: 'checklist_add', taskId } });
}

async function updateChecklistItem(taskId, itemId, fields) {
  await bitrix.call('task.checklistitem.update', {
    taskId: Number(taskId),
    id: Number(itemId),
    fields,
  }, { ctx: { step: 'checklist_update', taskId, itemId } });
}

async function deleteChecklistItem(taskId, itemId) {
  await bitrix.call('task.checklistitem.delete', {
    taskId: Number(taskId),
    id: Number(itemId),
  }, { ctx: { step: 'checklist_delete', taskId, itemId } });
}

async function safeDeleteChecklistItem(taskId, item) {
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
        SORT_INDEX: 9999,
      });
      return { ok: true, action: 'soft_deleted', id: itemId };
    } catch (err) {
      return { ok: false, action: 'delete_failed', id: itemId, error: err?.message || String(err) };
    }
  }
}

function isCompleteItem(it) {
  return String(it?.IS_COMPLETE ?? '').toUpperCase() === 'Y';
}

async function ensurePdfChecklist({ taskId, pdfList }) {
  if (checklistSync?.ensureChecklistForTask) {
    const checklist = await checklistSync.ensureChecklistForTask(taskId, pdfList || []);
    const items = Array.isArray(checklist?.items) ? checklist.items : await getChecklist(taskId);
    const itemsWithMarker = items.filter((it) => {
      const title = String(it?.TITLE || it?.title || '').trim();
      return /\[(pdf|pdfname|file):/i.test(title);
    });
    const fullyComplete = itemsWithMarker.length > 0 && itemsWithMarker.every(isCompleteItem);
    return {
      ok: true,
      ...checklist,
      totalPdfItems: itemsWithMarker.length,
      fullyComplete,
      items,
      itemsWithMarker,
    };
  }

  const normalizedPdfList = normalizePdfList(pdfList);
  const items = await getChecklist(taskId);

  const pdfItems = [];
  const otherItems = [];

  for (const it of items) {
    const title = String(it?.TITLE || it?.title || '').trim();
    if (extractFileIdFromTitle(title)) pdfItems.push(it);
    else otherItems.push(it);
  }

  const mapExisting = new Map();
  for (const it of pdfItems) {
    const fileId = extractFileIdFromTitle(it?.TITLE || it?.title);
    if (!fileId || mapExisting.has(fileId)) continue;
    mapExisting.set(fileId, it);
  }

  const setWanted = new Set(normalizedPdfList.map((p) => p.fileId));
  const added = [];
  const updated = [];
  const deleted = [];
  const removedOther = [];

  let sortIndex = 1;
  for (const pdf of normalizedPdfList) {
    const existing = mapExisting.get(pdf.fileId);
    const title = buildPdfTitle(pdf);
    if (existing) {
      const existingTitle = String(existing?.TITLE || existing?.title || '').trim();
      if (existingTitle !== title) {
        const itemId = toNum(existing?.ID || existing?.id);
        if (itemId) {
          await updateChecklistItem(taskId, itemId, { TITLE: title, SORT_INDEX: sortIndex });
          updated.push({ id: itemId, fileId: pdf.fileId });
        }
      }
    } else {
      await addChecklistItem(taskId, title, sortIndex);
      added.push({ fileId: pdf.fileId, title });
    }
    sortIndex++;
  }

  if (normalizedPdfList.length > 0) {
    for (const it of otherItems) {
      removedOther.push(await safeDeleteChecklistItem(taskId, it));
    }
  } else {
    const desired = parseChecklistTitles();
    const desiredMap = new Map(desired.map((t) => [t.toLowerCase(), t]));
    const existingStatic = new Map();

    for (const it of otherItems) {
      const title = String(it?.TITLE || it?.title || '').trim();
      const key = title.toLowerCase();
      if (!key || !desiredMap.has(key) || existingStatic.has(key)) {
        removedOther.push(await safeDeleteChecklistItem(taskId, it));
        continue;
      }
      existingStatic.set(key, it);

      const desiredTitle = desiredMap.get(key);
      if (title !== desiredTitle) {
        const itemId = toNum(it?.ID || it?.id);
        if (itemId) {
          await updateChecklistItem(taskId, itemId, { TITLE: desiredTitle });
          updated.push({ id: itemId, title: desiredTitle });
        }
      }
    }

    let staticSort = 1;
    for (const title of desired) {
      const key = title.toLowerCase();
      if (existingStatic.has(key)) {
        staticSort++;
        continue;
      }
      await addChecklistItem(taskId, title, staticSort++);
      added.push({ title });
    }
  }

  for (const it of pdfItems) {
    const fileId = extractFileIdFromTitle(it?.TITLE || it?.title);
    if (!fileId || setWanted.has(fileId)) continue;
    deleted.push(await safeDeleteChecklistItem(taskId, it));
  }

  const after = await getChecklist(taskId);
  const itemsWithMarker = after.filter((it) => extractFileIdFromTitle(it?.TITLE || it?.title));
  const fullyComplete = itemsWithMarker.length > 0 && itemsWithMarker.every(isCompleteItem);

  return {
    ok: true,
    added,
    updated,
    deleted,
    removedOther,
    totalPdfItems: itemsWithMarker.length,
    fullyComplete,
    items: after,
    itemsWithMarker,
  };
}

async function moveSpaToSuccess({ entityTypeId, itemId }) {
  await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: { stageId: 'DT1048_14:SUCCESS' },
  }, { ctx: { step: 'crm_move_success', itemId } });
}

async function findSpaByTaskId({ entityTypeId, taskId }) {
  // Иногда фильтр работает по camel, иногда по upper — пробуем оба
  const tryFilters = [
    { ufCrm8TaskId: Number(taskId) },
    { UF_CRM_8_TASK_ID: Number(taskId) },
  ];

  for (const filter of tryFilters) {
    const r = await bitrix.call('crm.item.list', {
      entityTypeId: Number(entityTypeId),
      filter,
      select: ['id', 'stageId', 'title', 'ufCrm8TaskId', 'UF_CRM_8_TASK_ID'],
      order: { id: 'DESC' },
      start: 0,
    }, { ctx: { step: 'crm_item_list_by_task', taskId } });

    const items = r?.items || r?.result?.items || r?.result || r;
    if (Array.isArray(items) && items.length) return items[0];
  }
  return null;
}

async function createPaymentTaskIfMissing({
  entityTypeId,
  itemId,
  itemTitle,
  deadline,
  taskId,
  pdfNames,
  responsibleId,
  stageId,
}) {
  const existingTaskId = toNum(taskId);
  const stage = String(stageId || '');

  if (existingTaskId) {
    try {
      const task = await getTask(existingTaskId);
      const status = Number(task?.status || task?.STATUS || 0) || 0;
      if (status === 5) {
        let movedToSuccess = false;
        if (stage !== 'DT1048_14:SUCCESS') {
          try {
            await moveSpaToSuccess({ entityTypeId, itemId });
            movedToSuccess = true;
          } catch (e) {
            return {
              ok: false,
              action: 'task_completed_skip_create',
              taskId: existingTaskId,
              status,
              error: e?.message || String(e),
            };
          }
        }
        return {
          ok: true,
          action: 'task_completed_skip_create',
          taskId: existingTaskId,
          status,
          movedToSuccess,
        };
      }

      return { ok: true, action: 'skip_task_exists', taskId: existingTaskId, status };
    } catch (e) {
      // если задача удалена/не найдена — создаём новую
    }
  }

  const pdfs = uniq(pdfNames).filter(x => x.toLowerCase().endsWith('.pdf'));
  const title = `Оплата счетов (${pdfs.length} PDF): ${itemTitle || ('SPA#' + itemId)}`;

  const descrLines = [
    `Оплата всех PDF-файлов по счёту/заказу SPA(1048) #${itemId}.`,
    `Отмечайте пункты чеклиста по мере оплаты.`,
    ``,
    ...pdfs.map((x, i) => `${i + 1}. ${x}`),
  ];
  const description = descrLines.join('\n');

  const typeHex = Number(entityTypeId).toString(16); // SPA binding требует HEX typeId
  const crmBindings = [`T${typeHex}_${itemId}`];
  const newTaskId = await addTask({ title, description, responsibleId, deadline, crmBindings });

  await setSpaTaskId({ entityTypeId, itemId, taskId: newTaskId });

  // привязка задачи к CRM (надежнее вторым шагом)
  await bindTaskToCrm(newTaskId, crmBindings);

  return { ok: true, action: 'task_created', taskId: newTaskId };
}

async function syncPaidToSuccessByTask({ entityTypeId, taskId }) {
  const spa = await findSpaByTaskId({ entityTypeId, taskId });
  if (!spa?.id) return { ok: false, action: 'spa_not_found_by_task', taskId: Number(taskId) };

  const itemId = toNum(spa.id);
  const stageId = String(spa.stageId || '');

  // если уже SUCCESS — скипаем
  if (stageId === 'DT1048_14:SUCCESS') {
    return { ok: true, action: 'already_success', itemId, taskId: Number(taskId) };
  }

  // pdfNames мы тут не знаем — считаем “оплачено”, если ВСЕ пункты чеклиста завершены
  const items = await getChecklist(taskId);
  const realItems = items.filter(i => String(i.TITLE || '').trim()); // без пустых
  if (!realItems.length) return { ok: false, action: 'checklist_empty', itemId, taskId: Number(taskId) };

  const allDone = realItems.every(i => String(i.IS_COMPLETE || '').toUpperCase() === 'Y');
  if (!allDone) return { ok: true, action: 'not_fully_paid', itemId, taskId: Number(taskId) };

  await moveSpaToSuccess({ entityTypeId, itemId });
  return { ok: true, action: 'moved_to_success', itemId, taskId: Number(taskId) };
}

module.exports = {
  createPaymentTaskIfMissing,
  ensurePdfChecklist,
  moveSpaToSuccess,
  findSpaByTaskId,
  syncPaidToSuccessByTask,
};
