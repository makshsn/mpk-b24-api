const axios = require('axios');
const crypto = require('crypto');

let env = {};
try {
  env = require('../../config/env');
} catch (_) {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickWebhookBase() {
  return (
    env.BITRIX_WEBHOOK_BASE ||
    env.BITRIX_WEBHOOK_URL ||
    env.B24_WEBHOOK_URL ||
    process.env.BITRIX_WEBHOOK_BASE ||
    process.env.BITRIX_WEBHOOK_URL ||
    process.env.B24_WEBHOOK_URL ||
    process.env.B24_WEBHOOK ||
    process.env.BITRIX_WEBHOOK ||
    ''
  );
}

function normalizeBaseUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function methodToJson(method) {
  const m = String(method || '').trim();
  if (!m) return m;
  return m.endsWith('.json') ? m : `${m}.json`;
}

function shouldRetry(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status === 503) return true;
  if (status === 502 || status === 504) return true;
  if (!status && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN')) return true;
  return false;
}

function buildError(err, method) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = err?.message || String(err);

  const bErr = data?.error || data?.ERROR || null;
  const bDesc = data?.error_description || data?.ERROR_DESCRIPTION || null;

  const extra = [];
  if (status) extra.push(`status=${status}`);
  if (bErr) extra.push(`bitrix_error=${bErr}`);
  if (bDesc) extra.push(`bitrix_desc=${bDesc}`);

  const e = new Error(`[bitrix:${method}] ${msg}${extra.length ? ' (' + extra.join(', ') + ')' : ''}`);
  e.status = status;
  e.data = data;
  e.method = method;
  return e;
}

/** -------- logging helpers -------- */
function nowIso() {
  return new Date().toISOString();
}

function genReqId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return crypto.randomBytes(16).toString('hex');
  }
}

function maskWebhookBase(base) {
  // .../rest/1/<token> -> .../rest/1/<****last4>
  const s = String(base || '');
  return s.replace(/(\/rest\/\d+\/)([^/]+)/, (m, p1, token) => {
    const t = String(token || '');
    const tail = t.slice(-4);
    return `${p1}****${tail}`;
  });
}

// редактируем большие base64 и токены в логах
function sanitize(val, depth = 0) {
  const MAX_DEPTH = 6;
  const MAX_STR = Number(process.env.BITRIX_LOG_MAX_STR || 180);
  if (depth > MAX_DEPTH) return '<max-depth>';

  if (val === null || val === undefined) return val;

  if (typeof val === 'string') {
    if (val.length > MAX_STR) return `<str len=${val.length}>`;
    // маскируем токен внутри urlMachine/rest, если вдруг попал
    return val.replace(/(\/rest\/\d+\/)([^/]+)/g, (m, p1, token) => `${p1}****${String(token).slice(-4)}`);
  }

  if (typeof val === 'number' || typeof val === 'boolean') return val;

  if (Array.isArray(val)) {
    // частый кейс файла: ["name.pdf", "<base64...>"]
    if (val.length === 2 && typeof val[0] === 'string' && typeof val[1] === 'string') {
      const name = val[0];
      const b64 = val[1];
      const out = [name, b64.length > 80 ? `<base64 len=${b64.length}>` : b64];
      return out;
    }
    return val.map((v) => sanitize(v, depth + 1));
  }

  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitize(v, depth + 1);
    return out;
  }

  return String(val);
}

function approxBytes(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj), 'utf8');
  } catch (_) {
    return -1;
  }
}

function logJson(level, event, payload) {
  const line = JSON.stringify({ ts: nowIso(), level, event, ...payload });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** -------- form-url-encoding (важно для UF "Файл") -------- */
function addPairs(out, key, val) {
  if (val === undefined || val === null) return;

  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      addPairs(out, `${key}[${i}]`, val[i]);
    }
    return;
  }

  if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      addPairs(out, `${key}[${k}]`, v);
    }
    return;
  }

  out.push([key, String(val)]);
}

function toUrlEncoded(params) {
  const pairs = [];
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      addPairs(pairs, k, v);
    }
  }
  const usp = new URLSearchParams();
  for (const [k, v] of pairs) usp.append(k, v);
  return usp;
}

async function call(method, params = {}) {
  const base = normalizeBaseUrl(pickWebhookBase());
  if (!base) throw new Error('BITRIX_WEBHOOK_BASE is empty');

  const m = methodToJson(method);
  const url = `${base}/${m}`;

  const maxRetries = Number(process.env.BITRIX_RETRY_MAX || 6);
  const timeoutMs = Number(process.env.BITRIX_TIMEOUT_MS || 60000);

  const reqId = genReqId();
  const safeParams = sanitize(params);
  logJson('debug', 'BITRIX_CALL_START', {
    reqId,
    method,
    url_base: maskWebhookBase(base),
    params: safeParams,
    paramsApproxBytes: approxBytes(safeParams),
  });

  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    try {
      const data = toUrlEncoded(params);

      const resp = await axios.post(url, data, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true, // сами проверим статус/ошибки
      });

      const ms = Date.now() - t0;

      const status = resp?.status;
      const body = resp?.data;

      logJson('debug', 'BITRIX_CALL_HTTP', {
        reqId,
        method,
        attempt,
        ms,
        status,
        headers: process.env.BITRIX_LOG_HEADERS === '1' ? sanitize(resp?.headers || {}) : undefined,
        body: process.env.BITRIX_LOG_BODY === '1' ? sanitize(body) : undefined,
      });

      // Bitrix может вернуть 200, но с error/error_description
      if (body?.error || body?.ERROR) {
        const e = new Error(`[bitrix:${method}] bitrix_error_in_body`);
        e.status = status;
        e.data = body;
        throw e;
      }

      if (status < 200 || status >= 300) {
        const e = new Error(`[bitrix:${method}] http_status_${status}`);
        e.status = status;
        e.data = body;
        throw e;
      }

      logJson('debug', 'BITRIX_CALL_OK', {
        reqId,
        method,
        attempt,
        ms,
        status,
        keys: body ? Object.keys(body) : [],
      });

      return body?.result !== undefined ? body.result : body;
    } catch (err) {
      const ms = Date.now() - t0;
      lastErr = err;

      // логируем ошибку всегда
      logJson('error', 'BITRIX_CALL_ERR', {
        reqId,
        method,
        attempt,
        ms,
        code: err?.code,
        status: err?.status || err?.response?.status,
        message: err?.message,
        data: sanitize(err?.data || err?.response?.data),
      });

      // ретраи только на сетевые/лимиты
      if (!shouldRetry(err) || attempt === maxRetries) {
        throw buildError(err, method);
      }

      const baseDelay = Math.min(30000, 1000 * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 400);
      await sleep(baseDelay + jitter);
    }
  }

  throw buildError(lastErr, method);
}

module.exports = { call };
