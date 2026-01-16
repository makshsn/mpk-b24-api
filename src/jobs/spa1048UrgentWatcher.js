require('dotenv').config({ path: '.env' });

const { logger } = require('../middlewares/requestLogger');
const { runUrgentToPayOnce } = require('../services/bitrix/spa1048UrgentToPay');

// PM2 job: каждые N часов прогоняет счета и переводит в "Срочно к оплате",
// если до дедлайна <= 3 дней.

const intervalHours = Number(process.env.SPA1048_URGENT_INTERVAL_HOURS || 6); // 4 раза в день = 6ч

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
