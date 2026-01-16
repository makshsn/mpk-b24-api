const bitrix = require('./bitrixClient');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const unzipper = require('unzipper');
const cfg = require('../../config/spa1048');

// В crm.item.get UF-файлы приходят в camelCase:
const F_FILES_PAY_READ = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
// Для update надёжнее использовать оригинальное имя:
const F_FILES_PAY_WRITE = process.env.SPA1048_FILES_FIELD_PAY_ORIG || 'UF_CRM_8_1768219060503';

const ZIP_MAX_FILES = Number(process.env.SPA1048_ZIP_MAX_FILES || 200);
const ZIP_MAX_PDF_MB = Number(process.env.SPA1048_ZIP_MAX_PDF_MB || 15);
const ZIP_CHUNK = Number(process.env.SPA1048_ZIP_CHUNK || 4);

function unwrap(resp) {
  return resp?.result ?? resp;
}

function normalizeStageId(x) {
  if (!x) return '';
  return String(x).trim().replace(/^['"]+|['"]+$/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function marker(fileId) {
  return `[file:${fileId}]`;
}

function extractMarkerId(title) {
  const m = String(title || '').match(/\[file:(\d+)\]\s*$/);
  return m ? m[1] : null;
}

function fileNameFromContentDisposition(cd) {
  if (!cd) return null;
  const s = String(cd);

  // RFC 5987: filename*=UTF-8''...
  const m1 = s.match(/filename\*\s*=\s*([^;]+)/i);
  if (m1) {
    let v = m1[1].trim();
    v = v.replace(/^UTF-8''/i, '');
    v = v.replace(/^["']|["']$/g, '');
    try { return decodeURIComponent(v); } catch (_e) { return v; }
  }

  // filename="..."
  const m2 = s.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m2) return m2[2].trim();

  return null;
}

function normalizeFileToken(x) {
  if (x == null) return null;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'string') {
    const s = x.trim();
    const m = s.match(/(\d+)/);
    return m ? m[1] : null;
  }
  if (typeof x === 'object') {
    if (x.id != null) return normalizeFileToken(x.id);
    if (x.ID != null) return normalizeFileToken(x.ID);
    if (x.fileId != null) return normalizeFileToken(x.fileId);
    if (x.FILE_ID != null) return normalizeFileToken(x.FILE_ID);
    if (x.attachedId != null) return normalizeFileToken(x.attachedId);
  }
  return null;
}

function extractFilesList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

async function resolveFileName(fileObjOrId) {
  const fileId = normalizeFileToken(fileObjOrId);
  if (!fileId) return null;

  const urlMachine =
    (fileObjOrId && typeof fileObjOrId === 'object')
      ? (fileObjOrId.urlMachine || fileObjOrId.url_machine || fileObjOrId.url)
      : null;

  if (urlMachine) {
    try {
      // HEAD часто запрещён — fallback на GET Range
      let resp = null;
      try {
        resp = await axios.head(urlMachine, { maxRedirects: 5, timeout: 20000, validateStatus: () => true });
      } catch (_e) {}

      if (!resp || resp.status >= 400) {
        resp = await axios.get(urlMachine, {
          headers: { Range: 'bytes=0-0' },
          responseType: 'arraybuffer',
          maxRedirects: 5,
          timeout: 20000,
          validateStatus: () => true,
        });
      }

      const cd = resp?.headers?.['content-disposition'] || resp?.headers?.['Content-Disposition'];
      const name = fileNameFromContentDisposition(cd);
      if (name) return String(name);

      const finalUrl = resp?.request?.res?.responseUrl;
      if (finalUrl) {
        const tail = String(finalUrl).split('?')[0].split('/').pop();
        if (tail && tail.includes('.')) return decodeURIComponent(tail);
      }
    } catch (_e2) {}
  }

  return `Файл #${fileId}`;
}

function isZipName(name) {
  return /\.zip$/i.test(String(name || ''));
}

function isPdfName(name) {
  return /\.pdf$/i.test(String(name || ''));
}

// Иногда в CRM file UF-полях Bitrix24 в ответе приходят только id/url,
// без имени файла. Поэтому ZIP/PDF лучше определять не по имени, а по "магии".
// Делаем лёгкий запрос с Range, чтобы не качать весь файл.
const _kindCache = new Map(); // fileId -> { kind: 'zip'|'pdf'|'other', ts }

function _bufHex(buf, n) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  return b.subarray(0, n).toString('hex');
}

function _kindByMagic(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b) return 'zip'; // PK..
  // %PDF-
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'pdf';
  return 'other';
}

