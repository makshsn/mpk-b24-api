const fs = require('fs/promises');
const path = require('path');

const bitrix = require('./bitrixClient');

function extractFilesList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
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
  const keepIds = collectExistingFileIds(item, fieldRead);

  const res = await client.call('crm.item.update', {
    entityTypeId,
    id: itemId,
    fields: { [fieldWrite]: [...keepIds, fileObj] },
  });

  return { keepIds, response: res };
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
  normalizeFileToken,
  fetchCrmItem,
  collectExistingFileIds,
  buildFileDataFromPath,
  appendFileObjectToCrmItemField,
  appendFileFromPathToCrmItemField,
};
