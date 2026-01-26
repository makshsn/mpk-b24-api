'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const rfs = require('rotating-file-stream');

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Требование: не больше 5MB
const LOG_ROTATE_SIZE = process.env.LOG_ROTATE_SIZE || '5M';

// Сколько ротированных файлов хранить на канал (чтобы не разрасталось)
const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES || 10);

const SERVICE_NAME =
  process.env.SERVICE_NAME ||
  process.env.npm_package_name ||
  'mpk-b24-api';

const FILES = {
  app: 'app.log',          // HTTP/access + общий апп-лог
  bitrix: 'bitrix.log',    // REST Bitrix
  spa1048: 'spa1048.log',  // бизнес-логика SPA1048
  jobs: 'jobs.log',        // джобы/воркеры
  errors: 'errors.log',    // unhandled/errors middleware
};

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function createRotatingStream(filename) {
  ensureDir();

  // rotating-file-stream поддерживает size/maxFiles (ротация по размеру и ограничение истории)
  // При maxFiles создаётся history-файл (это нормально).
  return rfs.createStream(filename, {
    path: LOG_DIR,
    size: LOG_ROTATE_SIZE,
    maxFiles: LOG_MAX_FILES,
    // compress: 'gzip', // при желании можно включить сжатие
  });
}

const cache = new Map();

function getLogger(channel = 'app') {
  const key = String(channel || 'app');

  if (cache.has(key)) return cache.get(key);

  const file = FILES[key] || `${key}.log`;
  const stream = createRotatingStream(file);

  const logger = pino(
    {
      level: LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        service: SERVICE_NAME,
        channel: key,
        pid: process.pid,
      },
    },
    stream
  );

  cache.set(key, logger);
  return logger;
}

module.exports = {
  getLogger,
  LOG_DIR,
  FILES,
};
