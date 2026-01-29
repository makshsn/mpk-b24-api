'use strict';

const axios = require('axios');
const { setInstall } = require('./tokenStore');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function toUrlEncoded(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    usp.append(k, String(v));
  }
  return usp;
}

/**
 * Refresh access token using refresh_token.
 * Bitrix24 uses oauth endpoint, typically https://oauth.bitrix.info/oauth/token/
 */
async function refreshToken(install) {
  const clientId = mustEnv('B24_OAUTH_CLIENT_ID');
  const clientSecret = mustEnv('B24_OAUTH_CLIENT_SECRET');

  const authEndpoint = normalizeUrl(
    install?.authEndpoint ||
    process.env.B24_OAUTH_AUTH_ENDPOINT ||
    'https://oauth.bitrix.info/oauth/token/'
  );

  const refreshTokenVal = install?.refreshToken;
  if (!refreshTokenVal) throw new Error('No refreshToken in install store');

  const params = {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshTokenVal,
  };

  const resp = await axios.post(authEndpoint, toUrlEncoded(params), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: Number(process.env.B24_OAUTH_TIMEOUT_MS || 30000),
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const e = new Error(`OAuth refresh http ${resp.status}`);
    e.data = resp.data;
    throw e;
  }

  const data = resp.data || {};
  if (data.error) {
    const e = new Error(`OAuth refresh error: ${data.error}`);
    e.data = data;
    throw e;
  }

  const accessToken = data.access_token;
  const refreshTokenNew = data.refresh_token || refreshTokenVal;
  const expiresIn = Number(data.expires_in || 0);

  if (!accessToken || !expiresIn) {
    const e = new Error('OAuth refresh: invalid response (missing access_token/expires_in)');
    e.data = data;
    throw e;
  }

  const expiresAt = Date.now() + expiresIn * 1000;

  const next = setInstall({
    accessToken,
    refreshToken: refreshTokenNew,
    expiresAt,
    updatedAt: new Date().toISOString(),
  });

  return next;
}

/**
 * Exchange authorization code for tokens (fallback flow).
 * Requires redirect_uri (should match app settings).
 */
async function exchangeCode(code, portalDomain = null) {
  const clientId = mustEnv('B24_OAUTH_CLIENT_ID');
  const clientSecret = mustEnv('B24_OAUTH_CLIENT_SECRET');

  const authEndpoint = normalizeUrl(
    process.env.B24_OAUTH_AUTH_ENDPOINT || 'https://oauth.bitrix.info/oauth/token/'
  );

  const redirectUri = String(process.env.B24_OAUTH_REDIRECT_URI || '').trim();
  if (!redirectUri) throw new Error('Missing env var: B24_OAUTH_REDIRECT_URI (required for code exchange)');

  const params = {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: String(code || '').trim(),
    redirect_uri: redirectUri,
  };

  const resp = await axios.post(authEndpoint, toUrlEncoded(params), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: Number(process.env.B24_OAUTH_TIMEOUT_MS || 30000),
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const e = new Error(`OAuth code exchange http ${resp.status}`);
    e.data = resp.data;
    throw e;
  }

  const data = resp.data || {};
  if (data.error) {
    const e = new Error(`OAuth code exchange error: ${data.error}`);
    e.data = data;
    throw e;
  }

  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = Number(data.expires_in || 0);

  if (!accessToken || !refreshToken || !expiresIn) {
    const e = new Error('OAuth code exchange: invalid response (missing tokens/expires_in)');
    e.data = data;
    throw e;
  }

  const expiresAt = Date.now() + expiresIn * 1000;

  const restEndpoint =
    String(data.client_endpoint || data.server_endpoint || '').trim() ||
    (portalDomain ? `https://${portalDomain}/rest` : '');

  return {
    accessToken,
    refreshToken,
    expiresAt,
    restEndpoint: restEndpoint || null,
    authEndpoint,
    raw: data,
  };
}

module.exports = { refreshToken, exchangeCode };
