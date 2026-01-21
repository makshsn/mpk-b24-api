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
function isZipName(name) { return extLower(name) === '.zip'; }
function isPdfName(name) { return extLower(name) === '.pdf'; }
function nameKey(name) { return String(name || '').trim().toLowerCase(); }

function listNameSet(list) {
  const set = new Set();
  for (const item of list || []) {
    const key = nameKey(item?.name);
    if (key) set.add(key);
  }
  return set;
}

function isSameNameSet(a, b) {
  const setA = listNameSet(a);
  const setB = listNameSet(b);
  if (setA.size !== setB.size) return false;
  for (const key of setA) {
    if (!setB.has(key)) return false;
  }
  return true;
}

function detectExtByMagic(buf) {
  if (!buf || buf.length < 4) return '';
  // ZIP: PK..
  if (buf[0] === 0x50 && buf[1] === 0x4b) return '.zip';
  // PDF: %PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return '.pdf';
  return '';
}

function uniqByName(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const k = String(f.name || '').toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

function buildPdfList({ afterFiles, pdfNames }) {
  const byName = new Map();
  const unnamed = [];
  for (const f of afterFiles || []) {
    const id = toNum(f?.id || f?.ID);
    if (!id) continue;
    const name = String(f?.name || f?.NAME || '').trim();
    if (name) {
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { fileId: id, name });
    } else {
      unnamed.push({ fileId: id });
    }
  }

  const usedUnnamed = new Set();
  const out = [];
  const seen = new Set();
  for (const rawName of pdfNames || []) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let entry = byName.get(key);
    if (!entry) {
      const next = unnamed.find((u) => !usedUnnamed.has(u.fileId));
      if (next) {
        usedUnnamed.add(next.fileId);
        entry = { fileId: next.fileId, name };
      }
    }

    if (entry?.fileId) out.push({ fileId: entry.fileId, name });
  }

  return out;
}

/** ---- дедуп комментариев (чтобы не спамить) ---- */
const COMMENT_TTL_SEC = Number(process.env.SPA1048_FILES_COMMENT_TTL_SEC || 600);
const commentSeen = new Map();
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
 * UF(File multiple) обычно приходит как массив объектов: [{id:123}, ...]
 * Имён может не быть.
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
        urlMachine: v.urlMachine || v.URL_MACHINE || null,
        url: v.url || v.URL || null,
      });
      return;
    }
    out.push({ id: toNum(v), name: null, urlMachine: null, url: null });
  };
  push(raw);
  return out.filter(x => x.id > 0);
}

function pickWebhookBase() {
  const s = String(process.env.BITRIX_WEBHOOK_BASE || '').trim();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

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
  return { raw, files: parseFileField(raw) };
}

