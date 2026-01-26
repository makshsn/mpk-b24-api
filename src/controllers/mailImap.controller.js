'use strict';

const {
  testImapConnection,
  fetchUnreadEmails,
} = require('../modules/mail/gmailImapReader.v1');

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET|POST /api/v1/mail/imap/test
 * Проверка, что мы умеем подключаться к Gmail по IMAP.
 */
async function imapTest(req, res) {
  const r = await testImapConnection();
  return res.json(r);
}

/**
 * GET|POST /api/v1/mail/imap/unseen
 * Возвращает последние N непрочитанных писем.
 * Параметр: ?limit=10
 */
async function imapUnseen(req, res) {
  const limit = toNum(req?.query?.limit ?? req?.body?.limit) || 0;
  const r = await fetchUnreadEmails({ limit });
  return res.json(r);
}

module.exports = {
  imapTest,
  imapUnseen,
};
