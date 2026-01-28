'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function storeDir() {
  return String(process.env.MAIL_STORE_DIR || path.join(process.cwd(), 'var', 'mail_store')).trim();
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function safeName(name, fallback = 'file') {
  const s = String(name || '').trim() || fallback;
  return s.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').slice(0, 180) || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function buildId({ mailbox, uid, messageId }) {
  // ВАЖНО: ID должен быть детерминированным, иначе одно и то же письмо может
  // обработаться дважды и получить разные emailId -> дубль SPA.
  // Ключ: mailbox + uid + messageId (если есть). UID в рамках mailbox стабильный.
  const base = `${mailbox || 'INBOX'}:${uid || ''}:${messageId || ''}`;
  return sha1(Buffer.from(base)).slice(0, 16);
}

function lockDir() {
  return path.join(storeDir(), 'locks');
}

function lockPath(key) {
  const safe = sha1(Buffer.from(String(key || ''))).slice(0, 24);
  return path.join(lockDir(), `${safe}.lock`);
}

function acquireLock(key, ttlMs = 10 * 60 * 1000) {
  const p = lockPath(key);
  ensureDir(path.dirname(p));

  const now = Date.now();

  try {
    // atomic create
    const fd = fs.openSync(p, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ key, pid: process.pid, at: nowIso(), ts: now }), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, acquired: true, path: p };
  } catch (e) {
    if (e && e.code !== 'EEXIST') {
      return { ok: false, acquired: false, path: p, error: e?.message || String(e) };
    }

    // lock exists: check TTL
    try {
      const st = fs.statSync(p);
      const age = now - Number(st.mtimeMs || 0);
      if (ttlMs > 0 && age > ttlMs) {
        // stale lock
        try { fs.unlinkSync(p); } catch (_) {}
        // retry once
        const fd = fs.openSync(p, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ key, pid: process.pid, at: nowIso(), ts: now, staleRecovered: true }), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return { ok: true, acquired: true, path: p, staleRecovered: true };
      }
      return { ok: true, acquired: false, path: p, reason: 'locked' };
    } catch (err) {
      return { ok: true, acquired: false, path: p, reason: 'locked_stat_failed', error: err?.message || String(err) };
    }
  }
}

function releaseLock(lock) {
  const p = typeof lock === 'string' ? lock : lock?.path;
  if (!p) return { ok: true, skipped: 'no_path' };
  try {
    fs.unlinkSync(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function emailPath(id) {
  return path.join(storeDir(), 'emails', id, 'email.json');
}

function rawPath(id) {
  return path.join(storeDir(), 'emails', id, 'raw.eml');
}

function attachDir(id) {
  return path.join(storeDir(), 'emails', id, 'attachments');
}

function saveEmailRecord({ mailbox, uid, messageId, envelope, parsed, rawBuffer }) {
  const id = buildId({ mailbox, uid, messageId });

  // Если уже есть запись (детерминированный id) — возвращаем её.
  // Это базовая идемпотентность на уровне письма.
  const existingFile = emailPath(id);
  if (fs.existsSync(existingFile)) {
    try {
      return readJson(existingFile);
    } catch (_) {
      // если json битый — продолжим пересоздание
    }
  }

  const baseDir = path.dirname(emailPath(id));
  ensureDir(baseDir);

  if (rawBuffer && Buffer.isBuffer(rawBuffer)) {
    fs.writeFileSync(rawPath(id), rawBuffer);
  }

  const attachments = [];
  const aDir = attachDir(id);
  ensureDir(aDir);

  for (const a of parsed.attachments || []) {
    const content = a?.content;
    if (!Buffer.isBuffer(content) || !content.length) continue;

    const filename = safeName(a.filename || `attachment-${attachments.length + 1}`);
    const fileHash = sha1(content).slice(0, 12);

    // чтобы не перетирать одинаковые имена
    const finalName = `${fileHash}__${filename}`;
    const full = path.join(aDir, finalName);

    fs.writeFileSync(full, content);

    attachments.push({
      filename,
      storedAs: finalName,
      path: full,
      size: content.length,
      contentType: String(a.contentType || ''),
      contentId: a.contentId || null,
      disposition: a.contentDisposition || null,
      related: !!a.related,
    });
  }

  const record = {
    id,
    storedAt: nowIso(),
    mailbox: mailbox || 'INBOX',
    uid: Number(uid) || 0,
    messageId: messageId || null,
    envelope: envelope || null,

    subject: parsed.subject || '',
    from: parsed.from || null,
    to: parsed.to || null,
    cc: parsed.cc || null,
    date: parsed.date ? new Date(parsed.date).toISOString() : null,

    text: parsed.text || '',
    html: parsed.html || '',

    attachments,
    rawEmlPath: rawBuffer ? rawPath(id) : null,
  };

  writeJson(emailPath(id), record);

  return record;
}

function loadEmailRecord(id) {
  const file = emailPath(String(id));
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function cleanupOldEmails() {
  const keepDays = Math.max(1, Number(process.env.MAIL_STORE_KEEP_DAYS || 30));
  const keepMs = keepDays * 24 * 60 * 60 * 1000;

  const root = path.join(storeDir(), 'emails');
  if (!fs.existsSync(root)) return { ok: true, removed: 0 };

  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  let removed = 0;

  const now = Date.now();

  for (const d of dirs) {
    const id = d.name;
    const file = emailPath(id);
    try {
      if (!fs.existsSync(file)) continue;
      const rec = readJson(file);
      const ts = Date.parse(rec?.storedAt || '');
      if (!ts || now - ts <= keepMs) continue;

      const dirPath = path.join(root, id);
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch (_) {
      // ignore
    }
  }

  return { ok: true, removed, keepDays };
}

module.exports = {
  saveEmailRecord,
  loadEmailRecord,
  cleanupOldEmails,
  acquireLock,
  releaseLock,
};
