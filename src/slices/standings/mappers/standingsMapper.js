/**
 * standingsMapper
 *
 * Translates a raw NHL standings row into the app's StandingsTeamContract.
 * Field sourcing mirrors react/src/Data/Helpers/LeagueStandingsHelper.ts.
 *
 * Scope note: this mapper does SHAPE translation only (raw field extraction,
 * id fallback chain, clinch-indicator spelling). App/derived logic stays on the
 * frontend (draft-lottery odds + trend, pointsPctg rounding, playoff-line delta).
 */

/**
 * @typedef {Object} StandingsTeamContract
 * @property {string|number} teamId          - resolved via fallback chain below
 * @property {string}      teamLogo
 * @property {string}      name              - teamCommonName.default
 * @property {string}      conferenceName
 * @property {string}      divisionName
 * @property {number}      wins
 * @property {number}      losses
 * @property {number}      otLosses
 * @property {number}      points
 * @property {number}      pointPctg         - raw NHL fraction (frontend rounds for display)
 * @property {number}      leagueSequence
 * @property {number}      conferenceSequence
 * @property {number}      divisionSequence
 * @property {number}      wildcardSequence
 * @property {string}      clinchingIndicator - clinchingIndicator || clinchIndicator || ""
 * @property {number}      leagueL10Sequence  - last-10 league rank (frontend lottery trend)
 */

/**
 * Resolve the team identifier across the NHL's inconsistent shapes.
 * Order: teamAbbrev.default -> teamId.id -> teamId -> id -> team.id
 * @param {any} rawTeam
 * @returns {string|number|undefined}
 */
function resolveTeamId(rawTeam) {
  return (
    rawTeam.teamAbbrev?.default ||
    rawTeam.teamId?.id ||
    rawTeam.teamId ||
    rawTeam.id ||
    rawTeam.team?.id
  );
}

/**
 * Map a single raw NHL standings row into a StandingsTeamContract.
 * Returns null for rows with no resolvable id (caller filters these out).
 * @param {any} rawTeam
 * @returns {StandingsTeamContract|null}
 */
function mapStandingsTeam(rawTeam) {
  const teamId = resolveTeamId(rawTeam);
  if (!teamId) {
    console.warn(
      'Skipping standings team with missing ID. Keys available:',
      Object.keys(rawTeam),
    );
    return null;
  }

  const teamLogo = rawTeam.teamLogo ?? '';
  const name = rawTeam.teamCommonName?.default ?? '';
  const conferenceName = rawTeam.conferenceName ?? '';
  const divisionName = rawTeam.divisionName ?? '';
  const wins = rawTeam.wins ?? 0;
  const losses = rawTeam.losses ?? 0;
  const otLosses = rawTeam.otLosses ?? 0;
  const points = rawTeam.points ?? 0;
  const pointPctg = rawTeam.pointPctg ?? 0;
  const leagueSequence = rawTeam.leagueSequence ?? 0;
  const conferenceSequence = rawTeam.conferenceSequence ?? 0;
  const divisionSequence = rawTeam.divisionSequence ?? 0;
  const wildcardSequence = rawTeam.wildcardSequence ?? 0;
  const clinchingIndicator =
    rawTeam.clinchingIndicator || rawTeam.clinchIndicator || '';
  const leagueL10Sequence = rawTeam.leagueL10Sequence ?? 0;

  return /** @type {StandingsTeamContract} */ ({
    teamId,
    teamLogo,
    name,
    conferenceName,
    divisionName,
    wins,
    losses,
    otLosses,
    points,
    pointPctg,
    leagueSequence,
    conferenceSequence,
    divisionSequence,
    wildcardSequence,
    clinchingIndicator,
    leagueL10Sequence,
  });
}

module.exports = { mapStandingsTeam, resolveTeamId };
