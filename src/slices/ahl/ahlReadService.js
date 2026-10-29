const createError = require('http-errors');
const { AHL_REPORTS } = require('#slices/ahl/ahlService.js');
const {
  indexTeamsById,
  mapAhlStandings,
  mapAhlTeamSummary,
  mapAhlScheduleGame,
  mapAhlRosterContract,
  mapAhlSkaterSummary,
  mapAhlGoalieSummary,
  mapAhlStatLeaders,
  mapAhlBoxscore,
} = require('#slices/ahl/mappers/ahlContractMapper.js');

const LEAGUE = 'ahl';

/** HockeyTech team and game ids are integers; anything else is rejected before it reaches the feed or a cache key. */
const ID_PATTERN = /^\d+$/;

/** Tags an object response, or each row of a list response, with `league: "ahl"`. */
function tagLeague(response) {
  return Array.isArray(response)
    ? response.map((row) => ({ ...row, league: LEAGUE }))
    : { ...response, league: LEAGUE };
}

/** 400 for a `teamId` query that is present but not a HockeyTech team id. */
function assertTeamId(teamId) {
  if (teamId && !ID_PATTERN.test(teamId)) {
    throw createError(400, 'Invalid AHL team id.');
  }
}

/**
 * AHL read routes (`?league=ahl`): serves the AHL slice's cached and stored
 * feed payloads in the NHL routes' response shapes. `seasonId` is our 8-digit
 * season id; league-wide stats, standings and rosters use its regular season,
 * the schedule every HockeyTech season (exhibition, regular, playoffs) of it.
 *
 * @param {{ ahlService: ReturnType<typeof import('#slices/ahl/ahlService.js').createAhlService> }} deps
 */
