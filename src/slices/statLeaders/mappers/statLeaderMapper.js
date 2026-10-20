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
 * @param {any} leadersPayload
 * @param {string} category - e.g. "goals" | "assists" | "wins" | "savePctg"
 * @returns {StatLeaderContract[]}
 */
function mapStatLeaders(leadersPayload, category) {
  const rawLeaders = leadersPayload?.[category];
  if (!Array.isArray(rawLeaders)) return [];

  return rawLeaders.map((rawLeader) => ({
    id: rawLeader.id,
    firstName: rawLeader.firstName?.default ?? '',
    lastName: rawLeader.lastName?.default ?? '',
    sweaterNumber: rawLeader.sweaterNumber ?? null,
    headshot: rawLeader.headshot ?? '',
    teamAbbrev: rawLeader.teamAbbrev ?? '',
    teamName: rawLeader.teamName?.default ?? '',
    teamLogo: rawLeader.teamLogo ?? '',
    position: rawLeader.position ?? '',
    value: rawLeader.value,
  }));
}

module.exports = { mapStatLeaders };
