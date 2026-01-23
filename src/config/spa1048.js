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
  accountantId: Number(process.env.SPA1048_ACCOUNTANT_ID || 70),

  // ВАЖНО: эти списки теперь парсятся корректно даже если в .env есть кавычки и пробелы
  stageActive: parseList(process.env.SPA1048_STAGE_ACTIVE),

  // success (оплачено)
  // Если env не задан, используем дефолтный код стадии успеха для SPA1048.
  stagePaid: process.env.SPA1048_STAGE_PAID || process.env.SPA1048_STAGE_SUCCESS || 'DT1048_14:SUCCESS',

  // финальные стадии (любые), например success/fail и т.п.
  stageFinal: parseList(process.env.SPA1048_STAGE_FINAL),

  // fail стадии (явно): то, что нужно игнорировать при проверке и переводе в "Срочно к оплате"
  // Можно задавать одним id или списком через запятую.
  // Если env не задан, используем дефолтный код fail для SPA1048.
  stageFail: parseList(process.env.SPA1048_STAGE_FAIL || process.env.SPA1048_STAGE_FAILURE || 'DT1048_14:FAIL'),

  // Код текущей стадии (в отдельном UF поле, если используется на портале)
  stageCodeField: 'UF_CRM_8_1768308894857',

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
