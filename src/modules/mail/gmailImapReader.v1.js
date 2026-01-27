'use strict';

const { ImapFlow } = require('imapflow');
const { getLogger } = require('../../services/logging');

const logger = getLogger('mail');

function envBool(name, def = false) {
  const v = String(process.env[name] ?? '').trim().toUpperCase();
  if (!v) return def;
  if (['1', 'Y', 'YES', 'TRUE', 'ON'].includes(v)) return true;
  if (['0', 'N', 'NO', 'FALSE', 'OFF'].includes(v)) return false;
  return def;
}

function getImapConfig() {
  const host = String(process.env.GMAIL_IMAP_HOST || 'imap.gmail.com').trim();
  const port = Number(process.env.GMAIL_IMAP_PORT || 993);
  const secure = envBool('GMAIL_IMAP_SECURE', true);
  const user = String(process.env.GMAIL_IMAP_USER || '').trim();
  const pass = String(process.env.GMAIL_IMAP_PASS || '').trim();
  const mailbox = String(process.env.GMAIL_IMAP_MAILBOX || 'INBOX').trim();
  const fetchLimit = Math.max(1, Math.min(50, Number(process.env.GMAIL_IMAP_FETCH_LIMIT || 10)));
  const markSeen = envBool('GMAIL_IMAP_MARK_SEEN', true);

  if (!user) throw new Error('GMAIL_IMAP_USER is required');
  if (!pass) throw new Error('GMAIL_IMAP_PASS is required');

  return { host, port, secure, user, pass, mailbox, fetchLimit, markSeen };
}

function createClient() {
  const cfg = getImapConfig();

  return {
    cfg,
    client: new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      disableAutoEnable: true,
    }),
  };
}

async function withImapClient(fn) {
  const { client, cfg } = createClient();

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      return await fn({ client, cfg });
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

function normalizeEnvelope(env) {
  const subject = String(env?.subject || '').trim();
  const fromAddr = env?.from?.[0]?.address || '';
  const fromName = env?.from?.[0]?.name || '';
  const from =
    [String(fromName).trim(), String(fromAddr).trim()].filter(Boolean).join(' <') +
    (fromName && fromAddr ? '>' : '');

  const messageId = String(env?.messageId || '').trim();
  const date = env?.date ? new Date(env.date).toISOString() : null;

  return { subject, from, messageId, date, fromAddr: String(fromAddr).trim().toLowerCase() };
}

async function testImapConnection() {
  return withImapClient(async ({ client, cfg }) => {
    const status = await client.status(cfg.mailbox, { messages: true, unseen: true });
    return { ok: true, mailbox: cfg.mailbox, status };
  });
}

async function listUnreadEmails(opts = {}) {
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 0) || 0)) || null;

  return withImapClient(async ({ client, cfg }) => {
    const fetchLimit = limit || cfg.fetchLimit;

    const uids = await client.search({ seen: false });
    const picked = uids.slice(-fetchLimit);

    const out = [];
    for await (const msg of client.fetch(picked, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
    })) {
      const env = normalizeEnvelope(msg.envelope);
      out.push({
        uid: msg.uid,
        flags: Array.isArray(msg.flags) ? msg.flags : [],
        size: Number(msg.size || 0),
        subject: env.subject,
        from: env.from,
        fromAddr: env.fromAddr,
        messageId: env.messageId,
        date: env.date,
      });
    }

    return {
      ok: true,
      mailbox: cfg.mailbox,
      totalUnseen: uids.length,
      returned: out.length,
      items: out,
    };
  });
}

/**
 * Забрать RAW source (RFC822) по UID (или списку UID)
 */
async function fetchRawByUids(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map((x) => Number(x)).filter(Boolean);
  if (!list.length) throw new Error('uids required');

  return withImapClient(async ({ client, cfg }) => {
    const out = [];
    for await (const msg of client.fetch(list, {
      uid: true,
      envelope: true,
      source: true,
      size: true,
      flags: true,
    })) {
      const env = normalizeEnvelope(msg.envelope);
      const raw = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source || '', 'utf8');

      out.push({
        uid: msg.uid,
        envelope: msg.envelope || null,
        normalized: env,
        size: Number(msg.size || 0),
        flags: Array.isArray(msg.flags) ? msg.flags : [],
        raw,
      });
    }

    return {
      ok: true,
      mailbox: cfg.mailbox,
      items: out,
    };
  });
}

async function markSeenByUids(uids) {
  const list = (Array.isArray(uids) ? uids : [uids]).map((x) => Number(x)).filter(Boolean);
  if (!list.length) return { ok: true, skipped: 'no_uids' };

  return withImapClient(async ({ client }) => {
    await client.messageFlagsAdd(list, ['\\Seen'], { uid: true });
    return { ok: true, count: list.length };
  });
}

/**
 * Gmail labels (X-GM-LABELS). Работает на Gmail/Google Workspace.
 * Если метод недоступен — просто игнорируем.
 */
async function addLabelByUids(uids, label) {
  const lbl = String(label || '').trim();
  if (!lbl) return { ok: true, skipped: 'no_label' };

  const list = (Array.isArray(uids) ? uids : [uids]).map((x) => Number(x)).filter(Boolean);
  if (!list.length) return { ok: true, skipped: 'no_uids' };

  return withImapClient(async ({ client }) => {
    if (typeof client.messageLabelsAdd !== 'function') {
      return { ok: true, skipped: 'labels_not_supported' };
    }
    try {
      await client.messageLabelsAdd(list, [lbl], { uid: true });
      return { ok: true, count: list.length, label: lbl };
    } catch (e) {
      logger.warn({ err: e?.message, label: lbl }, '[mail][imap] add label failed');
      return { ok: false, error: e?.message, label: lbl };
    }
  });
}

module.exports = {
  getImapConfig,
  testImapConnection,
  listUnreadEmails,
  fetchRawByUids,
  markSeenByUids,
  addLabelByUids,
};
