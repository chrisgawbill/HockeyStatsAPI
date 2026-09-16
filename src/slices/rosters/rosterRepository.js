const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const ROSTER_ENTRY_ON_CONFLICT = `
	ON CONFLICT (season_id, tri_code, player_id)
	DO UPDATE SET
		team_id = COALESCE(EXCLUDED.team_id, roster_entries.team_id),
		first_name = COALESCE(EXCLUDED.first_name, roster_entries.first_name),
		last_name = COALESCE(EXCLUDED.last_name, roster_entries.last_name),
		full_name = COALESCE(EXCLUDED.full_name, roster_entries.full_name),
		sweater_number = COALESCE(
			EXCLUDED.sweater_number,
			roster_entries.sweater_number
		),
		position_code = COALESCE(
			EXCLUDED.position_code,
			roster_entries.position_code
		),
		position_name = COALESCE(
			EXCLUDED.position_name,
			roster_entries.position_name
		),
		player_payload = EXCLUDED.player_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertRosterEntry}: dedupes by
 * (season_id, tri_code, player_id). Returns the number of unique roster entries
 * written.
 */
async function upsertRosterEntries(client, entries) {
  return batchUpsert(
    client,
    {
      table: 'roster_entries',
      columns: [
        'season_id',
        'team_id',
        'tri_code',
        'player_id',
        'first_name',
        'last_name',
        'full_name',
        'sweater_number',
        'position_code',
        'position_name',
        'player_payload',
      ],
      keyFn: (entry) =>
        JSON.stringify([entry.seasonId, entry.triCode, entry.playerId]),
      onConflict: ROSTER_ENTRY_ON_CONFLICT,
      toParams: (entry) => [
        entry.seasonId,
        entry.teamId ?? null,
        entry.triCode,
        entry.playerId,
        entry.firstName ?? null,
        entry.lastName ?? null,
        entry.fullName ?? null,
        entry.sweaterNumber ?? null,
        entry.positionCode ?? null,
        entry.positionName ?? null,
        toJsonParam(entry.playerPayload),
      ],
    },
    entries,
  );
}

async function getRosterEntries(client, seasonId, triCode) {
  const result = await client.query(
    `
		SELECT
			to_jsonb(roster_entries) AS roster_entry,
			to_jsonb(players) AS player
		FROM roster_entries
		JOIN players ON players.player_id = roster_entries.player_id
		WHERE roster_entries.season_id = $1
			AND roster_entries.tri_code = $2
		ORDER BY roster_entries.position_code, roster_entries.sweater_number
		`,
    [seasonId, triCode],
  );
  return result.rows;
}

module.exports = {
  upsertRosterEntries,
  getRosterEntries,
};
