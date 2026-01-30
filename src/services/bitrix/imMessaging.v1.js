'use strict';

const { getLogger } = require('../logging');
const logger = getLogger('im');

const bitrix = require('./bitrixClient');

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickClient() {
  // если отдельный вебхук задан — используем его (бот)
  const hasNotify = String(process.env.BITRIX_NOTIFY_WEBHOOK_BASE || '').trim();
  return hasNotify ? bitrix.notify : bitrix.main;
}

/**
 * Личное сообщение пользователю (в диалог), отправитель = владелец выбранного вебхука.
 * Docs: im.message.add
 */
async function sendDirectMessage({ toUserId, message }) {
  const uid = toNum(toUserId);
  const text = String(message || '').trim();
  if (!uid || !text) return { ok: true, action: 'skip_empty' };

  const client = pickClient();

  const r = await client.call(
    'im.message.add',
    {
      DIALOG_ID: String(uid),
      MESSAGE: text,
    },
    { ctx: { step: 'im.message.add', toUserId: uid, client: client === bitrix.notify ? 'notify' : 'main' } }
  );

  return { ok: true, result: r };
}

/**
 * Персональное уведомление (колокольчик).
 * Docs: im.notify.personal.add
 */
async function sendPersonalNotify({ toUserId, message }) {
  const uid = toNum(toUserId);
  const text = String(message || '').trim();
  if (!uid || !text) return { ok: true, action: 'skip_empty' };

  const client = pickClient();

  const r = await client.call(
    'im.notify.personal.add',
    { USER_ID: uid, MESSAGE: text },
    { ctx: { step: 'im.notify.personal.add', toUserId: uid, client: client === bitrix.notify ? 'notify' : 'main' } }
  );

  return { ok: true, result: r };
}

async function safeSendDirectMessage({ toUserId, message }) {
  try {
    return await sendDirectMessage({ toUserId, message });
  } catch (e) {
    logger.warn({ err: e?.message || String(e), data: e?.data, toUserId }, '[im] direct message failed, fallback to notify');
    try {
      return await sendPersonalNotify({ toUserId, message });
    } catch (e2) {
      logger.error({ err: e2?.message || String(e2), data: e2?.data, toUserId }, '[im] notify failed');
      return { ok: false, error: e2?.message || String(e2), data: e2?.data };
    }
  }
}

module.exports = {
  sendDirectMessage,
  sendPersonalNotify,
  safeSendDirectMessage,
};
