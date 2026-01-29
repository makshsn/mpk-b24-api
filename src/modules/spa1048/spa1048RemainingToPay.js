const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { getLogger } = require('../../services/logging');

const logger = getLogger('spa1048');

// Поля (из твоего сообщения)
const FIELD_TOTAL = 'UF_CRM_8_1769511406016';   // общая сумма счёта (money)
const FIELD_PAID = 'UF_CRM_8_1769511446943';    // общая сумма выплат (number)
const FIELD_REMAIN = 'UF_CRM_8_1769511472212';  // остаток к оплате (number)

function unwrap(x) {
  return x?.result ?? x;
}

// UF_CRM_8_176... -> ufCrm8_176...
function ufToCamel(uf) {
  const s = String(uf || '').trim();
  if (!s) return '';
  if (!/^UF_/i.test(s)) return s;

  const lower = s.toLowerCase();
  const parts = lower.split('_').filter(Boolean); // ['uf','crm','8','176...']
  if (!parts.length) return '';

  let out = parts[0]; // uf
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (i === 1) { out += p.charAt(0).toUpperCase() + p.slice(1); continue; } // crm -> Crm
    if (/^\d+$/.test(p) && i === 2) { out += p; continue; } // 8
    out += '_' + p; // остальное
  }
  return out;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** number: принимает число или строку "123,45" / "123.45" */
function parseNumber(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** money: принимает "123.45|RUB" или число/строку -> {amount, currency} */
function parseMoney(v) {
  if (v === undefined || v === null) return null;

  if (typeof v === 'number') {
    return Number.isFinite(v) ? { amount: v, currency: 'RUB' } : null;
  }

  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;

    if (s.includes('|')) {
      const [aRaw, cRaw] = s.split('|');
      const amount = Number(String(aRaw).trim().replace(',', '.'));
      if (!Number.isFinite(amount)) return null;
      const currency = String(cRaw || 'RUB').trim().toUpperCase() || 'RUB';
      return { amount, currency };
    }

    const amount = Number(s.replace(',', '.'));
    if (!Number.isFinite(amount)) return null;
    return { amount, currency: 'RUB' };
  }

  if (typeof v === 'object') {
    const amount = Number(v.amount ?? v.AMOUNT ?? v.value ?? v.VALUE);
    const currency = String(v.currency ?? v.CURRENCY ?? 'RUB').trim().toUpperCase() || 'RUB';
    if (!Number.isFinite(amount)) return null;
    return { amount, currency };
  }

  return null;
}

/** ---------- crm.item.fields cache (чтобы знать типы полей) ---------- */

let _fieldsCache = null;
let _fieldsCacheAt = 0;

async function getFieldsMap(entityTypeId) {
  const ttlMs = 10 * 60 * 1000; // 10 минут
  const now = Date.now();

  if (_fieldsCache && (now - _fieldsCacheAt) < ttlMs) return _fieldsCache;

  const r = await bitrix.call('crm.item.fields', { entityTypeId: Number(entityTypeId) });
  const fields = r?.fields || r?.result?.fields || r?.result || r;

  _fieldsCache = (fields && typeof fields === 'object') ? fields : {};
  _fieldsCacheAt = now;

  return _fieldsCache;
}

function pickFieldType(fieldsMap, fieldUpper) {
  const camel = ufToCamel(fieldUpper);
  const meta = fieldsMap?.[camel] || fieldsMap?.[fieldUpper] || null;
  const type = String(meta?.type || meta?.TYPE || '').trim().toLowerCase();
  return type || null;
}

/** ---------- list/update helpers ---------- */

async function listCategories(entityTypeId) {
  const r = await bitrix.call('crm.category.list', { entityTypeId: Number(entityTypeId) });
  const u = unwrap(r);
  const cats = u?.categories || u?.result?.categories || u;
  return Array.isArray(cats) ? cats : [];
}

async function listSpaItems({ entityTypeId, categoryId, stageIds, select }) {
  const items = [];
  let start = 0;

  while (true) {
    const r = await bitrix.call('crm.item.list', {
      entityTypeId: Number(entityTypeId),
      filter: {
        ...(categoryId != null ? { categoryId: Number(categoryId) } : {}),
        ...(stageIds?.length ? { stageId: stageIds } : {}),
      },
      select,
      start,
    });

    const u = unwrap(r);
    const page = u?.items || u?.result?.items || u?.result || u;
    if (Array.isArray(page)) items.push(...page);

    const next = u?.next ?? u?.result?.next;
    if (next == null) break;
    start = next;
  }

  return items;
}

async function updateRemain(entityTypeId, itemId, remainValue) {
  const remainCamel = ufToCamel(FIELD_REMAIN) || FIELD_REMAIN;

  // ВАЖНО: как в остальных модулях проекта — ставим useOriginalUfNames и пишем оба ключа
  return await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    useOriginalUfNames: 'Y',
    fields: {
      [FIELD_REMAIN]: remainValue,
      [remainCamel]: remainValue,
    },
  }, { ctx: { step: 'spa1048_remaining_update', itemId, remainValue } });
}

/**
 * Пересчитывает остаток к оплате: total(money) - paid(number) = remain(number)
 */
