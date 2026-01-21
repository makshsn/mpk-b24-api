function parseList(v) {
  if (!v) return [];
  return String(v)
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/^['"]+|['"]+$/g, '')) // снимаем кавычки вокруг
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = {
  entityTypeId: Number(process.env.SPA1048_ENTITY_TYPE_ID || 1048),
  accountantId: Number(process.env.SPA1048_ACCOUNTANT_ID || 1),

  // ВАЖНО: эти списки теперь парсятся корректно даже если в .env есть кавычки и пробелы
  stageActive: parseList(process.env.SPA1048_STAGE_ACTIVE),
  stagePaid: process.env.SPA1048_STAGE_PAID || process.env.SPA1048_STAGE_SUCCESS || '',

  stageFinal: parseList(process.env.SPA1048_STAGE_FINAL),

  // поля SPA
  deadlineField: 'UF_CRM_8_1768219591855',
  paidAtField: 'UF_CRM_8_1768219659763',
  // можно переопределить, если на портале поле называется иначе
  taskIdField: String(process.env.SPA1048_TASK_ID_FIELD_ORIG || 'UF_CRM_8_TASK_ID'),
  syncAtField: 'UF_CRM_8_SYNC_AT',
  syncSrcField: 'UF_CRM_8_SYNC_SRC',

  // Файлы счёта на оплату (UF множественное)
  filesField: 'UF_CRM_8_1768219060503',
  filesFieldCamel: 'ufCrm8_1768219060503',
};
