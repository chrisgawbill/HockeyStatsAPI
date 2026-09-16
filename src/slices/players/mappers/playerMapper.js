/**
 * playerMapper
 *
 * Translates the NHL stats/leaders payloads into stable contracts:
 *   - mapSkaterSummary  (rest/en/skater/summary -> data[])
 *   - mapGoalieSummary  (rest/en/goalie/summary -> data[])
 *
 * Field sourcing mirrors TeamPage.tsx (transformPlayerStats + goalie toiMap loop)
 * and react/src/Data/Helpers/PlayerStatLeaderConverter.ts.
 *
 * Scope note: corsi (SAT%) comes from a SEPARATE endpoint and is merged on the
 * frontend by playerId — it is intentionally NOT part of the skater contract.
 */

/**
 * @typedef {Object} SkaterSummaryContract
 * @property {number}      playerId
 * @property {string}      name            - skaterFullName
 * @property {string}      position        - positionCode
 * @property {number}      gamesPlayed
 * @property {number}      goals
 * @property {number}      assists
 * @property {number}      points
 * @property {number}      plusMinus
 * @property {number}      penaltyMinutes
 * @property {number|null} faceoffWinPct   - NULL when 0 (player takes no faceoffs)
 * @property {number|null} toiPerGame      - timeOnIcePerGame (seconds), for roster TOI merge
 */

/**
 * @typedef {Object} GoalieSummaryContract
 * @property {number}      goalieId
 * @property {string}      name            - goalieFullName
 * @property {number}      gamesPlayed
 * @property {number}      wins
 * @property {number}      losses
 * @property {number|null} savePctg
 * @property {number|null} goalsAgainstAverage
 * @property {number}      shutouts
 * @property {number|null} toiPerGame      - timeOnIcePerGame (seconds)
 */

/**
 * @typedef {Object} StatLeaderContract
 * @property {number}      id
 * @property {string}      firstName       - firstName.default (guarded -> "")
 * @property {string}      lastName        - lastName.default (guarded -> "")
 * @property {number|null} sweaterNumber
 * @property {string}      headshot
 * @property {string}      teamAbbrev
 * @property {string}      teamName        - teamName.default (guarded -> "")
 * @property {string}      teamLogo
 * @property {string}      position
 * @property {number}      value           - the category's stat value
 */

/**
 * Map the NHL skater summary payload into contract rows.
 * @param {any} raw - { data: [...] }
 * @returns {SkaterSummaryContract[]}
 */
function mapSkaterSummary(raw) {
  return (raw?.data ?? []).map((p) => ({
    playerId: p.playerId,
    name: p.skaterFullName ?? '',
    position: p.positionCode ?? '',
    gamesPlayed: p.gamesPlayed ?? 0,
    goals: p.goals ?? 0,
    assists: p.assists ?? 0,
    points: p.points ?? 0,
    plusMinus: p.plusMinus ?? 0,
    penaltyMinutes: p.penaltyMinutes ?? 0,
    // NHL returns 0 for players who take no faceoffs — treat that as N/A, not 0%.
    faceoffWinPct: p.faceoffWinPct > 0 ? p.faceoffWinPct : null,
    toiPerGame: p.timeOnIcePerGame ?? null,
  }));
}

/**
 * Map the NHL goalie summary payload into contract rows.
 * @param {any} raw - { data: [...] }
 * @returns {GoalieSummaryContract[]}
 */
function mapGoalieSummary(raw) {
  return (raw?.data ?? []).map((g) => ({
    // NOTE: the frontend read `goalieId`; the rest endpoint may also expose
    // `playerId`. Accept either so the TOI merge stays robust.
    goalieId: g.goalieId ?? g.playerId,
    name: g.goalieFullName ?? '',
    gamesPlayed: g.gamesPlayed ?? 0,
    wins: g.wins ?? 0,
    losses: g.losses ?? 0,
    savePctg: g.savePct ?? null,
    goalsAgainstAverage: g.goalsAgainstAverage ?? null,
    shutouts: g.shutouts ?? 0,
    toiPerGame: g.timeOnIcePerGame ?? null,
  }));
}

module.exports = { mapSkaterSummary, mapGoalieSummary };
