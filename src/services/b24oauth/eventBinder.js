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

async function bindDynamicItemUpdate(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();
  return await call('event.bind', {
    event: 'ONCRMDYNAMICITEMUPDATE',
    handler,
    event_type: 'online',
  }, { ctx: { step: 'event.bind', event: 'ONCRMDYNAMICITEMUPDATE' } });
}

async function unbindDynamicItemUpdate(handlerUrl = null) {
  const handler = handlerUrl || buildHandlerUrl();
  return await call('event.unbind', {
    event: 'ONCRMDYNAMICITEMUPDATE',
    handler,
  }, { ctx: { step: 'event.unbind', event: 'ONCRMDYNAMICITEMUPDATE' } });
}

async function appInfo() {
  return await call('app.info', {}, { ctx: { step: 'app.info' } });
}

module.exports = {
  bindDynamicItemUpdate,
  unbindDynamicItemUpdate,
  appInfo,
  buildHandlerUrl,
};
