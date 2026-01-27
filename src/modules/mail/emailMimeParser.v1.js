'use strict';

const { simpleParser } = require('mailparser');

async function parseRawEmail(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length) {
    throw new Error('rawBuffer is required');
  }

  const parsed = await simpleParser(rawBuffer, {
    skipHtmlToText: false,
    // attachments: true by default
  });

  // Нормализация адресов в удобный вид
  const normAddr = (a) => {
    if (!a) return null;
    const value = a.value || [];
    return value.map((x) => ({
      name: x.name || '',
      address: x.address || '',
    }));
  };

  return {
    messageId: parsed.messageId || null,
    subject: parsed.subject || '',
    date: parsed.date || null,
    from: normAddr(parsed.from),
    to: normAddr(parsed.to),
    cc: normAddr(parsed.cc),

    text: parsed.text || '',
    html: parsed.html || '',

    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      contentDisposition: a.contentDisposition || null,
      contentId: a.contentId || null,
      related: !!a.related,
      size: a.size || (a.content ? a.content.length : 0),
      content: a.content, // Buffer (будет сохранён на диск)
    })),
  };
}

module.exports = {
  parseRawEmail,
};
