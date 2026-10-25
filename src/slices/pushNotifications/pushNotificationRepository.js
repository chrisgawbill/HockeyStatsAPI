/**
 * Upserts by endpoint; a re-subscribed endpoint moves to the caller. Returns
 * true when the endpoint is new to the caller (not a re-sync of their own device).
 */
async function upsertSubscription(client, { userId, endpoint, p256dh, auth }) {
  const { rows: upsertedRows } = await client.query(
    `
		WITH previous_owner AS (
			SELECT user_id FROM push_subscriptions WHERE endpoint = $2
		)
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (endpoint) DO UPDATE
		SET user_id = EXCLUDED.user_id,
			p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth
		RETURNING (SELECT user_id FROM previous_owner) AS previous_user_id
		`,
    [userId, endpoint, p256dh, auth],
  );
  const previousUserId = upsertedRows[0]?.previous_user_id;
  return previousUserId == null || String(previousUserId) !== String(userId);
}

/** Deletes only the caller's row; returns how many rows were removed. */
async function deleteSubscriptionForUser(client, { userId, endpoint }) {
  const { rowCount: deletedCount } = await client.query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, endpoint],
  );
  return deletedCount;
}

/** Deletes a subscription by id (used when the push service reports it gone). */
async function deleteSubscriptionById(client, id) {
  await client.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
}

/** Lists the distinct ids of users with at least one subscribed device and the account push switch on. */
async function listSubscriptionUserIds(client) {
  const { rows: subscriberRows } = await client.query(
    `
		SELECT DISTINCT push_subscriptions.user_id
		FROM push_subscriptions
		JOIN users ON users.id = push_subscriptions.user_id
		WHERE users.push_enabled
		ORDER BY push_subscriptions.user_id
		`,
  );
  return subscriberRows.map((subscriberRow) => subscriberRow.user_id);
}

/** Lists a user's subscribed devices. */
async function listSubscriptionsForUser(client, userId) {
  const { rows: subscriptionRows } = await client.query(
    `
		SELECT id, endpoint, p256dh, auth
		FROM push_subscriptions
		WHERE user_id = $1
		ORDER BY id
		`,
    [userId],
  );
  return subscriptionRows;
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
  const { rows: ledgerRows } = await client.query(
    `
		SELECT game_id
		FROM after_action_report_pushes
		WHERE user_id = $1 AND game_id = ANY($2::bigint[])
		`,
    [userId, gameIds],
  );
  return ledgerRows.map((ledgerRow) => Number(ledgerRow.game_id));
}

/** Atomically claims a (user, game) push; true only for the winning caller. */
async function claimPush(client, { userId, gameId }) {
  const { rows: claimedRows } = await client.query(
    `
		INSERT INTO after_action_report_pushes (user_id, game_id)
		VALUES ($1, $2)
		ON CONFLICT (user_id, game_id) DO NOTHING
		RETURNING game_id
		`,
    [userId, gameId],
  );
  return claimedRows.length > 0;
}

/** Gives a claimed (user, game) push back so a later dispatch can retry it. */
async function releasePush(client, { userId, gameId }) {
  await client.query(
    'DELETE FROM after_action_report_pushes WHERE user_id = $1 AND game_id = $2',
    [userId, gameId],
  );
}

/** Deletes a subscription by endpoint, whichever user owns it (the push service reported it gone). */
async function deleteSubscriptionByEndpoint(client, endpoint) {
  await client.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [
    endpoint,
  ]);
}

/** Atomically claims a (user, week) weekly-report push. */
async function claimWeeklyPush(client, { userId, weekStart }) {
  const { rows: claimedRows } = await client.query(
    `
		INSERT INTO weekly_player_report_pushes (user_id, week_start)
		VALUES ($1, $2::date)
		ON CONFLICT (user_id, week_start) DO NOTHING
		RETURNING user_id
		`,
    [userId, weekStart],
  );
  return claimedRows.length > 0;
}

/** Gives a claimed (user, week) push back so a later dispatch can retry it. */
async function releaseWeeklyPush(client, { userId, weekStart }) {
  await client.query(
    'DELETE FROM weekly_player_report_pushes WHERE user_id = $1 AND week_start = $2::date',
    [userId, weekStart],
  );
}

/** Marks every weekly report the user already has as pushed (opt-in seeding). */
async function seedWeeklyLedger(client, userId) {
  await client.query(
    `
		INSERT INTO weekly_player_report_pushes (user_id, week_start)
		SELECT user_id, week_start
		FROM weekly_player_reports
		WHERE user_id = $1
		ON CONFLICT (user_id, week_start) DO NOTHING
		`,
    [userId],
  );
}

/** Whether the user's weekly-report push switch is on; defaults to on for an unknown user. */
async function getWeeklyReportPush(client, userId) {
  const { rows: settingRows } = await client.query(
    'SELECT weekly_report_push FROM users WHERE id = $1',
    [userId],
  );
  return settingRows[0] ? Boolean(settingRows[0].weekly_report_push) : true;
}

/** Turns the user's weekly-report push switch on or off. */
async function setWeeklyReportPush(client, { userId, enabled }) {
  await client.query('UPDATE users SET weekly_report_push = $2 WHERE id = $1', [
    userId,
    enabled,
  ]);
}

/** Whether the user's account-wide push switch is on; defaults to on for an unknown user. */
async function getPushEnabled(client, userId) {
  const { rows: settingRows } = await client.query(
    'SELECT push_enabled FROM users WHERE id = $1',
    [userId],
  );
  return settingRows[0] ? Boolean(settingRows[0].push_enabled) : true;
}

/** Turns the user's account-wide push switch on or off; returns 1 when it changed, else 0. */
async function setPushEnabled(client, { userId, enabled }) {
  const { rowCount: changedCount } = await client.query(
    'UPDATE users SET push_enabled = $2 WHERE id = $1 AND push_enabled <> $2',
    [userId, enabled],
  );
  return changedCount;
}

/** Users who switched the weekly-report push off. */
async function listWeeklyPushOptOuts(client) {
  const { rows: optOutRows } = await client.query(
    'SELECT id FROM users WHERE weekly_report_push = false',
  );
  return optOutRows.map((optOutRow) => String(optOutRow.id));
}

module.exports = {
  claimWeeklyPush,
  releaseWeeklyPush,
  releasePush,
  deleteSubscriptionByEndpoint,
  seedWeeklyLedger,
  getWeeklyReportPush,
  setWeeklyReportPush,
  listWeeklyPushOptOuts,
  getPushEnabled,
  setPushEnabled,
  upsertSubscription,
  deleteSubscriptionForUser,
  deleteSubscriptionById,
  listSubscriptionUserIds,
  listSubscriptionsForUser,
  insertLedgerGameIds,
  listLedgerGameIds,
  claimPush,
};
