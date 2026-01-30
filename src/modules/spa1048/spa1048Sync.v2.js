'use strict';

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { normalizeSpaFiles } = require('./spa1048Files.v1');

/**
 * LEGACY sync endpoint (/b24/spa-event)
 *
 * IMPORTANT:
 * Старый функционал постановки/обновления задач здесь УДАЛЁН.
 * Задачи на оплату теперь обслуживаются ТОЛЬКО обработчиком OAuth событий
 * (ONCRMDYNAMICITEMADD/ONCRMDYNAMICITEMUPDATE) в spa1048OAuthTaskFlow.v1.
 *
 * Этот модуль оставлен как "безопасный" ручной/входящий ресинк для SPA,
 * который НЕ трогает задачи и НЕ имеет сайд-эффектов.
 */

function toNum(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(x) {
  if (!x) return null;
  return String(x).slice(0, 10);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdFromDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function computeDefaultDeadlineYmd(now = new Date()) {
  const day = now.getDate();
  if (day < 25) return ymdFromDate(new Date(now.getFullYear(), now.getMonth(), 25));
  return ymdFromDate(new Date(now.getFullYear(), now.getMonth() + 1, 25));
}

function isLegacySpaEventEnabled() {
  const v = String(process.env.SPA1048_LEGACY_SPA_EVENT_ENABLED ?? '0').trim();
  return v === '1' || v.toUpperCase() === 'Y' || v.toUpperCase() === 'YES';
}

function isLegacyFilesSyncEnabled() {
  const v = String(process.env.SPA1048_LEGACY_FILES_SYNC_ENABLED ?? '0').trim();
  return v === '1' || v.toUpperCase() === 'Y' || v.toUpperCase() === 'YES';
}

// ---- simple in-process lock to avoid burst processing ----
const itemLocks = new Map();
async function withItemLock(itemId, fn) {
  const key = String(itemId);
  if (itemLocks.has(key)) return await itemLocks.get(key);
  const p = (async () => {
    try { return await fn(); }
    finally { itemLocks.delete(key); }
  })();
  itemLocks.set(key, p);
  return await p;
}

async function getSpaItem({ entityTypeId, itemId }) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    select: ['*'],
  }, { ctx: { step: 'spa1048_legacy_crm_item_get', itemId: Number(itemId), entityTypeId: Number(entityTypeId) } });

  return r?.item || r?.result?.item || r?.result || r;
}

async function ensureSpaDeadline({ entityTypeId, itemId, item }) {
  const deadlineOrig = String(cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const deadlineCamel = String(cfg.deadlineFieldCamel || 'ufCrm8_1768219591855');
  const current = dateOnly(item?.[deadlineCamel] ?? item?.[deadlineOrig] ?? null);

  if (current) return { ok: true, action: 'deadline_ok', deadline: current };

  const ymd = computeDefaultDeadlineYmd();
  try {
    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [deadlineOrig]: ymd },
    }, { ctx: { step: 'spa1048_legacy_deadline_set_default', itemId: Number(itemId), deadline: ymd } });
    return { ok: true, action: 'deadline_set_default', deadline: ymd };
  } catch (e) {
    return { ok: false, action: 'deadline_set_error', error: e?.message || String(e) };
  }
}

async function syncSpa1048Item({ itemId, debug = false }) {
  const entityTypeId = toNum(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);
  const id = toNum(itemId);
  if (!id) return { ok: false, error: 'invalid_itemId' };

  const item = await getSpaItem({ entityTypeId, itemId: id });
  if (!item?.id) return { ok: false, error: 'spa_not_found', itemId: id };

  const deadlineRes = await ensureSpaDeadline({ entityTypeId, itemId: id, item });

  let files = { ok: true, action: 'skipped', reason: 'legacy_files_sync_disabled' };
  if (isLegacyFilesSyncEnabled()) {
    try {
      const r = await normalizeSpaFiles({ entityTypeId, itemId: id });
      const fileNames = Array.isArray(r?.fileNames) ? r.fileNames : [];
      files = { ok: true, action: 'files_normalized', fileCount: fileNames.length };
      if (debug) files.debug = { fileNames };
    } catch (e) {
      files = { ok: false, action: 'files_error', error: e?.message || String(e) };
    }
  }

  return {
    ok: true,
    action: 'legacy_sync_ok',
    itemId: id,
    entityTypeId,
    deadline: deadlineRes,
    files,
  };
}

function extractItemIdFromReq(req) {
  const q = req?.query || {};
  const b = req?.body || {};

  const raw = (
    q.itemId ??
    q.id ??
    b?.data?.FIELDS?.ID ??
    b?.data?.FIELDS?.id ??
    b?.FIELDS?.ID ??
    b?.FIELDS?.id ??
    b?.itemId ??
    b?.id
  );

  const n = toNum(raw);
  return n > 0 ? n : 0;
}

async function handleSpaEvent(req, res) {
  // По умолчанию выключено — чтобы не было старых сайд-эффектов.
  if (!isLegacySpaEventEnabled()) {
    const itemId = extractItemIdFromReq(req);
    return res.json({
      ok: true,
      action: 'legacy_spa_event_disabled',
      itemId: itemId || null,
      hint: 'Enable via SPA1048_LEGACY_SPA_EVENT_ENABLED=1 if you really need legacy endpoint.',
    });
  }

  try {
    const b = req.body || {};
    const q = req.query || {};

    const itemId = extractItemIdFromReq(req);
    if (!itemId) return res.status(400).json({ ok: false, error: 'invalid_itemId' });

    const debug = String(q.debug ?? b.debug ?? '0') === '1';
    const result = await withItemLock(itemId, async () => {
      return await syncSpa1048Item({ itemId, debug });
    });

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

module.exports = { handleSpaEvent, syncSpa1048Item, withItemLock };
