'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const bitrix = require('../../services/bitrix/bitrixClient');
const cfg = require('../../config/spa1048');
const { getLogger } = require('../../services/logging');

const logger = getLogger('spa1048');

function nowIso() { return new Date().toISOString(); }

function envBool(name, def = false) {
  const v = String(process.env[name] ?? '').trim().toUpperCase();
  if (!v) return def;
  if (['1', 'Y', 'YES', 'TRUE', 'ON'].includes(v)) return true;
  if (['0', 'N', 'NO', 'FALSE', 'OFF'].includes(v)) return false;
  return def;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toStr(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}

function safeFilename(name, fallback = 'file') {
  const s = String(name || '').trim() || fallback;
  const clean = s.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').slice(0, 180);
  return clean || fallback;
}

function storeDir() {
  return String(process.env.MAIL_STORE_DIR || path.join(process.cwd(), 'var', 'mail_store')).trim();
}

function emailJsonPath(emailId) {
  return path.join(storeDir(), 'emails', String(emailId), 'email.json');
}

function emailRootDir(emailId) {
  return path.join(storeDir(), 'emails', String(emailId));
}

async function loadEmailRecord(emailId) {
  const p = emailJsonPath(emailId);
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function saveEmailRecord(emailId, record) {
  const p = emailJsonPath(emailId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(record, null, 2), 'utf8');
}

function buildTitleFromSubject(subject) {
  const s = toStr(subject);
  if (!s) return 'Счёт (из письма)';
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

/** ---------- sender -> userId mapping ---------- */

function parseSenderUserMap() {
  // формат: a@b=72,c@d=36
  const raw = String(process.env.MAIL_SENDER_USER_MAP || '').trim();
  const map = new Map();
  if (!raw) return map;

  for (const part of raw.split(',')) {
    const p = String(part || '').trim();
    if (!p) continue;
    const idx = p.indexOf('=');
    if (idx === -1) continue;

    const email = p.slice(0, idx).trim().toLowerCase();
    const id = toNum(p.slice(idx + 1).trim());
    if (email && id) map.set(email, id);
  }
  return map;
}

function resolveUserIdBySenderEmail(senderEmail) {
  const email = String(senderEmail || '').trim().toLowerCase();
  if (!email) return 0;
  const map = parseSenderUserMap();
  return map.get(email) || 0;
}

/** ---------- allowed extensions ---------- */

function parseAllowedExt() {
  const raw = String(process.env.MAIL_ALLOWED_EXT || '').trim();
  if (!raw) return null; // null = фильтр выключен
  const set = new Set(
    raw
      .split(',')
      .map((x) => String(x || '').trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)
  );
  return set.size ? set : null;
}

function getExt(name) {
  const ext = path.extname(String(name || '')).toLowerCase().replace('.', '');
  return ext || '';
}

/** ---------- crm.item.fields cache (to avoid createdById ошибок) ---------- */

let _fieldsCache = null;
let _fieldsCacheAt = 0;

async function getSpaSupportedFields(entityTypeId) {
  const ttlMs = 10 * 60 * 1000; // 10 минут
  const now = Date.now();

  if (_fieldsCache && (now - _fieldsCacheAt) < ttlMs) return _fieldsCache;

  const r = await bitrix.call('crm.item.fields', { entityTypeId: Number(entityTypeId) }, { ctx: { step: 'crm_item_fields', entityTypeId } });
  const fields = r?.fields || r?.result?.fields || r?.result || r;

  const set = new Set();
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) set.add(key);
  }

  _fieldsCache = set;
  _fieldsCacheAt = now;

  return set;
}

/** ---------- timeline formatting ---------- */

function formatEmailTextForTimeline(rec, skippedFiles) {
  const lines = [];
  if (rec?.envelope?.from) lines.push(`От: ${rec.envelope.from}`);
  if (rec?.subject) lines.push(`Тема: ${rec.subject}`);
  if (rec?.date) lines.push(`Дата: ${rec.date}`);
  lines.push('');

  const text = toStr(rec?.text);
  if (text) lines.push(text);

  const att = Array.isArray(rec?.attachments) ? rec.attachments : [];
  if (att.length) {
    lines.push('');
    lines.push('Вложения (в письме):');
    for (const a of att) {
      const mb = a?.size ? (a.size / 1024 / 1024).toFixed(2) : '?';
      lines.push(`- ${a?.filename || a?.storedAs || 'file'} (${mb} MB)`);
    }
  }

  if (Array.isArray(skippedFiles) && skippedFiles.length) {
    lines.push('');
    lines.push('Не прикреплено в счёт (фильтр/лимиты):');
    for (const s of skippedFiles) {
      const mb = s?.size ? (s.size / 1024 / 1024).toFixed(2) : '?';
      lines.push(`- ${s?.name || 'file'} (${mb} MB): ${s?.reason || 'skipped'}`);
    }
  }

  return lines.join('\n').trim();
}

function chunkText(text, maxLen = 3500) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    out.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

async function addSpaTimelineComment({ entityTypeId, entityId, text }) {
  if (!text) return;
  await bitrix.call('crm.timeline.comment.add', {
    fields: {
      ENTITY_TYPE_ID: Number(entityTypeId),
      ENTITY_ID: Number(entityId),
      COMMENT: String(text),
    },
  }, { ctx: { step: 'spa_email_timeline_comment', entityId } });
}

function buildUploadPairs(uploadList) {
  return uploadList.map(f => [f.name, f.buffer.toString('base64')]);
}

function enforceSizeLimits(files) {
  const maxOneMb = Math.max(1, Number(process.env.SPA1048_EMAIL_MAX_FILE_MB || 20));
  const maxTotalMb = Math.max(5, Number(process.env.SPA1048_EMAIL_MAX_TOTAL_MB || 60));
  const maxOne = maxOneMb * 1024 * 1024;
  const maxTotal = maxTotalMb * 1024 * 1024;

  const ok = [];
  const skipped = [];
  let total = 0;

  for (const f of files || []) {
    const size = f?.buffer?.length || 0;
    if (!size) continue;

    if (size > maxOne) {
      skipped.push({ name: f.name, size, reason: `too_large_single>${maxOneMb}MB` });
      continue;
    }
    if (total + size > maxTotal) {
      skipped.push({ name: f.name, size, reason: `too_large_total>${maxTotalMb}MB` });
      continue;
    }

    total += size;
    ok.push(f);
  }

  return { ok, skipped, total, maxOneMb, maxTotalMb };
}

async function readAttachmentsFromStore(rec, emailId) {
  const allowedExt = parseAllowedExt();

  const ok = [];
  const skipped = [];

  for (const a of rec.attachments || []) {
    const p = a?.path;
    const name0 = safeFilename(a.filename || a.storedAs || path.basename(p || 'file'));

    const ext = getExt(name0);
    if (allowedExt && ext && !allowedExt.has(ext)) {
      skipped.push({ name: name0, size: a?.size || 0, reason: `extension_not_allowed:${ext}` });
      continue;
    }

    if (allowedExt && !ext) {
      skipped.push({ name: name0, size: a?.size || 0, reason: 'extension_not_allowed:empty' });
      continue;
    }

    if (!p) {
      skipped.push({ name: name0, size: a?.size || 0, reason: 'no_path' });
      continue;
    }

    try {
      const buf = await fsp.readFile(p);
      ok.push({
        name: name0,
        buffer: buf,
        meta: { storedPath: p, contentType: a.contentType || '' },
      });
    } catch (e) {
      logger.warn({ emailId, err: e?.message, path: p }, '[spa1048][email] failed to read attachment');
      skipped.push({ name: name0, size: a?.size || 0, reason: 'read_failed' });
    }
  }

  return { ok, skipped };
}

function buildBodyFileIfNeeded(rec) {
  const attachBody = envBool('SPA1048_EMAIL_ATTACH_BODY_FILE', true);
  if (!attachBody) return null;

  const hasAttachments = Array.isArray(rec?.attachments) && rec.attachments.length > 0;
  if (hasAttachments) return null;

  const subjectBase = safeFilename(rec?.subject || 'email', 'email');

  if (rec?.html) {
    return {
      name: `${subjectBase}.html`,
      buffer: Buffer.from(String(rec.html), 'utf8'),
      meta: { kind: 'email_body_html' },
    };
  }

  const txt = toStr(rec?.text);
  if (txt) {
    return {
      name: `${subjectBase}.txt`,
      buffer: Buffer.from(txt, 'utf8'),
      meta: { kind: 'email_body_text' },
    };
  }

  return null;
}

async function updateUfFilesReplace({ entityTypeId, itemId, fieldCamel, uploadList }) {
  if (!uploadList.length) return { ok: true, skipped: 'no_files' };

  const chunk = Number(process.env.SPA1048_FILES_CHUNK || 0);

  if (!chunk || uploadList.length <= chunk) {
    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [fieldCamel]: buildUploadPairs(uploadList) },
    }, { ctx: { step: 'crm_item_update_files', itemId } });

    return { ok: true, mode: 'single', count: uploadList.length };
  }

  let existingIds = [];

  for (let i = 0; i < uploadList.length; i += chunk) {
    const part = uploadList.slice(i, i + chunk);
    const fieldsValue = [
      ...existingIds.map(id => ({ id })),
      ...buildUploadPairs(part),
    ];

    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [fieldCamel]: fieldsValue },
    }, { ctx: { step: 'crm_item_update_files_chunk', itemId, partFrom: i, partCount: part.length } });

    const r = await bitrix.call('crm.item.get', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      select: ['id', fieldCamel],
    }, { ctx: { step: 'crm_item_get_after_chunk', itemId } });

    const item = r?.item || r?.result?.item || r?.result || r;
    const raw = item?.[fieldCamel];

    const ids = [];
    const push = (v) => {
      if (!v) return;
      if (Array.isArray(v)) return v.forEach(push);
      if (typeof v === 'object') {
        const id = toNum(v.id || v.ID || v.fileId || v.FILE_ID);
        if (id) ids.push(id);
        return;
      }
      const id = toNum(v);
      if (id) ids.push(id);
    };
    push(raw);

    existingIds = Array.from(new Set(ids));
    if (!existingIds.length) throw new Error(`chunk_update_empty_after_part_${i}`);
  }

  return { ok: true, mode: 'chunk', count: uploadList.length, chunk };
}

