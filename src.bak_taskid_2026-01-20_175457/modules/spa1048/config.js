module.exports = {
  entityTypeId: 1048,

  // стадии (как ты прислал)
  stages: {
    active: ['DT1048_14:NEW', 'DT1048_14:PREPARATION', 'DT1048_14:CLIENT'],
    final:  ['DT1048_14:SUCCESS', 'DT1048_14:FAIL'],
  },

  // ВАЖНО: в crm.item.get в облаке коды полей приходят в camelCase
  fields: {
    deadlinePay: 'ufCrm8_1768219591855', // Крайний срок оплаты счёта (Дата)
    paidAt:      'ufCrm8_1768219659763', // Дата оплаты счёта (Дата)
    taskId:      'ufCrm8TaskId',         // ID задачи (целое)
    syncAt:      'ufCrm8SyncAt',         // SYNC_AT (datetime)
    syncSrc:     'ufCrm8SyncSrc',        // SYNC_SRC (string)
  },

  antiLoopSeconds: 4,

  // дедлайн задачи — всегда в 12:00 по МСК, чтобы не было плясок в датах
  taskDeadlineHour: 12,

  accountantIdEnv: 'SPA1048_ACCOUNTANT_ID',
};
