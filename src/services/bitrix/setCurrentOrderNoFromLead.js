const { call } = require('./bitrixClient');
const { normalizeRuPhone, removePhoneFromText, removeAnyPhonesFromText } = require('../../utils/phone');
const {
  LEAD_1C_ORDER_FIELD,
  CONTACT_CURRENT_ORDERS_FIELD,
} = require('../../config/fields');

const createContactSvc = require('./createContactFromLead');

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickNormalizedLeadPhoneE164(lead) {
  const phones = Array.isArray(lead.PHONE) ? lead.PHONE : [];
  for (const p of phones) {
    const raw = toText(p.VALUE);
    const n = normalizeRuPhone(raw);
    if (n.ok) return n.e164;
  }
  return null;
}

function leadTitleWithoutPhone(lead) {
  const title = toText(lead.TITLE || lead.NAME || '');
  const e164 = pickNormalizedLeadPhoneE164(lead);

  if (e164) {
    const cleaned = removePhoneFromText(title, e164);
    return cleaned || title;
  }

  const cleaned = removeAnyPhonesFromText(title);
  return cleaned || title;
}

function getContactIdFromLead(lead) {
  return (
    Number(lead.CONTACT_ID) ||
    (Array.isArray(lead.CONTACT_IDS) && lead.CONTACT_IDS.length ? Number(lead.CONTACT_IDS[0]) : 0)
  );
}

async function run({ leadId }) {
  let lead = await call('crm.lead.get', { id: leadId });

  let contactId = getContactIdFromLead(lead);

  // Если контакта нет — создаём/привязываем (и заодно нормализуем телефон)
  if (!contactId) {
    await createContactSvc.run({ leadId });

    // Битрикс может обновить связь не мгновенно — подождём и перечитаем
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      lead = await call('crm.lead.get', { id: leadId });
      contactId = getContactIdFromLead(lead);
      if (contactId) break;
    }
  }

  if (!contactId) {
    return { ok: false, leadId, error: 'Contact not linked to lead yet (even after retry)' };
  }

  const orderNo = toText(lead[LEAD_1C_ORDER_FIELD]);

  // Если номера 1С нет — пишем TITLE лида без телефонов
  const valueToSet = orderNo || leadTitleWithoutPhone(lead) || 'Без названия';

  await call('crm.contact.update', {
    id: contactId,
    fields: {
      [CONTACT_CURRENT_ORDERS_FIELD]: valueToSet,
    },
  });

  return {
    ok: true,
    leadId,
    contactId,
    orderNo: orderNo || null,
    valueToSet,
    usedFallbackTitle: !orderNo,
  };
}

module.exports = { run };
