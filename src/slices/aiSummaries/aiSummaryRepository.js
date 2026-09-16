const { toJsonParam } = require('#platform/jsonParam.js');

async function upsertAiSummary(client, summary) {
  const result = await client.query(
    `
		INSERT INTO ai_summaries (
			team_id,
			tri_code,
			summary_type,
			prompt_version,
			model_provider,
			model_name,
			prompt_hash,
			content,
			source_notes,
			updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
		ON CONFLICT (tri_code, summary_type, prompt_version)
		DO UPDATE SET
			team_id = COALESCE(EXCLUDED.team_id, ai_summaries.team_id),
			model_provider = COALESCE(
				EXCLUDED.model_provider,
				ai_summaries.model_provider
			),
			model_name = COALESCE(EXCLUDED.model_name, ai_summaries.model_name),
			prompt_hash = COALESCE(EXCLUDED.prompt_hash, ai_summaries.prompt_hash),
			content = EXCLUDED.content,
			source_notes = EXCLUDED.source_notes,
			updated_at = now()
		RETURNING *
		`,
    [
      summary.teamId ?? null,
      summary.triCode,
      summary.summaryType ?? 'team_history',
      summary.promptVersion ?? 'v1',
      summary.modelProvider ?? null,
      summary.modelName ?? null,
      summary.promptHash ?? null,
      toJsonParam(summary.content, {}),
      toJsonParam(summary.sourceNotes, []),
    ],
  );
  return result.rows[0];
}

async function getAiSummary(
  client,
  { triCode, summaryType = 'team_history', promptVersion = 'v1' },
) {
  const result = await client.query(
    `
		SELECT *
		FROM ai_summaries
		WHERE tri_code = $1
			AND summary_type = $2
			AND prompt_version = $3
		`,
    [triCode, summaryType, promptVersion],
  );
  return result.rows[0] ?? null;
}

module.exports = {
  upsertAiSummary,
  getAiSummary,
};
