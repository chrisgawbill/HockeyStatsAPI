const crypto = require('crypto');

/** Constant-time check of the provided passphrase against DIAGNOSTICS_PASSPHRASE; false when either is unset. */
function matchesPassphrase(providedPassphrase) {
  const expectedPassphrase = process.env.DIAGNOSTICS_PASSPHRASE;
  if (!expectedPassphrase || !providedPassphrase) {
    return false;
  }
  const providedDigest = crypto
    .createHash('sha256')
    .update(providedPassphrase)
    .digest();
  const expectedDigest = crypto
    .createHash('sha256')
    .update(expectedPassphrase)
    .digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/** Rejects requests without the correct `x-diagnostics-key` header with a 401. */
function authCheck(req, res, next) {
  const passphrase = req.get('x-diagnostics-key');
  if (!matchesPassphrase(passphrase)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { authCheck };
