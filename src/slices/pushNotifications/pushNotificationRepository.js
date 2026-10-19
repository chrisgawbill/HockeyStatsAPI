/** Upserts by endpoint; a re-subscribed endpoint moves to the caller. */
async function upsertSubscription(client, { userId, endpoint, p256dh, auth }) {
  await client.query(
    `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (endpoint) DO UPDATE
		SET user_id = EXCLUDED.user_id,
			p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth
		`,
    [userId, endpoint, p256dh, auth],
  );
}

/** Deletes only the caller's row; returns how many rows were removed. */
async function deleteSubscriptionForUser(client, { userId, endpoint }) {
  const result = await client.query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, endpoint],
  );
  return result.rowCount;
}

async function deleteSubscriptionById(client, id) {
  await client.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
}

async function listSubscriptionUserIds(client) {
  const result = await client.query(
    'SELECT DISTINCT user_id FROM push_subscriptions ORDER BY user_id',
  );
  return result.rows.map((row) => row.user_id);
}

async function listSubscriptionsForUser(client, userId) {
  const result = await client.query(
    `
		SELECT id, endpoint, p256dh, auth
		FROM push_subscriptions
		WHERE user_id = $1
		ORDER BY id
		`,
    [userId],
  );
  return result.rows;
}

/** Marks games as already pushed without sending (opt-in seeding). */
async function insertLedgerGameIds(client, { userId, gameIds }) {
  if (gameIds.length === 0) return;
  await client.query(
    `
		INSERT INTO after_action_report_pushes (user_id, game_id)
		SELECT $1, UNNEST($2::bigint[])
		ON CONFLICT (user_id, game_id) DO NOTHING
		`,
    [userId, gameIds],
  );
}

/** Returns the subset of `gameIds` already in the sent ledger for this user. */
async function listLedgerGameIds(client, { userId, gameIds }) {
  if (gameIds.length === 0) return [];
  const result = await client.query(
    `
		SELECT game_id
		FROM after_action_report_pushes
		WHERE user_id = $1 AND game_id = ANY($2::bigint[])
		`,
    [userId, gameIds],
  );
  return result.rows.map((row) => Number(row.game_id));
}

/** Atomically claims a (user, game) push; true only for the winning caller. */
async function claimPush(client, { userId, gameId }) {
  const result = await client.query(
    `
		INSERT INTO after_action_report_pushes (user_id, game_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id, game_id) DO NOTHING
		RETURNING game_id
		`,
    [userId, gameId],
  );
  return result.rows.length > 0;
}

module.exports = {
  upsertSubscription,
  deleteSubscriptionForUser,
  deleteSubscriptionById,
  listSubscriptionUserIds,
  listSubscriptionsForUser,
  insertLedgerGameIds,
  listLedgerGameIds,
  claimPush,
};
