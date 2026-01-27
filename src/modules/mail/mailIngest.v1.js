'use strict';

const { listUnreadEmails, fetchRawByUids } = require('./gmailImapReader.v1');
const { parseRawEmail } = require('./emailMimeParser.v1');
const { saveEmailRecord, cleanupOldEmails } = require('./mailStore.v1');
const { getLogger } = require('../../services/logging');

const logger = getLogger('mail');

async function ingestUnseen({ limit = 10 } = {}) {
  const listed = await listUnreadEmails({ limit });
  const uids = (listed.items || []).map((x) => x.uid).filter(Boolean);

  if (!uids.length) {
    cleanupOldEmails();
    return { ok: true, ingested: 0, items: [] };
  }

  const rawBatch = await fetchRawByUids(uids, { markSeen: true });

  const saved = [];
  for (const item of rawBatch.items || []) {
    try {
      const parsed = await parseRawEmail(item.raw);
      const rec = saveEmailRecord({
        mailbox: rawBatch.mailbox || 'INBOX',
        uid: item.uid,
        messageId: parsed.messageId || item.normalized?.messageId || null,
        envelope: item.normalized,
        parsed,
        rawBuffer: item.raw,
      });

      saved.push({
        id: rec.id,
        uid: rec.uid,
        subject: rec.subject,
        from: rec.from,
        date: rec.date,
        attachments: rec.attachments.length,
      });
    } catch (e) {
      logger.error({ err: e?.message, uid: item.uid }, '[mail][ingest] parse/save failed');
    }
  }

  const cleanup = cleanupOldEmails();

  return {
    ok: true,
    ingested: saved.length,
    items: saved,
    cleanup,
  };
}

module.exports = {
  ingestUnseen,
};
