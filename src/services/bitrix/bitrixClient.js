const axios = require('axios');

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
  if (status === 429) return true;                // Too Many Requests
  if (status === 503) return true;                // Service Unavailable
  if (status === 502 || status === 504) return true;
  if (!status && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN')) return true;
  return false;
}

function buildError(err, method) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = err?.message || String(err);

  // Bitrix иногда шлёт {error, error_description}
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

async function call(method, params = {}) {
  const base = normalizeBaseUrl(pickWebhookBase());
  if (!base) throw new Error('BITRIX_WEBHOOK_BASE is empty');

  const m = methodToJson(method);
  const url = `${base}/${m}`;

  const maxRetries = Number(process.env.BITRIX_RETRY_MAX || 6); // 0..6
  const timeoutMs = Number(process.env.BITRIX_TIMEOUT_MS || 30000);

  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.post(url, params, { timeout: timeoutMs });
      // Bitrix обычно возвращает {result: ...}
      return resp?.data?.result !== undefined ? resp.data.result : resp.data;
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err) || attempt === maxRetries) {
        throw buildError(err, method);
      }

      // backoff: 1s, 2s, 4s, 8s... + небольшой джиттер
      const baseDelay = Math.min(30000, 1000 * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 400);
      await sleep(baseDelay + jitter);
    }
  }

  throw buildError(lastErr, method);
}

module.exports = { call };
