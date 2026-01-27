'use strict';

const { createSpa1048FromStoredEmail } = require('../modules/spa1048/spa1048CreateFromStoredEmail.v1');

async function createFromEmail(req, res) {
  const emailId = String(req?.params?.emailId || '').trim();
  const r = await createSpa1048FromStoredEmail({ emailId });
  return res.json(r);
}

module.exports = { createFromEmail };
