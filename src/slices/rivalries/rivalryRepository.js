/**
 * Lists enabled rivalries with both teams' tri-codes, optionally only those
 * involving `triCode` on either side of the pair.
 */
async function listEnabledRivalries(client, triCode = null) {
  const { rows: rivalryRows } = await client.query(
    `
		SELECT a.tri_code AS team_a, b.tri_code AS team_b, r.tier, r.display_name
		FROM team_rivalries r
		JOIN teams a ON a.team_id = r.team_a_id
		JOIN teams b ON b.team_id = r.team_b_id
		WHERE r.enabled
			AND ($1::text IS NULL OR $1 IN (a.tri_code, b.tri_code))
		ORDER BY r.tier, a.tri_code, b.tri_code
		`,
    [triCode],
  );
  return rivalryRows;
}

module.exports = { listEnabledRivalries };
