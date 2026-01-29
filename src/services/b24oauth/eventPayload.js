'use strict';

/**
 * Normalize Bitrix24 event payload for ONCRMDYNAMICITEMUPDATE.
 * Supports both:
 * - req.body with fields like event, data, auth
 * - form-encoded style where keys are like "data[FIELDS][ID]"
 */
function pick(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeEventPayload(body = {}) {
  const event = body.event || body.EVENT || null;

  // common structure
  const entityTypeId =
    toNumber(pick(body, ['data', 'FIELDS', 'ENTITY_TYPE_ID'])) ??
    toNumber(pick(body, ['data', 'FIELDS', 'ENTITYTYPEID'])) ??
    toNumber(pick(body, ['data', 'entityTypeId'])) ??
    toNumber(pick(body, ['data', 'ENTITY_TYPE_ID'])) ??
    null;

  const itemId =
    toNumber(pick(body, ['data', 'FIELDS', 'ID'])) ??
    toNumber(pick(body, ['data', 'FIELDS', 'id'])) ??
    toNumber(pick(body, ['data', 'id'])) ??
    null;

  // form-encoded fallbacks (express.urlencoded already converts to nested objects for [..] patterns)
  const fEntityTypeId =
    toNumber(body?.data?.FIELDS?.ENTITY_TYPE_ID) ??
    toNumber(body?.data?.FIELDS?.ENTITYTYPEID) ??
    null;

  const fItemId =
    toNumber(body?.data?.FIELDS?.ID) ??
    null;

  const auth = body.auth || body.AUTH || null;

  const applicationToken =
    auth?.application_token ||
    auth?.APPLICATION_TOKEN ||
    body?.auth?.application_token ||
    null;

  const memberId =
    auth?.member_id ||
    auth?.MEMBER_ID ||
    null;

  const domain =
    auth?.domain ||
    auth?.DOMAIN ||
    null;

  return {
    event,
    entityTypeId: entityTypeId ?? fEntityTypeId,
    itemId: itemId ?? fItemId,
    applicationToken,
    memberId,
    domain,
    raw: body,
  };
}

module.exports = { normalizeEventPayload };
