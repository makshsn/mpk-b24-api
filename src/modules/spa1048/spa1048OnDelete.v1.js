"use strict";

const bitrix = require('../../services/bitrix/bitrixClient');
const { ensureObjectBody } = require('../../services/bitrix/b24Outbound.v1');

let cfg = {};
try { cfg = require('../../config/spa1048'); } catch (_) { cfg = {}; }

function toInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function computeCrmBinding(entityTypeId, itemId) {
  const et = toInt(entityTypeId);
  const id = toInt(itemId);
  if (!et || !id) return '';
  const hex = et.toString(16).toUpperCase();
  return `T${hex}_${id}`;
}

async function listTasksByCrmBinding(crmBinding) {
  const binding = String(crmBinding || '').trim();
  if (!binding) return [];

  const filterVariants = [
    { UF_CRM_TASK: binding },
    { UF_CRM_TASK: [binding] },
    { '=UF_CRM_TASK': binding },
  ];

  const limitPages = Number(process.env.SPA1048_DELETE_TASKS_MAX_PAGES || 50);

  for (let variantIndex = 0; variantIndex < filterVariants.length; variantIndex++) {
    const filter = filterVariants[variantIndex];
    const found = [];
    let start = 0;

    for (let page = 0; page < limitPages; page++) {
      const resp = await bitrix.call('tasks.task.list', {
        order: { ID: 'ASC' },
        filter,
        select: ['ID', 'UF_CRM_TASK'],
        start,
      }, { ctx: { step: 'tasks_list_by_crm_binding', crmBinding: binding, start, variantIndex } });

      const tasks = Array.isArray(resp?.tasks)
        ? resp.tasks
        : (Array.isArray(resp?.result?.tasks) ? resp.result.tasks : []);

      for (const t of tasks) {
        const id = toInt(t?.id ?? t?.ID);
        if (!id) continue;
        found.push({ id, ufCrmTask: t?.ufCrmTask ?? t?.UF_CRM_TASK ?? null });
      }

      const next = toInt(resp?.next ?? resp?.result?.next);
      if (next) {
        start = next;
        continue;
      }

      break;
    }

    if (found.length) {
      // unique + фильтрация по фактическому binding
      const seen = new Set();
      return found
        .filter((t) => {
          const v = t.ufCrmTask;
          if (!v) return true;
          if (Array.isArray(v)) return v.map(String).includes(binding);
          return String(v) === binding || String(v).includes(binding);
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

async function deleteTaskById(taskId, ctx = {}) {
  const id = toInt(taskId);
  if (!id) return { ok: false, taskId: 0, error: 'bad_task_id' };

  try {
    await bitrix.call('tasks.task.delete', { taskId: id }, { ctx: { step: 'task_delete', taskId: id, ...ctx } });
    return { ok: true, taskId: id, action: 'deleted' };
  } catch (e) {
    return { ok: false, taskId: id, action: 'delete_failed', error: e?.message || String(e) };
  }
}

function deepFindFirstInt(obj, keyMatcher, maxDepth = 7) {
  if (!obj || maxDepth <= 0) return 0;
  if (typeof obj !== 'object') return 0;

  for (const [k, v] of Object.entries(obj)) {
    if (keyMatcher(k)) {
      const n = toInt(v);
      if (n) return n;
    }
  }

  for (const v of Object.values(obj)) {
    if (!v) continue;
    if (typeof v === 'object') {
      const r = deepFindFirstInt(v, keyMatcher, maxDepth - 1);
      if (r) return r;
    }
  }

  return 0;
}

function extractFallbackTaskIdFromDeletePayload(req) {
  const b = ensureObjectBody(req);

  const taskIdField = String(process.env.SPA1048_TASK_ID_FIELD_ORIG || cfg.taskIdField || 'UF_CRM_8_TASK_ID');
  const taskIdFieldUpper = taskIdField.toUpperCase();

  // На удалении Битрикс может не прислать весь item, но иногда кидает FIELDS_BEFORE/AFTER.
  const directCandidates = [
    b?.data?.FIELDS?.[taskIdFieldUpper],
    b?.data?.FIELDS_BEFORE?.[taskIdFieldUpper],
    b?.data?.FIELDS_AFTER?.[taskIdFieldUpper],
    b?.FIELDS?.[taskIdFieldUpper],
    b?.FIELDS_BEFORE?.[taskIdFieldUpper],
    b?.FIELDS_AFTER?.[taskIdFieldUpper],
    b?.[taskIdFieldUpper],
  ];

  for (const v of directCandidates) {
    const n = toInt(v);
    if (n) return n;
  }

  // Плоские ключи вида data[FIELDS][UF_CRM_8_TASK_ID]
  const keyMatcher = (k) => String(k || '').toUpperCase().includes(taskIdFieldUpper);
  const deep = deepFindFirstInt(b, keyMatcher, 7);
  return toInt(deep);
}

/**
 * Основная логика:
 * 1) удаляем все задачи по UF_CRM_TASK привязке
 * 2) если не нашли — пробуем удалить по taskId из payload (UF_CRM_8_TASK_ID)
 */
async function handleSpa1048Delete({ entityTypeId, itemId, req, debug = false }) {
  const et = toInt(entityTypeId);
  const id = toInt(itemId);

  const binding = computeCrmBinding(et, id);

  const result = {
    ok: true,
    entityTypeId: et,
    itemId: id,
    crmBinding: binding,
    deleted: [],
    failed: [],
    fallback: null,
  };

  let tasks = [];
  let listError = null;

  if (binding) {
    try {
      tasks = await listTasksByCrmBinding(binding);
    } catch (e) {
      listError = e?.message || String(e);
      tasks = [];
    }
  }

  if (tasks.length) {
    for (const t of tasks) {
      const r = await deleteTaskById(t.id, { itemId: id, crmBinding: binding });
      if (r.ok) result.deleted.push(r.taskId);
      else result.failed.push(r);
    }

    if (debug) {
      result.debug = { tasks, listError };
    }

    return result;
  }

  const fallbackTaskId = extractFallbackTaskIdFromDeletePayload(req);
  if (fallbackTaskId) {
    const r = await deleteTaskById(fallbackTaskId, { itemId: id, crmBinding: binding, mode: 'fallback_payload' });
    result.fallback = { taskId: fallbackTaskId, result: r };
    if (r.ok) result.deleted.push(r.taskId);
    else result.failed.push(r);
  } else {
    result.fallback = {
      taskId: 0,
      result: { ok: false, error: listError ? `list_failed_or_empty: ${listError}` : 'no_tasks_found' },
    };
  }

  if (debug) {
    result.debug = {
      tasks,
      listError,
      payloadKeys: Object.keys(ensureObjectBody(req) || {}),
    };
  }

  return result;
}

module.exports = {
  computeCrmBinding,
  listTasksByCrmBinding,
  deleteTaskById,
  extractFallbackTaskIdFromDeletePayload,
  handleSpa1048Delete,
};