function parseFilenameFromContentDisposition(cd) {
  if (!cd) return null;
  const s = String(cd);

  // RFC5987: filename*=UTF-8''...
  const mStar = s.match(/filename\*\s*=\s*([^;]+)/i);
  if (mStar) {
    let v = mStar[1].trim();
    v = v.replace(/^UTF-8''/i, '').replace(/^["']|["']$/g, '');
    try { return decodeURIComponent(v); } catch (_e) { return v; }
  }

  // filename="..."
  const m = s.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m) return m[2];

  return null;
}

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

  const ct = String(resp.headers?.['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    const txt = Buffer.from(resp.data).toString('utf8').slice(0, 500);
    throw new Error(`download_json_instead_of_file_id_${fileRef.id}: ${txt}`);
  }

  const buf = Buffer.from(resp.data);
  const cd = resp.headers?.['content-disposition'];
  const filename = parseFilenameFromContentDisposition(cd);

  return { buffer: buf, filename };
}

async function extractPdfsFromZip(zipPath, { maxFiles, maxPdfMb }) {
  const out = [];
  const maxBytes = Number(maxPdfMb) * 1024 * 1024;

  const dir = await unzipper.Open.file(zipPath);
  for (const entry of dir.files) {
    if (out.length >= maxFiles) break;
    if (entry.type !== 'File') continue;

    const name = entry.path.split('/').pop();
    if (!isPdfName(name)) continue;
    if (entry.uncompressedSize > maxBytes) continue;

    const buf = await entry.buffer();
    out.push({ name, buffer: buf });
  }
  return out;
}

/**
 * Обновление поля файлами (перезапись).
 * Правильный формат: [[name, base64], ...]
 * Если payload слишком большой — chunk режим с накоплением id.
 */
async function updateUfFilesReplace({ entityTypeId, itemId, fieldCamel, fieldUpper, uploadList }) {
  if (!uploadList.length) throw new Error('upload_list_empty');

  const makePairs = (lst) => lst.map(f => [f.name, f.buffer.toString('base64')]);

  const chunk = Number(process.env.SPA1048_FILES_CHUNK || 0); // 0 = одним запросом
  if (!chunk || uploadList.length <= chunk) {
    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [fieldCamel]: makePairs(uploadList) },
    }, { ctx: { step: 'crm_item_update_files_replace', itemId } });
    return;
  }

  let existingIds = [];
  for (let i = 0; i < uploadList.length; i += chunk) {
    const part = uploadList.slice(i, i + chunk);
    const fieldsValue = [
      ...existingIds.map(id => ({ id })),
      ...makePairs(part),
    ];

    await bitrix.call('crm.item.update', {
      entityTypeId: Number(entityTypeId),
      id: Number(itemId),
      fields: { [fieldCamel]: fieldsValue },
    }, { ctx: { step: 'crm_item_update_files_chunk', itemId, partFrom: i, partCount: part.length } });

    const after = await getItemFiles({ entityTypeId, itemId, fieldUpper, fieldCamel });
    existingIds = after.files.map(f => f.id);

    if (!existingIds.length) {
      throw new Error(`chunk_update_result_empty_after_part_${i}`);
    }
  }
}

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
        text: `Поле файлов пустое (${fieldUpper}/${fieldCamel}). Поле обязательное — обработка остановлена.`,
        dedupKey: `files_empty_${itemId}`,
      });
      return { ok: false, action: 'required_field_empty', beforeIds: [], afterIds: [] };
    }

    const downloaded = [];
    const downloadErrors = [];

    for (const f of before.files) {
      try {
        const { buffer, filename } = await downloadToBuffer({ fileRef: f, entityTypeId, itemId, fieldNameUpper: fieldUpper });

        // 1) имя из поля
        // 2) имя из content-disposition
        // 3) fallback file_<id> + ext по сигнатуре
        let name = f.name || filename || `file_${f.id}`;
        const ext = extLower(name);
        if (!ext) {
          const guessed = detectExtByMagic(buffer);
          if (guessed) name = `${name}${guessed}`;
        }

        downloaded.push({ id: f.id, name, buffer });
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
        text: `Не удалось скачать ни одного файла из поля ${fieldUpper}/${fieldCamel}.`,
        dedupKey: `files_download_none_${itemId}`,
      });
      return { ok: false, action: 'download_none', beforeIds, afterIds: [] };
    }

    // ZIP детект: по имени ИЛИ по магии
    const zips = downloaded.filter(x => isZipName(x.name) || detectExtByMagic(x.buffer) === '.zip');
    const nonZips = downloaded.filter(x => !(isZipName(x.name) || detectExtByMagic(x.buffer) === '.zip'));
    const pdfsInField = downloaded.filter(x => isPdfName(x.name) || detectExtByMagic(x.buffer) === '.pdf');

    if (!zips.length && pdfsInField.length > 0) {
      const pdfNames = pdfsInField
        .map(x => x.name)
        .filter(x => String(x || '').toLowerCase().endsWith('.pdf'));
      const pdfList = buildPdfList({ afterFiles: before.files, pdfNames });

      log('debug', 'FILES_SKIP_NO_ZIP_PDF_ALREADY', {
        itemId,
        pdfCount: pdfNames.length,
        beforeCount: beforeIds.length,
      });

      return {
        ok: true,
        action: 'skipped_no_zip_pdf_already',
        beforeIds,
        afterIds: beforeIds,
        beforeCount: beforeIds.length,
        afterCount: beforeIds.length,
        zipDetected: false,
        extractedPdfCount: 0,
        pdfNames,
        pdfList,
        downloadErrors,
      };
    }

    let uploadList = [];
    let extractedPdfCount = 0;
    let action = 'reuploaded';

    if (zips.length) {
      const zip = zips[0];
      const zipPath = path.join(tmpRoot, `in_${zip.id}.zip`);
      await fsp.writeFile(zipPath, zip.buffer);

      const pdfs = await extractPdfsFromZip(zipPath, { maxFiles, maxPdfMb });
      extractedPdfCount = pdfs.length;

      log('debug', 'ZIP_EXTRACT', {
        itemId,
        zipId: zip.id,
        zipName: zip.name,
        pdfCount: extractedPdfCount,
        maxFiles,
        maxPdfMb,
      });

      if (!pdfs.length) {
        await addTimelineComment({
          entityTypeId,
          entityId: itemId,
          text: `ZIP найден, но подходящих PDF нет (или не прошли лимиты).`,
          dedupKey: `zip_no_pdf_${itemId}`,
        });
        uploadList = downloaded.map(x => ({ name: x.name, buffer: x.buffer }));
        action = 'reuploaded_zip_no_pdf';
      } else {
        // как ты просил: перезаписываем НОВЫМИ PDF (старые не сохраняем),
        // но nonZip оставляем (если хочешь убирать nonZip — скажи, выкину)
        uploadList = [
          ...nonZips.map(x => ({ name: x.name, buffer: x.buffer })),
          ...pdfs.map(x => ({ name: x.name, buffer: x.buffer })),
        ];
        action = 'zip_replaced_with_pdfs';
      }
    } else {
      uploadList = downloaded.map(x => ({ name: x.name, buffer: x.buffer }));
      action = 'reuploaded';
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

    if (isSameNameSet(uploadList, downloaded)) {
      const pdfNames = uploadList
        .filter(x => String(x.name || '').toLowerCase().endsWith('.pdf'))
        .map(x => x.name);
      const pdfList = buildPdfList({ afterFiles: before.files, pdfNames });

      log('debug', 'FILES_SKIP_NO_CHANGES', {
        itemId,
        action,
        uploadCount: uploadList.length,
      });

      return {
        ok: true,
        action: 'skipped_no_changes',
        beforeIds,
        afterIds: beforeIds,
        beforeCount: beforeIds.length,
        afterCount: beforeIds.length,
        zipDetected: zips.length > 0,
        extractedPdfCount,
        pdfNames,
        pdfList,
        downloadErrors,
      };
    }

    log('debug', 'FILES_UPDATE_PREPARED', {
      itemId,
      action,
      uploadCount: uploadList.length,
      zipDetected: zips.length > 0,
      extractedPdfCount,
    });

    await updateUfFilesReplace({ entityTypeId, itemId, fieldCamel, fieldUpper, uploadList });

    const after = await getItemFiles({ entityTypeId, itemId, fieldUpper, fieldCamel });
    const afterIds = after.files.map(f => f.id);

    const pdfNames = uploadList
      .filter(x => String(x.name || '').toLowerCase().endsWith('.pdf'))
      .map(x => x.name);
    const pdfList = buildPdfList({ afterFiles: after.files, pdfNames });

    const res = {
      ok: true,
      action,
      beforeIds,
      afterIds,
      beforeCount: beforeIds.length,
      afterCount: afterIds.length,
      zipDetected: zips.length > 0,
      extractedPdfCount,
      pdfNames,
      pdfList,
      downloadErrors,
    };

    log('debug', 'FILES_AFTER', res);

    if (!afterIds.length) {
      await addTimelineComment({
        entityTypeId,
        entityId: itemId,
        text: `⚠️ Bitrix вернул 200 OK, но поле файлов стало пустым после обновления. Нужна проверка формата/лимитов.`,
        dedupKey: `files_after_empty_${itemId}`,
      });
      return { ok: false, action: 'update_applied_but_empty', ...res };
    }

    return res;
  } finally {
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  }
}

module.exports = { normalizeSpaFiles };