async function sniffRemoteKind(fileObj) {
  const fid = normalizeFileToken(fileObj);
  const url = fileObj?.urlMachine || fileObj?.url;
  if (!fid || !url) return { kind: 'other', magic: '' };

  const cached = _kindCache.get(String(fid));
  const now = Date.now();
  if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) {
    return { kind: cached.kind, magic: cached.magic || '' };
  }

  // Bitrix иногда не поддерживает Range, поэтому делаем fallback на полный GET,
  // но лимитируем объём через maxContentLength.
  let head;
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { Range: 'bytes=0-31' },
      maxContentLength: 64 * 1024,
      maxBodyLength: 64 * 1024,
      timeout: 30000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    head = Buffer.from(r.data || []);
  } catch (e) {
    try {
      const r = await axios.get(url, {
        responseType: 'arraybuffer',
        maxContentLength: 64 * 1024,
        maxBodyLength: 64 * 1024,
        timeout: 30000,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      head = Buffer.from(r.data || []);
    } catch (e2) {
      // не смогли определить — считаем other
      const magic = '';
      _kindCache.set(String(fid), { kind: 'other', ts: now, magic });
      return { kind: 'other', magic };
    }
  }

  const kind = _kindByMagic(head);
  const magic = _bufHex(head, 8);
  _kindCache.set(String(fid), { kind, ts: now, magic });
  return { kind, magic };
}

async function isPdfMagicOnDisk(fp) {
  try {
    const fd = await fsp.open(fp, 'r');
    try {
      const buf = Buffer.alloc(5);
      const { bytesRead } = await fd.read(buf, 0, 5, 0);
      if (bytesRead < 5) return false;
      return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
    } finally {
      await fd.close();
    }
  } catch (_) {
    return false;
  }
}

function buildChecklistTitle(fileName, fileId) {
  return `🧾 ${fileName} ${marker(fileId)}`;
}

async function listChecklist(taskId) {
  const r = await bitrix.call('task.checklistitem.getlist', {
    TASKID: Number(taskId),
    ORDER: { ID: 'ASC' },
  });
  const u = unwrap(r);
  return Array.isArray(u) ? u : (Array.isArray(u?.items) ? u.items : []);
}

async function addChecklistItem(taskId, title) {
  return unwrap(await bitrix.call('task.checklistitem.add', {
    TASKID: Number(taskId),
    FIELDS: { TITLE: title, IS_COMPLETE: 'N' },
  }));
}

async function updateChecklistItem(taskId, itemId, title) {
  return unwrap(await bitrix.call('task.checklistitem.update', {
    TASKID: Number(taskId),
    ITEMID: Number(itemId),
    FIELDS: { TITLE: title },
  }));
}

async function deleteChecklistItem(taskId, itemId) {
  return unwrap(await bitrix.call('task.checklistitem.delete', {
    TASKID: Number(taskId),
    ITEMID: Number(itemId),
  }));
}

async function addSpaTimelineComment(itemId, text) {
  return { ok: true, skipped: true };
  return { ok: true, skipped: true };
  const et = Number(cfg.entityTypeId);
  const id = Number(itemId);

  const tries = [
    {
      method: 'crm.timeline.comment.add',
      params: { fields: { ENTITY_TYPE_ID: et, ENTITY_ID: id, COMMENT: text } },
    },
    {
      method: 'crm.timeline.comment.add',
      params: { fields: { ENTITY_TYPE: `DYNAMIC_${et}`, ENTITY_ID: id, COMMENT: text } },
    },
  ];

  let lastErr = null;
  for (const t of tries) {
    try {
      await bitrix.call(t.method, t.params);
      return { ok: true };
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = lastErr?.response?.data?.error_description || lastErr?.message || String(lastErr);
  return { ok: false, error: msg };
}

async function updateItemStagePaid(itemId) {
  const stagePaid = String(cfg.stagePaid || '').trim();
  if (!stagePaid) return { ok: false, error: 'cfg.stagePaid пустой (нужен SPA1048_STAGE_PAID в env)' };

  const r = await bitrix.call('crm.item.update', {
    entityTypeId: cfg.entityTypeId,
    id: Number(itemId),
    fields: {
      stageId: stagePaid,
      ufCrm8SyncAt: nowIso(),
      ufCrm8SyncSrc: 'server_paid_by_checklist',
    },
  });

  return { ok: true, result: unwrap(r), stagePaid };
}

async function completeTask(taskId) {
  try {
    return { ok: true, result: unwrap(await bitrix.call('tasks.task.complete', { taskId: Number(taskId) })) };
  } catch (e) {
    try {
      return { ok: true, result: unwrap(await bitrix.call('tasks.task.approve', { taskId: Number(taskId) })), fallback: 'tasks.task.approve' };
    } catch (e2) {
      const msg = e2?.response?.data?.error_description || e2?.message || String(e2);
      return { ok: false, error: msg };
    }
  }
}

async function withTempDir(prefix, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadToFile(url, filePath) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 180000, validateStatus: () => true, maxRedirects: 5 });
  if (res.status >= 400) throw new Error(`download failed: ${res.status}`);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    res.data.pipe(w);
    w.on('finish', resolve);
    w.on('error', reject);
  });
}

