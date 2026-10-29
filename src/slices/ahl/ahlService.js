const ahlRepository = require('#slices/ahl/ahlRepository.js');
const {
  GAME_TYPES,
  mapAhlSeasons,
  mapAhlTeams,
  mapAhlScheduleGames,
  mapAhlRoster,
} = require('#slices/ahl/mappers/ahlMapper.js');

/** League-wide reports stored per HockeyTech season, under team id 0. */
const AHL_REPORTS = {
  STANDINGS: 'standings',
  SKATERS: 'skaters',
  GOALIES: 'goalies',
};
const LEAGUE_TEAM_ID = 0;

// One page holds a whole season (about 1,250 skaters in 2025-26).
const PLAYER_STATS_PAGE_SIZE = 5000;

/** A final game never changes; anything else refetches its summary after this. */
const GAME_SUMMARY_TTL_MS = 60 * 1000;

/**
 * AHL slice service: fetches HockeyTech feed payloads through the shared cache
 * (keys prefixed `ahl:`, default lifetimes and stale-while-refresh) and stores
 * them in the `ahl_*` tables. The scheduled refresh calls
 * `refreshCurrentSeason`; routes come later and read through the getters.
 *
 * @param {{
 *   ahlApi: typeof import('#platform/ahlApiClient.js'),
 *   cache: typeof import('#platform/cacheManager.js'),
 *   seasons: typeof import('#platform/seasonHelper.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 *   withTransaction: typeof import('#platform/pool.js').withTransaction,
 * }} deps
 */
