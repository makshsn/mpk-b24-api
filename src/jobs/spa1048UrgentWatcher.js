const path = require('path');

// Важно: PM2/cron могут запускать процесс с неожиданным cwd.
// Чтобы .env гарантированно подхватывался, используем абсолютный путь от корня проекта.
require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { logger } = require('../middlewares/requestLogger');
const { runUrgentToPayOnce } = require('../modules/spa1048/spa1048UrgentToPay');

// PM2 job: каждые N часов прогоняет счета и переводит в "Срочно к оплате",
// если до дедлайна <= 3 дней.

// Интервал можно настраивать через env.
// По умолчанию: 6 часов (4 раза в день).
const intervalHours = Number(process.env.SPA1048_URGENT_INTERVAL_HOURS || 6);

async function tick() {
  try {
    const res = await runUrgentToPayOnce();
    logger.info({ res }, '[spa1048][urgent] run ok');
  } catch (e) {
    logger.error({ err: e?.message, data: e?.data }, '[spa1048][urgent] run failed');
  }
}

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: String(e) }, 'uncaughtException'));

(async () => {
  logger.info({ intervalHours }, '[spa1048][urgent] watcher started');
  await tick();
  setInterval(tick, Math.max(0.5, intervalHours) * 60 * 60 * 1000);
})();