async function unzipPdfToDir(zipPath, outDir, { maxFiles = ZIP_MAX_FILES } = {}) {
  const out = [];
  let count = 0;

  const stream = fs.createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of stream) {
    const entryName = entry.path || '';
    const base = path.basename(entryName);

    if (entry.type !== 'File') { entry.autodrain(); continue; }

    count += 1;
    if (count > maxFiles) { entry.autodrain(); continue; }

    // 1) Сначала фильтруем по имени (дешево)
    if (!isPdfName(base)) { entry.autodrain(); continue; }

    const dest = path.join(outDir, base);
    await new Promise((resolve, reject) => {
      entry.pipe(fs.createWriteStream(dest))
        .on('finish', resolve)
        .on('error', reject);
    });
    // 2) Доп. проверка по сигнатуре. Встречаются "pdf"-файлы, которые на деле не PDF.
    const ok = await isPdfMagicFile(dest);
    if (!ok) {
      await fsp.unlink(dest).catch(() => {});
      continue;
    }
    out.push(dest);
  }

  return out;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function refetchItem(entityTypeId, itemId) {
  const r = await bitrix.call('crm.item.get', { entityTypeId: Number(entityTypeId), id: Number(itemId), select: ['*'] });
  return r?.item || r?.result?.item || r?.result || r;
}

/**
 * Распаковка ZIP из поля файлов:
 * - ZIP оставляем в поле, пока не загрузим хотя бы 1 PDF (поле у тебя обязательное)
 * - PDF грузим чанками (иначе таймаут/лимиты)
 * - после успеха удаляем ZIP из поля, оставляя только PDF/остальные файлы
 */
