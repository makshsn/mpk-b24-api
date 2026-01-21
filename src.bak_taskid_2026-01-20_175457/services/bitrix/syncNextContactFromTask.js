const { call } = require('./bitrixClient');
const {
  CONTACT_TASK_TITLE_PREFIX,
  LEAD_CONTACT_TASK_ID_FIELD,
  LEAD_NEXT_CONTACT_DATETIME_FIELD, // используем как "дата следующего контакта"
} = require('../../config/fields');

function toStr(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}

function parseMs(v) {
  const s = toStr(v);
  if (!s) return null;
  const d = new Date(s);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function sameDateTime(a, b) {
  const am = parseMs(a);
  const bm = parseMs(b);

  // если обе даты парсятся — сравниваем по миллисекундам
  if (am != null && bm != null) return am === bm;

  // иначе просто строками (на крайний случай)
  return toStr(a) !== '' && toStr(a) === toStr(b);
}

async function addTaskComment(taskId, text) {
  await call('task.commentitem.add', {
    TASKID: Number(taskId),
    FIELDS: {
      POST_MESSAGE: String(text),
    },
  });
}

async function run({ taskId }) {
  const id = Number(taskId || 0);
  if (!id) return { ok: true, skipped: 'no_task_id' };

  // 1) берём задачу
  const t = await call('tasks.task.get', { taskId: id });
  const task = t?.task || t?.TASK || t?.result?.task || t?.result || null;
  if (!task) return { ok: true, taskId: id, skipped: 'task_not_found' };

  const title = toStr(task.title || task.TITLE);
  if (!title.startsWith(CONTACT_TASK_TITLE_PREFIX)) {
    return { ok: true, taskId: id, skipped: 'wrong_task_title', title };
  }

  const deadline = toStr(task.deadline || task.DEADLINE);
  if (!deadline) return { ok: true, taskId: id, skipped: 'no_deadline' };

  // 2) ищем лид по кастомному полю "ID задачи"
  const leads = await call('crm.lead.list', {
    order: { ID: 'ASC' },
    filter: { [LEAD_CONTACT_TASK_ID_FIELD]: id },
    select: ['ID', 'TITLE', 'STATUS_ID', LEAD_NEXT_CONTACT_DATETIME_FIELD, LEAD_CONTACT_TASK_ID_FIELD],
    start: 0,
  });

  if (!Array.isArray(leads) || leads.length === 0) {
    return { ok: true, taskId: id, skipped: 'lead_not_found_by_task' };
  }

  // по твоим правилам он один, но на всякий случай берём первый
  const lead = leads[0];
  const leadId = Number(lead.ID);

  const leadDate = lead[LEAD_NEXT_CONTACT_DATETIME_FIELD];

  // 3) защита от зацикливания: если даты уже одинаковые — ничего не делаем
  if (sameDateTime(leadDate, deadline)) {
    return {
      ok: true,
      taskId: id,
      leadId,
      action: 'no_change',
      leadDate: toStr(leadDate),
      taskDeadline: deadline,
    };
  }

  // 4) обновляем "дату следующего контакта" в лиде
  await call('crm.lead.update', {
    id: leadId,
    fields: {
      [LEAD_NEXT_CONTACT_DATETIME_FIELD]: deadline,
    },
  });

  // 5) комментарий в лид (чтобы было видно, что отработало)
  await addTaskComment(id,
    `Дата следующего контакта обновлена из задачи "${CONTACT_TASK_TITLE_PREFIX}…": ${deadline}`
  );

  return {
    ok: true,
    taskId: id,
    leadId,
    action: 'updated_lead_next_contact',
    from: toStr(leadDate),
    to: deadline,
  };
}

module.exports = { run };
