'use strict';

const { listUnreadEmails, fetchRawByUids, markSeenByUids } = require('./gmailImapReader.v1');
const { parseRawEmail } = require('./emailMimeParser.v1');
const { saveEmailRecord, cleanupOldEmails } = require('./mailStore.v1');
const { createSpa1048FromStoredEmail } = require('../spa1048/spa1048CreateFromStoredEmail.v1');
const { getLogger } = require('../../services/logging');

const logger = getLogger('mail');

async function ingestUnseen({ limit = 10, markSeen = true, createSpa1048 = false } = {}) {
  const listed = await listUnreadEmails({ limit });
  const uids = (listed.items || []).map((x) => x.uid).filter(Boolean);

  if (!uids.length) {
    const cleanup = cleanupOldEmails();
    return { ok: true, ingested: 0, created: 0, items: [], cleanup };
  }

  const rawBatch = await fetchRawByUids(uids);

  const out = [];

  for (const item of rawBatch.items || []) {
    const uid = item.uid;
    const senderEmail = String(item?.normalized?.fromAddr || '').toLowerCase();

    try {
      const parsed = await parseRawEmail(item.raw);

      const rec = saveEmailRecord({
        mailbox: rawBatch.mailbox || 'INBOX',
        uid,
        messageId: parsed.messageId || item.normalized?.messageId || null,
        envelope: item.normalized,
        parsed,
        rawBuffer: item.raw,
      });

      let created = null;
      if (createSpa1048) {
        created = await createSpa1048FromStoredEmail({ emailId: rec.id, senderEmail });
      }

      if (markSeen) await markSeenByUids([uid]);

      out.push({
        ok: true,
        id: rec.id,
        uid: rec.uid,
        subject: rec.subject,
        from: rec.from,
        date: rec.date,
        attachments: rec.attachments.length,
        itemId: created?.itemId || null,
      });
    } catch (e) {
      logger.error({ err: e?.message, uid }, '[mail][ingest] parse/save/create failed');
      out.push({ ok: false, uid, error: e?.message || String(e) });
    }
  }

  const cleanup = cleanupOldEmails();

  return {
    ok: true,
    ingested: out.filter((x) => x.ok).length,
    created: out.filter((x) => x.ok && x.itemId).length,
    items: out,
    cleanup,
  };
}

module.exports = {
  ingestUnseen,
};
