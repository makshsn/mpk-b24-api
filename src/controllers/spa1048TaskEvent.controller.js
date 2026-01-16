const { handleTaskEvent } = require('../services/bitrix/task1048Sync.v2');

async function taskEvent(req, res) {
  try {
    const r = await handleTaskEvent(req);
    res.json(r);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ ok: false, error: e.message || String(e) });
  }
}

module.exports = { taskEvent };