async function pruneLocalStoreAfterProcess(emailId, keepMinimalRecord) {
  const debugKeep = envBool('MAIL_STORE_DEBUG_KEEP', false);
  if (debugKeep) return { ok: true, mode: 'debug_keep' };

  const root = emailRootDir(emailId);
  const attachmentsDir = path.join(root, 'attachments');
  const rawEml = path.join(root, 'raw.eml');

  try { await fsp.rm(attachmentsDir, { recursive: true, force: true }); } catch (_) {}
  try { await fsp.rm(rawEml, { force: true }); } catch (_) {}

  if (!keepMinimalRecord) {
    try { await fsp.rm(root, { recursive: true, force: true }); } catch (_) {}
    return { ok: true, mode: 'deleted_all' };
  }

  return { ok: true, mode: 'pruned_heavy_only' };
}

/**
 * @param {Object} params
 * @param {string} params.emailId
 * @param {string} [params.senderEmail] - для маппинга постановщика/ответственного
 */
async function createSpa1048FromStoredEmail({ emailId, senderEmail }) {
  if (!emailId) throw new Error('emailId is required');

  const entityTypeId = Number(cfg.entityTypeId || 1048);
  const fieldCamel = cfg.filesFieldCamel || 'ufCrm8_1768219060503';

  const rec = await loadEmailRecord(emailId);
  const title = buildTitleFromSubject(rec?.subject);
  const createdAt = nowIso();

  const mappedUserId = resolveUserIdBySenderEmail(senderEmail || rec?.envelope?.fromAddr || '');
  const supportedFields = await getSpaSupportedFields(entityTypeId);

  const fieldsForAdd = {
    title,
    [cfg.syncSrcField]: 'email',
    [cfg.syncAtField]: createdAt,
  };

  // Ответственный
  if (mappedUserId) {
    fieldsForAdd.assignedById = mappedUserId;
  }

  // Постановщик (если поле поддерживается)
  if (mappedUserId && supportedFields.has('createdById')) {
    fieldsForAdd.createdById = mappedUserId;
  }

  const addRes = await bitrix.call('crm.item.add', {
    entityTypeId,
    fields: fieldsForAdd,
  }, { ctx: { step: 'crm_item_add_spa1048_from_email', emailId, mappedUserId } });

  const item = addRes?.item || addRes?.result?.item || addRes?.result || addRes;
  const itemId = toNum(item?.id || item?.ID);
  if (!itemId) throw new Error('cannot_extract_spa_itemId');

  const readRes = await readAttachmentsFromStore(rec, emailId);
  let files = readRes.ok;

  const bodyFile = buildBodyFileIfNeeded(rec);
  if (bodyFile) files.push(bodyFile);

  const limited = enforceSizeLimits(files);
  files = limited.ok;

  const skippedAll = [...(readRes.skipped || []), ...(limited.skipped || [])];

  const uploadRes = await updateUfFilesReplace({
    entityTypeId,
    itemId,
    fieldCamel,
    uploadList: files,
  });

  const timelineText = formatEmailTextForTimeline(rec, skippedAll);
  const parts = chunkText(timelineText, 3500);
  for (let i = 0; i < parts.length; i++) {
    await addSpaTimelineComment({
      entityTypeId,
      entityId: itemId,
      text: i === 0 ? parts[i] : `Продолжение (${i + 1}/${parts.length})\n${parts[i]}`,
    });
  }

  const keepTextMinimal = envBool('MAIL_STORE_KEEP_TEXT_MINIMAL', true);

  const updated = {
    ...rec,
    processedAt: nowIso(),
    processedTo: { entityTypeId, itemId },
    processedUserId: mappedUserId || null,
  };

  if (keepTextMinimal) {
    updated.html = '';
    if (updated.text && updated.text.length > 5000) updated.text = `${updated.text.slice(0, 5000)}\n\n[...cut...]`;
  }

  await saveEmailRecord(emailId, updated);
  const pruneRes = await pruneLocalStoreAfterProcess(emailId, true);

  logger.info({ emailId, itemId, uploadRes, pruned: pruneRes.mode, mappedUserId }, '[spa1048][email] created');

  return {
    ok: true,
    emailId,
    itemId,
    title,
    mappedUserId: mappedUserId || null,
    upload: uploadRes,
    skippedAttachments: skippedAll,
    pruned: pruneRes,
  };
}

module.exports = {
  createSpa1048FromStoredEmail,
};
