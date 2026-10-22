/**
 * Fetches the user that owns a sign-in identity (provider + the provider's
 * stable subject id), or null when the identity is not known yet.
 */
async function findUserByIdentity(client, { provider, subject }) {
  const { rows: userRows } = await client.query(
    `
		SELECT users.*
		FROM user_identities
		JOIN users ON users.id = user_identities.user_id
		WHERE user_identities.provider = $1 AND user_identities.subject = $2
		`,
    [provider, subject],
  );
  return userRows[0] ?? null;
}

/** Records a sign-in on an existing identity. */
async function touchIdentity(client, { provider, subject }) {
  await client.query(
    `
		UPDATE user_identities
		SET last_signed_in_at = now()
		WHERE provider = $1 AND subject = $2
		`,
    [provider, subject],
  );
}

/** Fetches the user holding a verified email's lookup hash, or null. */
async function findUserByEmailLookup(client, emailLookup) {
  const { rows: userRows } = await client.query(
    'SELECT * FROM users WHERE email_lookup = $1',
    [emailLookup],
  );
  return userRows[0] ?? null;
}

/** Inserts a user with an already-encrypted email (or none) and returns the row. */
async function createUser(client, { emailEncrypted, emailLookup }) {
  const { rows: createdUserRows } = await client.query(
    `
		INSERT INTO users (email_encrypted, email_lookup)
		VALUES ($1, $2)
		RETURNING *
		`,
    [emailEncrypted ?? null, emailLookup ?? null],
  );
  return createdUserRows[0];
}

/** Attaches a sign-in identity to a user, stamped as signed in now. */
async function addIdentity(client, { userId, provider, subject }) {
  await client.query(
    `
		INSERT INTO user_identities (user_id, provider, subject, last_signed_in_at)
		VALUES ($1, $2, $3, now())
		`,
    [userId, provider, subject],
  );
}

/** Replaces a user's encrypted email and lookup hash and returns the row. */
async function updateUserEmail(client, { userId, emailEncrypted, emailLookup }) {
  const { rows: updatedUserRows } = await client.query(
    `
		UPDATE users
		SET email_encrypted = $2, email_lookup = $3
		WHERE id = $1
		RETURNING *
		`,
    [userId, emailEncrypted ?? null, emailLookup ?? null],
  );
  return updatedUserRows[0];
}

/** Fetches a user by id, or null. */
async function getUserById(client, userId) {
  const { rows: userRows } = await client.query(
    'SELECT * FROM users WHERE id = $1',
    [userId],
  );
  return userRows[0] ?? null;
}

module.exports = {
  findUserByIdentity,
  touchIdentity,
  findUserByEmailLookup,
  createUser,
  addIdentity,
  updateUserEmail,
  getUserById,
};
