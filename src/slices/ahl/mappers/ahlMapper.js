/**
 * ahlMapper
 *
 * Turns raw HockeyTech feed payloads (all values arrive as strings) into rows
 * for the `ahl_*` tables. Each row keeps its raw feed object as `sourcePayload`.
 */
const { toInteger } = require('#platform/fieldValue.js');
const { getCurrentSeasonId } = require('#platform/seasonHelper.js');

const GAME_TYPES = { EXHIBITION: 1, REGULAR_SEASON: 2, PLAYOFFS: 3 };

/** Empty strings become null; other values pass through. */
function toText(value) {
  return value === '' || value === undefined ? null : value;
}

/** A feed date (YYYY-MM-DD), or null for empty and placeholder dates such as 0000-00-00. */
function toFeedDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && !value.startsWith('0000')
    ? value
    : null;
}

/** NHL-style game type of a HockeyTech season, or null for all-star events and other one-offs. */
function getSeasonGameType(feedSeason) {
  if (feedSeason.playoff === '1') return GAME_TYPES.PLAYOFFS;
  if (/regular season/i.test(feedSeason.season_name)) {
    return GAME_TYPES.REGULAR_SEASON;
  }
  if (/exhibition|pre-?season/i.test(feedSeason.season_name)) {
    return GAME_TYPES.EXHIBITION;
  }
  return null;
}

/**
 * `ahl_seasons` rows from the modulekit `seasons` view. The 8-digit season id
 * follows from the start date with the same September 1 rollover as the NHL
 * (spring playoffs belong to the season that started the autumn before).
 * Seasons without a game type are left out.
 */
function mapAhlSeasons(seasonsPayload) {
  return (seasonsPayload.Seasons ?? [])
    .filter((feedSeason) => toFeedDate(feedSeason.start_date) !== null)
    .map((feedSeason) => ({
      hockeytechSeasonId: toInteger(feedSeason.season_id),
      seasonId: getCurrentSeasonId(
        new Date(`${feedSeason.start_date}T12:00:00`),
      ),
      gameType: getSeasonGameType(feedSeason),
      seasonName: feedSeason.season_name,
      startDate: toFeedDate(feedSeason.start_date),
      endDate: toFeedDate(feedSeason.end_date),
      sourcePayload: feedSeason,
    }))
    .filter(
      (season) =>
        season.hockeytechSeasonId !== null && season.gameType !== null,
    );
}

/** `ahl_teams` rows from the modulekit `teamsbyseason` view. */
function mapAhlTeams(teamsPayload) {
  return (teamsPayload.Teamsbyseason ?? []).map((feedTeam) => ({
    teamId: toInteger(feedTeam.id),
    teamCode: feedTeam.code,
    fullName: toText(feedTeam.name),
    city: toText(feedTeam.city),
    nickname: toText(feedTeam.nickname),
    divisionName: toText(feedTeam.division_long_name),
    logoUrl: toText(feedTeam.team_logo_url),
    sourcePayload: feedTeam,
  }));
}

/**
 * `ahl_schedule_games` rows from the modulekit `schedule` view of one
 * HockeyTech season. Scores stay null until a game has started.
 */
function mapAhlScheduleGames(schedulePayload, season) {
  return (schedulePayload.Schedule ?? []).map((feedGame) => {
    const hasStarted = feedGame.started === '1';
    const hasStartTime = feedGame.date_tbd !== '1' && feedGame.time_tbd !== '1';
    return {
      gameId: toInteger(feedGame.game_id),
      hockeytechSeasonId: season.hockeytechSeasonId,
      seasonId: season.seasonId,
      gameType: season.gameType,
      gameDate: toFeedDate(feedGame.date_played),
      startTimeUtc: hasStartTime ? toText(feedGame.GameDateISO8601) : null,
      statusCode: toInteger(feedGame.status),
      gameStatus: toText(feedGame.game_status),
      venueName: toText(feedGame.venue_name),
      homeTeamId: toInteger(feedGame.home_team),
      awayTeamId: toInteger(feedGame.visiting_team),
      homeTeamCode: toText(feedGame.home_team_code),
      awayTeamCode: toText(feedGame.visiting_team_code),
      homeScore: hasStarted ? toInteger(feedGame.home_goal_count) : null,
      awayScore: hasStarted ? toInteger(feedGame.visiting_goal_count) : null,
      sourcePayload: feedGame,
    };
  });
}

/**
 * `ahl_players` and `ahl_roster_entries` rows from the modulekit `roster`
 * view. The roster also lists team staff (as a nested array); only entries
 * with a player id and a position are players.
 */
function mapAhlRoster(rosterPayload, hockeytechSeasonId, teamId) {
  const rosterPlayers = (rosterPayload.Roster ?? []).filter(
    (rosterEntry) =>
      !Array.isArray(rosterEntry) &&
      toInteger(rosterEntry.player_id) !== null &&
      toText(rosterEntry.position) !== null,
  );
  return {
    players: rosterPlayers.map((rosterPlayer) => ({
      playerId: toInteger(rosterPlayer.player_id),
      firstName: toText(rosterPlayer.first_name),
      lastName: toText(rosterPlayer.last_name),
      fullName: toText(rosterPlayer.name),
      positionCode: rosterPlayer.position,
      shoots: toText(rosterPlayer.shoots),
      catches: toText(rosterPlayer.catches),
      birthDate: toFeedDate(rosterPlayer.birthdate),
      headshotUrl: toText(rosterPlayer.player_image),
      sourcePayload: rosterPlayer,
    })),
    rosterEntries: rosterPlayers.map((rosterPlayer) => ({
      hockeytechSeasonId,
      teamId,
      playerId: toInteger(rosterPlayer.player_id),
      sweaterNumber: toInteger(rosterPlayer.tp_jersey_number),
      positionCode: rosterPlayer.position,
      sourcePayload: rosterPlayer,
    })),
  };
}

module.exports = {
  GAME_TYPES,
  getSeasonGameType,
  mapAhlSeasons,
  mapAhlTeams,
  mapAhlScheduleGames,
  mapAhlRoster,
};
