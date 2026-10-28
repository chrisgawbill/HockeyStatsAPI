const { toJsonParam } = require('#platform/jsonParam.js');

/** A team's stored stat report payload for a season, or null when none is stored. */
async function getTeamStatReport(client, seasonId, teamId, report) {
  const { rows: reportRows } = await client.query(
    `
		SELECT payload
		FROM team_player_stat_reports
		WHERE season_id = $1 AND team_id = $2 AND report = $3
		`,
    [seasonId, teamId, report],
  );
  return reportRows[0]?.payload ?? null;
}

/** Upserts one team's stat report payload for a season. */
async function upsertTeamStatReport(client, seasonId, teamId, report, payload) {
  await client.query(
    `
		INSERT INTO team_player_stat_reports (season_id, team_id, report, payload, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (season_id, team_id, report)
		DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
		`,
    [seasonId, teamId, report, toJsonParam(payload)],
  );
}

/**
 * Records an official game as ingested; true only for the call that recorded
 * it, so concurrent or repeated polls refresh its teams once.
 */
async function claimIngestedGame(client, gameId) {
  const { rowCount } = await client.query(
    `
		INSERT INTO team_stats_ingested_games (game_id)
		VALUES ($1)
		ON CONFLICT (game_id) DO NOTHING
		`,
    [gameId],
  );
  return rowCount === 1;
}

/** Forgets an ingested game so the next poll retries it. */
async function releaseIngestedGame(client, gameId) {
  await client.query(
    'DELETE FROM team_stats_ingested_games WHERE game_id = $1',
    [gameId],
  );
}

module.exports = {
  getTeamStatReport,
  upsertTeamStatReport,
  claimIngestedGame,
  releaseIngestedGame,
};
