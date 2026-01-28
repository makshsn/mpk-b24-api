const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { getLogger } = require('../../services/logging');

const logger = getLogger('spa1048');

// Поля (передал пользователь)
const FIELD_TOTAL = 'UF_CRM_8_1769511406016';   // общая сумма счёта
const FIELD_PAID = 'UF_CRM_8_1769511446943';    // общая сумма выплат
const FIELD_REMAIN = 'UF_CRM_8_1769511472212';  // остаток к оплате

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

function parseMoney(v) {
  if (v === undefined || v === null) return null;

  if (typeof v === 'number') {
    return { amount: v, currency: 'RUB' };
  }

  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;

    // формат Bitrix money: "123.45|RUB"
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
    // на всякий случай (иногда интеграции шлют { amount, currency })
    const amount = Number(v.amount ?? v.AMOUNT ?? v.value ?? v.VALUE);
    const currency = String(v.currency ?? v.CURRENCY ?? 'RUB').trim().toUpperCase() || 'RUB';
    if (!Number.isFinite(amount)) return null;
    return { amount, currency };
  }

  return null;
}

function formatMoney(amount, currency = 'RUB') {
  const a = Number(amount);
  const c = String(currency || 'RUB').trim().toUpperCase() || 'RUB';
  if (!Number.isFinite(a)) return null;
  return `${a.toFixed(2)}|${c}`;
}

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

async function updateRemain(entityTypeId, itemId, remainMoneyString) {
  return await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: {
      [FIELD_REMAIN]: remainMoneyString,
    },
  });
}

/**
 * Пересчитывает остаток к оплате: total - paid = remain.
 *
 * Важно:
 * - total/paid/remain — money поля (обычно "123.45|RUB")
 * - если total не задан, элемент пропускаем
 */
async function runRemainingToPayOnce(options = {}) {
  const entityTypeId = Number(options.entityTypeId || cfg.entityTypeId || 1048);
  const enabled = String(options.enabled ?? 'Y').toUpperCase() !== 'N';
  if (!enabled) return { ok: true, skipped: 'disabled' };

  const updateLimit = Math.max(1, Math.min(500, Number(options.limit || process.env.SPA1048_REMAINING_UPDATE_LIMIT || 50)));
  const dryRun = String(options.dryRun || process.env.SPA1048_REMAINING_DRY_RUN || 'N').toUpperCase() === 'Y';

  // Опционально ограничиваемся стадиями "в работе" (если заданы в env)
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

  const totalKey = ufToCamel(FIELD_TOTAL) || FIELD_TOTAL;
  const paidKey = ufToCamel(FIELD_PAID) || FIELD_PAID;
  const remainKey = ufToCamel(FIELD_REMAIN) || FIELD_REMAIN;

  const select = ['id', 'title', 'stageId', totalKey, paidKey, remainKey];

  // Категории: либо одна из env/opts, либо все
  const categoryIds = [];
  if (options.categoryId != null) {
    categoryIds.push(Number(options.categoryId));
  } else if (process.env.SPA1048_CATEGORY_ID) {
    categoryIds.push(Number(process.env.SPA1048_CATEGORY_ID));
  } else {
    const cats = await listCategories(entityTypeId);
    for (const c of cats) categoryIds.push(Number(c.id ?? c.ID));
    // На некоторых порталах categoryId может быть только один и не отдаётся — тогда пойдём без categoryId
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

      const total = parseMoney(it?.[totalKey]);
      if (!total || !Number.isFinite(total.amount) || total.amount <= 0) {
        catSkippedTotalNotSet++;
        summary.skippedTotalNotSet++;
        continue;
      }

      const paid = parseMoney(it?.[paidKey]) || { amount: 0, currency: total.currency || 'RUB' };
      const currRemain = parseMoney(it?.[remainKey]);

      const desiredRemain = round2(Math.max(0, Number(total.amount) - Number(paid.amount || 0)));
      const desiredStr = formatMoney(desiredRemain, total.currency || paid.currency || 'RUB');

      const currRemainAmount = currRemain ? round2(Number(currRemain.amount)) : null;

      // сравниваем по числу (с точностью до копеек)
      const same = currRemainAmount != null && desiredRemain != null && Math.abs(currRemainAmount - desiredRemain) < 0.009;
      if (same) continue;

      if (dryRun) {
        logger.info(
          {
            id: Number(it.id),
            title: String(it.title || ''),
            total: it?.[totalKey],
            paid: it?.[paidKey],
            remainBefore: it?.[remainKey],
            remainAfter: desiredStr,
          },
          '[spa1048][remain] dry-run: would update'
        );
        continue;
      }

      await updateRemain(entityTypeId, it.id, desiredStr);

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
