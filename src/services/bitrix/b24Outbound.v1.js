function stripQuotes(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim().replace(/^['"]+|['"]+$/g, '');
}

function ensureObjectBody(req) {
  // если вдруг body пришло строкой
  if (typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body); } catch {}
  }
  // иногда data может быть строкой JSON
  if (req?.body && typeof req.body.data === 'string') {
    try { req.body.data = JSON.parse(req.body.data); } catch {}
  }
  return req.body || {};
}

function getApplicationToken(req) {
  const b = req?.body || {};
  return (
    b?.auth?.application_token ||
    b?.AUTH?.application_token ||
    b?.auth?.APPLICATION_TOKEN ||
    b?.AUTH?.APPLICATION_TOKEN ||
    b?.data?.auth?.application_token ||
    b?.data?.AUTH?.application_token ||
    req?.query?.application_token ||
    req?.query?.token ||
    null
  );
}

function verifyOutboundToken(req, envKey) {
  const expected = stripQuotes(process.env[envKey]);
  if (!expected) return { ok: true, mode: 'skip', envKey };
  const got = stripQuotes(getApplicationToken(req));
  if (!got) return { ok: false, reason: 'no_application_token', envKey };
  if (got !== expected) return { ok: false, reason: 'bad_application_token', envKey };
  return { ok: true, mode: 'checked', envKey };
}

function parsePositiveInt(value) {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function deepFindFirstInt(obj, wantedKeys, maxDepth = 6) {
  if (!obj || maxDepth <= 0) return null;
  if (typeof obj !== 'object') return null;

  // прямые ключи
  for (const k of wantedKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = Number(String(obj[k]).trim());
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  // рекурсивный обход
  for (const [k, v] of Object.entries(obj)) {
    if (!v) continue;
    if (typeof v === 'object') {
      const r = deepFindFirstInt(v, wantedKeys, maxDepth - 1);
      if (r) return r;
    } else if (typeof v === 'string' || typeof v === 'number') {
      // иногда формы прилетают как плоские ключи типа data[FIELDS][ID]
      if (/(\[ID\]$|^ID$|\.ID$)/i.test(k)) {
        const n = Number(String(v).trim());
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return null;
}

function extractSpaItemId(req) {
  const b = ensureObjectBody(req);
  // сначала стандартные пути
  const candidates = [
    req?.query?.itemId,
    req?.query?.id,
    b?.itemId,
    b?.id,
    b?.data?.FIELDS?.ID,
    b?.data?.FIELDS?.id,
    b?.data?.ID,
    b?.data?.id,
    b?.FIELDS?.ID,
    b?.FIELDS?.id,
  ];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    const n = Number(String(v).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  // fallback: глубокий поиск ID
  return deepFindFirstInt(b, ['ID', 'id']);
}

function extractTaskId(req) {
  const { taskId } = extractTaskIdDetailed(req);
  return taskId;
}

function extractTaskIdDetailed(req) {
  const b = ensureObjectBody(req);
  const candidates = [
    { value: b?.data?.FIELDS_AFTER?.TASK_ID, source: 'body.data.FIELDS_AFTER.TASK_ID' },
    { value: b?.data?.FIELDS_AFTER?.ID, source: 'body.data.FIELDS_AFTER.ID' },
    { value: req?.query?.taskId, source: 'query.taskId' },
    { value: req?.query?.id, source: 'query.id' },
    { value: b?.taskId, source: 'body.taskId' },
    { value: b?.id, source: 'body.id' },
    { value: b?.data?.FIELDS?.ID, source: 'body.data.FIELDS.ID' },
    { value: b?.data?.FIELDS?.id, source: 'body.data.FIELDS.id' },
    { value: b?.data?.ID, source: 'body.data.ID' },
    { value: b?.data?.id, source: 'body.data.id' },
  ];

  for (const candidate of candidates) {
    const n = parsePositiveInt(candidate.value);
    if (n !== null) return { taskId: n, source: candidate.source };
  }

  const deep = deepFindFirstInt(b, ['TASK_ID', 'taskId', 'ID', 'id']);
  if (deep) return { taskId: deep, source: 'deep_find_first_int' };
  return { taskId: null, source: 'not_found' };
}

module.exports = {
  ensureObjectBody,
  verifyOutboundToken,
  extractSpaItemId,
  extractTaskId,
  extractTaskIdDetailed,
};

/**
 * Self-check (без внешних библиотек):
 * node -e "const { extractTaskIdDetailed } = require('./src/services/bitrix/b24Outbound.v1'); const req={ body:{ event:'ONTASKCOMMENTADD', data:{ FIELDS_AFTER:{ ID:'0', MESSAGE_ID:'48760', TASK_ID:'2536' } }, auth:{ application_token:'demo'} }, query:{} }; console.log(extractTaskIdDetailed(req));"
 */
