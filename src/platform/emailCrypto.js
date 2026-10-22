const crypto = require('crypto');

// Stored format: `v1:<iv>:<auth tag>:<ciphertext>`, each part base64. The
// version prefix leaves room to rotate EMAIL_ENCRYPTION_KEY later.
const CIPHERTEXT_VERSION = 'v1';
const IV_BYTES = 12;
// Binds each ciphertext to the column it belongs in, so a value copied into
// another encrypted column will not decrypt there.
const ASSOCIATED_DATA = Buffer.from('users.email');

/** Decodes a base64 32-byte key from env, failing loudly when it is missing or malformed. */
function getKey(name) {
  const encodedKey = process.env[name];
  if (!encodedKey) {
    throw new Error(`${name} is required to encrypt or look up emails.`);
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes, base64-encoded.`);
  }
  return key;
}

/** Lowercases and trims an email so the lookup hash ignores case and stray whitespace. */
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * Encrypts an email with AES-256-GCM under EMAIL_ENCRYPTION_KEY, using a fresh
 * random IV each time (so equal emails produce different ciphertexts).
 * @param {string} email
 * @returns {string}
 */
function encryptEmail(email) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getKey('EMAIL_ENCRYPTION_KEY'),
    iv,
  );
  cipher.setAAD(ASSOCIATED_DATA);
  const ciphertext = Buffer.concat([
    cipher.update(email.trim(), 'utf8'),
    cipher.final(),
  ]);
  return [CIPHERTEXT_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (Buffer.isBuffer(part) ? part.toString('base64') : part))
    .join(':');
}

/**
 * Decrypts a value produced by `encryptEmail`. Throws if it was tampered with,
 * is malformed, or was encrypted under a different key.
 * @param {string} encryptedEmail
 * @returns {string}
 */
function decryptEmail(encryptedEmail) {
  const [version, iv, authTag, ciphertext] = encryptedEmail.split(':');
  if (version !== CIPHERTEXT_VERSION || ciphertext === undefined) {
    throw new Error('Unrecognized encrypted email format.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey('EMAIL_ENCRYPTION_KEY'),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAAD(ASSOCIATED_DATA);
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Returns a keyed HMAC-SHA256 (hex) of the normalized email under
 * EMAIL_LOOKUP_KEY: a deterministic blind index for finding rows by email
 * without decrypting every row.
 * @param {string} email
 * @returns {string}
 */
function hashEmailForLookup(email) {
  return crypto
    .createHmac('sha256', getKey('EMAIL_LOOKUP_KEY'))
    .update(normalizeEmail(email))
    .digest('hex');
}

/**
 * Builds the two stored columns for an email, or nulls for a missing one.
 * @param {string|null|undefined} email
 * @returns {{ emailEncrypted: string|null, emailLookup: string|null }}
 */
function protectEmail(email) {
  if (!email) {
    return { emailEncrypted: null, emailLookup: null };
  }
  return {
    emailEncrypted: encryptEmail(email),
    emailLookup: hashEmailForLookup(email),
  };
}

module.exports = {
  encryptEmail,
  decryptEmail,
  hashEmailForLookup,
  protectEmail,
};
