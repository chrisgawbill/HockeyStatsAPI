const axios = require('axios');

const axiosDiscord = axios.create({
  baseURL: 'https://discord.com/api/v10',
  timeout: 10000,
});

/**
 * Parses DISCORD_REDIRECT_URIS (comma-separated) into the list of redirect URIs
 * the API will accept from the frontend. Each must also be registered under
 * OAuth2 -> Redirects in the Discord Developer Portal.
 * @returns {string[]}
 */
function getAllowedRedirectUris() {
  return (process.env.DISCORD_REDIRECT_URIS || '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);
}

/**
 * Exchanges a Discord OAuth2 authorization code (with its PKCE code verifier)
 * for an access token, then fetches the signed-in Discord user. `redirectUri`
 * must be the exact URI the frontend sent the user to Discord with. The access
 * token is used once here and never stored or returned.
 *
 * @param {{ code: string, codeVerifier: string, redirectUri: string }} params
 * @param {{ http?: { post: Function, get: Function } }} [options] HTTP client,
 *   replaceable in tests.
 * @returns {Promise<{ id: string, email: string|null, verified: boolean }>}
 */
async function verifyDiscordCode(
  { code, codeVerifier, redirectUri },
  { http = axiosDiscord } = {},
) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required to verify Discord sign-in.',
    );
  }

  const { data: tokenResponse } = await http.post(
    '/oauth2/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  );

  const { data: discordUser } = await http.get('/users/@me', {
    headers: { authorization: `Bearer ${tokenResponse.access_token}` },
  });

  return {
    id: discordUser.id,
    email: discordUser.email ?? null,
    verified: discordUser.verified === true,
  };
}

module.exports = { getAllowedRedirectUris, verifyDiscordCode };
