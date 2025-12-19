const { call } = require('./bitrixClient');
const {
  LEAD_1C_ORDER_FIELD,
  CONTACT_CLOSED_ORDERS_FIELD,
  CONTACT_CURRENT_ORDERS_FIELD,
  CLOSED_ORDERS_SEPARATOR,
} = require('../../config/fields');

function toText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(CLOSED_ORDERS_SEPARATOR).trim();
  return String(v).trim();
}

function splitLines(v) {
  const t = toText(v);
  if (!t) return [];
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// если текущее значение уже вида "что-то -- что-то", берём только левую часть (старое имя)
function baseNameFromCurrent(currentText) {
  const t = toText(currentText);
  if (!t) return '';
  const parts = t.split(/\s*--\s*/);
  return (parts[0] || '').trim();
}

function upsertClosedByOrderNo(closedValue, orderNo, newEntry) {
  const lines = splitLines(closedValue);

  // заменяем любые строки, где встречается orderNo (чтобы “затирать старое название”)
  let replaced = false;
  const out = [];

  for (const line of lines) {
    if (!replaced && line.includes(orderNo)) {
      out.push(newEntry);
      replaced = true;
      continue;
    }
    // если уже заменили, выкидываем дубликаты по этому orderNo
    if (replaced && line.includes(orderNo)) continue;
    out.push(line);
  }

  if (!replaced) out.push(newEntry);

  return out.join(CLOSED_ORDERS_SEPARATOR);
}

async function run({ leadId }) {
  const lead = await call('crm.lead.get', { id: leadId });

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

  const contact = await call('crm.contact.get', { id: contactId });

  const current = contact[CONTACT_CURRENT_ORDERS_FIELD];
  const closed = contact[CONTACT_CLOSED_ORDERS_FIELD];

  const oldName = baseNameFromCurrent(current);
  const closedEntry = oldName ? `${oldName} -- ${orderNo}` : `${orderNo}`;

  const newClosed = upsertClosedByOrderNo(closed, orderNo, closedEntry);
  const newCurrent = '';

  await call('crm.contact.update', {
    id: contactId,
    fields: {
      [CONTACT_CLOSED_ORDERS_FIELD]: newClosed,
      [CONTACT_CURRENT_ORDERS_FIELD]: newCurrent,
    },
  });

  return {
    ok: true,
    leadId,
    contactId,
    orderNo,
    oldCurrent: toText(current),
    closedEntry,
    newCurrent,
  };
}

module.exports = { run };
