const path = require('path');
const fs = require('fs/promises');

const bitrix = require('../services/bitrix/bitrixClient');
const cfg = require('../config/spa1048');

// чтение UF из crm.item.get обычно приходит в camelCase
const F_READ = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
// запись надёжнее в оригинальном имени
const F_WRITE = process.env.SPA1048_FILES_FIELD_PAY_ORIG || 'UF_CRM_8_1768219060503';

function extractFilesList(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
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
  }
  return null;
}

(async () => {
  const itemId = Number(process.argv[2] || process.env.ITEM_ID || 0);
  if (!itemId) {
    console.error('Usage: node src/tools/testUploadSpa1048Txt.js <ITEM_ID>');
    process.exit(2);
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);

  // 1) читаем элемент, чтобы сохранить уже загруженные файлы (если поле множественное)
  const got = await bitrix.call('crm.item.get', { entityTypeId, id: itemId, select: ['*'] });
  const item = got?.item || got?.result?.item || got?.result || got;

  const currentFiles = extractFilesList(item?.[F_READ]);
  const keepIds = [];
  for (const f of currentFiles) {
    const fid = normalizeFileToken(f);
    if (fid) keepIds.push(Number(fid));
  }

  // 2) генерим TXT прямо на лету
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `test_${itemId}_${stamp}.txt`;
  const content = `Test upload from server\nitemId=${itemId}\nentityTypeId=${entityTypeId}\ncreatedAt=${new Date().toISOString()}\n`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');

  // 3) грузим как fileData
  const fileObj = { fileData: [fileName, b64] };

  const payload = {
    entityTypeId,
    id: itemId,
    fields: {
      [F_WRITE]: [...keepIds, fileObj],
    },
  };

  const res = await bitrix.call('crm.item.update', payload);

  console.log('OK: crm.item.update done');
  console.log({ entityTypeId, itemId, fieldWrite: F_WRITE, kept: keepIds.length, added: fileName });
  console.log('Result:', res);
})().catch((e) => {
  const msg = e?.data?.error_description || e?.message || String(e);
  console.error('ERROR:', msg);
  if (e?.data) console.error('Bitrix data:', JSON.stringify(e.data, null, 2));
  process.exit(1);
});
