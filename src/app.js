const express = require('express');
const { httpLogger } = require('./middlewares/requestLogger');
const errorHandler = require('./middlewares/errorHandler');
const bitrixRoutes = require('./routes/bitrix.routes');
const publicRoutes = require('./routes/public.routes');

const app = express();

// если у тебя есть nginx — можно оставить, не мешает
app.set('trust proxy', 1);

// --- rawBody capture (чтобы видеть, что реально прилетело) ---
function rawBodySaver(req, _res, buf, encoding) {
  try {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  } catch (e) {
    req.rawBody = null;
  }
}

// ОДИН раз подключаем парсеры (и не режем тело внезапно до 1mb)
app.use(express.json({
  limit: '25mb',
  verify: rawBodySaver,
}));

app.use(express.urlencoded({
  extended: true,
  limit: '25mb',
  verify: rawBodySaver,
}));

app.use(httpLogger);

app.use('/b24', publicRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ВАЖНО: временно убрали express-rate-limit, потому что он валит запросы из-за X-Forwarded-For/trust proxy
app.use('/api/v1/bitrix', bitrixRoutes);

app.use(errorHandler);

module.exports = app;
