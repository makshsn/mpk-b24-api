const { run } = require('../services/bitrix/pauseSyncOne');

async function pauseSyncOne(req, res) {
  try {
    const leadId = Number(req.params.leadId || req.query.leadId);
    if (!leadId) return res.json({ ok: false, error: 'leadId required' });

    const result = await run({ leadId });
    return res.json(result);
  } catch (e) {
    return res.json({ ok: false, error: String(e?.message || e) });
  }
}

module.exports = { pauseSyncOne };
