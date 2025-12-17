const pino = require('pino');
const pinoHttp = require('pino-http');
const fs = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const streams = [
  { stream: pino.destination({ dest: 'logs/app.log', sync: false }) },
];

const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, pino.multistream(streams));

module.exports = {
  logger,
  httpLogger: pinoHttp({ logger }),
};
