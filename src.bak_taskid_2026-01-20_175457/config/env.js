require('dotenv').config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  BITRIX_WEBHOOK_BASE: must('BITRIX_WEBHOOK_BASE').replace(/\/+$/, ''),
  WEBHOOK_TOKEN: must('WEBHOOK_TOKEN'),
};
