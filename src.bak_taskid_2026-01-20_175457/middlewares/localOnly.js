module.exports = function localOnly(req, res, next) {
  const ip = (req.ip || '').replace('::ffff:', '');
  const ra = (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '').replace('::ffff:', '');

  const ok = ip === '127.0.0.1' || ip === '::1' || ra === '127.0.0.1' || ra === '::1';

  if (!ok) return res.status(403).json({ ok: false, error: 'local only' });
  next();
};
