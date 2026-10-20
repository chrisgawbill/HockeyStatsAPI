/** Serializes a value as a JSON bind parameter, using `fallback` when it is null or undefined. */
function toJsonParam(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

module.exports = {
  toJsonParam,
};
