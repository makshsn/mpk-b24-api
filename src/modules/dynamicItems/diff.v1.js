'use strict';

function isPrimitive(v) {
  return v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function normalizeScalar(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return String(v);
}

function normalizeArray(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const it of arr) {
    if (isPrimitive(it)) out.push(normalizeScalar(it));
    else if (it && typeof it === 'object') {
      const id = it.id ?? it.ID ?? it.value ?? it.VALUE;
      if (id !== undefined) out.push(normalizeScalar(id));
    }
  }
  // стабильность для сравнения
  return out
    .filter((x) => x !== null && x !== '')
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function normalizeItemForSnapshot(item = {}) {
  const out = {};
  if (!item || typeof item !== 'object') return out;

  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;

    if (isPrimitive(v)) {
      out[k] = normalizeScalar(v);
      continue;
    }

    if (Array.isArray(v)) {
      out[k] = normalizeArray(v);
      continue;
    }

    if (v && typeof v === 'object') {
      // частый кейс: пользователь/статус как объект с id
      const id = v.id ?? v.ID ?? null;
      if (id !== null && id !== undefined) {
        out[k] = normalizeScalar(id);
      }
      // иначе игнорируем сложные объекты (они часто шумят)
    }
  }

  return out;
}

function deepEqual(a, b) {
  // snapshot у нас плоский (примитивы/массивы)
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  return String(a) === String(b);
}

function computeChangedKeys(prev = {}, next = {}, opts = {}) {
  const ignore = new Set((opts.ignoreKeys || []).map(String));
  const only = Array.isArray(opts.onlyKeys) && opts.onlyKeys.length
    ? new Set(opts.onlyKeys.map(String))
    : null;

  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  const changed = [];

  for (const k of keys) {
    if (ignore.has(k)) continue;
    if (only && !only.has(k)) continue;

    const a = prev ? prev[k] : undefined;
    const b = next ? next[k] : undefined;
    if (!deepEqual(a, b)) changed.push(k);
  }

  changed.sort();
  return changed;
}

function buildDiff(prevSnap, nextSnap, opts = {}) {
  const p = prevSnap?.item || {};
  const n = nextSnap?.item || {};

  const stageKey = opts.stageKey || 'stageId';
  const stageBefore = p?.[stageKey] ?? null;
  const stageAfter = n?.[stageKey] ?? null;
  const stageChanged = !deepEqual(stageBefore, stageAfter);

  const changedKeys = computeChangedKeys(p, n, opts);
  const fieldChanged = changedKeys.length > 0;

  return {
    stageChanged,
    stageKey,
    stageBefore,
    stageAfter,
    changedKeys,
    fieldChanged,
  };
}

module.exports = {
  normalizeItemForSnapshot,
  buildDiff,
  computeChangedKeys,
};
