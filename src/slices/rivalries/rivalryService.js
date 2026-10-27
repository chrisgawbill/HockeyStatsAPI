const createError = require('http-errors');
const repository = require('#slices/rivalries/rivalryRepository.js');

const TRI_CODE_PATTERN = /^[A-Z]{3}$/;

/** Maps a rivalry row to the API shape; `teams` is alphabetical so either lookup side matches. */
function mapRivalryRow(row) {
  return {
    teams: [row.team_a, row.team_b].sort(),
    tier: row.tier,
    displayName: row.display_name ?? null,
  };
}

/**
 * Site-wide rivalries. Only stored, enabled pairs are returned; a team with
 * none gets an empty list rather than an inferred rival.
 */
function createRivalryService({ withTransaction }) {
  /** Every enabled rivalry, or only `triCode`'s when given. */
  async function listRivalries(triCode) {
    let teamTriCode = null;
    if (triCode !== undefined) {
      teamTriCode = String(triCode).toUpperCase();
      if (!TRI_CODE_PATTERN.test(teamTriCode)) {
        throw createError(400, 'Invalid team tri-code.');
      }
    }
    const rivalryRows = await withTransaction((client) =>
      repository.listEnabledRivalries(client, teamTriCode),
    );
    return { rivalries: rivalryRows.map(mapRivalryRow) };
  }

  return { listRivalries };
}

module.exports = { createRivalryService };