function createAhlReadService({ ahlService }) {
  /** Regular-season HockeyTech id and its teams payload, or nulls when the AHL has no such season. */
  async function getRegularSeason(seasonId) {
    const hockeytechSeasonId =
      await ahlService.findHockeytechSeasonId(seasonId);
    if (hockeytechSeasonId === null) {
      return { hockeytechSeasonId: null, teamsPayload: null };
    }
    return {
      hockeytechSeasonId,
      teamsPayload: await ahlService.getTeams(hockeytechSeasonId),
    };
  }

  /** League-wide or one team's skater or goalie table, or null without a season. */
  async function getPlayerTable(position, teamId, seasonId) {
    assertTeamId(teamId);
    const hockeytechSeasonId =
      await ahlService.findHockeytechSeasonId(seasonId);
    if (hockeytechSeasonId === null) return null;
    if (teamId) {
      return ahlService.getTeamPlayerStats(
        hockeytechSeasonId,
        position,
        teamId,
      );
    }
    return ahlService.getLeagueReport(
      hockeytechSeasonId,
      position === 'goalies' ? AHL_REPORTS.GOALIES : AHL_REPORTS.SKATERS,
    );
  }

  /** Every game of a season id across its HockeyTech seasons, as ScheduleGameContracts sorted by start. */
  async function listSeasonGames(seasonId) {
    const ahlSeasons = (await ahlService.getSeasons()).filter(
      (season) => season.seasonId === seasonId,
    );
    const seasonGames = await Promise.all(
      ahlSeasons.map(async ({ hockeytechSeasonId, gameType }) => {
        const [schedulePayload, teamsPayload] = await Promise.all([
          ahlService.getSchedule(hockeytechSeasonId),
          ahlService.getTeams(hockeytechSeasonId),
        ]);
        const teamsById = indexTeamsById(teamsPayload);
        return (schedulePayload.Schedule ?? []).map((feedGame) =>
          mapAhlScheduleGame(feedGame, gameType, teamsById),
        );
      }),
    );
    return seasonGames
      .flat()
      .sort((first, second) =>
        `${first.date}${first.gameTime ?? ''}`.localeCompare(
          `${second.date}${second.gameTime ?? ''}`,
        ),
      );
  }

  /** The season's feed team with this tri-code and its HockeyTech season id; 404 when the AHL has no such team. */
  async function findTeam(triCode, seasonId) {
    const { hockeytechSeasonId, teamsPayload } =
      await getRegularSeason(seasonId);
    const team = (teamsPayload?.Teamsbyseason ?? []).find(
      (feedTeam) => feedTeam.code === triCode,
    );
    if (!team) throw createError(404, 'Unknown AHL team.');
    return { team, hockeytechSeasonId };
  }

  return {
    findTeam,

    /**
     * Name, team, position and headshot of an AHL player, from the season's
     * league-wide skater and goalie tables; 404 when the player is in neither.
     * shortcut: a player without a game this season is not found; look up the
     * feed's player profile if users miss call-ups.
     */
    async findPlayerProfile(playerId, seasonId) {
      const [skaterTable, goalieTable] = await Promise.all([
        getPlayerTable('skaters', undefined, seasonId),
        getPlayerTable('goalies', undefined, seasonId),
      ]);
      const skater = mapAhlSkaterSummary(skaterTable).find(
        (row) => row.playerId === playerId,
      );
      const goalie = mapAhlGoalieSummary(goalieTable).find(
        (row) => row.goalieId === playerId,
      );
      const player = skater ?? goalie;
      if (!player) throw createError(404, 'Player not found.');
      return {
        fullName: player.name,
        teamTriCode: player.teamTriCodes[0] ?? null,
        position: skater ? skater.position : 'G',
        headshot: null,
      };
    },

    /** `{ standings, league }`; empty standings for a season the AHL does not have. */
    async getStandings(seasonId) {
      const { hockeytechSeasonId, teamsPayload } =
        await getRegularSeason(seasonId);
      if (hockeytechSeasonId === null) return tagLeague({ standings: [] });
      const standingsPayload = await ahlService.getLeagueReport(
        hockeytechSeasonId,
        AHL_REPORTS.STANDINGS,
      );
      return tagLeague({
        standings: mapAhlStandings(standingsPayload, teamsPayload),
      });
    },

    /** `{ data, total, league }` team summary rows for one HockeyTech team id, or every team. */
    async getTeamSummary(teamId, seasonId) {
      assertTeamId(teamId);
      const hockeytechSeasonId =
        await ahlService.findHockeytechSeasonId(seasonId);
      const data =
        hockeytechSeasonId === null
          ? []
          : mapAhlTeamSummary(
              await ahlService.getLeagueReport(
                hockeytechSeasonId,
                AHL_REPORTS.STANDINGS,
              ),
              seasonId,
              teamId,
            );
      return tagLeague({ data, total: data.length });
    },

    /** `{ games, league }` for the whole season. */
    async getSeasonSchedule(seasonId) {
      return tagLeague({ games: await listSeasonGames(seasonId) });
    },

    /** `{ games, league }` of one AHL tri-code's season. */
    async getTeamSchedule(triCode, seasonId) {
      const games = (await listSeasonGames(seasonId)).filter(
        (game) => game.homeTeam === triCode || game.awayTeam === triCode,
      );
      return tagLeague({ games });
    },

    /** Boxscore of one HockeyTech game id; 404 for a malformed or unknown id. */
    async getGameBoxscore(gameId) {
      if (!ID_PATTERN.test(gameId)) throw createError(404, 'Unknown game.');
      return tagLeague(mapAhlBoxscore(await ahlService.getGameSummary(gameId)));
    },

    /** RosterContract of one AHL tri-code; 404 when the AHL has no such team that season. */
    async getRoster(triCode, seasonId) {
      const { team, hockeytechSeasonId } = await findTeam(triCode, seasonId);
      return tagLeague(
        mapAhlRosterContract(
          await ahlService.getRoster(hockeytechSeasonId, team.id),
        ),
      );
    },

    async getSkaterSummary(teamId, seasonId) {
      const statTable = await getPlayerTable('skaters', teamId, seasonId);
      return tagLeague(mapAhlSkaterSummary(statTable));
    },

    async getGoalieSummary(teamId, seasonId) {
      const statTable = await getPlayerTable('goalies', teamId, seasonId);
      return tagLeague(mapAhlGoalieSummary(statTable));
    },

    /** Top-10 leaders of a category for `playerType` (skater, goalie). */
    async getLeaders(playerType, category, seasonId) {
      const { hockeytechSeasonId, teamsPayload } =
        await getRegularSeason(seasonId);
      if (hockeytechSeasonId === null) return [];
      const statTable = await ahlService.getLeagueReport(
        hockeytechSeasonId,
        playerType === 'goalie' ? AHL_REPORTS.GOALIES : AHL_REPORTS.SKATERS,
      );
      return tagLeague(
        mapAhlStatLeaders(statTable, playerType, category, teamsPayload),
      );
    },

    /** `{ version, league }`: changes whenever a stored AHL report does. */
    async getStatsVersion() {
      const latestUpdate = await ahlService.getLatestReportUpdate();
      return tagLeague({
        version: latestUpdate ? new Date(latestUpdate).toISOString() : null,
      });
    },
  };
}

module.exports = { createAhlReadService };
