const fs = require('fs');
const path = require('path');
const { call } = require('./bitrixClient');
const {
  LEAD_PREV_STAGE_FIELD,
  LEAD_PAUSE_STAGE_ID,
  LEAD_CONTACT_TASK_ID_FIELD,
  LEAD_NEXT_MEASURE_DATETIME_FIELD,
  LEAD_PAUSE_REASON_FIELD,
  LEAD_PAUSE_REASON_DEFAULT_TEXT,
  LEAD_ALLOWED_STAGES_FOR_PAUSE,
  CONTACT_TASK_TITLE_PREFIX,
  CONTACT_TASK_OVERDUE_DAYS,
} = require('../../config/fields');

const CURSOR_FILE = path.join(process.cwd(), 'var', 'pause_sync_cursor.json');
const REASON_CACHE_FILE = path.join(process.cwd(), 'var', 'pause_reason_cache.json');

function readCursor() {
  try {
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Number(j.start || 0) || 0;
  } catch {
    return 0;
  }
}

function writeCursor(start) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ start: Number(start || 0) }, null, 2));
}

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}
function isFilled(v) { return !!toText(v); }

function daysCeil(ms) {
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function qsEncode(obj) {
  const out = [];
  const walk = (prefix, val) => {
    if (val == null) return;
    if (typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) walk(`${prefix}[${k}]`, v);
      return;
    }
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(`${prefix}[${i}]`, v));
      return;
    }
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(val))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return out.join('&');
}

function cmd(method, params) {
  const q = qsEncode(params || {});
  return q ? `${method}?${q}` : method;
}

function parseTask(batchResult, key) {
  const r = batchResult?.result?.result?.[key] || batchResult?.result?.[key] || null;
  const task = r?.task || r?.TASK || r?.result?.task || r?.result || null;
  return task || null;
}

function getTaskDeadline(task) { return task?.deadline || task?.DEADLINE || task?.['deadline'] || null; }
function getTaskTitle(task) { return task?.title || task?.TITLE || ''; }
function getTaskStatus(task) { return Number(task?.status || task?.STATUS || 0) || 0; }

function untilDeadlineMs(deadline) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime() - Date.now();
}

function inAllowedStages(stageId) {
  return LEAD_ALLOWED_STAGES_FOR_PAUSE.includes(String(stageId || ''));
}

async function listLeads(start) {
  return call('crm.lead.list', {
    order: { ID: 'ASC' },
    select: [
      'ID',
      'STATUS_ID',
      LEAD_PREV_STAGE_FIELD,
      LEAD_CONTACT_TASK_ID_FIELD,
      LEAD_NEXT_MEASURE_DATETIME_FIELD,
      LEAD_PAUSE_REASON_FIELD,
    ],
    start,
    filter: { STATUS_ID: [LEAD_PAUSE_STAGE_ID, ...LEAD_ALLOWED_STAGES_FOR_PAUSE] },
  });
}

function pushId(stats, bucketName, leadId, withIds, idLimit) {
  if (!withIds) return;

  // внутренние Set'ы для уникальности (в JSON не уходят)
  if (!stats._idSets) stats._idSets = {};
  if (!stats._idSets[bucketName]) stats._idSets[bucketName] = new Set();

  const id = Number(leadId);
  if (stats._idSets[bucketName].has(id)) return;
  stats._idSets[bucketName].add(id);

  if (!stats.ids[bucketName]) stats.ids[bucketName] = [];
  if (stats.ids[bucketName].length >= idLimit) return;

  stats.ids[bucketName].push(id);
}

async function getDefaultPauseReasonValue(withIds, stats, idLimit) {
  try {
    const raw = fs.readFileSync(REASON_CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && j.defaultText === LEAD_PAUSE_REASON_DEFAULT_TEXT && j.value != null) return j.value;
  } catch {}

  try {
    const list = await call('crm.lead.userfield.list', { filter: { FIELD_NAME: LEAD_PAUSE_REASON_FIELD } });
    const uf = Array.isArray(list) && list.length ? list[0] : null;
    const ufId = uf && (uf.ID || uf.id);
    if (!ufId) throw new Error('userfield not found');

    const ufFull = await call('crm.lead.userfield.get', { id: ufId });
    const items = ufFull?.LIST || ufFull?.list || [];

    let found = null;
    for (const it of items) {
      const text = String(it.VALUE || it.value || '').trim();
      if (text === LEAD_PAUSE_REASON_DEFAULT_TEXT) {
        found = it.ID || it.Id || it.id || it.XML_ID || it.xmlId || null;
        break;
      }
    }

    const value = found != null ? found : LEAD_PAUSE_REASON_DEFAULT_TEXT;
    fs.writeFileSync(REASON_CACHE_FILE, JSON.stringify({ defaultText: LEAD_PAUSE_REASON_DEFAULT_TEXT, value }, null, 2));
    return value;
  } catch (e) {
    if (withIds && stats.ids.errors.length < idLimit) {
      stats.ids.errors.push({ error: `pause reason lookup failed: ${String(e?.message || e)}` });
    }
    return LEAD_PAUSE_REASON_DEFAULT_TEXT;
  }
}

