const qs = require('querystring');
const { handleSpaEvent } = require('../services/bitrix/spa1048Sync.v2');
const { verifyOutboundToken } = require('../services/bitrix/b24Outbound.v1');

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

  const autoId = `spa1048-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = autoId;
  return autoId;
}

function logWithReq(req, ...args) {
  const rid = req.requestId || 'no-rid';
  console.log(`[spa1048][rid=${rid}]`, ...args);
}

function extractItemId(req) {
  const q = req.query || {};
  const b = req.body || {};
  const q2 = parseQueryFromUrl(req);

  let raw = q.itemId ?? q.id ?? q2.itemId ?? q2.id;

  if (raw === undefined || raw === null || raw === '') {
    raw =
      b.itemId ?? b.id ??
      b?.data?.FIELDS?.ID ?? b?.data?.FIELDS?.id ??
      b?.FIELDS?.ID ?? b?.FIELDS?.id ??
      b?.data?.FIELDS_AFTER?.ID ?? b?.data?.FIELDS_AFTER?.id ??
      b?.data?.FIELDS_BEFORE?.ID ?? b?.data?.FIELDS_BEFORE?.id;
  }

  const str = String(raw ?? '').trim();
  const n = Number(str);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function spaEvent(req, res) {
  const rid = ensureRequestId(req);

  try {
    if (req.method === 'POST') {
      const tok = verifyOutboundToken(req, 'B24_OUTBOUND_SPA_TOKEN');
      if (!tok.ok) {
        logWithReq(req, 'auth_failed', tok.reason);
        return res.status(403).json({ ok: false, error: tok.reason });
      }
    }

    const q2 = parseQueryFromUrl(req);
    logWithReq(req, 'incoming', req.method, req.originalUrl || req.url, 'q2=', q2);

    const itemId = extractItemId(req);
    if (!itemId) {
      logWithReq(req, 'itemId_missing', { query: req.query, bodyKeys: Object.keys(req.body || {}) });
      return res.status(400).json({ ok: false, error: 'itemId is required', requestId: rid });
    }

    req.query = req.query || {};
    req.query.itemId = String(itemId);
    req.body = req.body || {};
    req.body.itemId = itemId;

    logWithReq(req, 'itemId_resolved', itemId);
    return await handleSpaEvent(req, res);
  } catch (e) {
    const msg = e?.message || String(e);
    logWithReq(req, 'error', msg);
    return res.status(500).json({ ok: false, error: msg, requestId: rid });
  }
}

module.exports = { spaEvent };
