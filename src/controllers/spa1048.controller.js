const { handleSpaEvent } = require('../services/bitrix/spa1048Sync.v2');

async function spaEvent(req, res) {
  try {
    const out = await handleSpaEvent(req);
    return res.json(out);
  } catch (e) {
    const msg = e?.response?.data?.error_description || e?.message || String(e);
    console.log('[spa1048] ERROR:', msg);
    // ВАЖНО: отдаём 200, чтобы Bitrix не "отключал" вебхук из-за 500
    return res.json({ ok: false, error: msg });
  }
}

module.exports = { spaEvent };
