const { run } = require('../services/bitrix/syncNextContactFromTask');

function extractTaskId(body) {
  // Bitrix может прислать разными форматами (JSON или form-urlencoded)
  const b = body || {};

  const direct =
    b.taskId ||
    b.TASK_ID ||
    b.id ||
    b.ID ||
    b.data?.taskId ||
    b.data?.TASK_ID ||
    b.data?.id ||
    b.data?.ID ||
    b.data?.FIELDS_AFTER?.ID ||
    b.data?.FIELDS_AFTER?.id ||
    b.data?.FIELDS_BEFORE?.ID ||
    b.data?.FIELDS_BEFORE?.id ||
    b.data?.FIELDS?.ID ||
    b.data?.FIELDS?.id;

  const n = Number(direct || 0);
  return n || null;
}

async function taskUpdate(req, res) {
  try {
    const taskId = extractTaskId(req.body) || extractTaskId(req.query);
    if (!taskId) return res.json({ ok: true, skipped: 'no_task_id_in_event' });

    const result = await run({ taskId });
    return res.json(result);
  } catch (e) {
    // чтобы Bitrix не долбил повторно, отвечаем JSON, без падения сервера
    return res.json({ ok: false, error: String(e?.message || e) });
  }
}

module.exports = { taskUpdate };
