'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CUR = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}

function dayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function filePath() {
  ensureDir();
  return path.join(LOG_DIR, `app-${dayStamp()}.log`);
}

function should(level) {
  return (LEVELS[level] ?? 100) >= CUR;
}

function truncStr(s, max = 1200) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + `…<truncated ${s.length - max} chars>`;
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '<max-depth>';
  if (value == null) return value;

  if (Buffer.isBuffer(value)) return `<Buffer len=${value.length}>`;
  if (typeof value === 'string') return truncStr(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    // fileData: [name, base64]
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && value[1].length > 200) {
      return [value[0], `<base64 len=${value[1].length}>`];
    }
    if (value.length > 50) return { _type: 'array', length: value.length, head: value.slice(0, 5).map(v => sanitize(v, depth + 1)) };
    return value.map(v => sanitize(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();

      if (key.includes('token') || key.includes('secret') || key === 'auth' || key.includes('password')) {
        out[k] = '<redacted>';
        continue;
      }

      if (key === 'filedata' || key.includes('base64') || key.includes('file_content')) {
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
          out[k] = [v[0], `<base64 len=${v[1].length}>`];
        } else if (typeof v === 'string') {
          out[k] = `<string len=${v.length}>`;
        } else {
          out[k] = '<redacted>';
        }
        continue;
      }

      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

function writeLine(line) {
  try { fs.appendFileSync(filePath(), line + '\n', 'utf8'); } catch (_) {}
}

function log(level, event, data = {}) {
  if (!should(level)) return;
  const payload = { ts: new Date().toISOString(), level, event, ...sanitize(data) };
  const line = JSON.stringify(payload);
  writeLine(line);

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function serializeError(err) {
  if (!err) return null;
  return sanitize({
    name: err.name,
    message: err.message,
    stack: err.stack,
    code: err.code,
    isAxiosError: err.isAxiosError,
    responseStatus: err.response?.status,
    responseData: err.response?.data,
    responseHeaders: err.response?.headers,
    config: {
      url: err.config?.url,
      method: err.config?.method,
      timeout: err.config?.timeout,
      headers: err.config?.headers,
      maxBodyLength: err.config?.maxBodyLength,
      maxContentLength: err.config?.maxContentLength,
    },
  });
}

module.exports = {
  log,
  logDebug: (event, data) => log('debug', event, data),
  logInfo:  (event, data) => log('info',  event, data),
  logWarn:  (event, data) => log('warn',  event, data),
  logError: (event, data) => log('error', event, data),
  serializeError,
  sanitize,
};
