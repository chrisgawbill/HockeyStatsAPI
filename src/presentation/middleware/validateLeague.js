const createError = require('http-errors');

const LEAGUES = ['nhl', 'ahl'];
const INVALID_LEAGUE_MSG = "Invalid league. Expected 'nhl' or 'ahl'.";

/**
 * Express middleware for league-capable routes. Validates the optional
 * `?league=` query param (400 unless `nhl` or `ahl`) and resolves it onto
 * `req.league`, defaulting to `nhl` so routes without it behave as before.
 */
function validateLeague(req, res, next) {
  const { league = 'nhl' } = req.query;
  if (!LEAGUES.includes(league)) {
    return res.status(400).send({ error: INVALID_LEAGUE_MSG });
  }
  req.league = league;
  next();
}

/** For NHL-only routes: `validateLeague`, then 404 for `league=ahl` rather than serving NHL data. */
function nhlOnly(req, res, next) {
  validateLeague(req, res, () =>
    next(
      req.league === 'ahl'
        ? createError(404, 'Not available for the AHL.')
        : undefined,
    ),
  );
}

module.exports = { validateLeague, nhlOnly, INVALID_LEAGUE_MSG };
