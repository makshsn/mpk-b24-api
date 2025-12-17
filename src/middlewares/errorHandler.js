const { logger } = require('./requestLogger');

module.exports = function errorHandler(err, req, res, _next) {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ ok: false, error: err.message || 'Internal error' });
};
