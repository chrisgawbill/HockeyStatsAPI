const { mapRoster } = require('#slices/rosters/mappers/rosterMapper.js');
const { withTransaction } = require('#platform/pool.js');
const seasonsRepository = require('#slices/seasons/seasonRepository.js');
const playersRepository = require('#slices/players/playersRepository.js');
const teamsRepository = require('#slices/teams/teamRepository.js');
const rostersRepository = require('#slices/rosters/rosterRepository.js');
const { buildSeason } = require('#platform/entityBuilders.js');
const {
  mapRosterPayload,
} = require('#slices/rosters/mappers/rosterDbMapper.js');

async function persistRoster({
  seasonId,
  triCode,
  teamId = null,
  rosterPayload,
}) {
  const mapped = mapRosterPayload({ seasonId, triCode, teamId, rosterPayload });

  return await withTransaction(async (client) => {
    // Season row first (FK parent), then the optional team and players before
    // roster entries (roster_entries references seasons, players, and teams).
    await seasonsRepository.upsertSeason(
      client,
      buildSeason(seasonId, { roster: rosterPayload ?? null }),
    );

    if (teamId) {
      await teamsRepository.upsertTeams(client, [
        { teamId, triCode, sourcePayload: { teamId, triCode } },
      ]);
    }

    const playersUpserted = await playersRepository.upsertPlayers(
      client,
      mapped.rows.map((row) => row.player),
    );
    const rosterEntriesUpserted = await rostersRepository.upsertRosterEntries(
      client,
      mapped.rows.map((row) => row.rosterEntry),
    );

    return {
      playersUpserted,
      rosterEntriesUpserted,
      skipped: mapped.skipped,
    };
  });
}

/**
 * Roster slice service: cached NHL roster reads plus write-behind persistence.
 *
 * @param {{
 *   nhlApi: { axiosNhl: import('axios').AxiosInstance },
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createRosterService({ nhlApi, cache, runServiceTask }) {
  const { axiosNhl } = nhlApi;
  const { GetOrFetch, CACHE_TYPES } = cache;

  return {
    /** Normalized RosterContract for one team/season. */
    async getRoster(triCode, seasonId) {
      const raw = await GetOrFetch(
        CACHE_TYPES.ROSTER,
        `${triCode}_${seasonId}`,
        () =>
          axiosNhl.get(`/roster/${triCode}/${seasonId}`).then((r) => r.data),
      );
      runServiceTask(`roster ${triCode} ${seasonId}`, () =>
        persistRoster({ seasonId, triCode, rosterPayload: raw }),
      );
      return mapRoster(raw);
    },

    persistRoster,
  };
}

module.exports = {
  createRosterService,
  persistRoster,
};
