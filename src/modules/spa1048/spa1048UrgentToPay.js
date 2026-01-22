const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');

// Джоба: переводит счета (SPA entityTypeId=1048) в стадию "Срочно к оплате",
// если до крайнего срока оплаты <= 3 дней.

function unwrap(x) {
  return x?.result ?? x;
}

function norm(s) {
  return String(s || '').trim().toLowerCase();
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

function dateOnly(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

function daysLeft(deadlineYmd) {
  if (!deadlineYmd) return null;
  const d = new Date(`${deadlineYmd}T00:00:00Z`).getTime();
  if (!Number.isFinite(d)) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffMs = d - todayUtc;
  return Math.floor(diffMs / 86400000);
}

async function listCategories(entityTypeId) {
  // Возвращает [{id, name, ...}, ...]
  const r = await bitrix.call('crm.category.list', { entityTypeId: Number(entityTypeId) });
  const u = unwrap(r);
  const cats = u?.categories || u?.result?.categories || u;
  return Array.isArray(cats) ? cats : [];
}

async function listStages(entityTypeId, categoryId) {
  // Для SPA стадии лежат в статусах: ENTITY_ID = DYNAMIC_<entityTypeId>_STAGE_<categoryId>
  const ENTITY_ID = `DYNAMIC_${Number(entityTypeId)}_STAGE_${Number(categoryId)}`;
  const r = await bitrix.call('crm.status.entity.items', { ENTITY_ID });
  const u = unwrap(r);
  const items = u?.items || u?.result?.items || u;
  return { ENTITY_ID, items: Array.isArray(items) ? items : [] };
}

function pickUrgentStageId(stages, urgentName, urgentIdFromEnv) {
  if (urgentIdFromEnv) return String(urgentIdFromEnv).trim();
  const target = norm(urgentName || 'Срочно к оплате');
  const found = stages.find(s => norm(s?.NAME) === target);
  return found?.STATUS_ID ? String(found.STATUS_ID) : null;
}

function buildProcessStageIds(stages, urgentStageId) {
  // SEMANTICS: 'P' (process), 'S' (success), 'F' (failure)
  // Берём только 'P', исключая urgent.
  const ids = stages
    .filter(s => String(s?.SEMANTICS || '').toUpperCase() === 'P')
    .map(s => String(s?.STATUS_ID))
    .filter(Boolean);
  return ids.filter(id => id !== urgentStageId);
}

async function listSpaItems(entityTypeId, categoryId, stageIdsToScan, select) {
  const items = [];
  let start = 0;

  while (true) {
    const r = await bitrix.call('crm.item.list', {
      entityTypeId: Number(entityTypeId),
      filter: {
        categoryId: Number(categoryId),
        ...(stageIdsToScan?.length ? { stageId: stageIdsToScan } : {}),
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

async function updateStage(entityTypeId, itemId, stageId) {
  return await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: { stageId: String(stageId) },
  });
}

async function runUrgentToPayOnce(options = {}) {
  const entityTypeId = Number(options.entityTypeId || cfg.entityTypeId || 1048);

  // Если категория явно задана — работаем только с ней.
  const categoryIds = [];
  if (options.categoryId != null) {
    categoryIds.push(Number(options.categoryId));
  } else if (process.env.SPA1048_CATEGORY_ID) {
    categoryIds.push(Number(process.env.SPA1048_CATEGORY_ID));
  } else {
    const cats = await listCategories(entityTypeId);
    for (const c of cats) categoryIds.push(Number(c.id ?? c.ID));
  }

  const urgentName = options.urgentStageName || process.env.SPA1048_URGENT_STAGE_NAME || 'Срочно к оплате';
  const urgentIdFromEnv = options.urgentStageId || process.env.SPA1048_URGENT_STAGE_ID || '';
  const days = Number(options.days || process.env.SPA1048_URGENT_DAYS || 3);

  // В crm.item.list поля приходят в camelCase (как и в crm.item.get),
  // поэтому для UF_* берём именно camel ключ.
  const deadlineKey = ufToCamel(cfg.deadlineField || 'UF_CRM_8_1768219591855') || 'ufCrm8_1768219591855';

  // Дата оплаты: если заполнено — счёт не трогаем
  const payDateKey = ufToCamel(cfg.paymentDateField || 'UF_CRM_8_1768219659763') || 'ufCrm8_1768219659763';

  const select = ['id', 'title', 'stageId', deadlineKey, payDateKey];
  const summary = {
    ok: true,
    entityTypeId,
    categories: {},
    movedTotal: 0,
    scannedTotal: 0,
    urgentStageName: urgentName,
    urgentDays: days,
  };

  for (const categoryId of categoryIds.filter(n => Number.isFinite(n))) {
    const { items: stages } = await listStages(entityTypeId, categoryId);
    const urgentStageId = pickUrgentStageId(stages, urgentName, urgentIdFromEnv);

    // Стадия 'успешно оплачено' — никогда не тащим обратно в срочные
    const paidStageId = String(cfg.stagePaid || process.env.SPA1048_STAGE_PAID || '').trim();


    if (!urgentStageId) {
      summary.categories[categoryId] = { ok: false, error: `urgent stage not found by name="${urgentName}"` };
      continue;
    }

    // Сканируем только процессные стадии (SEMANTICS=P), исключая urgent.
    // Это безопаснее, чем гадать по "не равно" или env спискам.
    const processStageIds = buildProcessStageIds(stages, urgentStageId);

    // Сканируем только процессные стадии, но исключаем paidStageId (если он почему-то тоже SEMANTICS=P)
    const stageIdsToScan = paidStageId ? processStageIds.filter(id => id !== paidStageId) : processStageIds;


    const items = await listSpaItems(entityTypeId, categoryId, stageIdsToScan, select);
    summary.scannedTotal += items.length;

    let moved = 0;
    const movedIds = [];

    for (const it of items) {
      const currentStage = String(it.stageId || '');
      if (paidStageId && currentStage === paidStageId) continue;

      // Если дата оплаты заполнена — это уже оплачено, не дёргаем
      const paidAt = it?.[payDateKey] || null;
      if (paidAt) continue;

      if (currentStage === urgentStageId) continue;

      const dlYmd = dateOnly(it?.[deadlineKey] || it?.[cfg.deadlineField] || null);
      if (!dlYmd) continue;

      const left = daysLeft(dlYmd);
      if (left == null) continue;

      if (left <= days) {
        try {
          await updateStage(entityTypeId, it.id, urgentStageId);
          const commentText = `Счёт переведён в "Срочно к оплате", т.к. до оплаты менее ${days} дн. (осталось: ${left} дн.).`;
          try {
            await bitrix.call('crm.timeline.comment.add', {
              fields: {
                ENTITY_ID: Number(it.id),
                ENTITY_TYPE: `DYNAMIC_${entityTypeId}`,
                COMMENT: commentText,
              },
            });
          } catch (e) {
            // комментарий не критичен
          }
          moved++;
          movedIds.push(Number(it.id));
        } catch (e) {
          // не падаем целиком
        }
      }
    }

    summary.movedTotal += moved;
    summary.categories[categoryId] = {
      ok: true,
      urgentStageId,
      processStages: processStageIds.length,
      scanned: items.length,
      moved,
      movedIds: movedIds.slice(0, 50), // чтобы не раздувать лог
    };
  }

  return summary;
}

module.exports = { runUrgentToPayOnce };
