-- Encrypted emails: `email_encrypted` holds AES-256-GCM ciphertext and
-- `email_lookup` a keyed HMAC of the normalized email for lookups. Neither key
-- is in the database. Not unique: Google and Discord accounts are never merged,
-- so one email can belong to two users. The plaintext `email` column is
-- emptied by src/platform/encryptStoredEmails.js on start and can be dropped in
-- a later migration once every environment has run it.
ALTER TABLE users
	ADD COLUMN IF NOT EXISTS email_encrypted text,
	ADD COLUMN IF NOT EXISTS email_lookup text;

CREATE INDEX IF NOT EXISTS users_email_lookup_idx ON users (email_lookup);
