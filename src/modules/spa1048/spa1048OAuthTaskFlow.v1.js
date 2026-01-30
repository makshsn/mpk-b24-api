'use strict';

const { getLogger } = require('../../services/logging');
const logSpa = getLogger('spa1048');
const logDyn = getLogger('dynamic-items');

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');

const { normalizeSpaFiles } = require('./spa1048Files.v1');
const { createPaymentTaskIfMissing, syncPaymentTaskContent } = require('./spa1048PaymentTask.v1');

let checklistModule = null;
try { checklistModule = require('./taskChecklistSync.v1'); } catch (_) { checklistModule = null; }
const ensureChecklistForTask = checklistModule?.ensureChecklistForTask;

function toNum(v) {
  const n = Number(v);
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

function taskDeadlineIso(ymd) {
  if (!ymd) return null;
  const t = String(process.env.SPA1048_TASK_DEADLINE_TIME || 'T18:00:00+03:00').trim();
  if (t.startsWith('T')) return ymd + t;
  if (/^\d{2}:\d{2}/.test(t)) return `${ymd}T${t}`;
  return `${ymd}T18:00:00+03:00`;
}

function getTaskIdFromItem(item) {
  // по умолчанию UF_CRM_8_TASK_ID, но оставляем оба варианта
  return (
    toNum(item?.ufCrm8TaskId) ||
    toNum(item?.UF_CRM_8_TASK_ID) ||
    toNum(item?.uf_crm_8_task_id) ||
    0
  );
}

function getDeadlineFromItem(item) {
  const deadlineOrig = String(cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const deadlineCamel = String(cfg.deadlineFieldCamel || 'ufCrm8_1768219591855');
  const ymd = dateOnly(item?.[deadlineCamel] ?? item?.[deadlineOrig] ?? null);
  return ymd || null;
}

function getFilesFieldNames() {
  const upper = String(cfg.filesField || 'UF_CRM_8_1768219060503');
  const camel = String(cfg.filesFieldCamel || 'ufCrm8_1768219060503');
  return { upper, camel };
}

function computeCrmBinding(entityTypeId, itemId) {
  const et = toNum(entityTypeId);
  const id = toNum(itemId);
  if (!et || !id) return '';
  // entityTypeId=1048 -> hex digits only, но пусть будет общий кейс
  const hex = et.toString(16).toUpperCase();
  return `T${hex}_${id}`;
}

async function setSpaTaskId({ entityTypeId, itemId, taskId }) {
  const taskIdField = String(process.env.SPA1048_TASK_ID_FIELD_ORIG || cfg.taskIdField || 'UF_CRM_8_TASK_ID');
  await bitrix.call('crm.item.update', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    fields: { [taskIdField]: Number(taskId), ufCrm8TaskId: Number(taskId) },
  }, { ctx: { step: 'spa1048_oauth_set_task_id', itemId: Number(itemId), taskId: Number(taskId), taskIdField } });
}

async function listTasksByCrmBinding(crmBinding) {
  const binding = String(crmBinding || '').trim();
  if (!binding) return [];

  const filterVariants = [
    { UF_CRM_TASK: binding },
    { UF_CRM_TASK: [binding] },
    { '=UF_CRM_TASK': binding },
  ];

  const limitPages = Number(process.env.SPA1048_TASK_BINDING_LIST_MAX_PAGES || 25);

  for (let variantIndex = 0; variantIndex < filterVariants.length; variantIndex++) {
    const filter = filterVariants[variantIndex];
    const found = [];
    let start = 0;

    for (let page = 0; page < limitPages; page++) {
      const resp = await bitrix.call('tasks.task.list', {
        order: { ID: 'ASC' },
        filter,
        select: ['ID', 'UF_CRM_TASK', 'TITLE', 'STATUS'],
        start,
      }, { ctx: { step: 'spa1048_oauth_tasks_list_by_binding', crmBinding: binding, start, variantIndex } });

      const tasks = Array.isArray(resp?.tasks)
        ? resp.tasks
        : (Array.isArray(resp?.result?.tasks) ? resp.result.tasks : []);

      for (const t of tasks) {
        const id = toNum(t?.id ?? t?.ID);
        if (!id) continue;
        found.push({
          id,
          status: toNum(t?.status ?? t?.STATUS),
          title: t?.title ?? t?.TITLE ?? null,
          ufCrmTask: t?.ufCrmTask ?? t?.UF_CRM_TASK ?? null,
        });
      }

      const next = toNum(resp?.next ?? resp?.result?.next);
      if (next) { start = next; continue; }
      break;
    }

    if (found.length) {
      // unique + строгая фильтрация по фактическому binding
      const seen = new Set();
      return found
        .filter((t) => {
          const v = t.ufCrmTask;
          if (!v) return true;
          if (Array.isArray(v)) return v.map(String).includes(binding);
          const s = String(v);
          return s === binding || s.includes(binding);
        })
        .filter((t) => {
          if (seen.has(t.id)) return false;
          seen.add(t.id);
          return true;
        });
    }
  }

  return [];
}

async function ensureTaskCrmBinding(taskId, crmBinding) {
  const tid = toNum(taskId);
  const bind = String(crmBinding || '').trim();
  if (!tid || !bind) return { ok: false, action: 'skip_bad_params' };

  try {
    const r = await bitrix.call('tasks.task.get', {
      taskId: Number(tid),
      select: ['ID', 'UF_CRM_TASK'],
    }, { ctx: { step: 'spa1048_oauth_task_get_binding', taskId: Number(tid) } });

    const t = r?.task || r?.result?.task || r?.result || r;
    const cur = t?.ufCrmTask ?? t?.UF_CRM_TASK ?? null;

    const arr = Array.isArray(cur) ? cur.map(String) : (cur ? [String(cur)] : []);
    const has = arr.some((x) => String(x) === bind);
    if (has) return { ok: true, action: 'binding_ok', taskId: tid, crmBinding: bind };

    const next = Array.from(new Set([bind, ...arr].filter(Boolean)));
    await bitrix.call('tasks.task.update', {
      taskId: Number(tid),
      fields: { UF_CRM_TASK: next },
    }, { ctx: { step: 'spa1048_oauth_task_set_binding', taskId: Number(tid), crmBinding: bind } });

    return { ok: true, action: 'binding_set', taskId: tid, crmBinding: bind, before: arr, after: next };
  } catch (e) {
    return { ok: false, action: 'binding_error', error: e?.message || String(e), taskId: tid, crmBinding: bind };
  }
}

function dualInfo(payload, msg) {
  logSpa.info(payload, msg);
  logDyn.info(payload, msg);
}

function dualWarn(payload, msg) {
  logSpa.warn(payload, msg);
  logDyn.warn(payload, msg);
}

function isChecklistEnabled() {
  const v = String(process.env.SPA1048_CHECKLIST_ENABLED ?? '1').trim();
  return v !== '0' && v.toUpperCase() !== 'N' && v.toUpperCase() !== 'NO';
}

async function ensureChecklistSafe(taskId, fileList) {
  if (!ensureChecklistForTask) return { ok: true, action: 'checklist_skip_module_missing', enabled: false };
  if (!isChecklistEnabled()) return { ok: true, action: 'checklist_skip_disabled', enabled: false };

  try {
    const list = Array.isArray(fileList) ? fileList : [];
    const r = await ensureChecklistForTask(Number(taskId), list);
    return { ok: true, action: 'checklist_synced', enabled: true, result: r };
  } catch (e) {
    return { ok: false, action: 'checklist_error', enabled: true, error: e?.message || String(e) };
  }
}

/**
 * SPA1048 task orchestration driven ONLY by OAuth dynamic item events.
 *
 * Rules:
 * - ADD: create task (idempotent by UF_CRM_TASK binding search) and write taskId to SPA.
 * - UPDATE: update ONLY on two triggers: deadline field / files field.
 * - UPDATE: NEVER create a task; if taskId empty -> skip_update_no_taskId.
 */
async function handleSpa1048OauthEvent(ctx) {
  const entityTypeId = toNum(ctx?.entityTypeId || cfg.entityTypeId || 1048);
  const itemId = toNum(ctx?.itemId);
  const event = String(ctx?.event || '').toUpperCase();

  if (!entityTypeId || !itemId) {
    return { ok: true, action: 'skip_missing_ids', entityTypeId, itemId, event };
  }

  const item = ctx?.item || null;
  if (!item) {
    return { ok: false, action: 'no_item_in_ctx', entityTypeId, itemId, event };
  }

  const accountantId = toNum(process.env.SPA1048_ACCOUNTANT_ID || cfg.accountantId || 70);
  const spaCreatorId = toNum(item.createdById || item.CREATED_BY_ID || item.createdBy || item.CREATED_BY || 0)
    || toNum(item.assignedById || item.ASSIGNED_BY_ID || 0);

  const itemTitle = String(item.title || item.TITLE || '').trim();
  const crmBinding = computeCrmBinding(entityTypeId, itemId);

  const { upper: filesUpper, camel: filesCamel } = getFilesFieldNames();
  const deadlineOrig = String(cfg.deadlineField || 'UF_CRM_8_1768219591855');
  const deadlineCamel = String(cfg.deadlineFieldCamel || 'ufCrm8_1768219591855');

  const changedKeys = Array.isArray(ctx?.diff?.changedKeys) ? ctx.diff.changedKeys : [];
  const filesChanged = changedKeys.includes(filesUpper) || changedKeys.includes(filesCamel);
  const deadlineChanged = changedKeys.includes(deadlineOrig) || changedKeys.includes(deadlineCamel);

  if (event === 'ONCRMDYNAMICITEMADD') {
    // --- ADD: create (idempotent) ---
    let taskId = getTaskIdFromItem(item);
    let reusedByBinding = false;

    if (!taskId) {
      const found = await listTasksByCrmBinding(crmBinding);
      if (found.length) {
        taskId = found[0].id;
        reusedByBinding = true;
        await setSpaTaskId({ entityTypeId, itemId, taskId });

        dualInfo({ entityTypeId, itemId, taskId, crmBinding }, '[spa1048][oauth] task reused by UF_CRM_TASK binding');
      }
    }

    // deadline for task (if no value in SPA -> default)
    let deadlineYmd = getDeadlineFromItem(item);
    if (!deadlineYmd) deadlineYmd = computeDefaultDeadlineYmd();
    const deadlineIso = taskDeadlineIso(deadlineYmd);

    // files: only for title/description/checklist
    let files = { ok: true, action: 'skipped' };
    try {
      files = await normalizeSpaFiles({ entityTypeId, itemId });
    } catch (e) {
      files = { ok: false, action: 'error', error: e?.message || String(e) };
    }

    const fileNames = Array.isArray(files?.fileNames) ? files.fileNames : [];
    const fileList = Array.isArray(files?.fileList) ? files.fileList : (Array.isArray(files?.pdfList) ? files.pdfList : []);

    let createRes = null;
    if (!taskId) {
      createRes = await createPaymentTaskIfMissing({
        entityTypeId,
        itemId,
        itemTitle,
        deadline: deadlineIso,
        taskId: 0,
        fileNames,
        responsibleId: accountantId,
        createdById: spaCreatorId,
        stageId: item.stageId || item.STAGE_ID || null,
      });

      taskId = toNum(createRes?.taskId);
      dualInfo({ entityTypeId, itemId, taskId, crmBinding, createdById: spaCreatorId, responsibleId: accountantId }, '[spa1048][oauth] task created');
    } else if (!reusedByBinding) {
      // taskId already present in SPA
      dualInfo({ entityTypeId, itemId, taskId, crmBinding }, '[spa1048][oauth] task exists in SPA');
    }

    // ensure CRM binding on ADD (esp. when reused)
    const bindingRes = await ensureTaskCrmBinding(taskId, crmBinding);

    // make deterministic on ADD: ensure content + deadline + checklist
    let contentSync = null;
    try {
      contentSync = await syncPaymentTaskContent({
        taskId,
        itemId,
        itemTitle,
        fileNames,
        deadline: deadlineIso,
      });
    } catch (e) {
      contentSync = { ok: false, action: 'task_content_sync_error', error: e?.message || String(e) };
    }

    const checklist = await ensureChecklistSafe(taskId, fileList);

    return {
      ok: true,
      action: 'oauth_add_processed',
      entityTypeId,
      itemId,
      taskId,
      crmBinding,
      reusedByBinding,
      createRes,
      bindingRes,
      contentSync,
      checklist,
      files: { ok: !!files?.ok, action: files?.action, fileCount: fileNames.length },
    };
  }

  if (event === 'ONCRMDYNAMICITEMUPDATE') {
    // --- UPDATE: only 2 triggers, no create ---
    const taskId = getTaskIdFromItem(item);

    if (!taskId) {
      dualWarn({ entityTypeId, itemId, crmBinding }, '[spa1048][oauth] skip_update_no_taskId');
      return { ok: true, action: 'skip_update_no_taskId', entityTypeId, itemId, crmBinding };
    }

    const ops = { files: null, deadline: null, checklist: null };

    if (filesChanged) {
      let files = { ok: true, action: 'skipped' };
      try {
        files = await normalizeSpaFiles({ entityTypeId, itemId });
      } catch (e) {
        files = { ok: false, action: 'error', error: e?.message || String(e) };
      }

      const fileNames = Array.isArray(files?.fileNames) ? files.fileNames : [];
      const fileList = Array.isArray(files?.fileList) ? files.fileList : (Array.isArray(files?.pdfList) ? files.pdfList : []);

      // IMPORTANT: on filesChanged do NOT touch deadline
      try {
        ops.files = await syncPaymentTaskContent({
          taskId,
          itemId,
          itemTitle,
          fileNames,
          deadline: null,
        });
      } catch (e) {
        ops.files = { ok: false, action: 'task_files_sync_error', error: e?.message || String(e) };
      }

      ops.checklist = await ensureChecklistSafe(taskId, fileList);

      dualInfo({ entityTypeId, itemId, taskId, crmBinding, fileCount: fileNames.length }, '[spa1048][oauth] task files updated');
    }

    if (deadlineChanged) {
      let deadlineYmd = getDeadlineFromItem(item);
      if (!deadlineYmd) deadlineYmd = computeDefaultDeadlineYmd();
      const deadlineIso = taskDeadlineIso(deadlineYmd);

      try {
        await bitrix.call('tasks.task.update', {
          taskId: Number(taskId),
          fields: { DEADLINE: String(deadlineIso) },
        }, { ctx: { step: 'spa1048_oauth_task_deadline_update', taskId: Number(taskId), itemId, deadlineIso } });

        ops.deadline = { ok: true, action: 'deadline_updated', to: deadlineIso };
        dualInfo({ entityTypeId, itemId, taskId, crmBinding, deadlineIso }, '[spa1048][oauth] task deadline updated');
      } catch (e) {
        ops.deadline = { ok: false, action: 'deadline_update_error', error: e?.message || String(e) };
        dualWarn({ entityTypeId, itemId, taskId, crmBinding, err: e?.message || String(e) }, '[spa1048][oauth] task deadline update failed');
      }
    }

    if (!filesChanged && !deadlineChanged) {
      return { ok: true, action: 'skip_update_no_triggers', entityTypeId, itemId, taskId, crmBinding };
    }

    return {
      ok: true,
      action: 'oauth_update_processed',
      entityTypeId,
      itemId,
      taskId,
      crmBinding,
      triggers: { filesChanged, deadlineChanged },
      ops,
    };
  }

  return { ok: true, action: 'skip_event_not_supported', entityTypeId, itemId, event };
}

module.exports = {
  handleSpa1048OauthEvent,
  computeCrmBinding,
};
