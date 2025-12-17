module.exports = {
  // Откуда брать телефон в лиде (первый найденный будет использован)
  LEAD_PHONE_FIELD_CODES: ['PHONE'],

  // Какие типы телефонов предпочитать (если в PHONE несколько)
  PHONE_TYPE_PRIORITY: ['MOBILE', 'WORK', 'HOME', 'OTHER'],

  // Имя контакта берём из поля лида (обычно TITLE)
  CONTACT_NAME_SOURCE_FIELD: 'TITLE',
  CONTACT_DEFAULT_NAME: 'Без имени',

  // Для PHONE в контакте
  CONTACT_PHONE_VALUE_TYPE: 'WORK', // или MOBILE
};
