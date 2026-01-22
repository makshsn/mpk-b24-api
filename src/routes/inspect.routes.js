'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

/**
 * Хранилище:
 * - в памяти (быстро)
 * - на диске в .inspect/ (чтобы переживало рестарт)
 */
const INSPECT_DIR = process.env.INSPECT_DIR
  ? String(process.env.INSPECT_DIR)
  : path.join(process.cwd(), '.inspect');

const MAX_ITEMS = Number(process.env.INSPECT_MAX || 500);

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

ensureDir(INSPECT_DIR);

const mem = new Map();   // id -> item
const order = [];        // ids (oldest -> newest)

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function compactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    // не сохраняем потенциально жирные/ненужные заголовки
    if (String(k).toLowerCase() === 'cookie') continue;
    out[k] = v;
  }
  return out;
}

function pushItem(item) {
  mem.set(item.id, item);
  order.push(item.id);

  // trim in-memory
  while (order.length > MAX_ITEMS) {
    const id = order.shift();
    if (id) mem.delete(id);
  }

  // write to disk (best-effort)
  try {
    const file = path.join(INSPECT_DIR, `${item.id}.json`);
    fs.writeFileSync(file, JSON.stringify(item, null, 2), 'utf8');
  } catch {}
}

function listIds(limit = 20) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20));
  return order.slice(-n).reverse(); // newest first
}

function loadFromDiskIfMissing(id) {
  if (mem.has(id)) return mem.get(id);
  const file = path.join(INSPECT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const obj = safeJsonParse(txt);
    if (obj && obj.id) {
      mem.set(obj.id, obj);
      return obj;
    }
  } catch {}
  return null;
}

/**
 * Парсеры только для инспектора, чтобы:
 * 1) не ломать остальные роуты
 * 2) не ловить “висим насмерть”
 *
 * Важное: verify сохраняет rawBody (без req.on('data')!)
 */
const inspectUrlencoded = express.urlencoded({
  extended: true,
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
});

const inspectJson = express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
});

function buildItem(req) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return {
    id,
    ts: nowIso(),
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    headers: compactHeaders(req.headers || {}),
    query: req.query || {},
    // body заполним ниже
    body: req.body,
    // rawBody может отсутствовать (например GET)
    rawBody: typeof req.rawBody === 'string' ? req.rawBody : undefined,
    // полезная инфа для urlencoded “как Bitrix”
    contentType: req.headers?.['content-type'] || null,
    ip: req.headers?.['x-real-ip'] || req.headers?.['x-forwarded-for'] || req.ip || null,
  };
}

/**
 * POST /_inspect/in
 * Bitrix outbound webhook сюда.
 */
router.post('/_inspect/in', inspectUrlencoded, inspectJson, (req, res) => {
  const item = buildItem(req);
  pushItem(item);

  // короткий ответ, чтобы Bitrix не плевался
  return res.json({
    ok: true,
    id: item.id,
    ts: item.ts,
    method: item.method,
    path: item.path,
  });
});

/**
 * GET /_inspect/in
 * Просто проверка доступности
 */
router.get('/_inspect/in', (req, res) => {
  return res.json({ ok: true, hint: 'POST сюда из Bitrix outbound webhook' });
});

/**
 * GET /_inspect/list?n=20
 * список последних запросов (мета)
 */
router.get('/_inspect/list', (req, res) => {
  const ids = listIds(req.query?.n || 20);
  const items = ids
    .map((id) => mem.get(id) || loadFromDiskIfMissing(id))
    .filter(Boolean)
    .map((x) => ({
      id: x.id,
      ts: x.ts,
      method: x.method,
      path: x.path,
      contentType: x.contentType,
      ip: x.ip,
    }));

  return res.json({ ok: true, count: items.length, items });
});

/**
 * GET /_inspect/last
 * последний запрос целиком
 */
router.get('/_inspect/last', (req, res) => {
  const lastId = order.length ? order[order.length - 1] : null;
  if (!lastId) return res.json({ ok: true, item: null });

  const item = mem.get(lastId) || loadFromDiskIfMissing(lastId);
  return res.json({ ok: true, item: item || null });
});

/**
 * GET /_inspect/get/:id
 * получить конкретный запрос
 */
router.get('/_inspect/get/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'no_id' });

  const item = mem.get(id) || loadFromDiskIfMissing(id);
  if (!item) return res.status(404).json({ ok: false, error: 'not_found', id });

  return res.json({ ok: true, item });
});

module.exports = router;
