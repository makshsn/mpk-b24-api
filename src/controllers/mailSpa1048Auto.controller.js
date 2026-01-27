'use strict';

const { runOnce } = require('../modules/mail/mailSpa1048AutoPipeline.v1');

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function run(req, res) {
  const limit = Math.max(1, Math.min(50, toNum(req?.query?.limit ?? req?.body?.limit) || 10));
  const r = await runOnce({ limit });
  return res.json(r);
}

module.exports = { run };
