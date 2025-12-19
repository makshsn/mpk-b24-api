const { call } = require('./bitrixClient');
const {
  LEAD_PREV_STAGE_FIELD,
  LEAD_PAUSE_STAGE_ID,
  LEAD_CONTACT_TASK_ID_FIELD,
  LEAD_NEXT_MEASURE_DATETIME_FIELD,
  LEAD_PAUSE_REASON_FIELD,
  LEAD_PAUSE_REASON_DEFAULT_TEXT,
  LEAD_ALLOWED_STAGES_FOR_PAUSE,
  CONTACT_TASK_TITLE_PREFIX,
  CONTACT_TASK_OVERDUE_DAYS,
} = require('../../config/fields');

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}
function isFilled(v) { return !!toText(v); }
function inAllowedStages(stageId) { return LEAD_ALLOWED_STAGES_FOR_PAUSE.includes(String(stageId || '')); }

function getTaskDeadline(task) { return task?.deadline || task?.DEADLINE || null; }
function getTaskTitle(task) { return task?.title || task?.TITLE || ''; }
function getTaskStatus(task) { return Number(task?.status || task?.STATUS || 0) || 0; }

function untilDeadlineMs(deadline) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() - Date.now();
}

function daysCeil(ms) {
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

async function addLeadComment(leadId, text) {
  // комментарий в таймлайн лида
  await call('crm.timeline.comment.add', {
    fields: {
      ENTITY_TYPE: 'lead',
      ENTITY_ID: Number(leadId),
      COMMENT: String(text),
    },
  });
}

// достаём значение причины: пытаемся найти в LIST, иначе ставим текст
async function getDefaultReasonValue() {
  try {
    const list = await call('crm.lead.userfield.list', { filter: { FIELD_NAME: LEAD_PAUSE_REASON_FIELD } });
    const uf = Array.isArray(list) && list.length ? list[0] : null;
    const ufId = uf && (uf.ID || uf.id);
    if (!ufId) return LEAD_PAUSE_REASON_DEFAULT_TEXT;

    const ufFull = await call('crm.lead.userfield.get', { id: ufId });
    const items = ufFull?.LIST || [];
    for (const it of items) {
      if (String(it.VALUE || '').trim() === LEAD_PAUSE_REASON_DEFAULT_TEXT) {
        return it.ID || it.XML_ID || LEAD_PAUSE_REASON_DEFAULT_TEXT;
      }
    }
    return LEAD_PAUSE_REASON_DEFAULT_TEXT;
  } catch {
    return LEAD_PAUSE_REASON_DEFAULT_TEXT;
  }
}

async function run({ leadId }) {
  const lead = await call('crm.lead.get', { id: leadId });

  // финальные не трогаем
  const sem = String(lead.STATUS_SEMANTIC_ID || '').trim();
  if (sem && sem !== 'P') return { ok: true, leadId, skipped: 'final', semantic: sem };

  // замер задан — не трогаем
  if (isFilled(lead[LEAD_NEXT_MEASURE_DATETIME_FIELD])) {
    return { ok: true, leadId, skipped: 'measure_set' };
  }

  const taskId = Number(lead[LEAD_CONTACT_TASK_ID_FIELD] || 0);
  if (!taskId) return { ok: true, leadId, skipped: 'no_task_id' };

  let task;
  try {
    const r = await call('tasks.task.get', { taskId });
    task = r?.task || r?.TASK || r?.result?.task || r?.result || null;
  } catch {
    return { ok: true, leadId, skipped: 'task_not_found', taskId };
  }
  if (!task) return { ok: true, leadId, skipped: 'task_not_found', taskId };

  const title = String(getTaskTitle(task) || '');
  if (!title.startsWith(CONTACT_TASK_TITLE_PREFIX)) {
    return { ok: true, leadId, skipped: 'wrong_task_title', taskId, title };
  }

  const status = getTaskStatus(task);
  if (status === 5 || status === 7) {
    return { ok: true, leadId, skipped: 'task_closed', taskId, status };
  }

  const deadline = getTaskDeadline(task);
  if (!deadline) return { ok: true, leadId, skipped: 'no_deadline', taskId };

  const ms = untilDeadlineMs(deadline);
  if (ms == null) return { ok: true, leadId, skipped: 'bad_deadline', taskId, deadline };

  const isFarMoreThan3Days = ms > (CONTACT_TASK_OVERDUE_DAYS * 24 * 60 * 60 * 1000);

  const currentStage = String(lead.STATUS_ID || '');
  const prevStage = String(lead[LEAD_PREV_STAGE_FIELD] || '').trim();

  // В паузу: если дедлайн дальше чем через 3 дня
  if (isFarMoreThan3Days && currentStage !== LEAD_PAUSE_STAGE_ID) {
    if (!inAllowedStages(currentStage)) {
      return { ok: true, leadId, skipped: 'stage_not_allowed', currentStage };
    }

    const reasonValue = await getDefaultReasonValue();

    await call('crm.lead.update', {
      id: leadId,
      fields: {
        STATUS_ID: LEAD_PAUSE_STAGE_ID,
        [LEAD_PREV_STAGE_FIELD]: currentStage,
        [LEAD_PAUSE_REASON_FIELD]: reasonValue,
      },
    });

    const days = daysCeil(ms);
    await addLeadComment(
      leadId,
      `Переведено в ПАУЗУ, т.к. дата следующего контакта больше 3х дней (≈${days} дн.).`
    );

    return {
      ok: true,
      leadId,
      action: 'moved_to_pause',
      from: currentStage,
      reason: reasonValue,
      deadline,
      msUntilDeadline: ms,
      deadlineInMoreThan3Days: true,
    };
  }

  // Вывести из паузы: если дедлайн уже близко (<=3 дней) ИЛИ прошёл
  if (!isFarMoreThan3Days && currentStage === LEAD_PAUSE_STAGE_ID) {
    if (!prevStage) return { ok: true, leadId, skipped: 'no_prev_stage' };
    if (!inAllowedStages(prevStage)) return { ok: true, leadId, skipped: 'prev_stage_not_allowed', prevStage };

    await call('crm.lead.update', {
      id: leadId,
      fields: {
        STATUS_ID: prevStage,
        [LEAD_PREV_STAGE_FIELD]: '',
      },
    });

    const days = ms >= 0 ? daysCeil(ms) : 0;
    await addLeadComment(
      leadId,
      `Выведено из ПАУЗЫ, т.к. контакт через 3 дня и меньше (≈${days} дн.).`
    );

    return {
      ok: true,
      leadId,
      action: 'restored_from_pause',
      to: prevStage,
      deadline,
      msUntilDeadline: ms,
      deadlineInMoreThan3Days: false,
    };
  }

  return {
    ok: true,
    leadId,
    action: 'no_change',
    currentStage,
    deadline,
    msUntilDeadline: ms,
    deadlineInMoreThan3Days: isFarMoreThan3Days,
  };
}

module.exports = { run };