async function runRemainingToPayOnce(options = {}) {
  const entityTypeId = Number(options.entityTypeId || cfg.entityTypeId || 1048);
  const enabled = String(options.enabled ?? 'Y').toUpperCase() !== 'N';
  if (!enabled) return { ok: true, skipped: 'disabled' };

  const updateLimit = Math.max(1, Math.min(500, Number(options.limit || process.env.SPA1048_REMAINING_UPDATE_LIMIT || 50)));
  const dryRun = String(options.dryRun || process.env.SPA1048_REMAINING_DRY_RUN || 'N').toUpperCase() === 'Y';

  const stageIds = Array.isArray(cfg.stageActive) && cfg.stageActive.length ? cfg.stageActive : null;

  const finalStageIds = new Set(
    [
      ...(Array.isArray(cfg.stageFinal) ? cfg.stageFinal : []),
      ...(Array.isArray(cfg.stageFail) ? cfg.stageFail : []),
      cfg.stagePaid,
    ]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
  );

  const totalCamel = ufToCamel(FIELD_TOTAL);
  const paidCamel = ufToCamel(FIELD_PAID);
  const remainCamel = ufToCamel(FIELD_REMAIN);

  // Берём и camel, и UF_* — чтобы точно прилетело значение
  const select = [
    'id',
    'title',
    'stageId',

    totalCamel, FIELD_TOTAL,
    paidCamel, FIELD_PAID,
    remainCamel, FIELD_REMAIN,
  ];

  const fieldsMap = await getFieldsMap(entityTypeId);

  const totalType = pickFieldType(fieldsMap, FIELD_TOTAL);   // ожидаем money
  const paidType = pickFieldType(fieldsMap, FIELD_PAID);     // ожидаем double/int/string
  const remainType = pickFieldType(fieldsMap, FIELD_REMAIN); // ожидаем double/int

  // Это уйдёт в spa1048.log
  logger.info({ entityTypeId, totalType, paidType, remainType }, '[spa1048][remain] field types');

  const categoryIds = [];
  if (options.categoryId != null) {
    categoryIds.push(Number(options.categoryId));
  } else if (process.env.SPA1048_CATEGORY_ID) {
    categoryIds.push(Number(process.env.SPA1048_CATEGORY_ID));
  } else {
    const cats = await listCategories(entityTypeId);
    for (const c of cats) categoryIds.push(Number(c.id ?? c.ID));
    if (!categoryIds.length) categoryIds.push(null);
  }

  const summary = {
    ok: true,
    entityTypeId,
    stageFilter: stageIds?.length ? stageIds : null,
    updateLimit,
    dryRun,
    scannedTotal: 0,
    updatedTotal: 0,
    skippedTotalNotSet: 0,
    skippedFinalStage: 0,
    updatedItems: [], // <= 10 шт, чтобы в jobs.log было видно какой элемент реально обновили
    categories: {},
  };

  let updated = 0;

  for (const categoryId of categoryIds) {
    const catKey = categoryId == null ? 'no_category_filter' : String(categoryId);

    const items = await listSpaItems({
      entityTypeId,
      categoryId,
      stageIds,
      select,
    });

    summary.scannedTotal += items.length;

    let catScanned = 0;
    let catUpdated = 0;
    let catSkippedTotalNotSet = 0;
    let catSkippedFinalStage = 0;

    for (const it of items) {
      catScanned++;

      const stageId = String(it?.stageId || '');
      if (stageId && finalStageIds.has(stageId)) {
        catSkippedFinalStage++;
        summary.skippedFinalStage++;
        continue;
      }

      const totalRaw = it?.[totalCamel] ?? it?.[FIELD_TOTAL];
      const totalMoney = (totalType === 'money') ? parseMoney(totalRaw) : parseMoney(totalRaw); // money у тебя точно, но оставим универсально
      const totalAmount = totalMoney?.amount;

      if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
        catSkippedTotalNotSet++;
        summary.skippedTotalNotSet++;
        continue;
      }

      const paidRaw = it?.[paidCamel] ?? it?.[FIELD_PAID];
      const paidAmount = parseNumber(paidRaw) ?? 0;

      const desiredRemain = round2(Math.max(0, Number(totalAmount) - Number(paidAmount)));

      const currRemainRaw = it?.[remainCamel] ?? it?.[FIELD_REMAIN];
      const currRemain = parseNumber(currRemainRaw);
      const currRemainR = currRemain == null ? null : round2(currRemain);

      const same = (currRemainR != null) && (desiredRemain != null) && Math.abs(currRemainR - desiredRemain) < 0.009;
      if (same) continue;

      if (dryRun) {
        logger.info(
          {
            id: Number(it.id),
            title: String(it.title || ''),
            totalRaw,
            paidRaw,
            remainBefore: currRemainRaw,
            remainAfter: desiredRemain,
          },
          '[spa1048][remain] dry-run: would update'
        );
        continue;
      }

      await updateRemain(entityTypeId, it.id, desiredRemain);

      catUpdated++;
      updated++;
      summary.updatedTotal++;

      if (summary.updatedItems.length < 10) {
        summary.updatedItems.push({
          id: Number(it.id),
          title: String(it.title || ''),
          totalRaw,
          paidRaw,
          remainBefore: currRemainRaw ?? null,
          remainAfter: desiredRemain,
        });
      }

      if (updated >= updateLimit) {
        summary.categories[catKey] = {
          scanned: catScanned,
          updated: catUpdated,
          skippedTotalNotSet: catSkippedTotalNotSet,
          skippedFinalStage: catSkippedFinalStage,
          stoppedByLimit: true,
        };
        summary.stoppedByLimit = true;
        return summary;
      }
    }

    summary.categories[catKey] = {
      scanned: catScanned,
      updated: catUpdated,
      skippedTotalNotSet: catSkippedTotalNotSet,
      skippedFinalStage: catSkippedFinalStage,
      stoppedByLimit: false,
    };
  }

  return summary;
}

module.exports = {
  runRemainingToPayOnce,
  FIELDS: {
    FIELD_TOTAL,
    FIELD_PAID,
    FIELD_REMAIN,
  },
};