async function run({ maxLeads = 500, withIds = false, idLimit = 200 } = {}) {
  let start = readCursor();
  let processed = 0;

  const stats = {
    ok: true,
    startFrom: start,
    processed: 0,
    movedToPause: 0,
    restoredFromPause: 0,

    commentsToPause: 0,
    commentsRestore: 0,

    skippedFinal: 0,
    skippedStageNotAllowed: 0,
    skippedPrevStageNotAllowed: 0,

    skippedMeasure: 0,
    skippedNoTaskId: 0,
    skippedTaskNotFound: 0,
    skippedWrongTaskTitle: 0,
    skippedNoDeadline: 0,
    skippedNoPrevStage: 0,
    errors: 0,
    nextCursor: null,

    withIds,
    idLimit,
    ids: {
      movedToPause: [],
      restoredFromPause: [],

      commentsToPause: [],
      commentsRestore: [],

      skippedFinal: [],
      skippedStageNotAllowed: [],
      skippedPrevStageNotAllowed: [],

      skippedMeasure: [],
      skippedNoTaskId: [],
      skippedTaskNotFound: [],
      skippedWrongTaskTitle: [],
      skippedNoDeadline: [],
      skippedNoPrevStage: [],
      errors: [],
    },
  };

  const defaultReasonValue = await getDefaultPauseReasonValue(withIds, stats, idLimit);

  while (processed < maxLeads) {
    const page = await listLeads(start);
    const leads = page || [];

    if (!Array.isArray(leads) || leads.length === 0) {
      start = 0;
      writeCursor(0);
      stats.nextCursor = 0;
      break;
    }

    const candidates = [];
    for (const lead of leads) {
      if (processed >= maxLeads) break;

      const leadId = lead.ID;

      const sem = String(lead.STATUS_SEMANTIC_ID || '').trim();
      if (sem && sem !== 'P') {
        stats.skippedFinal++;
        pushId(stats, 'skippedFinal', leadId, withIds, idLimit);
        continue;
      }

      const taskId = Number(lead[LEAD_CONTACT_TASK_ID_FIELD] || 0);
      if (!taskId) {
        stats.skippedNoTaskId++;
        pushId(stats, 'skippedNoTaskId', leadId, withIds, idLimit);
        continue;
      }

      if (isFilled(lead[LEAD_NEXT_MEASURE_DATETIME_FIELD])) {
        stats.skippedMeasure++;
        pushId(stats, 'skippedMeasure', leadId, withIds, idLimit);
        continue;
      }

      const currentStage = String(lead.STATUS_ID || '');
      const prevStage = String(lead[LEAD_PREV_STAGE_FIELD] || '').trim();

      if (currentStage === LEAD_PAUSE_STAGE_ID) {
        if (!prevStage) {
          stats.skippedNoPrevStage++;
          pushId(stats, 'skippedNoPrevStage', leadId, withIds, idLimit);
          continue;
        }
        if (!inAllowedStages(prevStage)) {
          stats.skippedPrevStageNotAllowed++;
          pushId(stats, 'skippedPrevStageNotAllowed', leadId, withIds, idLimit);
          continue;
        }
        candidates.push({ lead, taskId });
        processed++;
        continue;
      }

      if (!inAllowedStages(currentStage)) {
        stats.skippedStageNotAllowed++;
        pushId(stats, 'skippedStageNotAllowed', leadId, withIds, idLimit);
        continue;
      }

      candidates.push({ lead, taskId });
      processed++;
    }

    // tasks.task.get батчами
    for (let i = 0; i < candidates.length; i += 50) {
      const chunk = candidates.slice(i, i + 50);

      const cmdMap = {};
      chunk.forEach((x, idx) => {
        cmdMap[`t${idx}`] = cmd('tasks.task.get', { taskId: x.taskId });
      });

      let tasksBatch;
      try {
        tasksBatch = await call('batch', { halt: 0, cmd: cmdMap });
      } catch (e) {
        stats.errors++;
        if (withIds && stats.ids.errors.length < idLimit) stats.ids.errors.push({ error: String(e?.message || e) });
        continue;
      }

      const updates = [];
      const comments = []; // { leadId, text, kind }

      for (let idx = 0; idx < chunk.length; idx++) {
        const { lead } = chunk[idx];
        const leadId = lead.ID;

        const task = parseTask(tasksBatch, `t${idx}`);
        if (!task) {
          stats.skippedTaskNotFound++;
          pushId(stats, 'skippedTaskNotFound', leadId, withIds, idLimit);
          continue;
        }

        const title = String(getTaskTitle(task) || '');
        if (!title.startsWith(CONTACT_TASK_TITLE_PREFIX)) {
          stats.skippedWrongTaskTitle++;
          pushId(stats, 'skippedWrongTaskTitle', leadId, withIds, idLimit);
          continue;
        }

        const status = getTaskStatus(task);
        if (status === 5 || status === 7) continue;

        const deadline = getTaskDeadline(task);
        if (!deadline) {
          stats.skippedNoDeadline++;
          pushId(stats, 'skippedNoDeadline', leadId, withIds, idLimit);
          continue;
        }

        const ms = untilDeadlineMs(deadline);
        if (ms == null) {
          stats.skippedNoDeadline++;
          pushId(stats, 'skippedNoDeadline', leadId, withIds, idLimit);
          continue;
        }

        const isFarMoreThan3Days = ms > (CONTACT_TASK_OVERDUE_DAYS * 24 * 60 * 60 * 1000);

        const currentStage = String(lead.STATUS_ID || '');
        const prevStage = String(lead[LEAD_PREV_STAGE_FIELD] || '').trim();

        // В ПАУЗУ
        if (isFarMoreThan3Days && currentStage !== LEAD_PAUSE_STAGE_ID) {
          const days = daysCeil(ms);
          updates.push({
            id: leadId,
            fields: {
              STATUS_ID: LEAD_PAUSE_STAGE_ID,
              [LEAD_PREV_STAGE_FIELD]: currentStage,
              [LEAD_PAUSE_REASON_FIELD]: defaultReasonValue,
            },
            kind: 'toPause',
          });
          comments.push({
            leadId,
            kind: 'toPause',
            text: `Переведено в ПАУЗУ, т.к. дата следующего контакта больше 3х дней (≈${days} дн.).`,
          });
          continue;
        }

        // ИЗ ПАУЗЫ
        if (!isFarMoreThan3Days && currentStage === LEAD_PAUSE_STAGE_ID) {
          const days = ms >= 0 ? daysCeil(ms) : 0;
          updates.push({
            id: leadId,
            fields: {
              STATUS_ID: prevStage,
              [LEAD_PREV_STAGE_FIELD]: '',
            },
            kind: 'restore',
          });
          comments.push({
            leadId,
            kind: 'restore',
            text: `Выведено из ПАУЗЫ, т.к. контакт через 3 дня и меньше (≈${days} дн.).`,
          });
        }
      }

      // update батч
      for (let u = 0; u < updates.length; u += 50) {
        const uChunk = updates.slice(u, u + 50);
        const cmdUpd = {};
        uChunk.forEach((it, k) => {
          cmdUpd[`u${k}`] = cmd('crm.lead.update', { id: it.id, fields: it.fields });
        });

        try {
          await call('batch', { halt: 0, cmd: cmdUpd });
        } catch (e) {
          stats.errors += uChunk.length;
          if (withIds) {
            for (const it of uChunk) {
              if (stats.ids.errors.length >= idLimit) break;
              stats.ids.errors.push({ leadId: Number(it.id), error: String(e?.message || e) });
            }
          }
          continue;
        }

        // считаем успешные апдейты
        uChunk.forEach(it => {
          if (it.kind === 'toPause') {
            stats.movedToPause++;
            pushId(stats, 'movedToPause', it.id, withIds, idLimit);
          }
          if (it.kind === 'restore') {
            stats.restoredFromPause++;
            pushId(stats, 'restoredFromPause', it.id, withIds, idLimit);
          }
        });
      }

      // комменты батч (до 50)
      for (let c = 0; c < comments.length; c += 50) {
        const cChunk = comments.slice(c, c + 50);
        const cmdC = {};
        cChunk.forEach((it, k) => {
          cmdC[`c${k}`] = cmd('crm.timeline.comment.add', {
            fields: {
              ENTITY_TYPE: 'lead',
              ENTITY_ID: Number(it.leadId),
              COMMENT: it.text,
            },
          });
        });

        try {
          await call('batch', { halt: 0, cmd: cmdC });
          cChunk.forEach(it => {
            if (it.kind === 'toPause') {
              stats.commentsToPause++;
              pushId(stats, 'commentsToPause', it.leadId, withIds, idLimit);
            } else {
              stats.commentsRestore++;
              pushId(stats, 'commentsRestore', it.leadId, withIds, idLimit);
            }
          });
        } catch (e) {
          stats.errors += cChunk.length;
          if (withIds && stats.ids.errors.length < idLimit) {
            stats.ids.errors.push({ error: `comment batch failed: ${String(e?.message || e)}` });
          }
        }
      }
    }

    const next = Number(page?.next || 0) || (start + leads.length);
    start = next;
    writeCursor(start);
    stats.nextCursor = start;

    if (leads.length < 50) break;
  }

  stats.processed = processed;
  return stats;
}

module.exports = { run };
