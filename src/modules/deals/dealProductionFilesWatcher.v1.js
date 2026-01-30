'use strict';

const { getLogger } = require('../../services/logging');
const logger = getLogger('deal-files');

const bitrix = require('../../services/bitrix/bitrixClient');
const { safeSendDirectMessage } = require('../../services/bitrix/imMessaging.v1');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeScalar(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return String(v);
}

function normalizeFileValue(v) {
  const out = [];

  const push = (x) => {
    if (x === undefined || x === null) return;
    if (Array.isArray(x)) return x.forEach(push);
    if (x && typeof x === 'object') {
      const id = x.id ?? x.ID ?? x.value ?? x.VALUE;
      if (id !== undefined && id !== null) return push(id);
      return;
    }
    const s = normalizeScalar(x);
    if (s !== null && s !== '') out.push(String(s).trim());
  };

  push(v);
  return out.sort((a, b) => String(a).localeCompare(String(b)));
}

function deepEqualArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parseUserId(v) {
  if (Array.isArray(v)) {
    for (const it of v) {
      const n = parseUserId(it);
      if (n > 0) return n;
    }
    return 0;
  }
  if (v && typeof v === 'object') {
    const id = v.id ?? v.ID ?? v.value ?? v.VALUE;
    return toNum(id);
  }
  return toNum(v);
}

const TTL_SEC = Number(process.env.DEAL_FILES_MESSAGE_TTL_SEC || 300);
const seen = new Map();
function shouldSend(key) {
  const now = Date.now();
  const last = seen.get(key) || 0;
  if (now - last < TTL_SEC * 1000) return false;
  seen.set(key, now);
  return true;
}

function buildDealUrl(dealId) {
  const portal =
    String(process.env.B24_OAUTH_PORTAL || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') ||
    String(process.env.B24_PORTAL || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (!portal) return `/crm/deal/details/${Number(dealId)}/`;
  return `https://${portal}/crm/deal/details/${Number(dealId)}/`;
}

function buildMessageText({ dealId, dealTitle, changes }) {
  const title = String(dealTitle || '').trim() || `Сделка #${Number(dealId)}`;
  const url = buildDealUrl(dealId);

  return [
    changes.join('\n'),
    '',
    `Сделка: ${title} (#${Number(dealId)})`,
    `Ссылка: ${url}`,
  ].join('\n');
}

function pickTimelineClient() {
  // таймлайн тоже от бота, если задан отдельный вебхук
  const hasNotify = String(process.env.BITRIX_NOTIFY_WEBHOOK_BASE || '').trim();
  return hasNotify ? bitrix.notify : bitrix.main;
}

async function addTimelineComment({ dealId, text }) {
  const client = pickTimelineClient();

  const r = await client.call('crm.timeline.comment.add', {
    fields: {
      ENTITY_TYPE_ID: 2,
      ENTITY_ID: Number(dealId),
      COMMENT: String(text || ''),
    },
  }, { ctx: { step: 'crm.timeline.comment.add', entity: 'deal', dealId } });

  return { ok: true, result: r };
}

async function notifyUsers({ toUserIds, text, dedupKey }) {
  if (!Array.isArray(toUserIds) || !toUserIds.length) return { ok: true, action: 'no_recipients' };

  const uniq = [...new Set(toUserIds.map(toNum).filter((x) => x > 0))];
  if (!uniq.length) return { ok: true, action: 'no_recipients' };

  if (dedupKey && !shouldSend(dedupKey)) return { ok: true, action: 'dedup_dm' };

  const results = [];
  for (const uid of uniq) {
    try {
      const r = await safeSendDirectMessage({ toUserId: uid, message: text });
      results.push({ userId: uid, ok: true, res: r });
    } catch (e) {
      results.push({ userId: uid, ok: false, error: e?.message || String(e) });
    }
  }

  return { ok: true, results };
}

async function handleDealFileFieldChanges({ deal, prevSnapshot, nextSnapshot }) {
  const dealId = toNum(deal?.ID);
  if (!dealId) return { ok: true, action: 'skip_missing_deal_id' };

  // ВАЖНО: "0" трактуем как "фильтр выключен"
  const categoryFilterRaw = String(process.env.DEAL_PRODUCTION_CATEGORY_ID || '').trim();
  const categoryFilter = (categoryFilterRaw && categoryFilterRaw !== '0') ? categoryFilterRaw : '';

  if (categoryFilter) {
    const dealCategory = normalizeScalar(deal?.CATEGORY_ID);
    if (String(dealCategory || '') !== categoryFilter) {
      return { ok: true, action: 'skip_not_target_category', dealId, categoryId: dealCategory, expected: categoryFilter };
    }
  }

  const constructorField = String(process.env.DEAL_LEAD_CONSTRUCTOR_FIELD || 'UF_CRM_1752671444').trim();
  const fieldSpec = String(process.env.DEAL_SPEC_FILE_FIELD || 'UF_CRM_6877639A49D78').trim();
  const fieldCalc = String(process.env.DEAL_CALC_FILE_FIELD || 'UF_CRM_687A05AF2793F').trim();

  const prev = prevSnapshot?.item || {};
  const next = nextSnapshot?.item || {};

  const prevSpec = normalizeFileValue(prev[fieldSpec]);
  const nextSpec = normalizeFileValue(next[fieldSpec]);

  const prevCalc = normalizeFileValue(prev[fieldCalc]);
  const nextCalc = normalizeFileValue(next[fieldCalc]);

  const changes = [];
  if (!deepEqualArray(prevSpec, nextSpec)) changes.push('Изменён файл спецификации');
  if (!deepEqualArray(prevCalc, nextCalc)) changes.push('Изменён файл просчёта');

  if (!changes.length) return { ok: true, action: 'skip_no_relevant_changes', dealId };

  const text = buildMessageText({
    dealId,
    dealTitle: deal?.TITLE,
    changes,
  });

  // 1) таймлайн — всегда
  const timelineKey = `deal:${dealId}:timeline:${changes.join('|')}`;
  let timelineRes = null;
  try {
    if (!shouldSend(timelineKey)) {
      timelineRes = { ok: true, action: 'dedup_timeline' };
    } else {
      timelineRes = await addTimelineComment({ dealId, text });
    }
  } catch (e) {
    logger.error({ dealId, err: e?.message || String(e), data: e?.data }, '[deal-files] timeline comment failed');
    timelineRes = { ok: false, error: e?.message || String(e), data: e?.data };
  }

  // 2) личка — только если конструктор назначен
  const constructorId = parseUserId(deal?.[constructorField]);
  if (!constructorId) {
    return { ok: true, action: 'timeline_only_no_constructor', dealId, timeline: timelineRes, text };
  }

  const extraRaw = String(process.env.DEAL_FILES_NOTIFY_USER_IDS || '').trim();
  const extraIds = extraRaw
    ? extraRaw.split(',').map((s) => toNum(s.trim())).filter((n) => n > 0)
    : [];

  const recipients = [constructorId, ...extraIds];
  const dmKey = `deal:${dealId}:dm:${recipients.sort((a, b) => a - b).join(',')}:${changes.join('|')}`;

  const dmRes = await notifyUsers({ toUserIds: recipients, text, dedupKey: dmKey });

  return { ok: true, action: 'notified', dealId, constructorId, recipients, timeline: timelineRes, dm: dmRes, text };
}

module.exports = {
  handleDealFileFieldChanges,
};
