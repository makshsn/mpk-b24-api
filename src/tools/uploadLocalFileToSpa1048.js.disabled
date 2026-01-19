const { appendFileFromPathToCrmItemField } = require('../services/bitrix/crmFileField');
const cfg = require('../config/spa1048');

const F_READ = process.env.SPA1048_FILES_FIELD_PAY_CAMEL || 'ufCrm8_1768219060503';
const F_WRITE = process.env.SPA1048_FILES_FIELD_PAY_ORIG || 'UF_CRM_8_1768219060503';

(async () => {
  const itemId = Number(process.argv[2] || 0);
  const filePath = process.argv[3];
  if (!itemId || !filePath) {
    console.error('Usage: node src/tools/uploadLocalFileToSpa1048.js <ITEM_ID> <FILE_PATH>');
    process.exit(2);
  }

  const entityTypeId = Number(process.env.SPA1048_ENTITY_TYPE_ID || cfg.entityTypeId || 1048);

  const { fileName, keepIds, response } = await appendFileFromPathToCrmItemField({
    entityTypeId,
    itemId,
    fieldRead: F_READ,
    fieldWrite: F_WRITE,
    filePath,
  });

  console.log('OK uploaded:', { itemId, entityTypeId, fileName, kept: keepIds.length });
  console.log('Result field:', response?.item?.[F_READ] ?? response?.result?.item?.[F_READ] ?? response?.[F_READ]);
})().catch(e => {
  console.error('ERROR:', e?.data?.error_description || e?.message || String(e));
  if (e?.data) console.error(JSON.stringify(e.data, null, 2));
  process.exit(1);
});
