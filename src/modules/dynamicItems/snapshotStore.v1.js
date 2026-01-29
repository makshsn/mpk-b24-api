'use strict';

const fs = require('fs');
const path = require('path');

const SNAP_DIR = process.env.DYNAMIC_ITEM_SNAPSHOT_DIR
  ? String(process.env.DYNAMIC_ITEM_SNAPSHOT_DIR)
  : path.join(process.cwd(), 'var', 'dynamic_item_snapshots');

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function entityDir(entityTypeId) {
  return path.join(SNAP_DIR, String(entityTypeId));
}

function snapshotPath(entityTypeId, itemId) {
  return path.join(entityDir(entityTypeId), `${String(itemId)}.json`);
}

function readSnapshot(entityTypeId, itemId) {
  const file = snapshotPath(entityTypeId, itemId);
  try {
    if (!fs.existsSync(file)) return null;
    const s = fs.readFileSync(file, 'utf8');
    return safeJsonParse(s);
  } catch (_) {
    return null;
  }
}

function writeSnapshot(entityTypeId, itemId, snapshotObj) {
  const file = snapshotPath(entityTypeId, itemId);
  const json = JSON.stringify(snapshotObj, null, 2);
  atomicWrite(file, json);
  return { ok: true, file };
}

function listSnapshots(entityTypeId) {
  try {
    const dir = entityDir(entityTypeId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .map((x) => path.join(dir, x));
  } catch (_) {
    return [];
  }
}

module.exports = {
  SNAP_DIR,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
  listSnapshots,
};
