'use strict';

const { getLogger } = require('../../services/logging');
const logger = getLogger('deal-events');

const bitrix = require('../../services/bitrix/bitrixClient');

const { normalizeItemForSnapshot, buildDiff } = require('../dynamicItems/diff.v1');
const { readSnapshot, writeSnapshot } = require('./dealSnapshotStore.v1');
const { handleDealFileFieldChanges } = require('./dealProductionFilesWatcher.v1');

// ---- in-process per-deal queue (не теряем события) ----
const queues = new Map();
async function withDealQueue(key, fn) {
  const k = String(key);
  const prev = queues.get(k) || Promise.resolve();

  const next = prev
    .catch(() => null)
    .then(() => fn())
    .finally(() => {
      if (queues.get(k) === next) queues.delete(k);
    });

  queues.set(k, next);
  return await next;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function fetchDeal(dealId) {
  const id = toNum(dealId);
  if (!id) return null;

  const r = await bitrix.call('crm.deal.get', { id }, { ctx: { step: 'crm.deal.get', dealId: id } });
  return r || null;
}

async function processOne(payload) {
  const event = String(payload?.event || '').trim().toUpperCase();
  const dealId = toNum(payload?.itemId || payload?.raw?.data?.FIELDS?.ID || payload?.raw?.data?.FIELDS?.id);

  if (!dealId) {
    return { ok: true, action: 'skip_missing_deal_id', event };
  }

  const lockKey = `deal:${dealId}`;
  return await withDealQueue(lockKey, async () => {
    let deal;
    try {
      deal = await fetchDeal(dealId);
    } catch (e) {
      logger.error({ dealId, event, err: e?.message || String(e), data: e?.data }, '[deal-events] crm.deal.get failed');
      return { ok: false, action: 'crm_deal_get_failed', dealId, event, error: e?.message || String(e) };
    }

    const nextSnap = {
      fetchedAt: new Date().toISOString(),
      item: normalizeItemForSnapshot(deal),
    };

    const prevSnap = readSnapshot(dealId);
    const diff = buildDiff(prevSnap, nextSnap, {
      stageKey: 'STAGE_ID',
      // чтобы шум от системных полей не мешал, но при этом UF поля ловились
      ignoreKeys: ['DATE_MODIFY', 'DATE_CREATE', 'MODIFY_BY_ID', 'CREATED_BY_ID'],
      onlyKeys: [
        'CATEGORY_ID',
        String(process.env.DEAL_LEAD_CONSTRUCTOR_FIELD || 'UF_CRM_1752671444').trim(),
        String(process.env.DEAL_SPEC_FILE_FIELD || 'UF_CRM_6877639A49D78').trim(),
        String(process.env.DEAL_CALC_FILE_FIELD || 'UF_CRM_687A05AF2793F').trim(),
      ].filter(Boolean),
    });

    // snapshot пишем всегда, ДО обработчика
    try {
      writeSnapshot(dealId, nextSnap);
    } catch (e) {
      logger.warn({ dealId, err: e?.message || String(e) }, '[deal-events] snapshot write failed');
    }

    // первый снимок — не уведомляем, чтобы не спамить при установке/первом событии
    if (!prevSnap) {
      return { ok: true, action: 'snapshot_init', dealId, event };
    }

    if (!diff?.fieldChanged) {
      return { ok: true, action: 'skip_no_changes', dealId, event };
    }

    try {
      const r = await handleDealFileFieldChanges({ deal, prevSnapshot: prevSnap, nextSnapshot: nextSnap, diff });
      logger.info({ dealId, event, changedKeys: diff.changedKeys, res: r?.action }, '[deal-events] processed');
      return { ok: true, action: 'handled', dealId, event, diff, handlerResult: r };
    } catch (e) {
      logger.error({ dealId, event, err: e?.message || String(e), data: e?.data }, '[deal-events] handler failed');
      return { ok: false, action: 'handler_failed', dealId, event, error: e?.message || String(e), diff };
    }
  });
}

function enqueueDealEvent(payload) {
  const enabled = String(process.env.DEAL_EVENT_PROCESSOR_ENABLED || '1').trim();
  if (enabled === '0') return { ok: true, action: 'disabled' };

  setImmediate(() => {
    processOne(payload)
      .then((r) => logger.debug({ r }, '[deal-events] done'))
      .catch((e) => logger.error({ err: e?.message || String(e) }, '[deal-events] fatal'));
  });

  return { ok: true, action: 'enqueued' };
}

module.exports = {
  enqueueDealEvent,
  processOne,
};
