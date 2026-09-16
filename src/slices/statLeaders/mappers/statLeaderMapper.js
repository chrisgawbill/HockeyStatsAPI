/**
 * statLeaderMapper
 *
 * Translates the NHL api-web skater/goalie-stats-leaders payload (keyed by stat
 * category) into the app's StatLeaderContract rows. Split out of playerMapper so
 * the stat-leaders slice owns the shape it serves.
 */

/**
 * Map a stat-leaders payload for a single category into contract rows.
 * The raw payload is keyed by category (goals, assists, wins, savePctg, ...);
 * select raw[category], then map each entry. Guards every `.default` unwrap.
 * @param {any} raw
 * @param {string} category - e.g. "goals" | "assists" | "wins" | "savePctg"
 * @returns {StatLeaderContract[]}
 */
function mapStatLeaders(raw, category) {
  const list = raw?.[category];
  if (!Array.isArray(list)) return [];

  return list.map((p) => ({
    id: p.id,
    firstName: p.firstName?.default ?? '',
    lastName: p.lastName?.default ?? '',
    sweaterNumber: p.sweaterNumber ?? null,
    headshot: p.headshot ?? '',
    teamAbbrev: p.teamAbbrev ?? '',
    teamName: p.teamName?.default ?? '',
    teamLogo: p.teamLogo ?? '',
    position: p.position ?? '',
    value: p.value,
  }));
}

module.exports = { mapStatLeaders };
