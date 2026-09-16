const crypto = require('crypto');

function matchesPassphrase(providedPassphrase) {
  const expectedPassphrase = process.env.DIAGNOSTICS_PASSPHRASE;
  if (!expectedPassphrase || !providedPassphrase) {
    return false;
  }
  const a = crypto.createHash('sha256').update(providedPassphrase).digest();
  const b = crypto.createHash('sha256').update(expectedPassphrase).digest();
  return crypto.timingSafeEqual(a, b);
}

function authCheck(req, res, next) {
  const passphrase = req.get('x-diagnostics-key');
  if (!matchesPassphrase(passphrase)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { authCheck };
