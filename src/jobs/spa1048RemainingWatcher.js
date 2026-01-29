const path = require('path');

require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { getLogger } = require('../services/logging');
const logger = getLogger('jobs');

const { runRemainingToPayOnce } = require('../modules/spa1048/spa1048RemainingToPay');

/**
 * Раньше это был watcher с setInterval().
 * Теперь — one-shot: один прогон и выход.
 *
 * По умолчанию выключено (чтобы случайно не запускать по расписанию).
 * Включить вручную можно env-переменной:
 *   SPA1048_REMAINING_ENABLED=Y
 */
const enabled = String(process.env.SPA1048_REMAINING_ENABLED || 'N').toUpperCase() === 'Y';
const updateLimit = Math.max(1, Math.min(500, Number(process.env.SPA1048_REMAINING_UPDATE_LIMIT || 50)));

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: String(e) }, 'uncaughtException'));

(async () => {
  logger.info({ enabled, updateLimit }, '[spa1048][remaining] one-shot started');

  if (!enabled) {
    logger.info({ enabled }, '[spa1048][remaining] disabled -> exit');
    process.exit(0);
    return;
  }

  try {
    const res = await runRemainingToPayOnce({ limit: updateLimit });
    logger.info({ res }, '[spa1048][remaining] one-shot ok');
    process.exit(0);
  } catch (e) {
    logger.error({ err: e?.message, data: e?.data }, '[spa1048][remaining] one-shot failed');
    process.exit(1);
  }
})();
