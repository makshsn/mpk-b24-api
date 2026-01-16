const { handleTaskEvent } = require('../services/bitrix/spa1048TaskDeadlineSync');

async function taskEvent(req, res, next) {
  try {
    // Bitrix шлёт POST. Для ручного теста поддержим query.
    const taskId =
      req.query.taskId ||
      req.body?.data?.FIELDS_AFTER?.ID ||
      req.body?.data?.FIELDS_AFTER?.Id ||
      req.body?.data?.FIELDS_AFTER?.id ||
      req.body?.data?.TASK_ID ||
      req.body?.taskId;

    const result = await handleTaskEvent({ taskId });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

module.exports = { taskEvent };
