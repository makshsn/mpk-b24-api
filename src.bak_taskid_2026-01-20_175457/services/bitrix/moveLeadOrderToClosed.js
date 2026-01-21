const { call } = require('./bitrixClient');
const {
  LEAD_1C_ORDER_FIELD,
  CONTACT_CLOSED_ORDERS_FIELD,
  CONTACT_CURRENT_ORDERS_FIELD,
  CLOSED_ORDERS_SEPARATOR,
} = require('../../config/fields');

function toText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(CLOSED_ORDERS_SEPARATOR).trim();
  return String(value).trim();
}

function appendEntry(existing, entry) {
  const ex = toText(existing);
  const en = toText(entry);
  if (!en) return ex;
  if (!ex) return en;
  return ex + CLOSED_ORDERS_SEPARATOR + en;
}

async function run({ leadId }) {
  // Лид: берем номер 1С и контакт
  const lead = await call('crm.lead.get', { id: leadId }); // :contentReference[oaicite:3]{index=3}

  const orderNo = toText(lead[LEAD_1C_ORDER_FIELD]);
  if (!orderNo) {
    return { ok: false, leadId, error: `Lead field ${LEAD_1C_ORDER_FIELD} is empty (1C order number)` };
  }

  const contactId =
    Number(lead.CONTACT_ID) ||
    (Array.isArray(lead.CONTACT_IDS) && lead.CONTACT_IDS.length ? Number(lead.CONTACT_IDS[0]) : 0);

  if (!contactId) {
    return { ok: false, leadId, error: 'Lead has no CONTACT_ID / CONTACT_IDS' };
  }

  // Контакт: читаем поля "текущие/закрытые"
  const contact = await call('crm.contact.get', { id: contactId }); // :contentReference[oaicite:4]{index=4}

  const oldCurrent = toText(contact[CONTACT_CURRENT_ORDERS_FIELD]);
  const existingClosed = contact[CONTACT_CLOSED_ORDERS_FIELD];

  // Формируем запись в "Закрытые заказы"
  const closedEntry = oldCurrent
    ? `${oldCurrent} -- ${orderNo}`
    : `-- ${orderNo}`; // если вдруг пусто, всё равно не ломаемся

  const newClosed = appendEntry(existingClosed, closedEntry);
  const newCurrent = orderNo; // "Текущие заказы" теперь только номер 1С

  // Обновляем контакт
  await call('crm.contact.update', {
    id: contactId,
    fields: {
      [CONTACT_CLOSED_ORDERS_FIELD]: newClosed,
      [CONTACT_CURRENT_ORDERS_FIELD]: newCurrent,
    },
  }); // :contentReference[oaicite:5]{index=5}

  return {
    ok: true,
    leadId,
    contactId,
    orderNo,
    oldCurrent,
    closedEntry,
    newCurrent,
  };
}

module.exports = { run };
