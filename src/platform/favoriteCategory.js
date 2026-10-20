const createError = require('http-errors');

const FAVORITE_TIERS = ['diehard', 'fan', 'curious'];
const DEFAULT_FAVORITE_TIER = 'fan';
const MAX_LABEL_LENGTH = 24;

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** User-perceived character count (grapheme clusters; code points as a fallback). */
function countGraphemes(text) {
  if (segmenter) {
    let count = 0;
    for (const _segment of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}

/**
 * Validates a PATCH body for a favorite's fan category. Returns
 * `{ setTier, tier, setLabel, label }`; `label` is trimmed, and null or an
 * empty string clears it. Throws a 400 for a bad tier or label, or when
 * neither key is present.
 */
function parseCategoryUpdate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw createError(400, 'Body must be a JSON object with tier and/or label.');
  }
  const hasTier = Object.hasOwn(body, 'tier');
  const hasLabel = Object.hasOwn(body, 'label');
  if (!hasTier && !hasLabel) {
    throw createError(400, 'Provide tier and/or label.');
  }

  let tier = null;
  if (hasTier) {
    if (!FAVORITE_TIERS.includes(body.tier)) {
      throw createError(
        400,
        `tier must be one of: ${FAVORITE_TIERS.join(', ')}.`,
      );
    }
    tier = body.tier;
  }

  let label = null;
  if (hasLabel && body.label !== null) {
    if (typeof body.label !== 'string') {
      throw createError(400, 'label must be a string or null.');
    }
    label = body.label.trim() || null;
    if (label !== null && countGraphemes(label) > MAX_LABEL_LENGTH) {
      throw createError(
        400,
        `label must be at most ${MAX_LABEL_LENGTH} characters.`,
      );
    }
  }

  return { setTier: hasTier, tier, setLabel: hasLabel, label };
}

module.exports = {
  FAVORITE_TIERS,
  DEFAULT_FAVORITE_TIER,
  MAX_LABEL_LENGTH,
  countGraphemes,
  parseCategoryUpdate,
};
