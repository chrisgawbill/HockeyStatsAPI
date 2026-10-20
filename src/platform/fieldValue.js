/** Unwraps ES-module style `{ default: value }` wrappers; other values pass through. */
function unwrapDefault(value) {
  if (value && typeof value === 'object' && 'default' in value) {
    return value.default;
  }
  return value;
}

/** Converts to an integer, or null for empty and non-integer values. */
function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Converts to a finite number, or null for empty and non-numeric values. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns the first argument that is not null, undefined or an empty string (after unwrapping), else null. */
function firstValue(...values) {
  for (const value of values) {
    const unwrapped = unwrapDefault(value);
    if (unwrapped !== null && unwrapped !== undefined && unwrapped !== '') {
      return unwrapped;
    }
  }
  return null;
}

module.exports = {
  unwrapDefault,
  toInteger,
  toNumber,
  firstValue,
};
