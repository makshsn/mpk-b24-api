const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const unzipper = require('unzipper');

const bitrix = require('./bitrixClient');
const cfg = require('../../config/spa1048');

function nowIso() { return new Date().toISOString(); }
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

function log(level, event, payload) {
  const line = JSON.stringify({ ts: nowIso(), level, event, ...payload });
  if (level === 'error') console.error(line);
  else console.log(line);
}

function extLower(name) { return path.extname(String(name || '')).toLowerCase(); }
function isZip(name) { return extLower(name) === '.zip'; }
function isPdf(name) { return extLower(name) === '.pdf'; }

function uniqByName(arr) {
  const seen = new Set();
  const out = [];
  for (const f of arr) {
    const k = String(f.name || '').toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** ---- дедуп комментариев (чтобы не спамить) ---- */
const COMMENT_TTL_SEC = Number(process.env.SPA1048_FILES_COMMENT_TTL_SEC || 600);
const commentSeen = new Map(); // key -> ts
function shouldPostComment(key) {
  const now = Date.now();
  const last = commentSeen.get(key) || 0;
  if (now - last < COMMENT_TTL_SEC * 1000) return false;
  commentSeen.set(key, now);
  return true;
}

async function addTimelineComment({ entityTypeId, entityId, text, dedupKey }) {
  try {
    if (dedupKey && !shouldPostComment(dedupKey)) {
      log('debug', 'TIMELINE_COMMENT_DEDUP', { entityId, dedupKey });
      return;
    }
    await bitrix.call('crm.timeline.comment.add', {
      fields: {
        ENTITY_TYPE_ID: Number(entityTypeId),
        ENTITY_ID: Number(entityId),
        COMMENT: String(text || ''),
      },
    }, { ctx: { step: 'timeline_comment' } });
  } catch (e) {
    log('error', 'TIMELINE_COMMENT_FAIL', { message: e?.message });
  }
}

/**
 * В UF(File multiple) могут лежать:
 * - число (fileId)
 * - объект {id, url, urlMachine, name, size}
 */
function parseFileField(raw) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(push);

    if (typeof v === 'object') {
      const id = toNum(v.id || v.ID || v.fileId || v.FILE_ID);
      out.push({
        id,
        name: v.name || v.NAME || v.originalName || v.ORIGINAL_NAME || null,
        size: toNum(v.size || v.SIZE),
        url: v.url || v.URL || null,
        urlMachine: v.urlMachine || v.URL_MACHINE || null,
      });
      return;
    }

    out.push({ id: toNum(v), name: null, size: 0, url: null, urlMachine: null });
  };

  push(raw);
  return out.filter(x => x.id > 0);
}

