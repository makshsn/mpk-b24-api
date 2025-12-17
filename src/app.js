const express = require('express');
const rateLimit = require('express-rate-limit');
const { httpLogger } = require('./middlewares/requestLogger');
const errorHandler = require('./middlewares/errorHandler');
const bitrixRoutes = require('./routes/bitrix.routes');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(httpLogger);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ограничение: максимум 60 запросов в минуту на IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/v1', apiLimiter);
app.use('/api/v1/bitrix', bitrixRoutes);

app.use(errorHandler);

module.exports = app;
