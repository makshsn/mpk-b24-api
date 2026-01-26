'use strict';

const { getLogger } = require('../services/logging');

const errLogger = getLogger('errors');

module.exports = function errorHandler(err, req, res, _next) {
  errLogger.error(
    {
      reqId: req?.id,
      method: req?.method,
      url: req?.originalUrl,
      err,
    },
    'Unhandled error'
  );

  res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
};
