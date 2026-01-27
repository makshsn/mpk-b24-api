const path = require('path');

require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { getLogger } = require('../services/logging');
const logger = getLogger('jobs');

const { runOnce } = require('../modules/mail/mailSpa1048AutoPipeline.v1');

const enabled = String(process.env.MAIL_SPA1048_AUTORUN_ENABLED || 'Y').toUpperCase() !== 'N';
const intervalSec = Math.max(15, Number(process.env.MAIL_SPA1048_INTERVAL_SEC || 60));
const runLimit = Math.max(1, Math.min(50, Number(process.env.MAIL_SPA1048_RUN_LIMIT || 10)));

async function tick() {
  if (!enabled) return;
  try {
    const res = await runOnce({ limit: runLimit });
    logger.info({ res }, '[mail][spa1048][auto] tick ok');
  } catch (e) {
    logger.error({ err: e?.message, data: e?.data }, '[mail][spa1048][auto] tick failed');
  }
}

process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => logger.error({ err: String(e) }, 'uncaughtException'));

(async () => {
  logger.info({ enabled, intervalSec, runLimit }, '[mail][spa1048][auto] started');
  await tick();
  setInterval(tick, intervalSec * 1000);
})();
