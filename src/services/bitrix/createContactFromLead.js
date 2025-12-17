const { call } = require('./bitrixClient');
const { normalizePhone, removePhoneFromText } = require('../../utils/phone');
const {
  LEAD_PHONE_FIELD_CODES,
  PHONE_TYPE_PRIORITY,
  CONTACT_DEFAULT_NAME,
  CONTACT_PHONE_VALUE_TYPE,
  CONTACT_NAME_SOURCE_FIELD,
} = require('../../config/fields');

function pickPhoneFromMultifield(arr) {
  if (!Array.isArray(arr)) return null;

  const sorted = [...arr].sort((a, b) => {
    const pa = PHONE_TYPE_PRIORITY.indexOf(a.VALUE_TYPE);
    const pb = PHONE_TYPE_PRIORITY.indexOf(b.VALUE_TYPE);
    return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
  });

  for (const item of sorted) {
    const p = normalizePhone(item && item.VALUE);
    if (p) return p;
  }
  return null;
}

function extractLeadPhone(lead) {
  for (const code of LEAD_PHONE_FIELD_CODES) {
    const v = lead[code];
    if (code === 'PHONE') {
      const p = pickPhoneFromMultifield(v);
      if (p) return p;
    } else {
      const p = normalizePhone(v);
      if (p) return p;
    }
  }
  return null;
}

function buildContactNameFromLead(lead, phone) {
  const raw = lead[CONTACT_NAME_SOURCE_FIELD] || lead.TITLE || lead.NAME || '';
  const cleaned = removePhoneFromText(raw, phone);
  return (cleaned && cleaned.trim()) || CONTACT_DEFAULT_NAME;
}

async function findContactByPhone(phone) {
  const result = await call('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT',
    type: 'PHONE',
    values: [phone],
  });

  const ids = (result && (result.CONTACT || result['CONTACT'])) || [];
  return Array.isArray(ids) && ids.length ? Number(ids[0]) : null;
}

async function getContact(contactId) {
  return call('crm.contact.get', { id: contactId });
}

async function updateContactNameIfNeeded(contactId, desiredName) {
  if (!desiredName || desiredName === CONTACT_DEFAULT_NAME) return false;

  const contact = await getContact(contactId);
  const currentName = (contact && contact.NAME ? String(contact.NAME).trim() : '');

  if (!currentName || currentName === CONTACT_DEFAULT_NAME) {
    await call('crm.contact.update', {
      id: contactId,
      fields: { NAME: desiredName },
    });
    return true;
  }

  return false;
}

async function createContactFromLead(lead, phone) {
  const name = buildContactNameFromLead(lead, phone);

  const contactId = await call('crm.contact.add', {
    fields: {
      NAME: name,
      PHONE: [{ VALUE: phone, VALUE_TYPE: CONTACT_PHONE_VALUE_TYPE }],
    },
  });

  return Number(contactId);
}

async function linkLeadToContact(leadId, contactId) {
  await call('crm.lead.update', {
    id: leadId,
    fields: { CONTACT_ID: contactId },
  });
}

async function run({ leadId }) {
  const lead = await call('crm.lead.get', { id: leadId });

  const phone = extractLeadPhone(lead);
  if (!phone) return { ok: false, leadId, error: 'No phone found in lead' };

  const desiredName = buildContactNameFromLead(lead, phone);

  let contactId = await findContactByPhone(phone);
  let created = false;

  if (!contactId) {
    contactId = await createContactFromLead(lead, phone);
    created = true;
  }

  // если контакт уже был и он "Без имени" — перезаписываем имя
  const nameUpdated = await updateContactNameIfNeeded(contactId, desiredName);

  await linkLeadToContact(leadId, contactId);

  return { ok: true, leadId, contactId, created, phone, nameUpdated, desiredName };
}

module.exports = { run };
