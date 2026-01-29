'use strict';

const { testImapConnection, listUnreadEmails } = require('../modules/mail/gmailImapReader.v1');
const { ingestUnseen } = require('../modules/mail/mailIngest.v1');
const { loadEmailRecord } = require('../modules/mail/mailStore.v1');

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toBool(v, def = false) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return def;
  if (['1', 'Y', 'YES', 'TRUE', 'ON'].includes(s)) return true;
  if (['0', 'N', 'NO', 'FALSE', 'OFF'].includes(s)) return false;
  return def;
}

async function imapTest(_req, res) {
  const r = await testImapConnection();
  return res.json(r);
}

async function imapUnseen(req, res) {
  const limit = toNum(req?.query?.limit ?? req?.body?.limit) || 0;
  const r = await listUnreadEmails({ limit: limit || undefined });
  return res.json(r);
}

/**
 * GET /api/v1/mail/imap/ingest?limit=10&markSeen=Y&createSpa1048=Y
 */
async function imapIngest(req, res) {
  const limit = Math.max(1, Math.min(50, toNum(req?.query?.limit ?? req?.body?.limit) || 10));
  const markSeen = toBool(req?.query?.markSeen ?? req?.body?.markSeen, true);
  const createSpa1048 = toBool(req?.query?.createSpa1048 ?? req?.body?.createSpa1048, false);

  const r = await ingestUnseen({ limit, markSeen, createSpa1048 });
  return res.json(r);
}

async function getSavedEmail(req, res) {
  const id = String(req?.params?.id || '').trim();
  const rec = loadEmailRecord(id);
  if (!rec) return res.status(404).json({ ok: false, error: 'Not found' });
  return res.json({ ok: true, item: rec });
}

module.exports = {
  imapTest,
  imapUnseen,
  imapIngest,
  getSavedEmail,
};
