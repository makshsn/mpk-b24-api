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

function ufToCamel(fieldCode) {
  // UF_CRM_8_1768219591855 -> ufCrm8_1768219591855
  // UF_CRM_8_TASK_ID      -> ufCrm8TaskId
  const raw = String(fieldCode || '').trim();
  if (!raw) return '';
  const parts = raw.split('_').filter(Boolean);
  if (parts.length < 3) return raw;

  const head = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '');

  const p0 = parts[0].toLowerCase(); // uf
  const p1 = head(parts[1]);         // Crm
  const p2 = parts[2];               // 8

  // Если 4-я часть — числа, то оставляем подчёркивание перед ней (как в реальном ответе crm.item.get/list)
  if (parts.length === 4 && /^\d+$/.test(parts[3])) {
    return `${p0}${p1}${p2}_${parts[3]}`;
  }

  // Иначе — обычный camelCase по оставшимся частям
  const tail = parts.slice(3).map(head).join('');
  return `${p0}${p1}${p2}${tail}`;
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
  // remainValue ДОЛЖЕН соответствовать типу поля (в твоём случае number)
  return await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: {
      [FIELD_REMAIN]: remainValue,
    },
  });
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

  // Опционально ограничиваемся стадиями "в работе" (если заданы в cfg)
  const stageIds = Array.isArray(cfg.stageActive) && cfg.stageActive.length ? cfg.stageActive : null;

  // Финальные стадии — пропускаем (если заданы)
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

  // Важно для диагностики
  logger.info({ entityTypeId, totalType, paidType, remainType }, '[spa1048][remain] field types');

  // Категории: либо одна из opts/env, либо все
  const categoryIds = [];
  if (options.categoryId != null) {
    categoryIds.push(Number(options.categoryId));
  } else if (process.env.SPA1048_CATEGORY_ID) {
    categoryIds.push(Number(process.env.SPA1048_CATEGORY_ID));
  } else {
    const cats = await listCategories(entityTypeId);
    for (const c of cats) categoryIds.push(Number(c.id ?? c.ID));
    if (!categoryIds.length) categoryIds.push(null); // на всякий случай
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

      // total: money (берём из camel либо из UF_*)
      const totalRaw = it?.[totalCamel] ?? it?.[FIELD_TOTAL];
      const totalMoney = (totalType === 'money') ? parseMoney(totalRaw) : null;
      const totalAmount = totalMoney?.amount;

      if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
        catSkippedTotalNotSet++;
        summary.skippedTotalNotSet++;
        continue;
      }

      // paid: number (берём из camel либо из UF_*)
      const paidRaw = it?.[paidCamel] ?? it?.[FIELD_PAID];
      const paidAmount = parseNumber(paidRaw) ?? 0;

      const desiredRemain = round2(Math.max(0, Number(totalAmount) - Number(paidAmount)));

      // текущий remain: number
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

      // remainType должен быть числовой; если вдруг окажется money — можно будет расширить,
      // но по твоим словам поле "остаток" = число => пишем число.
      await updateRemain(entityTypeId, it.id, desiredRemain);

      catUpdated++;
      updated++;
      summary.updatedTotal++;

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
