const qs = require('querystring');

const { verifyOutboundToken, extractSpaItemId, ensureObjectBody } = require('../services/bitrix/b24Outbound.v1');
const { handleSpa1048Delete } = require('../modules/spa1048/spa1048OnDelete.v1');

function parseQueryFromUrl(req) {
  const u = String(req.originalUrl || req.url || '');
  const i = u.indexOf('?');
  if (i < 0) return {};
  return qs.parse(u.slice(i + 1));
}

function ensureRequestId(req) {
  const headerId = req.headers['x-request-id'] || req.headers['x-requestid'];
  if (headerId) {
    req.requestId = String(headerId);
    return req.requestId;
  }

  const autoId = `spa1048-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = autoId;
  return autoId;
}

function logWithReq(req, ...args) {
  const rid = req.requestId || 'no-rid';
  console.log(`[spa1048-delete][rid=${rid}]`, ...args);
}

function extractEntityTypeId(req) {
  const b = ensureObjectBody(req);
  const q = req.query || {};
  const q2 = parseQueryFromUrl(req);

  const candidates = [
    q.entityTypeId,
    q2.entityTypeId,
    b?.entityTypeId,
    b?.ENTITY_TYPE_ID,
    b?.data?.ENTITY_TYPE_ID,
    b?.data?.entityTypeId,
    b?.data?.FIELDS?.ENTITY_TYPE_ID,
    b?.data?.FIELDS?.entityTypeId,
    b?.FIELDS?.ENTITY_TYPE_ID,
    b?.FIELDS?.entityTypeId,
  ];

  for (const v of candidates) {
    const n = Number(String(v ?? '').trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function spaDeleteWebhook(req, res) {
  const rid = ensureRequestId(req);

  try {
    if (req.method === 'POST') {
      const tok = verifyOutboundToken(req, 'B24_OUTBOUND_SPA_TOKEN');
      if (!tok.ok) {
        logWithReq(req, 'auth_failed', tok.reason);
        return res.status(403).json({ ok: false, error: tok.reason, requestId: rid });
      }
    }

    const q2 = parseQueryFromUrl(req);
    logWithReq(req, 'incoming', req.method, req.originalUrl || req.url, 'q2=', q2);

    const itemId = extractSpaItemId(req);
    if (!itemId) {
      logWithReq(req, 'itemId_missing', {
        query: req.query,
        params: req.params,
        bodyKeys: Object.keys(req.body || {}),
      });
      return res.status(400).json({ ok: false, error: 'itemId is required', requestId: rid });
    }

    const debug = String((req.query || {}).debug ?? q2.debug ?? '0') === '1';
    const entityTypeId = extractEntityTypeId(req) || Number(process.env.SPA1048_ENTITY_TYPE_ID || 1048);

    const result = await handleSpa1048Delete({
      entityTypeId,
      itemId,
      req,
      debug,
    });

    logWithReq(req, 'done', {
      itemId,
      entityTypeId,
      deleted: Array.isArray(result.deleted) ? result.deleted.length : 0,
      failed: Array.isArray(result.failed) ? result.failed.length : 0,
    });

    return res.json({ requestId: rid, ...result });
  } catch (e) {
    const msg = e?.message || String(e);
    logWithReq(req, 'error', msg);
    return res.status(500).json({ ok: false, error: msg, requestId: rid });
  }
}

module.exports = { spaDeleteWebhook };
