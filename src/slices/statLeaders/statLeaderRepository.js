const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const STAT_LEADER_ON_CONFLICT = `
	ON CONFLICT (season_id, player_type, category, team_scope, player_id)
	DO UPDATE SET
		rank = COALESCE(EXCLUDED.rank, stat_leaders.rank),
		value = COALESCE(EXCLUDED.value, stat_leaders.value),
		leader_payload = EXCLUDED.leader_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertStatLeader}: dedupes by
 * (season_id, player_type, category, team_scope, player_id). The `team_scope`
 * default of 'all' is applied in the key so rows omitting it collide exactly as
 * the single-row upsert's param default does. Returns the number of unique
 * leaders written.
 */
async function upsertStatLeaders(client, leaders) {
  return batchUpsert(
    client,
    {
      table: 'stat_leaders',
      columns: [
        'season_id',
        'player_id',
        'player_type',
        'category',
        'rank',
        'team_scope',
        'value',
        'leader_payload',
      ],
      keyFn: (leader) =>
        JSON.stringify([
          leader.seasonId,
          leader.playerType,
          leader.category,
          leader.teamScope ?? 'all',
          leader.playerId,
        ]),
      onConflict: STAT_LEADER_ON_CONFLICT,
      toParams: (leader) => [
        leader.seasonId,
        leader.playerId,
        leader.playerType,
        leader.category,
        leader.rank ?? null,
        leader.teamScope ?? 'all',
        leader.value ?? null,
        toJsonParam(leader.leaderPayload),
      ],
    },
    leaders,
  );
}

async function getStatLeaders(
  client,
  { seasonId, playerType, category, teamScope = 'all' },
) {
  const result = await client.query(
    `
		SELECT
			to_jsonb(stat_leaders) AS leader,
			to_jsonb(players) AS player
		FROM stat_leaders
		JOIN players ON players.player_id = stat_leaders.player_id
		WHERE stat_leaders.season_id = $1
			AND stat_leaders.player_type = $2
			AND stat_leaders.category = $3
			AND stat_leaders.team_scope = $4
		ORDER BY stat_leaders.rank NULLS LAST, stat_leaders.value DESC NULLS LAST
		`,
    [seasonId, playerType, category, teamScope],
  );
  return result.rows;
}

module.exports = {
  upsertStatLeaders,
  getStatLeaders,
};
