'use strict';

const { testImapConnection, listUnreadEmails } = require('../modules/mail/gmailImapReader.v1');
const { ingestUnseen } = require('../modules/mail/mailIngest.v1');
const { loadEmailRecord } = require('../modules/mail/mailStore.v1');

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
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
 * Забираем непрочитанные письма, парсим MIME, сохраняем на диск, помечаем как прочитанные.
 * GET /api/v1/mail/imap/ingest?limit=10
 */
async function imapIngest(req, res) {
  const limit = Math.max(1, Math.min(50, toNum(req?.query?.limit ?? req?.body?.limit) || 10));
  const r = await ingestUnseen({ limit });
  return res.json(r);
}

/**
 * Получить сохранённое письмо по id
 * GET /api/v1/mail/imap/email/:id
 */
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
