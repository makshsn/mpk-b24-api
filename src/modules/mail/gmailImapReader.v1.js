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
      auth: {
        user: cfg.user,
        pass: cfg.pass,
      },
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
    try {
      await client.logout();
    } catch (e) {
      // ignore
    }
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

  return { subject, from, messageId, date };
}

/**
 * Читает непрочитанные письма из выбранного mailbox.
 * Возвращает метаданные + (опционально) raw source.
 */
async function fetchUnreadEmails(opts = {}) {
  const includeSource = envBool('GMAIL_IMAP_INCLUDE_SOURCE', false);
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 0) || 0)) || null;

  return withImapClient(async ({ client, cfg }) => {
    const fetchLimit = limit || cfg.fetchLimit;

    // Gmail: непрочитанные
    const uids = await client.search({ seen: false });
    const picked = uids.slice(-fetchLimit); // последние N

    const out = [];
    for await (const msg of client.fetch(picked, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      source: includeSource,
    })) {
      const env = normalizeEnvelope(msg.envelope);

      const item = {
        uid: msg.uid,
        flags: Array.isArray(msg.flags) ? msg.flags : [],
        size: Number(msg.size || 0),
        ...env,
      };

      if (includeSource && msg.source) {
        item.source = Buffer.isBuffer(msg.source) ? msg.source.toString('utf8') : String(msg.source);
      }

      out.push(item);
    }

    // помечаем как прочитанные
    if (cfg.markSeen && out.length) {
      const toMark = out.map((x) => x.uid).filter(Boolean);
      try {
        await client.messageFlagsAdd(toMark, ['\\Seen'], { uid: true });
      } catch (e) {
        logger.warn({ err: e?.message, count: toMark.length }, '[mail][imap] failed to mark as seen');
      }
    }

    return {
      ok: true,
      mailbox: cfg.mailbox,
      totalUnseen: uids.length,
      returned: out.length,
      markSeen: cfg.markSeen,
      includeSource,
      items: out,
    };
  });
}

/**
 * Быстрая проверка коннекта, полезно для health-check.
 */
async function testImapConnection() {
  return withImapClient(async ({ client, cfg }) => {
    const status = await client.status(cfg.mailbox, { messages: true, unseen: true });
    return {
      ok: true,
      mailbox: cfg.mailbox,
      status,
    };
  });
}

module.exports = {
  getImapConfig,
  testImapConnection,
  fetchUnreadEmails,
};
