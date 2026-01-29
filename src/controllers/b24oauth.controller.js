'use strict';

const { getLogger } = require('../services/logging');
const log = getLogger('b24oauth');

const { getInstall, setInstall, publicStatus } = require('../services/b24oauth/tokenStore');
const { exchangeCode } = require('../services/b24oauth/oauthApi');
const {
  DYNAMIC_ITEM_EVENTS,
  bindDynamicItemEvents,
  unbindDynamicItemEvents,
  appInfo,
  buildHandlerUrl,
} = require('../services/b24oauth/eventBinder');
const { normalizeEventPayload } = require('../services/b24oauth/eventPayload');
const { call } = require('../services/b24oauth/restClient');
const { enqueueDynamicItemEvent } = require('../modules/dynamicItems/dynamicItemEventProcessor.v1');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizePortal(d) {
  const s = String(d || '').trim().toLowerCase();
  return s.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s : `${s}/`;
}

function tryExtractDomainFromEndpoint(endpoint) {
  try {
    const s = String(endpoint || '').trim();
    if (!s) return null;
    const url = s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`;
    const u = new URL(url);
    return normalizePortal(u.hostname);
  } catch (_) {
    return null;
  }
}

function deriveDomainFromPayload({ auth, body, query }) {
  const candidates = [
    auth?.domain, auth?.DOMAIN,
    body?.domain, body?.DOMAIN,
    query?.domain, query?.DOMAIN,
  ];

  for (const c of candidates) {
    const d = normalizePortal(c);
    if (d) return d;
  }

  const endpoints = [
    auth?.client_endpoint, auth?.CLIENT_ENDPOINT,
    auth?.server_endpoint, auth?.SERVER_ENDPOINT,
    auth?.rest_endpoint, auth?.REST_ENDPOINT,
    body?.client_endpoint, body?.CLIENT_ENDPOINT,
    body?.server_endpoint, body?.SERVER_ENDPOINT,
  ];

  for (const ep of endpoints) {
    const d = tryExtractDomainFromEndpoint(ep);
    if (d) return d;
  }

  return null;
}

function pickFirst(sources, keys) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const v = src[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
  }
  return null;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isBadRestEndpoint(endpoint) {
  const s = String(endpoint || '').trim().toLowerCase();
  if (!s) return true;
  return s.includes('oauth.bitrix24.tech');
}

function pickPortalRestEndpoint(portalDomain, appInfoResult, fallbackFromAuth) {
  const clientEndpoint =
    appInfoResult?.install?.client_endpoint ||
    appInfoResult?.install?.CLIENT_ENDPOINT ||
    null;

  if (clientEndpoint && !isBadRestEndpoint(clientEndpoint)) {
    return normalizeUrl(clientEndpoint);
  }

  if (fallbackFromAuth && !isBadRestEndpoint(fallbackFromAuth)) {
    return normalizeUrl(fallbackFromAuth);
  }

  return normalizeUrl(`https://${portalDomain}/rest/`);
}

async function install(req, res, next) {
  try {
    const portalExpected = normalizePortal(mustEnv('B24_OAUTH_PORTAL'));

    const auth = req.body?.auth || req.body?.AUTH || null;
    const body = req.body || {};
    const query = req.query || {};
    const cur = getInstall() || {};

    const domain = deriveDomainFromPayload({ auth, body, query });

    const memberId = String(
      pickFirst([auth, body, query], ['member_id', 'MEMBER_ID', 'member', 'MEMBER']) || ''
    ).trim();

    if (!domain && !memberId) {
      return res.status(400).json({
        ok: false,
        error: 'not_install_call',
        hint: 'Этот endpoint должен вызываться Битриксом при установке/переустановке локального приложения.',
        expectedPortal: portalExpected,
      });
    }

    if (!domain || domain !== portalExpected) {
      log.warn({
        msg: 'portal_mismatch_on_install',
        expected: portalExpected,
        got: domain,
        contentType: req.headers?.['content-type'] || null,
        bodyKeys: Object.keys(body),
        authKeys: auth ? Object.keys(auth) : [],
        query,
      });
      return res.status(403).json({
        ok: false,
        error: 'portal_mismatch',
        expected: portalExpected,
        got: domain || null,
      });
    }

    if (!memberId) {
      return res.status(400).json({ ok: false, error: 'missing_member_id' });
    }

    // Локальные приложения часто шлют AUTH_ID/REFRESH_ID
    let accessToken = String(
      pickFirst([auth, body, query], ['access_token', 'ACCESS_TOKEN', 'AUTH_ID', 'auth_id', 'AUTHID']) || ''
    ).trim();

    let refreshToken = String(
      pickFirst([auth, body, query], ['refresh_token', 'REFRESH_TOKEN', 'REFRESH_ID', 'refresh_id']) || ''
    ).trim();

    const expiresIn = toNum(
      pickFirst([auth, body, query], ['expires_in', 'EXPIRES_IN', 'AUTH_EXPIRES', 'auth_expires'])
    );

    const applicationToken = String(
      pickFirst([auth, body, query], ['application_token', 'APPLICATION_TOKEN']) || ''
    ).trim();

    // Fallback через code (если вдруг будет приходить)
    const code = String(pickFirst([body, query], ['code', 'CODE']) || '').trim();
    if ((!accessToken || !refreshToken) && code) {
      const exchanged = await exchangeCode(code, portalExpected);
      accessToken = exchanged.accessToken || accessToken;
      refreshToken = exchanged.refreshToken || refreshToken;
    }

    const refreshTokenFinal = refreshToken || cur.refreshToken || null;
    if (!refreshTokenFinal) {
      return res.status(400).json({
        ok: false,
        error: 'missing_refresh_token',
        hint: 'Bitrix24 не прислал refresh_token/REFRESH_ID и в хранилище его ещё нет.',
      });
    }

    const expiresAt = expiresIn ? (Date.now() + expiresIn * 1000) : (cur.expiresAt || 0);

    const authEndpoint = String(
      pickFirst([auth, body], ['auth_endpoint', 'AUTH_ENDPOINT'])
      || cur.authEndpoint
      || String(process.env.B24_OAUTH_AUTH_ENDPOINT || 'https://oauth.bitrix.info/oauth/token/').trim()
    ).trim();

    // Сохраняем токены, чтобы app.info точно работал
    let stored = setInstall({
      installedAt: cur.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      portal: portalExpected,
      memberId,
      applicationToken: applicationToken || cur.applicationToken || null,
      accessToken: accessToken || cur.accessToken || null,
      refreshToken: refreshTokenFinal,
      expiresAt,
      restEndpoint: cur.restEndpoint || null,
      authEndpoint,
    });

    // Smoke test
    let info = null;
    try { info = await appInfo(); } catch (e) { info = { ok: false, error: e.message, data: e.data }; }

    const fallbackClientEndpoint = String(
      pickFirst([auth, body], ['client_endpoint', 'CLIENT_ENDPOINT', 'server_endpoint', 'SERVER_ENDPOINT']) || ''
    ).trim();

    const normalizedRestEndpoint = pickPortalRestEndpoint(portalExpected, info, fallbackClientEndpoint);

    stored = setInstall({
      restEndpoint: normalizedRestEndpoint,
      updatedAt: new Date().toISOString(),
    });

    // Bind events (SPA / dynamic items)
    let unbindRes = null;
    let bindRes = null;
    const handlerUrl = buildHandlerUrl();

    try { unbindRes = await unbindDynamicItemEvents(handlerUrl); }
    catch (e) { unbindRes = { ok: false, error: e.message, data: e.data }; }

    try { bindRes = await bindDynamicItemEvents(handlerUrl); }
    catch (e) { bindRes = { ok: false, error: e.message, data: e.data }; }

    log.info(
      { portal: portalExpected, memberId, handlerUrl, restEndpoint: normalizedRestEndpoint, bindRes },
      '[b24oauth] installed/bound'
    );

    return res.json({
      ok: true,
      action: 'installed',
      handlerUrl,
      status: publicStatus(stored),
      appInfo: info,
      unbind: unbindRes,
      bind: bindRes,
    });
  } catch (e) {
    return next(e);
  }
}

async function event(req, res, next) {
  try {
    const portalExpected = normalizePortal(mustEnv('B24_OAUTH_PORTAL'));
    const payload = normalizeEventPayload(req.body || {});
    const installData = getInstall();

    const domain = normalizePortal(payload.domain);
    if (domain && domain !== portalExpected) {
      return res.status(403).json({ ok: false, error: 'portal_mismatch', expected: portalExpected, got: domain });
    }

    if (installData?.applicationToken && payload.applicationToken && installData.applicationToken !== payload.applicationToken) {
      return res.status(403).json({ ok: false, error: 'bad_application_token' });
    }

    log.info({
      event: payload.event,
      entityTypeId: payload.entityTypeId,
      itemId: payload.itemId,
      memberId: payload.memberId,
      domain: payload.domain,
      rawKeys: Object.keys(req.body || {}),
    }, '[b24oauth] event received');

    const queued = enqueueDynamicItemEvent(payload);
    return res.json({ ok: true, queued });
  } catch (e) {
    return next(e);
  }
}

async function status(_req, res) {
  const installData = getInstall();
  return res.json({ ok: true, status: publicStatus(installData) });
}

/**
 * Debug endpoint: list event subscriptions from portal (event.get)
 * Работает только в контексте авторизации приложения. :contentReference[oaicite:1]{index=1}
 */
async function eventsList(_req, res, next) {
  try {
    const r = await call('event.get', {}, { ctx: { step: 'event.get' } });

    const items = Array.isArray(r) ? r : (r?.items || r?.events || r || []);
    const list = Array.isArray(items) ? items : [];

    const handlerUrl = buildHandlerUrl();
    const filtered = list.filter((x) => {
      const ev = String(x?.event || x?.EVENT || '').toUpperCase();
      const h = String(x?.handler || x?.HANDLER || '');
      return DYNAMIC_ITEM_EVENTS.includes(ev) && h === handlerUrl;
    });

    return res.json({
      ok: true,
      total: list.length,
      handlerUrl,
      matchDynamicItemEvents: filtered,
      events: list,
    });
  } catch (e) {
    return next(e);
  }
}

/**
 * Debug endpoint: force test event delivery (event.test)
 * Используется для проверки, что handler вообще способен принимать события. :contentReference[oaicite:2]{index=2}
 */
async function eventTest(_req, res, next) {
  try {
    const handlerUrl = buildHandlerUrl();

    // event.test триггерит тестовое событие доставки (если привязка есть)
    const r = await call('event.test', { event: 'ONCRMDYNAMICITEMUPDATE' }, { ctx: { step: 'event.test', handlerUrl } });

    return res.json({ ok: true, called: 'event.test', handlerUrl, result: r });
  } catch (e) {
    return next(e);
  }
}

module.exports = {
  install,
  event,
  status,
  eventsList,
  eventTest,
};
