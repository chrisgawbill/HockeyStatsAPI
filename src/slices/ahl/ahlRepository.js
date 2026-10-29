const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

/** `ON CONFLICT (...) DO UPDATE` that overwrites every listed column with the incoming row. */
function overwriteOnConflict(conflictColumns, updatedColumns) {
  const assignments = updatedColumns
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(', ');
  return `ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${assignments}, updated_at = now()`;
}

/** Upserts HockeyTech seasons with their season id and game type mapping. */
async function upsertAhlSeasons(client, seasons) {
  const columns = [
    'hockeytech_season_id',
    'season_id',
    'game_type',
    'season_name',
    'start_date',
    'end_date',
    'source_payload',
  ];
  return batchUpsert(
    client,
    {
      table: 'ahl_seasons',
      columns,
      keyFn: (season) => String(season.hockeytechSeasonId),
      onConflict: overwriteOnConflict(columns.slice(0, 1), columns.slice(1)),
      toParams: (season) => [
        season.hockeytechSeasonId,
        season.seasonId,
        season.gameType,
        season.seasonName,
        season.startDate,
        season.endDate,
        toJsonParam(season.sourcePayload),
      ],
    },
    seasons,
  );
}

/** Upserts AHL teams; the latest season's name and division win. */
async function upsertAhlTeams(client, teams) {
  const columns = [
    'team_id',
    'team_code',
    'full_name',
    'city',
    'nickname',
    'division_name',
    'logo_url',
    'source_payload',
  ];
  return batchUpsert(
    client,
    {
      table: 'ahl_teams',
      columns,
      keyFn: (team) => String(team.teamId),
      onConflict: overwriteOnConflict(columns.slice(0, 1), columns.slice(1)),
      toParams: (team) => [
        team.teamId,
        team.teamCode,
        team.fullName,
        team.city,
        team.nickname,
        team.divisionName,
        team.logoUrl,
        toJsonParam(team.sourcePayload),
      ],
    },
    teams,
  );
}

/** Upserts one HockeyTech season's schedule games. */
async function upsertAhlScheduleGames(client, games) {
  const columns = [
    'game_id',
    'hockeytech_season_id',
    'season_id',
    'game_type',
    'game_date',
    'start_time_utc',
    'status_code',
    'game_status',
    'venue_name',
    'home_team_id',
    'away_team_id',
    'home_team_code',
    'away_team_code',
    'home_score',
    'away_score',
    'source_payload',
  ];
  return batchUpsert(
    client,
    {
      table: 'ahl_schedule_games',
      columns,
      keyFn: (game) => String(game.gameId),
      onConflict: overwriteOnConflict(columns.slice(0, 1), columns.slice(1)),
      toParams: (game) => [
        game.gameId,
        game.hockeytechSeasonId,
        game.seasonId,
        game.gameType,
        game.gameDate,
        game.startTimeUtc,
        game.statusCode,
        game.gameStatus,
        game.venueName,
        game.homeTeamId,
        game.awayTeamId,
        game.homeTeamCode,
        game.awayTeamCode,
        game.homeScore,
        game.awayScore,
        toJsonParam(game.sourcePayload),
      ],
    },
    games,
  );
}

/** Upserts AHL players from a roster. */
async function upsertAhlPlayers(client, players) {
  const columns = [
    'player_id',
    'first_name',
    'last_name',
    'full_name',
    'position_code',
    'shoots',
    'catches',
    'birth_date',
    'headshot_url',
    'source_payload',
  ];
  return batchUpsert(
    client,
    {
      table: 'ahl_players',
      columns,
      keyFn: (player) => String(player.playerId),
      onConflict: overwriteOnConflict(columns.slice(0, 1), columns.slice(1)),
      toParams: (player) => [
        player.playerId,
        player.firstName,
        player.lastName,
        player.fullName,
        player.positionCode,
        player.shoots,
        player.catches,
        player.birthDate,
        player.headshotUrl,
        toJsonParam(player.sourcePayload),
      ],
    },
    players,
  );
}

/**
 * Replaces one team's roster for a HockeyTech season, so players who left
 * the team drop off.
 */
async function replaceAhlRoster(
  client,
  hockeytechSeasonId,
  teamId,
  rosterEntries,
) {
  await client.query(
    'DELETE FROM ahl_roster_entries WHERE hockeytech_season_id = $1 AND team_id = $2',
    [hockeytechSeasonId, teamId],
  );
  const columns = [
    'hockeytech_season_id',
    'team_id',
    'player_id',
    'sweater_number',
    'position_code',
    'source_payload',
  ];
  return batchUpsert(
    client,
    {
      table: 'ahl_roster_entries',
      columns,
      keyFn: (rosterEntry) => String(rosterEntry.playerId),
      onConflict: overwriteOnConflict(columns.slice(0, 3), columns.slice(3)),
      toParams: (rosterEntry) => [
        rosterEntry.hockeytechSeasonId,
        rosterEntry.teamId,
        rosterEntry.playerId,
        rosterEntry.sweaterNumber,
        rosterEntry.positionCode,
        toJsonParam(rosterEntry.sourcePayload),
      ],
    },
    rosterEntries,
  );
}

/** A stored report payload for a HockeyTech season and team (0 = league-wide), or null. */
async function getAhlStatReport(client, hockeytechSeasonId, teamId, report) {
  const { rows: reportRows } = await client.query(
    `
		SELECT payload
		FROM ahl_team_stat_reports
		WHERE hockeytech_season_id = $1 AND team_id = $2 AND report = $3
		`,
    [hockeytechSeasonId, teamId, report],
  );
  return reportRows[0]?.payload ?? null;
}

/** Upserts one report payload for a HockeyTech season and team (0 = league-wide). */
async function upsertAhlStatReport(
  client,
  hockeytechSeasonId,
  teamId,
  report,
  payload,
) {
  await client.query(
    `
		INSERT INTO ahl_team_stat_reports (hockeytech_season_id, team_id, report, payload, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (hockeytech_season_id, team_id, report)
		DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
		`,
    [hockeytechSeasonId, teamId, report, toJsonParam(payload)],
  );
}

/** When any stored AHL report last changed, or null when none is stored. */
async function getLatestAhlReportUpdate(client) {
  const { rows } = await client.query(
    'SELECT max(updated_at) AS latest_update FROM ahl_team_stat_reports',
  );
  return rows[0]?.latest_update ?? null;
}

module.exports = {
  upsertAhlSeasons,
  upsertAhlTeams,
  upsertAhlScheduleGames,
  upsertAhlPlayers,
  replaceAhlRoster,
  getAhlStatReport,
  upsertAhlStatReport,
  getLatestAhlReportUpdate,
};
