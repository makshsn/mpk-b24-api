'use strict';

const { listUnreadEmails, fetchRawByUids, markSeenByUids, addLabelByUids } = require('./gmailImapReader.v1');
const { parseRawEmail } = require('./emailMimeParser.v1');
const { saveEmailRecord, acquireLock, releaseLock } = require('./mailStore.v1');
const { createSpa1048FromStoredEmail } = require('../spa1048/spa1048CreateFromStoredEmail.v1');
const { getLogger } = require('../../services/logging');

const logger = getLogger('mail');

function envBool(name, def = false) {
  const v = String(process.env[name] ?? '').trim().toUpperCase();
  if (!v) return def;
  if (['1', 'Y', 'YES', 'TRUE', 'ON'].includes(v)) return true;
  if (['0', 'N', 'NO', 'FALSE', 'OFF'].includes(v)) return false;
  return def;
}

function parseAllowlist() {
  const raw = String(process.env.MAIL_ALLOWED_FROM || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

async function runOnce({ limit = 10 } = {}) {
  // Глобальный lock: защищает от параллельных запусков (pm2 cluster, job+ручной запуск и т.п.)
  const globalLock = acquireLock('mail:spa1048:auto:runOnce', Number(process.env.MAIL_AUTO_LOCK_TTL_MS || 5 * 60 * 1000));
  if (!globalLock.ok) return { ok: false, error: globalLock.error || 'auto_lock_failed' };
  if (!globalLock.acquired) {
    return { ok: true, skipped: 'already_running', reason: globalLock.reason || 'locked' };
  }

  const allow = parseAllowlist();
  if (!allow.size) {
    releaseLock(globalLock);
    return { ok: false, error: 'MAIL_ALLOWED_FROM is empty (allowlist required)' };
  }

  const skipMarkSeen = envBool('MAIL_SKIP_MARK_SEEN', true);
  const skipLabel = String(process.env.MAIL_SKIP_LABEL || '').trim();
  const processedLabel = String(process.env.MAIL_PROCESSED_LABEL || '').trim();

  const listed = await listUnreadEmails({ limit });

  const allowed = [];
  const skipped = [];

  for (const m of listed.items || []) {
    const addr = String(m.fromAddr || '').toLowerCase();
    if (addr && allow.has(addr)) allowed.push(m);
    else skipped.push(m);
  }

  if (skipped.length) {
    const uids = skipped.map((x) => x.uid);
    if (skipMarkSeen) await markSeenByUids(uids);
    if (skipLabel) await addLabelByUids(uids, skipLabel);
  }

  if (!allowed.length) {
    releaseLock(globalLock);
    return {
      ok: true,
      totalUnseen: listed.totalUnseen,
      allowed: 0,
      skipped: skipped.length,
      created: 0,
      items: [],
    };
  }

  const rawBatch = await fetchRawByUids(allowed.map((x) => x.uid));

  const results = [];

  for (const msg of rawBatch.items || []) {
    const uid = msg.uid;
    const senderEmail = String(msg?.normalized?.fromAddr || '').toLowerCase();

    // Lock на конкретное письмо (mailbox+uid) — защита от гонок при параллельном runOnce.
    const mailKey = `mail:${rawBatch.mailbox || 'INBOX'}:uid:${uid}`;
    const mailLock = acquireLock(mailKey, Number(process.env.MAIL_UID_LOCK_TTL_MS || 10 * 60 * 1000));
    if (!mailLock.ok) {
      results.push({ ok: false, uid, senderEmail, error: mailLock.error || 'mail_lock_failed' });
      continue;
    }
    if (!mailLock.acquired) {
      results.push({ ok: true, uid, senderEmail, skipped: 'locked_already_processing' });
      continue;
    }

    try {
      const parsed = await parseRawEmail(msg.raw);

      const rec = saveEmailRecord({
        mailbox: rawBatch.mailbox || 'INBOX',
        uid,
        messageId: parsed.messageId || msg.normalized?.messageId || null,
        envelope: msg.normalized,
        parsed,
        rawBuffer: msg.raw,
      });

      const created = await createSpa1048FromStoredEmail({
        emailId: rec.id,
        senderEmail,
      });

      await markSeenByUids([uid]);
      if (processedLabel) await addLabelByUids([uid], processedLabel);

      results.push({ ok: true, uid, senderEmail, emailId: rec.id, itemId: created.itemId, mappedUserId: created.mappedUserId });
    } catch (e) {
      const err = e?.message || String(e);
      logger.error({ uid, senderEmail, err }, '[mail][auto] failed to create spa from email');
      results.push({ ok: false, uid, senderEmail, error: err });
    } finally {
      releaseLock(mailLock);
    }
  }

  releaseLock(globalLock);
  return {
    ok: true,
    totalUnseen: listed.totalUnseen,
    allowed: allowed.length,
    skipped: skipped.length,
    created: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    items: results,
  };
}

module.exports = {
  runOnce,
};
