const { OAuth2Client } = require('google-auth-library');

let client = null;

function getClient() {
  if (!client) {
    client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  }
  return client;
}

/**
 * Verifies a Google Identity Services ID token and returns its payload
 * (including `sub`, `email`, ...). Throws if the token is missing, malformed,
 * expired, or was not issued for `GOOGLE_OAUTH_CLIENT_ID`.
 *
 * @param {string} idToken Raw ID token credential from Google Identity Services.
 * @returns {Promise<import('google-auth-library').TokenPayload>}
 */
async function verifyGoogleIdToken(idToken) {
  const audience = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!audience) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is required to verify Google sign-in.');
  }
  const ticket = await getClient().verifyIdToken({ idToken, audience });
  return ticket.getPayload();
}

module.exports = { verifyGoogleIdToken };
