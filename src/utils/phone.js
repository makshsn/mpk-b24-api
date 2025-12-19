function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function baseNormalizeRuDigits(d) {
  // 10 цифр: 9XXXXXXXXX -> +7 9XXXXXXXXX
  if (d.length === 10 && d.startsWith('9')) {
    return { ok: true, e164: '+7' + d };
  }

  // 11 цифр: 8XXXXXXXXXX -> +7XXXXXXXXXX
  if (d.length === 11 && d.startsWith('8')) {
    return { ok: true, e164: '+7' + d.slice(1) };
  }

  // 11 цифр: 7XXXXXXXXXX -> +7XXXXXXXXXX
  if (d.length === 11 && d.startsWith('7')) {
    return { ok: true, e164: '+7' + d.slice(1) };
  }

  return { ok: false, reason: `unrecognized_length_${d.length}` };
}

function scoreRuE164(e164) {
  // хотим “самый вероятный”: мобилки РФ обычно +79...
  if (typeof e164 !== 'string') return 0;
  if (e164.startsWith('+79')) return 100;
  if (e164.startsWith('+7')) return 10;
  return 0;
}

// Нормализация РФ -> +7XXXXXXXXXX
// Умеет чинить частый мусор: 12 цифр (лишняя 1 цифра) -> пытается удалить 1 цифру и выбрать лучший вариант
function normalizeRuPhone(raw) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, reason: 'empty' };

  const d0 = digitsOnly(input);
  if (!d0) return { ok: false, reason: 'no_digits' };

  // 1) Прямая нормализация
  const direct = baseNormalizeRuDigits(d0);
  if (direct.ok) return { ok: true, e164: direct.e164, fixed: false };

  // 2) Попытка исправить "лишнюю цифру" (длина 12)
  if (d0.length === 12) {
    const candidates = new Map(); // e164 -> bestScore
    for (let i = 0; i < d0.length; i++) {
      const d = d0.slice(0, i) + d0.slice(i + 1);
      const r = baseNormalizeRuDigits(d);
      if (!r.ok) continue;
      const sc = scoreRuE164(r.e164);
      const prev = candidates.get(r.e164);
      if (prev == null || sc > prev) candidates.set(r.e164, sc);
    }

    if (candidates.size) {
      // выбрать лучший по score, если не двусмысленно
      const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
      const best = sorted[0];
      const second = sorted[1];

      // если есть второй с таким же score — считаем неоднозначно
      if (second && second[1] === best[1]) {
        return { ok: false, reason: 'ambiguous_after_fix_12_digits' };
      }
      return { ok: true, e164: best[0], fixed: true };
    }
  }

  return { ok: false, reason: direct.reason || 'invalid' };
}

// Удаляет из текста КОНКРЕТНЫЙ телефон (любой формат), если знаем нормализованный
function removePhoneFromText(text, normalizedE164) {
  if (!text) return '';
  if (!normalizedE164) return String(text).trim();

  const t = String(text);
  const d = digitsOnly(normalizedE164); // 7XXXXXXXXXX
  if (d.length < 7) return t.trim();

  const body = d.split('').join('\\D*');
  const re = new RegExp(`\\+?${body}`, 'g');

  return t
    .replace(re, ' ')
    .replace(/[(),\-–—]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Если PHONE пустой, чистим TITLE от "похожих на телефоны"
function removeAnyPhonesFromText(text) {
  if (!text) return '';
  const t = String(text);

  const cleaned = t.replace(/(\+?\d[\d\s().\-]{6,}\d)/g, (m) => {
    const n = normalizeRuPhone(m);
    // если похоже на РФ номер — убираем
    if (n.ok && n.e164.startsWith('+7')) return ' ';
    return m;
  });

  return cleaned
    .replace(/[(),\-–—]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Заменяет в тексте все куски, которые нормализуются в тот же номер, на нормальный +7...
function replaceAnyPhonesWithNormalized(text, normalizedE164) {
  if (!text) return '';
  if (!normalizedE164) return String(text).trim();

  const target = String(normalizedE164).trim();

  return String(text)
    .replace(/(\+?\d[\d\s().\-]{6,}\d)/g, (m) => {
      const n = normalizeRuPhone(m);
      if (n.ok && n.e164 === target) return target;
      return m;
    })
    .replace(/[(),\-–—]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = {
  normalizeRuPhone,
  removePhoneFromText,
  removeAnyPhonesFromText,
  replaceAnyPhonesWithNormalized,
};
