/**
 * Outbound guard полностью выключен.
 * Никаких application_token не проверяем.
 */
function outboundGuard(_kind = '') {
  return (_req, _res, next) => next();
}

// на всякий случай если в проекте кто-то импортит иначе
function bitrixOutboundGuard(_req, _res, next) { return next(); }
function verifyBitrixToken(_req, _res, next) { return next(); }

module.exports = {
  outboundGuard,
  bitrixOutboundGuard,
  verifyBitrixToken,
};
