const { toJsonParam } = require('#platform/jsonParam.js');

/** A team's stored stat report payload for a season, or null when none is stored. */
async function getTeamStatReport(client, seasonId, teamId, report) {
  const { rows: reportRows } = await client.query(
    `
		SELECT payload
		FROM team_stat_reports
		WHERE season_id = $1 AND team_id = $2 AND report = $3
		`,
    [seasonId, teamId, report],
  );
  return reportRows[0]?.payload ?? null;
}

/**
 * Every team's stored payload of one report for a season, as
 * `{ teamId, payload, updatedAt }`.
 */
async function listTeamStatReports(client, seasonId, report) {
  const { rows: reportRows } = await client.query(
    `
		SELECT team_id, payload, updated_at
		FROM team_stat_reports
		WHERE season_id = $1 AND report = $2
		`,
    [seasonId, report],
  );
  return reportRows.map((reportRow) => ({
    teamId: reportRow.team_id,
    payload: reportRow.payload,
    updatedAt: reportRow.updated_at,
  }));
}

/** The names of the reports stored for one team (or the league) in a season. */
async function listStoredReports(client, seasonId, teamId) {
  const { rows: reportRows } = await client.query(
    `
		SELECT report
		FROM team_stat_reports
		WHERE season_id = $1 AND team_id = $2
		`,
    [seasonId, teamId],
  );
  return reportRows.map((reportRow) => reportRow.report);
}

/** When any stored report last changed, or null when none is stored. */
async function getLatestReportUpdate(client) {
  const { rows: latestRows } = await client.query(
    'SELECT max(updated_at) AS updated_at FROM team_stat_reports',
  );
  return latestRows[0]?.updated_at ?? null;
}

/** Upserts one team's stat report payload for a season. */
async function upsertTeamStatReport(client, seasonId, teamId, report, payload) {
  await client.query(
    `
		INSERT INTO team_stat_reports (season_id, team_id, report, payload, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (season_id, team_id, report)
		DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
		`,
    [seasonId, teamId, report, toJsonParam(payload)],
  );
}

/**
 * Claims official games for a refresh and returns the ids this call claimed:
 * games never claimed, plus games not caught up whose last claim is older
 * than `retryAfterSeconds`. Concurrent or repeated polls claim a game once.
 */
async function claimIngestedGames(client, gameIds, retryAfterSeconds) {
  const { rows: claimedRows } = await client.query(
    `
		INSERT INTO team_stats_ingested_games (game_id)
		SELECT unnest($1::bigint[])
		ON CONFLICT (game_id) DO UPDATE SET ingested_at = now()
		WHERE NOT team_stats_ingested_games.caught_up
			AND team_stats_ingested_games.ingested_at
				< now() - make_interval(secs => $2)
		RETURNING game_id
		`,
    [gameIds, retryAfterSeconds],
  );
  return claimedRows.map((claimedRow) => Number(claimedRow.game_id));
}

/** Marks claimed games as caught up, so they are never claimed again. */
async function markGamesCaughtUp(client, gameIds) {
  await client.query(
    `
		UPDATE team_stats_ingested_games
		SET caught_up = true
		WHERE game_id = ANY($1::bigint[])
		`,
    [gameIds],
  );
}

module.exports = {
  getTeamStatReport,
  listTeamStatReports,
  listStoredReports,
  getLatestReportUpdate,
  upsertTeamStatReport,
  claimIngestedGames,
  markGamesCaughtUp,
};
