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

function toIdList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  return [String(v).trim()].filter(Boolean);
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

  // UF поля приходят в camelCase
  const deadlineKey = ufToCamel(cfg.deadlineField || 'UF_CRM_8_1768219591855') || 'ufCrm8_1768219591855';
  const payDateKey = ufToCamel(cfg.paidAtField || 'UF_CRM_8_1768219659763') || 'ufCrm8_1768219659763';

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

    // success (оплачено)
    const paidStageId = String(cfg.stagePaid || process.env.SPA1048_STAGE_PAID || '').trim();

    // fail (может быть 1..N)
    const failStageIds = [
      ...toIdList(options.failStageIds),
      ...toIdList(cfg.stageFail),
      ...toIdList(process.env.SPA1048_STAGE_FAIL),
      ...toIdList(process.env.SPA1048_STAGE_FAILURE),
    ].map(String).filter(Boolean);

    // Любые финальные стадии (если заданы списком)
    const finalStageIds = [
      ...toIdList(cfg.stageFinal),
      ...toIdList(process.env.SPA1048_STAGE_FINAL),
      ...toIdList(paidStageId),
      ...failStageIds,
    ].map(String).filter(Boolean);

    const finalSet = new Set(finalStageIds);

    if (!urgentStageId) {
      summary.categories[categoryId] = { ok: false, error: `urgent stage not found by name="${urgentName}"` };
      continue;
    }

    // 1) Если SEMANTICS корректные — берём только процессные стадии (P)
    // 2) Если SEMANTICS пустые/не приходят — processStageIds будет пустой,
    //    тогда item.list пойдёт без фильтра stageId, но ниже мы всё равно отрежем финальные стадии.
    const processStageIds = buildProcessStageIds(stages, urgentStageId);

    // stageIdsToScan = process - urgent - финальные (success/fail и т.п.)
    const stageIdsToScan = processStageIds
      .filter(id => id !== urgentStageId)
      .filter(id => !finalSet.has(String(id)));

    const items = await listSpaItems(entityTypeId, categoryId, stageIdsToScan, select);
    summary.scannedTotal += items.length;

    let moved = 0;
    const movedIds = [];

    for (const it of items) {
      const currentStage = String(it.stageId || '');

      // 1) Игнорируем urgent — чтобы не дергать повторно
      if (currentStage === urgentStageId) continue;

      // 2) Игнорируем любые финальные стадии: success и fail (и всё, что ты положишь в SPA1048_STAGE_FINAL)
      if (finalSet.has(currentStage)) continue;

      // 3) Если дата оплаты заполнена — это уже оплачено, не трогаем
      const paidAt = it?.[payDateKey] || null;
      if (paidAt) continue;

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
      failStageIds,
      finalStageIds,
      processStages: processStageIds.length,
      scanned: items.length,
      moved,
      movedIds: movedIds.slice(0, 50),
    };
  }

  return summary;
}

module.exports = { runUrgentToPayOnce };
