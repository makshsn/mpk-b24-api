'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const DUMP_DIR = path.join(process.cwd(), 'data', 'webhook-inspect');

function ensureDir() {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
}

function safeName(name) {
  // защита от ../
  return path.basename(String(name || ''));
}

function nowStamp() {
  // 2026-01-22T07-12-33.123Z
  return new Date().toISOString().replace(/:/g, '-');
}

function pickBody(req) {
  // если body не распарсилось (у тебя бывает undefined) — вернём null
  if (typeof req.body === 'undefined') return null;
  return req.body;
}

function dumpRequest(req) {
  return {
    ts: new Date().toISOString(),
    method: req.method,
    url: req.originalUrl || req.url,
    headers: req.headers,
    query: req.query,
    bodyType: typeof req.body,
    body: pickBody(req),
  };
}

// 1) принять любой запрос и сохранить его
router.all('/_inspect', (req, res) => {
  ensureDir();
  const dump = dumpRequest(req);
  const file = `${nowStamp()}_${dump.method}.json`;
  fs.writeFileSync(path.join(DUMP_DIR, file), JSON.stringify(dump, null, 2), 'utf8');
  return res.json({ ok: true, action: 'saved', file, dir: 'data/webhook-inspect' });
});

// удобный тест-эндпоинт
router.all('/_inspect/test', (req, res) => {
  ensureDir();
  const dump = dumpRequest(req);
  const file = `${nowStamp()}_TEST_${dump.method}.json`;
  fs.writeFileSync(path.join(DUMP_DIR, file), JSON.stringify(dump, null, 2), 'utf8');
  return res.json({ ok: true, action: 'saved', file });
});

// 2) список последних N файлов
router.get('/_inspect/list', (req, res) => {
  ensureDir();
  const n = Math.max(1, Math.min(200, Number(req.query.n || 20) || 20));
  const files = fs.readdirSync(DUMP_DIR)
    .filter(f => f.endsWith('.json'))
    .sort((a, b) => fs.statSync(path.join(DUMP_DIR, b)).mtimeMs - fs.statSync(path.join(DUMP_DIR, a)).mtimeMs)
    .slice(0, n);

  return res.json({ ok: true, files, dir: 'data/webhook-inspect' });
});

// 3) получить конкретный файл
router.get('/_inspect/file/:name', (req, res) => {
  ensureDir();
  const name = safeName(req.params.name);
  const full = path.join(DUMP_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'not_found', name });

  const txt = fs.readFileSync(full, 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(txt);
});

module.exports = router;
