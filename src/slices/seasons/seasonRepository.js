const { toJsonParam } = require('#platform/jsonParam.js');

async function upsertSeason(client, season) {
  const startYear = Number(season.seasonId.slice(0, 4));
  const endYear = Number(season.seasonId.slice(4, 8));
  const result = await client.query(
    `
		INSERT INTO seasons (
			season_id,
			start_year,
			end_year,
			regular_season_start,
			regular_season_end,
			playoffs_end,
			source_payload,
			updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (season_id)
		DO UPDATE SET
			regular_season_start = COALESCE(
				EXCLUDED.regular_season_start,
				seasons.regular_season_start
			),
			regular_season_end = COALESCE(
				EXCLUDED.regular_season_end,
				seasons.regular_season_end
			),
			playoffs_end = COALESCE(EXCLUDED.playoffs_end, seasons.playoffs_end),
			source_payload = EXCLUDED.source_payload,
			updated_at = now()
		RETURNING *
		`,
    [
      season.seasonId,
      startYear,
      endYear,
      season.regularSeasonStart ?? null,
      season.regularSeasonEnd ?? null,
      season.playoffsEnd ?? null,
      toJsonParam(season.sourcePayload),
    ],
  );
  return result.rows[0];
}

async function getSeason(client, seasonId) {
  const result = await client.query(
    'SELECT * FROM seasons WHERE season_id = $1',
    [seasonId],
  );
  return result.rows[0] ?? null;
}

module.exports = {
  upsertSeason,
  getSeason,
};
