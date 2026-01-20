const { appendFileObjectToCrmItemField } = require('../services/bitrix/crmFileField');
const cfg = require('../config/spa1048');

// чтение UF из crm.item.get обычно приходит в camelCase
const F_READ = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
// запись надёжнее в оригинальном имени
const F_WRITE = process.env.SPA1048_FILES_FIELD_PAY_ORIG || 'UF_CRM_8_1768219060503';

(async () => {
  const itemId = Number(process.argv[2] || process.env.ITEM_ID || 0);
  if (!itemId) {
    console.error('Usage: node src/tools/testUploadSpa1048Txt.js <ITEM_ID>');
    process.exit(2);
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);

  // 1) генерим TXT прямо на лету
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `test_${itemId}_${stamp}.txt`;
  const content = `Test upload from server\nitemId=${itemId}\nentityTypeId=${entityTypeId}\ncreatedAt=${new Date().toISOString()}\n`;
  const b64 = Buffer.from(content, 'utf8').toString('base64');

  // 2) грузим как fileData
  const fileObj = { fileData: [fileName, b64] };

  const { response } = await appendFileObjectToCrmItemField({
    entityTypeId,
    itemId,
    fieldRead: F_READ,
    fieldWrite: F_WRITE,
    fileObj,
  });

  console.log('OK: crm.item.update done');
  console.log({ entityTypeId, itemId, fieldWrite: F_WRITE, added: fileName });
  console.log('Result:', response);
})().catch((e) => {
  const msg = e?.data?.error_description || e?.message || String(e);
  console.error('ERROR:', msg);
  if (e?.data) console.error('Bitrix data:', JSON.stringify(e.data, null, 2));
  process.exit(1);
});
