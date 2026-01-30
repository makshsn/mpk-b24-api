'use strict';

const { call } = require('./restClient');

function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function buildHandlerUrl() {
  const base = normalizeUrl(mustEnv('B24_OAUTH_PUBLIC_BASE_URL'));
  return `${base}/b24/oauth/event`;
}

// Универсальные события по Смарт-процессам (SPA / dynamic items)
// Документация: Events of Custom CRM Types (ONCRMDYNAMICITEMADD/UPDATE/DELETE)
// https://apidocs.bitrix24.com/api-reference/crm/universal/events/index.html
const DYNAMIC_ITEM_EVENTS = [
  'ONCRMDYNAMICITEMADD',
  'ONCRMDYNAMICITEMUPDATE',
  'ONCRMDYNAMICITEMDELETE',
];

// События по сделкам
// Документация: Events When Working with Deals
// https://apidocs.bitrix24.com/api-reference/crm/deals/events/index.html
const DEAL_EVENTS = [
  'ONCRMDEALUPDATE',
];

async function bindEvent(event, handler, event_type = 'online') {
  return await call(
    'event.bind',
    { event, handler, event_type },
    { ctx: { step: 'event.bind', event } }
  );
}

async function unbindEvent(event, handler) {
  return await call(
    'event.unbind',
    { event, handler },
    { ctx: { step: 'event.unbind', event } }
  );
}

async function bindDynamicItemEvents(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();

  const results = [];
  for (const ev of DYNAMIC_ITEM_EVENTS) {
    const r = await bindEvent(ev, handler, 'online');
    results.push({ event: ev, result: r });
  }

  return { ok: true, handler, bound: results };
}

async function unbindDynamicItemEvents(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();

  const results = [];
  for (const ev of DYNAMIC_ITEM_EVENTS) {
    try {
      const r = await unbindEvent(ev, handler);
      results.push({ event: ev, result: r, ok: true });
    } catch (e) {
      // event.unbind может кидать ошибку, если привязки нет — это не фатально
      results.push({
        event: ev,
        ok: false,
        error: e?.message || String(e),
        data: e?.data,
      });
    }
  }

  return { ok: true, handler, unbound: results };
}

async function bindDealEvents(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();

  const results = [];
  for (const ev of DEAL_EVENTS) {
    const r = await bindEvent(ev, handler, 'online');
    results.push({ event: ev, result: r });
  }

  return { ok: true, handler, bound: results };
}

async function unbindDealEvents(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();

  const results = [];
  for (const ev of DEAL_EVENTS) {
    try {
      const r = await unbindEvent(ev, handler);
      results.push({ event: ev, result: r, ok: true });
    } catch (e) {
      results.push({
        event: ev,
        ok: false,
        error: e?.message || String(e),
        data: e?.data,
      });
    }
  }

  return { ok: true, handler, unbound: results };
}

// Backward compatibility (старые имена)
async function bindDynamicItemUpdate(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();
  return await bindEvent('ONCRMDYNAMICITEMUPDATE', handler, 'online');
}

async function unbindDynamicItemUpdate(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();
  return await unbindEvent('ONCRMDYNAMICITEMUPDATE', handler);
}

async function appInfo() {
  return await call('app.info', {}, { ctx: { step: 'app.info' } });
}

module.exports = {
  DYNAMIC_ITEM_EVENTS,
  DEAL_EVENTS,
  bindDynamicItemEvents,
  unbindDynamicItemEvents,
  bindDealEvents,
  unbindDealEvents,
  bindDynamicItemUpdate,
  unbindDynamicItemUpdate,
  appInfo,
  buildHandlerUrl,
};
