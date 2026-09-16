const {
  getCurrentSeasonId,
  isValidSeasonId,
  INVALID_SEASON_MSG,
} = require('#platform/seasonHelper.js');

/**
 * Express middleware for season-capable routes. Validates the optional
 * `?season=` query param, responds 400 if it is present but malformed, and
 * otherwise resolves it (falling back to the current season) onto `req.seasonId`
 * so handlers can read one value instead of repeating the validate-and-default
 * dance.
 */
function validateSeason(req, res, next) {
  const { season } = req.query;
  if (season && !isValidSeasonId(season)) {
    return res.status(400).send({ error: INVALID_SEASON_MSG });
  }
  req.seasonId = season || getCurrentSeasonId();
  next();
}

module.exports = { validateSeason, INVALID_SEASON_MSG };
