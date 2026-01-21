const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');

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

async function ensurePdfChecklist({ taskId, pdfNames }) {
  const titles = uniq(pdfNames).filter(x => x.toLowerCase().endsWith('.pdf'));
  if (!titles.length) return { ok: true, total: 0, done: 0, added: [] };

  const items = await getChecklist(taskId);
  const existing = new Set(items.map(i => String(i.TITLE || i.title || '').trim().toLowerCase()).filter(Boolean));

  const added = [];
  let sort = 1;

  for (const t of titles) {
    const key = t.toLowerCase();
    if (existing.has(key)) { sort++; continue; }
    await addChecklistItem(taskId, t, sort++);
    added.push(t);
  }

  const after = await getChecklist(taskId);
  const done = after.filter(i => String(i.IS_COMPLETE || i.isComplete || '').toUpperCase() === 'Y').length;

  return { ok: true, total: after.length, done, added, items: after };
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
