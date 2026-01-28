const path = require('path');

// Джоба: каждую минуту пересчитывает поле "Остаток к оплате" в SPA1048
// Формула: total - paid = remain

require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { getLogger } = require('../services/logging');
const logger = getLogger('jobs');

const { runRemainingToPayOnce } = require('../modules/spa1048/spa1048RemainingToPay');

const enabled = String(process.env.SPA1048_REMAINING_ENABLED || 'Y').toUpperCase() !== 'N';
const intervalSec = Math.max(10, Number(process.env.SPA1048_REMAINING_INTERVAL_SEC || 60));
const updateLimit = Math.max(1, Math.min(500, Number(process.env.SPA1048_REMAINING_UPDATE_LIMIT || 50)));

async function tick() {
  if (!enabled) return;

  try {
    const res = await runRemainingToPayOnce({ limit: updateLimit });
    logger.info({ res }, '[spa1048][remain] tick ok');
  } catch (e) {
    logger.error({ err: e?.message, data: e?.data }, '[spa1048][remain] tick failed');
  }
}

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: String(e) }, 'uncaughtException'));

(async () => {
  logger.info({ enabled, intervalSec, updateLimit }, '[spa1048][remain] watcher started');
  await tick();
  setInterval(tick, intervalSec * 1000);
})();
