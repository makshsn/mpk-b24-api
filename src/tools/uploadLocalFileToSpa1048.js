const fs = require('fs/promises');
const path = require('path');

const bitrix = require('../services/bitrix/bitrixClient');
const cfg = require('../config/spa1048');

const F_READ = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
const F_WRITE = process.env.SPA1048_FILES_FIELD_PAY_ORIG || 'UF_CRM_8_1768219060503';

function asArr(v){ return v ? (Array.isArray(v) ? v : [v]) : []; }
function normId(x){
  if (x == null) return null;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'string') { const m = x.match(/(\d+)/); return m ? m[1] : null; }
  if (typeof x === 'object') {
    return normId(x.id ?? x.ID ?? x.fileId ?? x.FILE_ID ?? x.value ?? x.VALUE);
  }
  return null;
}

(async () => {
  const itemId = Number(process.argv[2] || 0);
  const filePath = process.argv[3];
  if (!itemId || !filePath) {
    console.error('Usage: node src/tools/uploadLocalFileToSpa1048.js <ITEM_ID> <FILE_PATH>');
    process.exit(2);
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);

  // читаем текущие файлы, чтобы не потерять
  const got = await bitrix.call('crm.item.get', { entityTypeId, id: itemId, select: ['*'] });
  const item = got?.item || got?.result?.item || got?.result || got;

  const keepIds = [];
  for (const f of asArr(item?.[F_READ])) {
    const id = normId(f);
    if (id) keepIds.push(Number(id));
  }

  const buf = await fs.readFile(filePath);
  const b64 = buf.toString('base64');
  const fileName = path.basename(filePath);

  const fileObj = { fileData: [fileName, b64] };

  const res = await bitrix.call('crm.item.update', {
    entityTypeId,
    id: itemId,
    fields: { [F_WRITE]: [...keepIds, fileObj] },
  });

  console.log('OK uploaded:', { itemId, entityTypeId, fileName, kept: keepIds.length });
  console.log('Result field:', res?.item?.[F_READ] ?? res?.result?.item?.[F_READ] ?? res?.[F_READ]);
})().catch(e => {
  console.error('ERROR:', e?.data?.error_description || e?.message || String(e));
  if (e?.data) console.error(JSON.stringify(e.data, null, 2));
  process.exit(1);
});
