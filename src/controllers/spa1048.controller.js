const { handleSpaEvent } = require('../services/bitrix/spa1048Sync.v2');
const { verifyOutboundToken } = require('../services/bitrix/b24Outbound.v1');

function pickItemId(req) {
  const b = req.body || {};
  const q = req.query || {};
  const candidates = [
    q.itemId,
    b?.data?.FIELDS?.ID,
    b?.data?.FIELDS?.id,
    b?.FIELDS?.ID,
    b?.FIELDS?.id,
    b?.itemId,
    b?.id,
  ];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    const n = Number(String(v).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

async function spaEvent(req, res) {
  try {
    // outbound secret: auth.application_token
    if (req.method === 'POST') {
      const tok = verifyOutboundToken(req, 'B24_OUTBOUND_SPA_TOKEN');
      if (!tok.ok) return res.status(403).json({ ok: false, error: tok.reason });
    }

    const itemId = pickItemId(req);
    if (!itemId) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_itemId:undefined',
        debug: { body: req.body || null }
      });
    }

    req.query = req.query || {};
    req.query.itemId = String(itemId);
return await handleSpaEvent(req, res);
  } catch (e) {
    const msg = e?.message || String(e);
    console.log('[spa1048] ERROR:', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
}

module.exports = { spaEvent };
