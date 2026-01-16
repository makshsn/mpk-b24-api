require('dotenv').config();

const bitrix = require('../services/bitrix/bitrixClient');
const cfg = require('../config/spa1048');
const { syncFilesChecklistAndMaybeClose } = require('../services/bitrix/spa1048FilesChecklist');

const POLL_MIN = Number(process.env.SPA1048_CHECKLIST_POLL_MIN || 10);
const ONCE = process.argv.includes('--once');

const F_FILES_PAY = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
const STAGE_PAID = String(cfg.stagePaid || process.env.SPA1048_STAGE_PAID || '').trim();

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function crmItemListAll(filter, select) {
  let start = 0;
  const out = [];
  while (true) {
    const r = await bitrix.call('crm.item.list', {
      entityTypeId: cfg.entityTypeId,
      filter,
      select,
      order: { id: 'ASC' },
      start,
    });

    const res = r?.result || r;
    const items = res?.items || res?.result?.items || [];
    out.push(...items);

    const next = res?.next ?? res?.result?.next;
    if (next == null) break;
    start = Number(next);
    if (!Number.isFinite(start)) break;
  }
  return out;
}

async function getItemFull(itemId) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    select: ['*'], // важно: так файлы приходят с url/urlMachine
  });

  // твой bitrixClient отдаёт { item: {...} }
  return r?.item || r?.result?.item || r?.result || r;
}

async function getTask(taskId) {
  const r = await bitrix.call('tasks.task.get', { taskId: Number(taskId) });
  return r?.result?.task || r?.task || r?.result || r;
}

async function moveItemToPaid(itemId) {
  if (!STAGE_PAID) {
    return { ok:false, error:'SPA1048_STAGE_PAID не задан (cfg.stagePaid пустой)' };
  }

  await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields: {
      stageId: STAGE_PAID,
      ufCrm8SyncAt: new Date().toISOString(),
      ufCrm8SyncSrc: 'watcher_task_completed',
    },
  });

  try {
    await bitrix.call('crm.timeline.comment.add', {
      fields: {
        ENTITY_TYPE: `DYNAMIC_${cfg.entityTypeId}`,
        ENTITY_ID: Number(itemId),
        COMMENT: `Задача оплачивания выполнена — счёт переведён в "успешно оплаченные".`,
      },
    });
  } catch (_e) {}

  return { ok:true, stagePaid: STAGE_PAID };
}

async function tick() {
  const filter = { '>ufCrm8TaskId': 0 };
  if (STAGE_PAID) filter['!stageId'] = STAGE_PAID;

  // list используем только чтобы быстро получить IDшники
  const select = ['id','ufCrm8TaskId','stageId'];
  const items = await crmItemListAll(filter, select);

  let processed = 0, moved = 0, noFiles = 0, closeFails = 0;

  for (const it of items) {
    const itemId = it.id || it.ID;
    if (!itemId) continue;

    // берём полный item, чтобы гарантированно были файлы и taskId
    let full;
    try { full = await getItemFull(itemId); } catch (_e) { continue; }

    const taskId = full.ufCrm8TaskId || full.UF_CRM8TASKID;
    const stageId = full.stageId || full.STAGE_ID;
    if (!taskId) continue;

    // 1) если задачу уже закрыли руками — просто двигаем стадию
    let task;
    try { task = await getTask(taskId); } catch (_e) { continue; }

    const status = Number(task?.status || task?.STATUS || task?.realStatus || task?.REAL_STATUS || 0);
    if (status === 5) {
      const r = await moveItemToPaid(itemId);
      if (r.ok) moved++;
      processed++;
      await sleep(200);
      continue;
    }

    // 2) иначе — проверяем чеклист/закрываем
    try {
      const res = await syncFilesChecklistAndMaybeClose({
        itemId,
        taskId,
        item: full,
        stageId,
      });

      if (res?.note === 'no_files') noFiles++;

      if (res?.allDone && !res?.closed) {
        closeFails++;
        console.log(`[watcher] allDone BUT not closed: item=${itemId} task=${taskId} closeTask=${JSON.stringify(res.closeTask)} move=${JSON.stringify(res.move)}`);
      }

      if (res?.closed) moved++;
    } catch (e) {
      console.log(`[watcher] sync error item=${itemId} task=${taskId}:`, e?.message || e);
    }

    processed++;
    await sleep(200);
  }

  console.log(`[spa1048ChecklistWatcher] processed=${processed} moved=${moved} noFiles=${noFiles} closeFails=${closeFails} items=${items.length} at=${new Date().toISOString()}`);
}

(async () => {
  if (ONCE) {
    await tick();
    process.exit(0);
  }

  console.log(`[spa1048ChecklistWatcher] started, every ${POLL_MIN} min`);
  while (true) {
    try { await tick(); } catch (e) { console.error(e?.message || e); }
    await sleep(POLL_MIN * 60 * 1000);
  }
})();