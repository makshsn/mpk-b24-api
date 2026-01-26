const { run } = require('../services/bitrix/syncNextContactFromTask');
const { processSpa1048TaskUpdate } = require('../modules/spa1048/spa1048TaskOnUpdate.v1');

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

    // 1) SPA1048: синхронизация дедлайна (дата) из задачи (дата+время) + проверка чеклиста
    // 2) Остальная логика проекта: syncNextContactFromTask
    const [spa1048, nextContactSync] = await Promise.all([
      processSpa1048TaskUpdate({ payload: req.body || {}, query: req.query || {}, taskId }),
      run({ taskId }),
    ]);

    return res.json({ ok: true, taskId, spa1048, nextContactSync });
  } catch (e) {
    // чтобы Bitrix не долбил повторно, отвечаем JSON, без падения сервера
    return res.json({ ok: false, error: String(e?.message || e) });
  }
}

module.exports = { taskUpdate };
