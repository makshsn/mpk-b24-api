'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getInstall, isInstalled, isTokenExpired } = require('./tokenStore');
const { refreshToken } = require('./oauthApi');
const { getLogger } = require('../logging');

const log = getLogger('b24oauth');

function methodToJson(method) {
  const m = String(method || '').trim();
  if (!m) return m;
  return m.endsWith('.json') ? m : `${m}.json`;
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function addPairs(out, key, val) {
  if (val === undefined || val === null) return;

  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) addPairs(out, `${key}[${i}]`, val[i]);
    return;
  }
  if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) addPairs(out, `${key}[${k}]`, v);
    return;
  }
  out.push([key, String(val)]);
}

function toUrlEncoded(params) {
  const pairs = [];
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) addPairs(pairs, k, v);
  }
  const usp = new URLSearchParams();
  for (const [k, v] of pairs) usp.append(k, v);
  return usp;
}

function genReqId() {
  try { return crypto.randomUUID(); }
  catch (_) { return crypto.randomBytes(16).toString('hex'); }
}

async function ensureAccess(install) {
  if (!isInstalled(install)) throw new Error('B24 OAuth app is not installed (no tokens in store)');
  if (!isTokenExpired(install)) return install;
  return await refreshToken(install);
}

/**
 * Call Bitrix24 REST method using OAuth access token.
 * Uses POST x-www-form-urlencoded and passes auth=<access_token>.
 */
async function call(method, params = {}, opts = {}) {
  const reqId = genReqId();
  const t0 = Date.now();

  let install = getInstall();
  install = await ensureAccess(install);

  const restEndpoint = normalizeUrl(
    install?.restEndpoint ||
    process.env.B24_OAUTH_REST_ENDPOINT ||
    `https://${process.env.B24_OAUTH_PORTAL}/rest`
  );

  const url = `${restEndpoint}/${methodToJson(method)}`;

  const payload = { ...params, auth: install.accessToken };
  const data = toUrlEncoded(payload);

  log.debug({ reqId, method, url, ctx: opts?.ctx }, '[b24oauth] call start');

  const resp = await axios.post(url, data, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: Number(process.env.B24_OAUTH_TIMEOUT_MS || 30000),
    validateStatus: () => true,
  });

  const ms = Date.now() - t0;

  if (resp.status < 200 || resp.status >= 300) {
    const e = new Error(`B24 REST http ${resp.status}`);
    e.status = resp.status;
    e.data = resp.data;
    e.ctx = opts?.ctx;
    log.error({ reqId, method, ms, status: resp.status, data: resp.data, ctx: opts?.ctx }, '[b24oauth] call failed');
    throw e;
  }

  const body = resp.data || {};
  if (body.error) {
    const e = new Error(`B24 REST error: ${body.error}`);
    e.data = body;
    e.ctx = opts?.ctx;
    log.error({ reqId, method, ms, error: body.error, desc: body.error_description, ctx: opts?.ctx }, '[b24oauth] call error');
    throw e;
  }

  log.debug({ reqId, method, ms, ctx: opts?.ctx }, '[b24oauth] call ok');

  return body.result !== undefined ? body.result : body;
}

module.exports = { call };
