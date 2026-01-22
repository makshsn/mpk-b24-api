const express = require('express');
const { httpLogger } = require('./middlewares/requestLogger');
const errorHandler = require('./middlewares/errorHandler');
const bitrixRoutes = require('./routes/bitrix.routes');
const publicRoutes = require('./routes/public.routes');

const app = express();
// RAW body collector (для инспектора вебхуков)
app.use((req, res, next) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  });
  


app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
// если у тебя есть nginx — можно оставить, не мешает
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(httpLogger);

app.use('/b24', publicRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ВАЖНО: временно убрали express-rate-limit, потому что он валит запросы из-за X-Forwarded-For/trust proxy
app.use('/api/v1/bitrix', bitrixRoutes);

app.use(errorHandler);


module.exports = app;
