const path = require('path');

// Одноразовый ручной прогон джобы "Срочно к оплате".
// Удобно запускать через SSH/PM2, чтобы быстро понять, отрабатывает ли логика.

require('dotenv').config({
  path: process.env.DOTENV_PATH
    ? String(process.env.DOTENV_PATH)
    : path.join(__dirname, '../../.env'),
});

const { runUrgentToPayOnce } = require('../modules/spa1048/spa1048UrgentToPay');

(async () => {
  try {
    const res = await runUrgentToPayOnce();
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e?.message || e);
    if (e?.data) console.error(JSON.stringify(e.data, null, 2));
    process.exit(1);
  }
})();
