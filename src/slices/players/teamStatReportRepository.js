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
 * Records official games as ingested and returns the ids this call recorded,
 * so concurrent or repeated polls and sweeps refresh their teams once.
 */
async function claimIngestedGames(client, gameIds) {
  const { rows: claimedRows } = await client.query(
    `
		INSERT INTO team_stats_ingested_games (game_id)
		SELECT unnest($1::bigint[])
		ON CONFLICT (game_id) DO NOTHING
		RETURNING game_id
		`,
    [gameIds],
  );
  return claimedRows.map((claimedRow) => Number(claimedRow.game_id));
}

/** Forgets ingested games so the next poll or sweep retries them. */
async function releaseIngestedGames(client, gameIds) {
  await client.query(
    'DELETE FROM team_stats_ingested_games WHERE game_id = ANY($1::bigint[])',
    [gameIds],
  );
}

module.exports = {
  getTeamStatReport,
  upsertTeamStatReport,
  claimIngestedGames,
  releaseIngestedGames,
};
