const { toJsonParam } = require('#platform/jsonParam.js');
const { batchUpsert } = require('#platform/batchSql.js');

const PLAYER_ON_CONFLICT = `
	ON CONFLICT (player_id)
	DO UPDATE SET
		first_name = COALESCE(EXCLUDED.first_name, players.first_name),
		last_name = COALESCE(EXCLUDED.last_name, players.last_name),
		full_name = COALESCE(EXCLUDED.full_name, players.full_name),
		headshot_url = COALESCE(EXCLUDED.headshot_url, players.headshot_url),
		hero_image_url = COALESCE(
			EXCLUDED.hero_image_url,
			players.hero_image_url
		),
		birth_date = COALESCE(EXCLUDED.birth_date, players.birth_date),
		nationality_code = COALESCE(
			EXCLUDED.nationality_code,
			players.nationality_code
		),
		shoots_catches = COALESCE(
			EXCLUDED.shoots_catches,
			players.shoots_catches
		),
		position_code = COALESCE(EXCLUDED.position_code, players.position_code),
		source_payload = EXCLUDED.source_payload,
		updated_at = now()
`;

/**
 * Batched equivalent of {@link upsertPlayer}: dedupes by player_id. Returns the
 * number of unique players written.
 */
async function upsertPlayers(client, players) {
  return batchUpsert(
    client,
    {
      table: 'players',
      columns: [
        'player_id',
        'first_name',
        'last_name',
        'full_name',
        'headshot_url',
        'hero_image_url',
        'birth_date',
        'nationality_code',
        'shoots_catches',
        'position_code',
        'source_payload',
      ],
      keyFn: (player) => String(player.playerId),
      onConflict: PLAYER_ON_CONFLICT,
      toParams: (player) => [
        player.playerId,
        player.firstName ?? null,
        player.lastName ?? null,
        player.fullName ?? null,
        player.headshotUrl ?? null,
        player.heroImageUrl ?? null,
        player.birthDate ?? null,
        player.nationalityCode ?? null,
        player.shootsCatches ?? null,
        player.positionCode ?? null,
        toJsonParam(player.sourcePayload),
      ],
    },
    players,
  );
}

async function getPlayer(client, playerId) {
  const result = await client.query(
    'SELECT * FROM players WHERE player_id = $1',
    [playerId],
  );
  return result.rows[0] ?? null;
}

module.exports = {
  upsertPlayers,
  getPlayer,
};
