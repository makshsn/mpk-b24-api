const { call } = require('./bitrixClient');
const {
  normalizeRuPhone,
  removeAnyPhonesFromText,
} = require('../../utils/phone');

const {
  PHONE_TYPE_PRIORITY,
  CONTACT_DEFAULT_NAME,
  CONTACT_PHONE_VALUE_TYPE,
  CONTACT_NAME_SOURCE_FIELD,
} = require('../../config/fields');

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join('\n').trim();
  return String(v).trim();
}

function sortPhonesByPriority(arr) {
  return [...arr].sort((a, b) => {
    const pa = PHONE_TYPE_PRIORITY.indexOf(a.VALUE_TYPE);
    const pb = PHONE_TYPE_PRIORITY.indexOf(b.VALUE_TYPE);
    return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
  });
}

// Берём первый телефон, который можно нормализовать
function pickLeadPhone(lead) {
  const list = Array.isArray(lead.PHONE) ? sortPhonesByPriority(lead.PHONE) : [];
  for (const item of list) {
    const raw = toText(item.VALUE);
    const norm = normalizeRuPhone(raw);
    if (raw && norm.ok) return { raw, norm };
  }
  const raw = list.length ? toText(list[0].VALUE) : '';
  return { raw, norm: normalizeRuPhone(raw) };
}

function normalizeMultifieldPhones(list) {
  if (!Array.isArray(list)) return { out: [], changed: false };

  let changed = false;
  const out = list
    .map(item => {
      const raw = toText(item.VALUE);
      const n = normalizeRuPhone(raw);
      if (n.ok) {
        if (raw !== n.e164) changed = true;
        return { VALUE: n.e164, VALUE_TYPE: item.VALUE_TYPE || 'WORK' };
      }
      return { VALUE: raw, VALUE_TYPE: item.VALUE_TYPE || 'WORK' };
    })
    .filter(x => x.VALUE);

  return { out, changed };
}

function buildContactNameFromLead(lead) {
  const rawTitle = toText(lead[CONTACT_NAME_SOURCE_FIELD] || lead.TITLE || lead.NAME || '');
  const cleaned = removeAnyPhonesFromText(rawTitle).trim();
  return cleaned || CONTACT_DEFAULT_NAME;
}

async function findContactByPhone(raw, normalizedE164) {
  const values = [];
  if (normalizedE164) values.push(normalizedE164);
  if (raw && raw !== normalizedE164) values.push(raw);

  const result = await call('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT',
    type: 'PHONE',
    values,
  });

  const ids = (result && (result.CONTACT || result['CONTACT'])) || [];
  return Array.isArray(ids) && ids.length ? Number(ids[0]) : null;
}

async function getContact(contactId) {
  return call('crm.contact.get', { id: contactId });
}

async function updateLeadPhonesIfNeeded(leadId, phoneList) {
  const { out, changed } = normalizeMultifieldPhones(phoneList);
  if (!changed) return { updated: false };
  await call('crm.lead.update', { id: leadId, fields: { PHONE: out } });
  return { updated: true };
}

// ВАЖНО: TITLE делаем "имя без телефонов + один нормальный телефон"
async function updateLeadTitleIfNeeded(leadId, title, normalizedE164) {
  const oldTitle = toText(title);
  if (!oldTitle) return { updated: false };

  const base = removeAnyPhonesFromText(oldTitle).trim();
  const newTitle = (base ? `${base} ${normalizedE164}` : normalizedE164).trim();

  if (newTitle === oldTitle) return { updated: false };

  await call('crm.lead.update', { id: leadId, fields: { TITLE: newTitle } });
  return { updated: true, oldTitle, newTitle };
}

async function updateContactPhonesIfNeeded(contactId, phoneList) {
  const { out, changed } = normalizeMultifieldPhones(phoneList);
  if (!changed) return { updated: false };
  await call('crm.contact.update', { id: contactId, fields: { PHONE: out } });
  return { updated: true };
}

// NAME контакта чистим от любых телефонов (чтобы не было "+7..." в имени)
async function cleanContactNameIfNeeded(contactId, name) {
  const oldName = toText(name);
  if (!oldName) return { updated: false };

  const cleaned = removeAnyPhonesFromText(oldName).trim();
  if (!cleaned || cleaned === oldName) return { updated: false };

  await call('crm.contact.update', { id: contactId, fields: { NAME: cleaned } });
  return { updated: true };
}

async function updateContactNameIfNeeded(contactId, desiredName) {
  if (!desiredName || desiredName === CONTACT_DEFAULT_NAME) return false;

  const contact = await getContact(contactId);
  const currentName = toText(contact.NAME);

  if (!currentName || currentName === CONTACT_DEFAULT_NAME) {
    await call('crm.contact.update', { id: contactId, fields: { NAME: desiredName } });
    return true;
  }
  return false;
}

async function createContact(desiredName, normalizedE164) {
  const contactId = await call('crm.contact.add', {
    fields: {
      NAME: desiredName,
      PHONE: [{ VALUE: normalizedE164, VALUE_TYPE: CONTACT_PHONE_VALUE_TYPE }],
    },
  });
  return Number(contactId);
}

async function linkLeadToContact(leadId, contactId) {
  await call('crm.lead.update', { id: leadId, fields: { CONTACT_ID: contactId } });
}

async function run({ leadId }) {
  const lead = await call('crm.lead.get', { id: leadId });

  const { raw, norm } = pickLeadPhone(lead);
  if (!raw) return { ok: false, leadId, error: 'No phone in lead (PHONE empty)' };
  if (!norm.ok) return { ok: false, leadId, error: `Phone invalid: ${norm.reason}` };

  const normalizedPhone = norm.e164;

  const leadPhonesUpdated = (await updateLeadPhonesIfNeeded(leadId, lead.PHONE)).updated;
  const leadTitleUpdated = (await updateLeadTitleIfNeeded(leadId, lead.TITLE, normalizedPhone)).updated;

  let contactId = await findContactByPhone(raw, normalizedPhone);
  let created = false;

  const desiredName = buildContactNameFromLead(lead);

  if (!contactId) {
    contactId = await createContact(desiredName, normalizedPhone);
    created = true;
  } else {
    const contact = await getContact(contactId);
    const contactPhonesUpdated = (await updateContactPhonesIfNeeded(contactId, contact.PHONE)).updated;
    const contactNameCleaned = (await cleanContactNameIfNeeded(contactId, contact.NAME)).updated;
    const contactNameSet = await updateContactNameIfNeeded(contactId, desiredName);

    await linkLeadToContact(leadId, contactId);

    return {
      ok: true,
      leadId,
      contactId,
      created,
      phoneRaw: raw,
      phoneNormalized: normalizedPhone,
      leadPhonesUpdated,
      leadTitleUpdated,
      contactPhonesUpdated,
      contactNameCleaned,
      contactNameSet,
      desiredName,
    };
  }

  await linkLeadToContact(leadId, contactId);

  return {
    ok: true,
    leadId,
    contactId,
    created,
    phoneRaw: raw,
    phoneNormalized: normalizedPhone,
    leadPhonesUpdated,
    leadTitleUpdated,
    desiredName,
  };
}

module.exports = { run };
