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

/**
 * Upserts a team's roster in one transaction. The season row goes first (FK
 * parent), then the optional team and players, before the roster entries that
 * reference seasons, players and teams.
 */
async function persistRoster({
  seasonId,
  triCode,
  teamId = null,
  rosterPayload,
}) {
  const mappedRoster = mapRosterPayload({ seasonId, triCode, teamId, rosterPayload });

  return await withTransaction(async (client) => {
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
      mappedRoster.rows.map((mappedRow) => mappedRow.player),
    );
    const rosterEntriesUpserted = await rostersRepository.upsertRosterEntries(
      client,
      mappedRoster.rows.map((mappedRow) => mappedRow.rosterEntry),
    );

    return {
      playersUpserted,
      rosterEntriesUpserted,
      skipped: mappedRoster.skipped,
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
  const { getOrFetchCached, CACHE_TYPES } = cache;

  return {
    /** Normalized RosterContract for one team/season. */
    async getRoster(triCode, seasonId) {
      const rosterPayload = await getOrFetchCached(
        CACHE_TYPES.ROSTER,
        `${triCode}_${seasonId}`,
        () =>
          axiosNhl.get(`/roster/${triCode}/${seasonId}`).then((response) => response.data),
      );
      runServiceTask(`roster ${triCode} ${seasonId}`, () =>
        persistRoster({ seasonId, triCode, rosterPayload }),
      );
      return mapRoster(rosterPayload);
    },

    persistRoster,
  };
}

module.exports = {
  createRosterService,
  persistRoster,
};
