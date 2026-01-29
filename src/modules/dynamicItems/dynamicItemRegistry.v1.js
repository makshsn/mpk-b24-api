'use strict';

const { syncSpa1048Item } = require('../spa1048/spa1048Sync.v2');
const { recalcRemainingForItem, FIELDS } = require('../spa1048/spa1048RemainingToPay');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// UF_CRM_8_1769511446943 -> ufCrm8_1769511446943 (локально, чтобы не тащить лишние зависимости)
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
    if (i === 1) { out += p.charAt(0).toUpperCase() + p.slice(1); continue; }
    if (/^\d+$/.test(p) && i === 2) { out += p; continue; }
    out += '_' + p;
  }
  return out;
}

const SPA1048_ENTITY_TYPE_ID = toNum(process.env.SPA1048_ENTITY_TYPE_ID || 1048);

// что считаем “изменением оплаты”
const PAID_KEY_UPPER = FIELDS.FIELD_PAID;                 // UF_CRM_8_1769511446943
const PAID_KEY_CAMEL = ufToCamel(FIELDS.FIELD_PAID);      // ufCrm8_1769511446943

function hasPaidChanged(diff) {
  const keys = diff?.changedKeys || [];
  return keys.includes(PAID_KEY_CAMEL) || keys.includes(PAID_KEY_UPPER);
}

function buildRegistry() {
  const map = new Map();

  // SPA 1048 ("Счета")
  map.set(SPA1048_ENTITY_TYPE_ID, async (ctx) => {
    const itemId = toNum(ctx?.itemId);
    if (!itemId) return { ok: true, action: 'skip_no_itemId' };

    // 1) основной sync (как у тебя сейчас)
    const syncRes = await syncSpa1048Item({ itemId, debug: false });

    // 2) точечный пересчёт остатка к оплате — ТОЛЬКО если изменилось поле paid
    if (hasPaidChanged(ctx?.diff)) {
      const remainRes = await recalcRemainingForItem({ itemId, entityTypeId: ctx.entityTypeId });
      return { ok: true, action: 'spa1048_sync_and_recalc_remaining', sync: syncRes, remaining: remainRes };
    }

    return { ok: true, action: 'spa1048_sync', result: syncRes };
  });

  return map;
}

module.exports = { buildRegistry, SPA1048_ENTITY_TYPE_ID };
