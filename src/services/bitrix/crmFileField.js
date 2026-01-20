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

async function fetchCrmItem({ entityTypeId, itemId, client = bitrix }) {
  const got = await client.call('crm.item.get', { entityTypeId, id: itemId, select: ['*'] });
  return got?.item || got?.result?.item || got?.result || got;
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

function buildAppendPayload(existingFiles, fileObj) {
  const data = normalizeFileDataInput(fileObj);
  if (!data) throw new Error('fileObj is invalid');
  const [fileName, b64] = data;
  const safeB64 = normalizeBase64(b64);
  const next = extractFilesList(existingFiles).filter((x) => x && typeof x === 'object');
  next.push({ fileData: [fileName, safeB64] });
  return next;
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
  const payload = buildAppendPayload(existingFiles, fileObj);

  const res = await client.call('crm.item.update', {
    entityTypeId,
    id: itemId,
    fields: { [fieldWrite]: payload },
  });

  return { response: res };
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
  appendFileObjectToCrmItemField,
  appendFileFromPathToCrmItemField,
};