async function expandZipAttachments({ entityTypeId, itemId, files }) {
  const input = Array.isArray(files) ? files : [];
  if (!input.length) return { changed: false, files: input };

  const zipObjs = [];
  for (const f of input) {
    const fid = normalizeFileToken(f);
    if (!fid) continue;
    // Имя файла может быть недоступно в ответе crm.item.get. Поэтому:
    // 1) пытаемся получить имя (если есть)
    // 2) если по имени не понятно — нюхаем первые байты по urlMachine
    let name = '';
    try { name = await resolveFileName(f); } catch (_) { /* ignore */ }

    let isZip = isZipName(name);
    if (!isZip) {
      const url = f?.urlMachine || f?.url_machine || f?.url;
      if (url) {
        const kind = await sniffRemoteKind(f);
        isZip = (kind === 'zip');
      }
    }

    if (isZip) zipObjs.push({ f, fid, name: name || `file_${fid}.zip` });
  }
  if (!zipObjs.length) return { changed: false, files: input };

  // Текущий набор id (включая ZIP) — чтобы поле не стало пустым
  let currentItem = await refetchItem(entityTypeId, itemId);
  let currentFiles = extractFilesList(currentItem?.[F_FILES_PAY_READ]);

  const zipIds = new Set(zipObjs.map(z => String(z.fid)));

  let uploadedTotal = 0;

  for (const z of zipObjs) {
    const url = z.f?.urlMachine || z.f?.url_machine || z.f?.url;
    if (!url) continue;

    try {
      const { uploaded } = await withTempDir('mpkzip', async (dir) => {
        const zipPath = path.join(dir, z.name || `archive_${z.fid}.zip`);
        const outDir = path.join(dir, 'out');
        await fsp.mkdir(outDir, { recursive: true });

        await downloadToFile(url, zipPath);
        const pdfPaths = await unzipPdfToDir(zipPath, outDir, { maxFiles: ZIP_MAX_FILES });

        if (!pdfPaths.length) return { uploaded: 0 };

        const pdfChunks = chunk(pdfPaths, ZIP_CHUNK);

        let localUploaded = 0;

        for (const part of pdfChunks) {
          // ids того что уже лежит в поле (включая ZIP пока)
          const keepIds = [];
          for (const f of currentFiles) {
            const fid = normalizeFileToken(f);
            if (fid) keepIds.push(Number(fid));
          }

          const fileDatas = [];
          for (const pdfPath of part) {
            const st = await fsp.stat(pdfPath).catch(() => null);
            if (!st) continue;
            if (st.size > ZIP_MAX_PDF_MB * 1024 * 1024) continue;

            const buf = await fsp.readFile(pdfPath);
            const b64 = buf.toString('base64');
            const fileName = path.basename(pdfPath);
            fileDatas.push([fileName, b64]);

          }

          if (!fileDatas.length) continue;

          // добавляем PDF (ZIP остаётся, чтобы поле не было пустым)
          const beforeIds = new Set(keepIds.map((x) => String(x)));
          await bitrix.call('crm.item.update', {
            entityTypeId: Number(entityTypeId),
            id: Number(itemId),
            fields: { [F_FILES_PAY_WRITE]: [...keepIds, ...fileDatas] },
          });

          // перечитываем


          currentItem = await refetchItem(entityTypeId, itemId);


          currentFiles = extractFilesList(currentItem?.[F_FILES_PAY_READ]);



          localUploaded += fileDatas.length;
        }

        return { uploaded: localUploaded };
      });

      uploadedTotal += uploaded;
    } catch (e) {
      const msg = e?.response?.data?.error_description || e?.message || String(e);
      await addSpaTimelineComment(itemId, `ZIP распаковка: ошибка при добавлении PDF из "${z.name}": ${String(msg).slice(0, 180)}. ZIP оставлен.`);
      // при ошибке — не продолжаем удаление ZIP
      return { changed: false, files: input, error: msg };
    }
  }

  // если ничего не загрузили — ZIP оставляем как есть
  if (uploadedTotal <= 0) {
    await addSpaTimelineComment(itemId, `ZIP найден(ы) (${zipObjs.length}), но PDF не добавились (возможны лимиты/права). ZIP оставлен.`);
    return { changed: false, files: input, note: 'no_pdf_uploaded' };
  }

  // теперь удаляем ZIP из поля (оставляя всё остальное)
  try {
    const finalIds = [];
    for (const f of currentFiles) {
      const fid = normalizeFileToken(f);
      if (!fid) continue;
      if (zipIds.has(String(fid))) continue; // выкидываем ZIP
      finalIds.push(Number(fid));
    }

    if (finalIds.length > 0) {
      await bitrix.call('crm.item.update', {
        entityTypeId: Number(entityTypeId),
        id: Number(itemId),
        fields: { [F_FILES_PAY_WRITE]: finalIds },
      });
    }

    const finalItem = await refetchItem(entityTypeId, itemId);
    const finalFiles = extractFilesList(finalItem?.[F_FILES_PAY_READ]);

    await addSpaTimelineComment(itemId, `ZIP распакован: добавлено PDF (${uploadedTotal}), ZIP удалён (${zipObjs.length}).`);

    return { changed: true, files: finalFiles, removedZip: zipObjs.length, addedPdf: uploadedTotal };
  } catch (e2) {
    const msg = e2?.response?.data?.error_description || e2?.message || String(e2);
    await addSpaTimelineComment(itemId, `PDF добавлены (${uploadedTotal}), но удалить ZIP не удалось: ${String(msg).slice(0, 180)}.`);
    const finalItem = await refetchItem(entityTypeId, itemId);
    const finalFiles = extractFilesList(finalItem?.[F_FILES_PAY_READ]);
    return { changed: true, files: finalFiles, removedZip: 0, addedPdf: uploadedTotal, warn: msg };
  }
}