/** берём base вебхука (как в bitrixClient) */
function pickWebhookBase() {
  // сначала из config/env (если есть), потом env vars
  let env = {};
  try { env = require('../../config/env'); } catch (_) {}

  const base =
    env.BITRIX_WEBHOOK_BASE ||
    env.BITRIX_WEBHOOK_URL ||
    env.B24_WEBHOOK_URL ||
    process.env.BITRIX_WEBHOOK_BASE ||
    process.env.BITRIX_WEBHOOK_URL ||
    process.env.B24_WEBHOOK_URL ||
    process.env.B24_WEBHOOK ||
    process.env.BITRIX_WEBHOOK ||
    '';

  const s = String(base || '').trim();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Строим REST URL для скачивания CRM file:
 * .../crm.controller.item.getFile.json?entityTypeId=...&id=...&fieldName=...&fileId=...
 * ВАЖНО: fieldName используем в UPPER (как в UI).
 */
function buildCrmGetFileUrl({ entityTypeId, itemId, fieldNameUpper, fileId }) {
  const base = pickWebhookBase();
  if (!base) return null;

  const siteId = String(process.env.B24_SITE_ID || 's1');
  const qs = new URLSearchParams({
    entityTypeId: String(entityTypeId),
    id: String(itemId),
    fieldName: String(fieldNameUpper),
    fileId: String(fileId),
    SITE_ID: siteId,
  });

  return `${base}/crm.controller.item.getFile.json?${qs.toString()}`;
}

async function getItemFiles({ entityTypeId, itemId, fieldUpper, fieldCamel }) {
  const r = await bitrix.call('crm.item.get', {
    entityTypeId: Number(entityTypeId),
    id: Number(itemId),
    select: ['id', fieldUpper, fieldCamel],
  }, { ctx: { step: 'crm_item_get_files', itemId } });

  const item = r?.item || r?.result?.item || r?.result || r;

  const raw = (item && item[fieldCamel] !== undefined) ? item[fieldCamel] : item?.[fieldUpper];
  const files = parseFileField(raw);

  return { raw, files };
}

/**
 * Скачиваем файл:
 * - если urlMachine/url пришёл из поля — используем его
 * - если нет — строим crm.controller.item.getFile.json по fileId
 */
async function downloadToBuffer({ fileRef, entityTypeId, itemId, fieldNameUpper }) {
  const url =
    fileRef.urlMachine ||
    fileRef.url ||
    buildCrmGetFileUrl({
      entityTypeId,
      itemId,
      fieldNameUpper,
      fileId: fileRef.id,
    });

  if (!url) throw new Error(`no_download_url_for_id_${fileRef.id}`);

  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`download_http_${resp.status}_id_${fileRef.id}`);
  }
  return Buffer.from(resp.data);
}

/**
 * ZIP -> PDF buffers (лимиты: maxFiles, maxPdfMb)
 */
async function extractPdfsFromZip(zipPath, { maxFiles, maxPdfMb }) {
  const out = [];
  const maxBytes = Number(maxPdfMb) * 1024 * 1024;

  const dir = await unzipper.Open.file(zipPath);
  for (const entry of dir.files) {
    if (out.length >= maxFiles) break;
    if (entry.type !== 'File') continue;

    const name = entry.path.split('/').pop();
    if (!isPdf(name)) continue;
    if (entry.uncompressedSize > maxBytes) continue;

    const buf = await entry.buffer();
    out.push({ name, buffer: buf });
  }
  return out;
}

/**
 * Нормализация UF(File multiple) через fileData=[name, base64]
 */
