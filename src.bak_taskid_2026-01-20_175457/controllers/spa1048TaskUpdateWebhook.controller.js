const { handleTaskUpdateWebhook } = require('../services/bitrix/spa1048TaskOnUpdate.v1');

async function taskUpdateWebhook(req, res) {
  try {
    return await handleTaskUpdateWebhook(req, res);
  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[task-update-webhook] ERROR:', msg, e?.data ? JSON.stringify(e.data) : '');
    return res.status(500).json({ ok: false, error: msg });
  }
}

module.exports = { taskUpdateWebhook };
