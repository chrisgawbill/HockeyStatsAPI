/**
 * Computes the current NHL season id from today's date. The season is named for
 * its two calendar years (e.g. "20252026") and rolls over on September 1, so
 * any month from September on belongs to the season starting that year.
 * @param {Date} [now] Date to compute from; defaults to the real current date.
 *   Injectable so tests can pin the boundary instead of depending on the clock.
 * @returns {string} The 8-digit season id for the season in progress at `now`.
 */
function getCurrentSeasonId(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return `${startYear}${startYear + 1}`;
}

/**
 * Checks whether a string is a well-formed season id: exactly 8 digits whose
 * first four (start year) plus one equal the last four (end year).
 * @param {string} idStr
 * @returns {boolean}
 */
function isValidSeasonId(idStr) {
  return (
    /^\d{8}$/.test(idStr) &&
    parseInt(idStr.slice(0, 4)) + 1 === parseInt(idStr.slice(4, 8))
  );
}

const INVALID_SEASON_MSG =
  "Invalid season format. Expected format is 'YYYYYYYY', where the first YYYY is the start year and the second YYYY is the end year (e.g., '20232024').";

module.exports = {
  getCurrentSeasonId,
  isValidSeasonId,
  INVALID_SEASON_MSG,
};
