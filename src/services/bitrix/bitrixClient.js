const axios = require('axios');
const { BITRIX_WEBHOOK_BASE } = require('../../config/env');

const http = axios.create({
  timeout: 15000,
});

async function call(method, params = {}) {
  const url = `${BITRIX_WEBHOOK_BASE}/${method}.json`;
  const { data } = await http.post(url, params);

  if (data && data.error) {
    const e = new Error(`${data.error}: ${data.error_description || ''}`.trim());
    e.bitrix = data;
    throw e;
  }
  return data.result;
}

module.exports = { call };