function createAhlService({
  ahlApi,
  cache,
  seasons,
  runServiceTask,
  withTransaction,
}) {
  const { getOrFetchCached, readCache, writeCache, CACHE_TYPES } = cache;

  /** Cache type, key and fetcher of each feed payload. */
  const feedEntries = {
    seasons: () => ({
      type: CACHE_TYPES.SCHEDULE,
      key: 'ahl:seasons',
      fetch: () => ahlApi.fetchModulekit('seasons'),
    }),
    teams: (hockeytechSeasonId) => ({
      type: CACHE_TYPES.TEAM,
      key: `ahl:teams:${hockeytechSeasonId}`,
      fetch: () =>
        ahlApi.fetchModulekit('teamsbyseason', {
          season_id: hockeytechSeasonId,
        }),
    }),
    schedule: (hockeytechSeasonId) => ({
      type: CACHE_TYPES.SCHEDULE,
      key: `ahl:${hockeytechSeasonId}`,
      fetch: () =>
        ahlApi.fetchModulekit('schedule', { season_id: hockeytechSeasonId }),
    }),
    roster: (hockeytechSeasonId, teamId) => ({
      type: CACHE_TYPES.ROSTER,
      key: `ahl:${teamId}:${hockeytechSeasonId}`,
      fetch: () =>
        ahlApi.fetchModulekit('roster', {
          season_id: hockeytechSeasonId,
          team_id: teamId,
        }),
    }),
    [AHL_REPORTS.STANDINGS]: (hockeytechSeasonId) => ({
      type: CACHE_TYPES.STANDINGS,
      key: `ahl:${hockeytechSeasonId}`,
      fetch: () =>
        ahlApi.fetchModulekit('statviewtype', {
          type: 'standings',
          stat: 'conference',
          season_id: hockeytechSeasonId,
        }),
    }),
    [AHL_REPORTS.SKATERS]: (hockeytechSeasonId) => ({
      type: CACHE_TYPES.STAT_LEADERS,
      key: `ahl:skaters:${hockeytechSeasonId}`,
      fetch: () => fetchPlayerStats(hockeytechSeasonId, 'skaters'),
    }),
    [AHL_REPORTS.GOALIES]: (hockeytechSeasonId) => ({
      type: CACHE_TYPES.STAT_LEADERS,
      key: `ahl:goalies:${hockeytechSeasonId}`,
      fetch: () => fetchPlayerStats(hockeytechSeasonId, 'goalies'),
    }),
    teamPlayerStats: (hockeytechSeasonId, position, teamId) => ({
      type: CACHE_TYPES.PLAYER,
      key: `ahl:${position}:${hockeytechSeasonId}:${teamId}`,
      fetch: () => fetchPlayerStats(hockeytechSeasonId, position, teamId),
    }),
  };

  /**
   * Skater or goalie stat table for a HockeyTech season, every player on one
   * page: league-wide, or only a player's games for one team.
   */
  function fetchPlayerStats(hockeytechSeasonId, position, teamId = 'all') {
    return ahlApi.fetchStatview('players', {
      season: hockeytechSeasonId,
      team: teamId,
      position,
      rookies: 0,
      statsType: 'standard',
      qualified: 'all',
      sort: position === 'goalies' ? 'gaa' : 'points',
      limit: PLAYER_STATS_PAGE_SIZE,
    });
  }

  /** Cached payload of one feed entry, fetched when missing. */
  function readFeedEntry({ type, key, fetch }) {
    return getOrFetchCached(type, key, fetch);
  }

  /** Fetches one feed entry and overwrites its cache entry. */
  async function refreshFeedEntry({ type, key, fetch }) {
    const payload = await fetch();
    await writeCache(type, key, payload);
    return payload;
  }

  /**
   * The HockeyTech seasons of the current season id that have started, in
   * feed order: the regular season and, once they begin, the playoffs.
   */
  function listCurrentSeasons(ahlSeasons) {
    const currentSeasonId = seasons.getCurrentSeasonId();
    const today = new Date().toISOString().slice(0, 10);
    return ahlSeasons.filter(
      (season) =>
        season.seasonId === currentSeasonId && season.startDate <= today,
    );
  }

  /** Fetches and caches one HockeyTech season's teams, schedule and league-wide reports. */
  async function refreshSeasonPayloads(hockeytechSeasonId) {
    const [teamsPayload, schedulePayload, ...reportPayloads] =
      await Promise.all(
        [
          'teams',
          'schedule',
          AHL_REPORTS.STANDINGS,
          AHL_REPORTS.SKATERS,
          AHL_REPORTS.GOALIES,
        ].map((entryName) =>
          refreshFeedEntry(feedEntries[entryName](hockeytechSeasonId)),
        ),
      );
    return {
      teamsPayload,
      schedulePayload,
      reports: {
        [AHL_REPORTS.STANDINGS]: reportPayloads[0],
        [AHL_REPORTS.SKATERS]: reportPayloads[1],
        [AHL_REPORTS.GOALIES]: reportPayloads[2],
      },
    };
  }

  /** Stores one refreshed HockeyTech season (seasons, teams, schedule, reports) in one transaction. */
  function persistSeason(ahlSeasons, season, seasonPayloads) {
    return withTransaction(async (client) => {
      await ahlRepository.upsertAhlSeasons(client, ahlSeasons);
      await ahlRepository.upsertAhlTeams(
        client,
        mapAhlTeams(seasonPayloads.teamsPayload),
      );
      await ahlRepository.upsertAhlScheduleGames(
        client,
        mapAhlScheduleGames(seasonPayloads.schedulePayload, season),
      );
      for (const [report, payload] of Object.entries(seasonPayloads.reports)) {
        await ahlRepository.upsertAhlStatReport(
          client,
          season.hockeytechSeasonId,
          LEAGUE_TEAM_ID,
          report,
          payload,
        );
      }
    });
  }

  return {
    AHL_REPORTS,

    /**
     * Re-fetches the current AHL season (and its playoffs once started):
     * seasons, teams, schedule, standings and league-wide skater and goalie
     * stats, overwriting their cache entries and storing them. Runs after the
     * NHL schedule refresh. Errors are logged, not thrown, so a feed outage
     * never touches the NHL side; the cached and stored copies stay.
     */
    async refreshCurrentSeason() {
      if (!ahlApi.isAhlFeedConfigured()) {
        console.warn('AHL refresh skipped: AHL_FEED_KEY is not set.');
        return;
      }
      try {
        const ahlSeasons = mapAhlSeasons(
          await refreshFeedEntry(feedEntries.seasons()),
        );
        for (const season of listCurrentSeasons(ahlSeasons)) {
          const seasonPayloads = await refreshSeasonPayloads(
            season.hockeytechSeasonId,
          );
          runServiceTask(`ahl refresh ${season.hockeytechSeasonId}`, () =>
            persistSeason(ahlSeasons, season, seasonPayloads),
          );
        }
        console.log('AHL data refreshed at', new Date().toISOString());
      } catch (error) {
        console.error('Failed to refresh AHL data:', error.message);
      }
    },

    /** Mapped HockeyTech seasons (id, season id, game type), from the cached seasons payload. */
    async getSeasons() {
      return mapAhlSeasons(await readFeedEntry(feedEntries.seasons()));
    },

    /**
     * The HockeyTech season id for one of our season ids and game type
     * (regular season by default), or null when the AHL has none.
     */
    async findHockeytechSeasonId(
      seasonId,
      gameType = GAME_TYPES.REGULAR_SEASON,
    ) {
      const ahlSeasons = await this.getSeasons();
      const matchingSeason = ahlSeasons.find(
        (season) =>
          season.seasonId === seasonId && season.gameType === gameType,
      );
      return matchingSeason?.hockeytechSeasonId ?? null;
    },

    /** Cached raw teams payload of a HockeyTech season. */
    getTeams(hockeytechSeasonId) {
      return readFeedEntry(feedEntries.teams(hockeytechSeasonId));
    },

    /** Cached raw schedule payload of a HockeyTech season. */
    getSchedule(hockeytechSeasonId) {
      return readFeedEntry(feedEntries.schedule(hockeytechSeasonId));
    },

    /** Cached raw roster payload of one team and HockeyTech season, stored in the background. */
    async getRoster(hockeytechSeasonId, teamId) {
      const rosterPayload = await readFeedEntry(
        feedEntries.roster(hockeytechSeasonId, teamId),
      );
      runServiceTask(`ahl roster ${teamId} ${hockeytechSeasonId}`, async () => {
        const ahlSeasons = await this.getSeasons();
        const { players, rosterEntries } = mapAhlRoster(
          rosterPayload,
          Number(hockeytechSeasonId),
          Number(teamId),
        );
        await withTransaction(async (client) => {
          await ahlRepository.upsertAhlSeasons(client, ahlSeasons);
          await ahlRepository.upsertAhlPlayers(client, players);
          await ahlRepository.replaceAhlRoster(
            client,
            Number(hockeytechSeasonId),
            Number(teamId),
            rosterEntries,
          );
        });
      });
      return rosterPayload;
    },

    /**
     * A league-wide report (`AHL_REPORTS`) of a HockeyTech season: the stored
     * copy, else the cached feed payload. If the database cannot be read, the
     * cached payload is served.
     */
    async getLeagueReport(hockeytechSeasonId, report) {
      try {
        const storedPayload = await withTransaction((client) =>
          ahlRepository.getAhlStatReport(
            client,
            Number(hockeytechSeasonId),
            LEAGUE_TEAM_ID,
            report,
          ),
        );
        if (storedPayload) return storedPayload;
      } catch (error) {
        console.error(
          `Failed to read stored AHL ${report} ${hockeytechSeasonId}:`,
          error.message,
        );
      }
      return readFeedEntry(feedEntries[report](hockeytechSeasonId));
    },

    /** Cached raw skater or goalie (`position`) stat table of one team and HockeyTech season. */
    getTeamPlayerStats(hockeytechSeasonId, position, teamId) {
      return readFeedEntry(
        feedEntries.teamPlayerStats(hockeytechSeasonId, position, teamId),
      );
    },

    /**
     * Raw game summary of one game: served from the cache forever once
     * final, else refetched after GAME_SUMMARY_TTL_MS.
     */
    async getGameSummary(gameId) {
      const key = `ahl:gamesummary:${gameId}`;
      const cachedSummary = await readCache(CACHE_TYPES.SCHEDULE, key, {
        ttlMs: Infinity,
      });
      if (cachedSummary?.details?.final === '1') return cachedSummary;
      return getOrFetchCached(
        CACHE_TYPES.SCHEDULE,
        key,
        () => ahlApi.fetchGameSummary(gameId),
        { ttlMs: GAME_SUMMARY_TTL_MS },
      );
    },

    /** Latest update of any stored AHL report, or null when none is stored. */
    getLatestReportUpdate() {
      return withTransaction((client) =>
        ahlRepository.getLatestAhlReportUpdate(client),
      );
    },
  };
}

module.exports = { createAhlService, AHL_REPORTS };
