'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_PATH = process.env.B24_OAUTH_STORE_PATH
  ? String(process.env.B24_OAUTH_STORE_PATH)
  : path.join(process.cwd(), 'var', 'b24oauth_install.json');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function readStoreRaw() {
  try {
    if (!fs.existsSync(DEFAULT_STORE_PATH)) return null;
    const s = fs.readFileSync(DEFAULT_STORE_PATH, 'utf8');
    return safeJsonParse(s) || null;
  } catch (_) {
    return null;
  }
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeStoreRaw(obj) {
  const json = JSON.stringify(obj, null, 2);
  atomicWrite(DEFAULT_STORE_PATH, json);
}

function getInstall() {
  return readStoreRaw();
}

function setInstall(patch) {
  const cur = readStoreRaw() || {};
  const next = { ...cur, ...patch };
  writeStoreRaw(next);
  return next;
}

function isInstalled(install) {
  return Boolean(install && install.portal && install.memberId && install.refreshToken);
}

function isTokenExpired(install, skewSec = 30) {
  const exp = Number(install?.expiresAt || 0);
  if (!exp) return true;
  return (Date.now() + skewSec * 1000) >= exp;
}

function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 10) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function publicStatus(install) {
  if (!install) return { installed: false };
  return {
    installed: isInstalled(install),
    portal: install.portal || null,
    memberId: install.memberId || null,
    installedAt: install.installedAt || null,
    updatedAt: install.updatedAt || null,
    expiresAt: install.expiresAt || null,
    tokenExpired: isTokenExpired(install),
    restEndpoint: install.restEndpoint || null,
    authEndpoint: install.authEndpoint || null,
    // маскируем
    accessToken: install.accessToken ? maskToken(install.accessToken) : null,
    refreshToken: install.refreshToken ? maskToken(install.refreshToken) : null,
    applicationToken: install.applicationToken ? maskToken(install.applicationToken) : null,
  };
}

module.exports = {
  DEFAULT_STORE_PATH,
  getInstall,
  setInstall,
  isInstalled,
  isTokenExpired,
  publicStatus,
};
