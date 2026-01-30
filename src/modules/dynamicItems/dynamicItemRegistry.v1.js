'use strict';

const { getLogger } = require('../../services/logging');
const logDyn = getLogger('dynamic-items');

const { handleSpa1048OauthEvent } = require('../spa1048/spa1048OAuthTaskFlow.v1');
const { recalcRemainingForItem, FIELDS } = require('../spa1048/spa1048RemainingToPay');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// UF_CRM_8_176... -> ufCrm8_176...
function ufToCamel(uf) {
  const s = String(uf || '').trim();
  if (!s) return '';
  if (!/^UF_/i.test(s)) return s;

  const lower = s.toLowerCase();
  const parts = lower.split('_').filter(Boolean);
  if (!parts.length) return '';

  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === 1) {
      out += p.charAt(0).toUpperCase() + p.slice(1);
      continue;
    }
    if (/^\d+$/.test(p) && i === 2) {
      out += p;
      continue;
    }
    out += '_' + p;
  }
  return out;
}

const SPA1048_ENTITY_TYPE_ID = toNum(process.env.SPA1048_ENTITY_TYPE_ID || 1048);

const PAID_KEY_UPPER = String(FIELDS.FIELD_PAID || '').trim();
const PAID_KEY_CAMEL = ufToCamel(PAID_KEY_UPPER);

function hasPaidChanged(diff) {
  const keys = Array.isArray(diff?.changedKeys) ? diff.changedKeys : [];
  if (!keys.length) return false;
  return keys.includes(PAID_KEY_UPPER) || (PAID_KEY_CAMEL ? keys.includes(PAID_KEY_CAMEL) : false);
}

function buildRegistry() {
  const map = new Map();

  // SPA1048: задачи на оплату + точечный пересчёт остатка
  map.set(SPA1048_ENTITY_TYPE_ID, async (ctx) => {
    const entityTypeId = toNum(ctx?.entityTypeId || SPA1048_ENTITY_TYPE_ID);
    const itemId = toNum(ctx?.itemId);
    const event = String(ctx?.event || '').toUpperCase();

    if (!itemId) return { ok: true, action: 'skip_no_itemId', entityTypeId, event };

    // 1) Задачи по OAuth событиям (ADD/UPDATE)
    let oauth = null;
    try {
      oauth = await handleSpa1048OauthEvent(ctx);
    } catch (e) {
      oauth = { ok: false, action: 'oauth_handler_error', error: e?.message || String(e) };
      logDyn.error({ entityTypeId, itemId, event, err: oauth.error }, '[dynamic-items] spa1048 oauth handler failed');
    }

    // 2) Остаток к оплате — только по изменению "Оплачено" (внутренняя бизнес-логика)
    let remaining = null;
    try {
      if (hasPaidChanged(ctx?.diff)) {
        remaining = await recalcRemainingForItem({ itemId, entityTypeId });
      }
    } catch (e) {
      remaining = { ok: false, action: 'remaining_recalc_error', error: e?.message || String(e) };
      logDyn.error({ entityTypeId, itemId, event, err: remaining.error }, '[dynamic-items] remaining recalc failed');
    }

    // Диагностика: фиксируем ключевые исходы
    const oauthAction = String(oauth?.action || 'none');
    if (oauthAction && oauthAction !== 'skip_event_not_supported' && oauthAction !== 'skip_update_no_triggers') {
      logDyn.info({ entityTypeId, itemId, event, oauthAction, triggers: oauth?.triggers }, '[dynamic-items] spa1048 oauth result');
    }

    return {
      ok: true,
      action: 'spa1048_processed',
      entityTypeId,
      itemId,
      event,
      oauth,
      remaining,
    };
  });

  return map;
}

module.exports = {
  buildRegistry,
  SPA1048_ENTITY_TYPE_ID,
};