async function syncFilesChecklistAndMaybeClose({ itemId, taskId, item, stageId }) {
  // 1) сначала ZIP -> PDF (если нужно)
  let filesRaw = extractFilesList(item?.[F_FILES_PAY_READ]);

  const zipRes = await expandZipAttachments({
    entityTypeId: cfg.entityTypeId,
    itemId,
    files: filesRaw,
  });

  if (zipRes?.changed) {
    filesRaw = Array.isArray(zipRes.files) ? zipRes.files : filesRaw;
    item = { ...(item || {}), [F_FILES_PAY_READ]: filesRaw };
  }

  // 2) чеклист строим только по НЕ-ZIP (то есть по PDF и другим файлам)
  const files = extractFilesList(item?.[F_FILES_PAY_READ]);
  const uniqueFiles = files; // объекты (id/urlMachine) сохраняем как есть

  if (uniqueFiles.length === 0) {
    return { ok: true, files: 0, added: 0, updated: 0, deleted: 0, closed: false, note: 'no_files' };
  }

  const desired = new Map(); // fileId(string) -> title

  for (const f of uniqueFiles) {
    const fid = normalizeFileToken(f);
    if (!fid) continue;

    const name = await resolveFileName(f);

    // В поле могут оказаться ZIP/мусорные файлы (например, из архива).
    // Имена иногда отсутствуют, поэтому дополнительно проверяем "магию".
    const kind = await sniffRemoteKind(f);
    if (kind === 'zip') continue;
    if (!isPdfName(name) && kind !== 'pdf') continue;

    desired.set(fid, buildChecklistTitle(name, fid));
  }

  if (desired.size === 0) {
    // есть только ZIP или непонятные файлы
    return { ok: true, files: 0, added: 0, updated: 0, deleted: 0, closed: false, note: 'no_pdf_files' };
  }

  const existing = await listChecklist(taskId);

  const ours = existing
    .map((x) => {
      const id = x?.ID ?? x?.id;
      const title = x?.TITLE ?? x?.title;
      const isComplete = x?.IS_COMPLETE ?? x?.isComplete;
      const fid = extractMarkerId(title);
      return { id: Number(id), title: String(title || ''), isComplete: String(isComplete || ''), fid };
    })
    .filter((x) => x.id && x.fid);

  const oursByFid = new Map(ours.map((x) => [x.fid, x]));

  let added = 0, updated = 0, deleted = 0;

  for (const x of ours) {
    if (!desired.has(x.fid)) {
      await deleteChecklistItem(taskId, x.id);
      deleted++;
    }
  }

  for (const [fid, title] of desired.entries()) {
    if (!oursByFid.has(fid)) {
      await addChecklistItem(taskId, title);
      added++;
    }
  }

  for (const [fid, title] of desired.entries()) {
    const ex = oursByFid.get(fid);
    if (ex && ex.title !== title) {
      await updateChecklistItem(taskId, ex.id, title);
      updated++;
    }
  }

  const after = await listChecklist(taskId);
  const afterOurs = after
    .map((x) => {
      const id = x?.ID ?? x?.id;
      const title = x?.TITLE ?? x?.title;
      const isComplete = x?.IS_COMPLETE ?? x?.isComplete;
      const fid = extractMarkerId(title);
      return { id: Number(id), title: String(title || ''), isComplete: String(isComplete || ''), fid };
    })
    .filter((x) => x.id && x.fid);

  const relevant = afterOurs.filter((x) => desired.has(x.fid));

  const allDone =
    relevant.length === desired.size &&
    relevant.length > 0 &&
    relevant.every((x) => x.isComplete === 'Y' || x.isComplete === 'true' || x.isComplete === '1');

  let closed = false;
  let closeTaskRes = null;
  let moveRes = null;
  let timeline = null;

  if (allDone) {
    closeTaskRes = await completeTask(taskId);
    moveRes = await updateItemStagePaid(itemId);

    const st = normalizeStageId(stageId);
    const text =
      `Все пункты чеклиста по файлам закрыты. ` +
      `Задача #${taskId} завершена, счёт переведён в "успешно оплаченные".` +
      (st ? ` (стадия была: ${st})` : '');

    timeline = await addSpaTimelineComment(itemId, text);
    closed = closeTaskRes?.ok && moveRes?.ok;
  }

  return {
    ok: true,
    files: desired.size,
    added, updated, deleted,
    allDone,
    closed,
    closeTask: closeTaskRes,
    move: moveRes,
    timeline,
  };
}

module.exports = { syncFilesChecklistAndMaybeClose };
