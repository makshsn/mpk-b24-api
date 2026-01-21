const { run } = require('../services/bitrix/pauseSync');

async function pauseSync(req, res) {
  try {
    const maxLeads = Number(req.query.maxLeads || 500) || 500;
    const withIds = String(req.query.withIds || '0') === '1';
    const idLimit = Number(req.query.idLimit || 200) || 200;

    const result = await run({ maxLeads, withIds, idLimit });
    return res.json(result);
  } catch (e) {
    // ВАЖНО: 200, чтобы массовый прогон не падал из-за временных 503
    return res.json({ ok: false, error: String(e?.message || e) });
  }
}

module.exports = { pauseSync };
