'use strict';

const axios = require('axios');
const { getLogger } = require('../logging');
const logger = getLogger('bitrix');

function normalizeBaseUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s : `${s}/`;
}

async function callWithEnv(baseEnvName, method, params = {}, meta = {}) {
  const base = normalizeBaseUrl(process.env[baseEnvName]);

  if (!base) {
    const err = new Error(`Missing env ${baseEnvName}`);
    err.data = { baseEnvName, method, meta };
    throw err;
  }

  const url = `${base}${String(method).trim()}.json`;

  try {
    const res = await axios.post(url, params, { timeout: 60000 });
    const data = res?.data;

    if (data && data.error) {
      const e = new Error(data.error_description || data.error || 'bitrix_error');
      e.data = data;
      e.meta = meta;
      throw e;
    }

    return data?.result !== undefined ? data.result : data;
  } catch (e) {
    logger.error(
      {
        err: e?.message || String(e),
        data: e?.data,
        meta,
        method,
        url,
        baseEnvName,
      },
      '[bitrix] call failed'
    );
    throw e;
  }
}

const mainClient = {
  call(method, params = {}, meta = {}) {
    return callWithEnv('BITRIX_WEBHOOK_BASE', method, params, meta);
  },
};

const notifyClient = {
  call(method, params = {}, meta = {}) {
    return callWithEnv('BITRIX_NOTIFY_WEBHOOK_BASE', method, params, meta);
  },
};

module.exports = {
  // backward-compatible: старый код может использовать bitrix.call(...)
  call(method, params = {}, meta = {}) {
    return callWithEnv('BITRIX_WEBHOOK_BASE', method, params, meta);
  },

  // явные клиенты
  main: mainClient,
  notify: notifyClient,
};
