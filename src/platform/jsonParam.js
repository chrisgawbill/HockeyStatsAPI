function toJsonParam(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

module.exports = {
  toJsonParam,
};
