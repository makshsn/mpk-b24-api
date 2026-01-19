const fs = require('fs/promises');
const path = require('path');

const bitrix = require('./bitrixClient');

function extractFilesList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeBase64(b64) {
  const s = String(b64 || '');
  return s.replace(/^data:[^;]+;base64,/, '');
}

function normalizeFileToken(x) {
  if (x == null) return null;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'string') {
    const m = x.trim().match(/(\d+)/);
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

async function fetchCrmItem({ entityTypeId, itemId, client = bitrix }) {
  const got = await client.call('crm.item.get', { entityTypeId, id: itemId, select: ['*'] });
  return got?.item || got?.result?.item || got?.result || got;
}

function collectExistingFileIds(item, fieldRead) {
  const files = extractFilesList(item?.[fieldRead]);
  const ids = [];
  for (const f of files) {
    const fid = normalizeFileToken(f);
    if (fid) ids.push(Number(fid));
  }
  return ids;
}

function normalizeFileDataInput(input) {
  if (!input) return null;
  if (Array.isArray(input) && input.length >= 2) {
    return [input[0], input[1]];
  }
  if (typeof input === 'object') {
    if (Array.isArray(input.fileData) && input.fileData.length >= 2) {
      return [input.fileData[0], input.fileData[1]];
    }
    if (input.fileName && input.b64) {
      return [input.fileName, input.b64];
    }
  }
  return null;
}

function buildPayloadVariants(existingFiles, fileObj) {
  const normalized = normalizeFileDataInput(fileObj);
  if (!normalized) return [];
  const [fileName, b64] = normalized;
  const safeB64 = normalizeBase64(b64);
  const fileDataObj = { fileData: [fileName, safeB64] };
  const fileDataArr = [fileName, safeB64];
  const existingIds = (existingFiles || [])
    .map((x) => normalizeFileToken(x))
    .filter((x) => x)
    .map((x) => Number(x));

  return [
    buildUfMultiFilePayload(existingFiles, [fileDataObj]),
    [...existingIds, fileDataObj],
    [...existingIds, fileDataArr],
    buildUfMultiFilePayload(existingFiles, [fileDataArr]),
  ];
}

function isAdded(existingCount, nextFiles) {
  const nextCount = extractFilesList(nextFiles).length;
  return nextCount > existingCount;
}

function buildUfMultiFilePayload(existingArr, newFileDatas) {
  const out = [];

  for (const x of (existingArr || [])) {
    const id = (x && typeof x === 'object') ? (x.id ?? x.ID ?? x.value) : x;
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) out.push({ id: n });
  }

  for (const fd of (newFileDatas || [])) {
    const data = normalizeFileDataInput(fd);
    if (!data) continue;
    const name = data[0] || 'file.bin';
    const b64 = normalizeBase64(data[1] || '');
    out.push({ fileData: [name, b64] });
  }

  return out;
}

async function buildFileDataFromPath(filePath) {
  const buf = await fs.readFile(filePath);
  const b64 = buf.toString('base64');
  const fileName = path.basename(filePath);
  return {
    fileName,
    fileObj: { fileData: [fileName, b64] },
  };
}

async function appendFileObjectToCrmItemField({
  entityTypeId,
  itemId,
  fieldRead,
  fieldWrite,
  fileObj,
  client = bitrix,
}) {
  if (!entityTypeId || !itemId) throw new Error('entityTypeId and itemId are required');
  if (!fieldRead || !fieldWrite) throw new Error('fieldRead and fieldWrite are required');
  if (!fileObj) throw new Error('fileObj is required');

  const item = await fetchCrmItem({ entityTypeId, itemId, client });
  const existingFiles = extractFilesList(item?.[fieldRead]);
  const keepIds = collectExistingFileIds(item, fieldRead);
  const variants = buildPayloadVariants(existingFiles, fileObj);

  let lastRes = null;
  for (const payload of variants) {
    lastRes = await client.call('crm.item.update', {
      entityTypeId,
      id: itemId,
      fields: { [fieldWrite]: payload },
    });
    const nextItem = await fetchCrmItem({ entityTypeId, itemId, client });
    const nextFiles = nextItem?.[fieldRead];
    if (isAdded(existingFiles.length, nextFiles)) {
      return { keepIds, response: lastRes };
    }
  }

  return { keepIds, response: lastRes };
}

async function appendFileFromPathToCrmItemField({
  entityTypeId,
  itemId,
  fieldRead,
  fieldWrite,
  filePath,
  client = bitrix,
}) {
  if (!filePath) throw new Error('filePath is required');
  const { fileName, fileObj } = await buildFileDataFromPath(filePath);
  const result = await appendFileObjectToCrmItemField({
    entityTypeId,
    itemId,
    fieldRead,
    fieldWrite,
    fileObj,
    client,
  });
  return { fileName, ...result };
}

module.exports = {
  extractFilesList,
  normalizeBase64,
  normalizeFileToken,
  fetchCrmItem,
  collectExistingFileIds,
  buildPayloadVariants,
  buildUfMultiFilePayload,
  buildFileDataFromPath,
  appendFileObjectToCrmItemField,
  appendFileFromPathToCrmItemField,
};
