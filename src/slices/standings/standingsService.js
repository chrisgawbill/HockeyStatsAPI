const {
  mapStandingsTeam,
} = require('#slices/standings/mappers/standingsMapper.js');

/**
 * Standings slice service. The NHL standings endpoint is date-based rather than
 * season-based, so this owns the season -> date translation, the cached fetch,
 * and the mapping into StandingsTeamContract rows.
 *
 * @param {{
 *   nhlApi: { axiosNhl: import('axios').AxiosInstance },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   seasons: typeof import('#platform/seasonHelper.js'),
 * }} deps
 */
function createStandingsService({ nhlApi, cache, seasons }) {
  const { axiosNhl } = nhlApi;
  const { GetOrFetch, CACHE_TYPES } = cache;

  /**
   * The standings-season index lists each season's final date (standingsEnd),
   * so we translate a season into the date we should ask for.
   * @param {string} season
   * @returns {Promise<string|null>} YYYY-MM-DD end date, or null if season unknown
   */
  async function getSeasonEndDate(season) {
    const data = await GetOrFetch(CACHE_TYPES.STANDINGS, 'season-index', () =>
      axiosNhl.get('/standings-season').then((r) => r.data),
    );
    const match = (data.seasons ?? []).find(
      (s) => String(s.id) === String(season),
    );
    return match?.standingsEnd ?? null;
  }

  /**
   * Fetches raw NHL standings for a season. The current season uses the live
   * `/standings/now` route while a past season is translated to its settled end
   * date. An unknown past season yields empty standings rather than an error.
   * @param {string} season
   * @returns {Promise<{ standings: any[] }>} Raw, unmapped standings payload.
   */
  async function fetchStandings(season) {
    if (season === seasons.getCurrentSeasonId()) {
      const response = await axiosNhl.get('/standings/now');
      return response.data;
    }
    const endDate = await getSeasonEndDate(season);
    if (!endDate) return { standings: [] };
    const response = await axiosNhl.get(`/standings/${endDate}`);
    return response.data;
  }

  return {
    /**
     * Cached standings payload for a season, with `standings` replaced by
     * normalized StandingsTeamContract rows.
     */
    async getStandings(seasonId) {
      const data = await GetOrFetch(CACHE_TYPES.STANDINGS, seasonId, () =>
        fetchStandings(seasonId),
      );
      const standings = (data.standings ?? [])
        .map(mapStandingsTeam)
        .filter(Boolean);
      return { ...data, standings };
    },
  };
}

module.exports = { createStandingsService };
