const path = require('path');

// Одноразовый ручной прогон джобы "Срочно к оплате".
// Удобно запускать через SSH/PM2, чтобы быстро понять, отрабатывает ли логика.

require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { getLogger } = require('../services/logging');
const logger = getLogger('jobs');

const { runUrgentToPayOnce } = require('../modules/spa1048/spa1048UrgentToPay');

(async () => {
  try {
    const res = await runUrgentToPayOnce();
    logger.info(res, 'spa1048-urgent-run-once result');
    process.exit(0);
  } catch (e) {
    logger.error({ err: e?.message || e }, 'spa1048-urgent-run-once error');
    if (e?.data) logger.error({ data: e.data }, 'spa1048-urgent-run-once error.data');
    process.exit(1);
  }
})();
