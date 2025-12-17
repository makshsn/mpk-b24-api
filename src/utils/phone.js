function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  const cleaned = digits.startsWith('+')
    ? '+' + digits.slice(1).replace(/\D/g, '')
    : digits.replace(/\D/g, '');
  return cleaned.length >= 7 ? cleaned : null;
}

// Удаляет из строки тот же телефон, но в любом “человеческом” формате:
// +7 999 888-77-52, 7(999)8887752, 79998887752 и т.п.
function removePhoneFromText(text, normalizedPhone) {
  if (!text) return '';
  if (!normalizedPhone) return String(text).trim();

  const t = String(text);

  const digits = String(normalizedPhone).replace(/\D/g, ''); // 79998887752
  if (digits.length < 7) return t.trim();

  // строим паттерн вида: \+?7\D*9\D*9\D*...
  const body = digits.split('').map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\D*');
  const re = new RegExp(`\\+?${body}`, 'g');

  const cleaned = t
    .replace(re, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[(),\-–—]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned;
}

module.exports = { normalizePhone, removePhoneFromText };
