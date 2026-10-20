const createError = require('http-errors');

const FAVORITE_TIERS = ['diehard', 'fan', 'curious'];
const DEFAULT_FAVORITE_TIER = 'fan';
const MAX_LABEL_LENGTH = 24;
/** Matches the label CHECK in migration 006 and caps characters built from many code points. */
const MAX_LABEL_CODE_POINTS = 512;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

/** Counts user-perceived characters, so an emoji counts as one. */
function countCharacters(text) {
  return [...graphemeSegmenter.segment(text)].length;
}

/** True when a label exceeds 24 characters or the code-point bound. */
function isLabelTooLong(label) {
  return (
    countCharacters(label) > MAX_LABEL_LENGTH ||
    [...label].length > MAX_LABEL_CODE_POINTS
  );
}

/**
 * Validates a PATCH body for a favorite's fan category and returns
 * `{ changeTier, tier, changeLabel, label }`. A `change*` flag is false when
 * the body left that field out, so the stored value is kept. The label is
 * trimmed, and null or an empty string clears it. Throws a 400 for a bad tier
 * or label, or when the body has neither key.
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
    if (label !== null && isLabelTooLong(label)) {
      throw createError(
        400,
        `label must be at most ${MAX_LABEL_LENGTH} characters.`,
      );
    }
  }

  return { changeTier: hasTier, tier, changeLabel: hasLabel, label };
}

module.exports = { DEFAULT_FAVORITE_TIER, parseCategoryUpdate };