async function normalizeSpaFiles({ entityTypeId, itemId }) {
  const fieldUpper = cfg.filesField || 'UF_CRM_8_1768219060503';
  const fieldCamel = cfg.filesFieldCamel || 'ufCrm8_1768219060503';

  const maxFiles = Number(process.env.SPA1048_FILES_MAX_FILES || 200);
  const maxPdfMb = Number(process.env.SPA1048_FILES_MAX_PDF_MB || 15);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'spa1048-files-'));

  try {
    const before = await getItemFiles({ entityTypeId, itemId, fieldUpper, fieldCamel });
    const beforeIds = before.files.map(f => f.id);

    log('debug', 'FILES_BEFORE', {
      itemId,
      fieldUpper,
      fieldCamel,
      beforeCount: beforeIds.length,
      beforeIds,
      rawType: Array.isArray(before.raw) ? 'array' : typeof before.raw,
    });

    if (!before.files.length) {
      await addTimelineComment({
        entityTypeId,
        entityId: itemId,
        text: `Поле файлов пустое (${fieldUpper}/${fieldCamel}). Нельзя продолжать: поле обязательное.`,
        dedupKey: `files_empty_${itemId}`,
      });
      return { ok: false, action: 'required_field_empty', beforeIds: [], afterIds: [] };
    }

    // скачиваем все файлы
    const downloaded = [];
    const downloadErrors = [];

    for (const f of before.files) {
      try {
        const buf = await downloadToBuffer({
          fileRef: f,
          entityTypeId,
          itemId,
          fieldNameUpper: fieldUpper,
        });

        // имя может не прийти — делаем техническое, но с правильным расширением
        let name = f.name;
        if (!name) name = `file_${f.id}`;

        downloaded.push({ id: f.id, name, buffer: buf });
      } catch (e) {
        downloadErrors.push({ id: f.id, error: e.message });
      }
    }

    if (downloadErrors.length) {
      log('error', 'FILES_DOWNLOAD_ERRORS', { itemId, downloadErrors });
      await addTimelineComment({
        entityTypeId,
        entityId: itemId,
        text: `Часть файлов не скачалась (${downloadErrors.length}). Пример: ${downloadErrors[0].id}: ${downloadErrors[0].error}`,
        dedupKey: `files_download_err_${itemId}`,
      });
    }

    if (!downloaded.length) {
      await addTimelineComment({
        entityTypeId,
        entityId: itemId,
        text: `Не удалось скачать ни одного файла из поля ${fieldUpper}/${fieldCamel}. Автонормализация невозможна.`,
        dedupKey: `files_download_none_${itemId}`,
      });
      return { ok: false, action: 'download_none', beforeIds, afterIds: [] };
    }

    // ZIP?
    const zips = downloaded.filter(x => isZip(x.name));
    const nonZips = downloaded.filter(x => !isZip(x.name));

    let extractedPdfs = [];
    if (zips.length) {
      const zip = zips[0];
      const zipPath = path.join(tmpRoot, `in_${zip.id}.zip`);
      await fsp.writeFile(zipPath, zip.buffer);

      extractedPdfs = await extractPdfsFromZip(zipPath, { maxFiles, maxPdfMb });

      log('debug', 'ZIP_EXTRACT', {
        itemId,
        zipId: zip.id,
        zipName: zip.name,
        pdfCount: extractedPdfs.length,
        maxFiles,
        maxPdfMb,
      });

      if (!extractedPdfs.length) {
        await addTimelineComment({
          entityTypeId,
          entityId: itemId,
          text: `ZIP (${zip.name}) найден, но подходящих PDF нет (или не прошли лимиты).`,
          dedupKey: `zip_no_pdf_${itemId}`,
        });
      }
    }

    // итоговый список upload:
    // если ZIP был и PDF извлечены -> ZIP не возвращаем
    // иначе -> reupload как есть
    let uploadList = [];
    if (zips.length && extractedPdfs.length) {
      uploadList = [
        ...nonZips.map(x => ({ name: x.name, buffer: x.buffer })),
        ...extractedPdfs.map(x => ({ name: x.name, buffer: x.buffer })),
      ];
    } else {
      uploadList = downloaded.map(x => ({ name: x.name, buffer: x.buffer }));
    }

    uploadList = uniqByName(uploadList);

    if (!uploadList.length) {
      await addTimelineComment({
        entityTypeId,
        entityId: itemId,
        text: `После подготовки файлов список пустой — обновление запрещено (поле обязательное).`,
        dedupKey: `files_would_be_empty_${itemId}`,
      });
      return { ok: false, action: 'would_be_empty', beforeIds, afterIds: [] };
    }

    const ufValue = uploadList.map(f => ({
      fileData: [f.name, f.buffer.toString('base64')],
    }));

    log('debug', 'FILES_UPDATE_PREPARED', {
      itemId,
      fieldCamel,
      uploadCount: ufValue.length,
      zipDetected: zips.length > 0,
      extractedPdfCount: extractedPdfs.length,
    });

    // ВАЖНО: update делаем по camelCase
    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [fieldCamel]: ufValue },
    }, { ctx: { step: 'crm_item_update_files', itemId } });

    const after = await getItemFiles({ entityTypeId, itemId, fieldUpper, fieldCamel });
    const afterIds = after.files.map(f => f.id);

    const res = {
      ok: true,
      action: (zips.length && extractedPdfs.length) ? 'zip_replaced_with_pdfs' : 'reuploaded',
      beforeIds,
      afterIds,
      beforeCount: beforeIds.length,
      afterCount: afterIds.length,
      zipDetected: zips.length > 0,
      extractedPdfCount: extractedPdfs.length,
      downloadErrors,
    };

    log('debug', 'FILES_AFTER', res);
    return res;
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  }
}

module.exports = { normalizeSpaFiles };
