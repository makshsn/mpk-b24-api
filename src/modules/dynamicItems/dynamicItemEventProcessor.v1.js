'use strict';

const { getLogger } = require('../../services/logging');
const logger = getLogger('dynamic-items');

const bitrix = require('../../services/bitrix/bitrixClient');

const { normalizeItemForSnapshot, buildDiff } = require('./diff.v1');
const { readSnapshot, writeSnapshot } = require('./snapshotStore.v1');
const { buildRegistry } = require('./dynamicItemRegistry.v1');

// ---- in-process per-item queue: гарантия, что события НЕ теряются ----
// Старый "lock" склеивал события (второе событие возвращало тот же promise и не выполнялось).
// Здесь — настоящая очередь (promise chain) по ключу entityTypeId:itemId.
const queues = new Map();
async function withItemQueue(key, fn) {
  const k = String(key);

  const prev = queues.get(k) || Promise.resolve();

  // Важно: даже если prev упал — следующий fn всё равно должен выполниться.
  const next = prev
    .catch(() => null)
    .then(() => fn())
    .finally(() => {
      // чистим только если мы всё ещё последний хвост очереди
      if (queues.get(k) === next) queues.delete(k);
    });

  queues.set(k, next);
  return await next;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseEntityAllowList() {
  const raw = String(process.env.DYNAMIC_ITEM_WATCH_ENTITY_TYPE_IDS || '').trim();
  if (!raw) return null;
  const set = new Set(
    raw.split(',').map((s) => toNum(s.trim())).filter((n) => n > 0)
  );
  return set.size ? set : null;
}

const ALLOW_ENTITY_SET = parseEntityAllowList();
const REGISTRY = buildRegistry();

const IGNORE_KEYS_DEFAULT = [
  // системные поля, которые часто меняются и создают шум
  'updatedTime',
  'updatedBy',
  'lastActivityTime',
  'lastActivityBy',
  'movedTime',
  'movedBy',
  'createdTime',
  'createdBy',
];

async function fetchItem(entityTypeId, itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    select: ['*'],
  }, { ctx: { step: 'crm.item.get', entityTypeId, itemId } });

  const u = r?.result ?? r;
  return u?.item || u;
}

async function processOne(payload) {
  const entityTypeId = toNum(payload?.entityTypeId);
  const itemId = toNum(payload?.itemId);
  const event = String(payload?.event || '').trim().toUpperCase();

  if (!entityTypeId || !itemId) {
    return { ok: true, action: 'skip_missing_ids', entityTypeId, itemId, event };
  }

  if (ALLOW_ENTITY_SET && !ALLOW_ENTITY_SET.has(entityTypeId)) {
    return { ok: true, action: 'skip_not_in_allow_list', entityTypeId, itemId, event };
  }

  const handler = REGISTRY.get(entityTypeId);
  if (!handler) {
    // Ничего не делаем, но snapshot можно сохранить — чтобы потом быстро включить обработчик.
    // По умолчанию — не сохраняем, чтобы не плодить мусор.
    return { ok: true, action: 'skip_no_handler', entityTypeId, itemId, event };
  }

  // Гарантируем последовательность по item И НЕ теряем события
  const lockKey = `${entityTypeId}:${itemId}`;
  return await withItemQueue(lockKey, async () => {
    let item = null;
    try {
      item = await fetchItem(entityTypeId, itemId);
    } catch (e) {
      logger.error(
        { entityTypeId, itemId, event, err: e?.message || String(e), data: e?.data },
        '[dynamic-items] crm.item.get failed'
      );
      return {
        ok: false,
        action: 'crm_item_get_failed',
        entityTypeId,
        itemId,
        event,
        error: e?.message || String(e),
      };
    }

    const nextSnap = {
      fetchedAt: new Date().toISOString(),
      item: normalizeItemForSnapshot(item),
    };

    const prevSnap = readSnapshot(entityTypeId, itemId);
    const diff = buildDiff(prevSnap, nextSnap, {
      stageKey: 'stageId',
      ignoreKeys: IGNORE_KEYS_DEFAULT,
    });

    // Записываем snapshot ДО вызова обработчика — чтобы при крэше не зациклиться.
    // (handler может кинуть ошибку; snapshot всё равно должен отражать актуальное состояние)
    try {
      writeSnapshot(entityTypeId, itemId, nextSnap);
    } catch (e) {
      logger.warn(
        { entityTypeId, itemId, event, err: e?.message || String(e) },
        '[dynamic-items] snapshot write failed'
      );
    }

    // Отдаём handler полный контекст
    const ctx = {
      event,
      entityTypeId,
      itemId,
      item,
      prevSnapshot: prevSnap,
      nextSnapshot: nextSnap,
      diff,
      rawPayload: payload,
    };

    logger.info(
      { entityTypeId, itemId, event, stageChanged: diff.stageChanged, changedKeys: diff.changedKeys },
      '[dynamic-items] event processed'
    );

    try {
      const r = await handler(ctx);
      return { ok: true, action: 'handled', entityTypeId, itemId, event, handlerResult: r, diff };
    } catch (e) {
      logger.error(
        { entityTypeId, itemId, event, err: e?.message || String(e) },
        '[dynamic-items] handler failed'
      );
      return {
        ok: false,
        action: 'handler_failed',
        entityTypeId,
        itemId,
        event,
        error: e?.message || String(e),
        diff,
      };
    }
  });
}

// Публичный API: быстро принять и обработать "в фоне" внутри процесса
function enqueueDynamicItemEvent(payload) {
  const enabled = String(process.env.DYNAMIC_ITEM_PROCESSOR_ENABLED || '1').trim();
  if (enabled === '0') return { ok: true, action: 'disabled' };

  // не блокируем HTTP handler
  setImmediate(() => {
    processOne(payload)
      .then((r) => logger.debug({ r }, '[dynamic-items] done'))
      .catch((e) => logger.error({ err: e?.message || String(e) }, '[dynamic-items] fatal'));
  });

  return { ok: true, action: 'enqueued' };
}

module.exports = {
  enqueueDynamicItemEvent,
  processOne,
};
