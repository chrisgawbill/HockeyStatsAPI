function unwrapDefault(value) {
  if (value && typeof value === 'object' && 'default' in value) {
    return value.default;
  }
  return value;
}

function toInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

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
