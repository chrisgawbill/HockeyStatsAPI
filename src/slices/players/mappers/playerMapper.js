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
 * @property {number}      otLosses
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
 * Map the NHL skater summary payload into contract rows. The NHL returns 0 for
 * players who take no faceoffs, so a faceoff percentage of 0 maps to null (N/A).
 * @param {any} summaryPayload - { data: [...] }
 * @returns {SkaterSummaryContract[]}
 */
function mapSkaterSummary(summaryPayload) {
  return (summaryPayload?.data ?? []).map((skater) => ({
    playerId: skater.playerId,
    name: skater.skaterFullName ?? '',
    position: skater.positionCode ?? '',
    gamesPlayed: skater.gamesPlayed ?? 0,
    goals: skater.goals ?? 0,
    assists: skater.assists ?? 0,
    points: skater.points ?? 0,
    plusMinus: skater.plusMinus ?? 0,
    penaltyMinutes: skater.penaltyMinutes ?? 0,
    faceoffWinPct: skater.faceoffWinPct > 0 ? skater.faceoffWinPct : null,
    toiPerGame: skater.timeOnIcePerGame ?? null,
  }));
}

/**
 * Map the NHL goalie summary payload into contract rows. The frontend read
 * `goalieId` but the endpoint may also expose `playerId`, so either is accepted
 * to keep the TOI merge robust.
 * @param {any} summaryPayload - { data: [...] }
 * @returns {GoalieSummaryContract[]}
 */
function mapGoalieSummary(summaryPayload) {
  return (summaryPayload?.data ?? []).map((goalie) => ({
    goalieId: goalie.goalieId ?? goalie.playerId,
    name: goalie.goalieFullName ?? '',
    gamesPlayed: goalie.gamesPlayed ?? 0,
    wins: goalie.wins ?? 0,
    losses: goalie.losses ?? 0,
    otLosses: goalie.otLosses ?? 0,
    savePctg: goalie.savePct ?? null,
    goalsAgainstAverage: goalie.goalsAgainstAverage ?? null,
    shutouts: goalie.shutouts ?? 0,
    toiPerGame: goalie.timeOnIcePerGame ?? null,
  }));
}

module.exports = { mapSkaterSummary, mapGoalieSummary };
