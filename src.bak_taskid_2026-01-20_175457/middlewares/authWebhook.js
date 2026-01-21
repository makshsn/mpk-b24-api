const { WEBHOOK_TOKEN } = require('../config/env');

module.exports = function authWebhook(req, res, next) {
  const token =
    req.headers['x-webhook-token'] ||
    req.query.token ||
    (req.body && req.body.token);

  if (token !== WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
};
