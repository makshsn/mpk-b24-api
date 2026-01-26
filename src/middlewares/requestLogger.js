'use strict';

const pinoHttp = require('pino-http');
const { getLogger } = require('../services/logging');

const logger = getLogger('app');

// pino-http использует переданный pino instance как базовый логгер :contentReference[oaicite:4]{index=4}
const httpLogger = pinoHttp({ logger });

module.exports = {
  logger,
  httpLogger,
};
