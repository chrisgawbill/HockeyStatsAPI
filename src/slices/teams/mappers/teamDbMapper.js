const { firstValue, toInteger, toNumber } = require('#platform/fieldValue.js');
const { buildTeam: buildBaseTeam } = require('#platform/entityBuilders.js');

function buildTeam(rawTeam) {
  return buildBaseTeam(rawTeam);
}

function mergeTeam(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    ...primary,
    triCode: primary.triCode || secondary.triCode,
    franchiseId: primary.franchiseId ?? secondary.franchiseId,
    fullName: primary.fullName ?? secondary.fullName,
    commonName: primary.commonName ?? secondary.commonName,
    placeName: primary.placeName ?? secondary.placeName,
    logoUrl: primary.logoUrl ?? secondary.logoUrl,
    sourcePayload: {
      stats: primary.sourcePayload,
      standings: secondary.sourcePayload,
    },
  };
}

function buildStandingsLookup(standingsPayload) {
  const standingsRows = standingsPayload?.standings ?? [];
  const byTeamId = new Map();
  const byTriCode = new Map();

  for (const rawStanding of standingsRows) {
    const team = buildTeam(rawStanding);
    if (team?.teamId) byTeamId.set(team.teamId, rawStanding);
    if (team?.triCode) byTriCode.set(team.triCode, rawStanding);
  }

  return { byTeamId, byTriCode, rows: standingsRows };
}

function buildTeamSeasonSnapshot({ seasonId, statsRow, standingsRow, team }) {
  return {
    seasonId,
    teamId: team.teamId,
    triCode: team.triCode,
    gamesPlayed: toInteger(
      firstValue(statsRow?.gamesPlayed, standingsRow?.gamesPlayed),
    ),
    wins: toInteger(firstValue(statsRow?.wins, standingsRow?.wins)),
    losses: toInteger(firstValue(statsRow?.losses, standingsRow?.losses)),
    otLosses: toInteger(firstValue(statsRow?.otLosses, standingsRow?.otLosses)),
    regulationWins: toInteger(
      firstValue(statsRow?.regulationWins, standingsRow?.regulationWins),
    ),
    points: toInteger(firstValue(statsRow?.points, standingsRow?.points)),
    goalsFor: toInteger(
      firstValue(
        statsRow?.goalsFor,
        standingsRow?.goalFor,
        standingsRow?.goalsFor,
      ),
    ),
    goalsAgainst: toInteger(
      firstValue(
        statsRow?.goalsAgainst,
        standingsRow?.goalAgainst,
        standingsRow?.goalsAgainst,
      ),
    ),
    goalsForPerGame: toNumber(
      firstValue(statsRow?.goalsForPerGame, statsRow?.goalsPerGame),
    ),
    goalsAgainstPerGame: toNumber(statsRow?.goalsAgainstPerGame),
    powerPlayPct: toNumber(statsRow?.powerPlayPct),
    penaltyKillPct: toNumber(statsRow?.penaltyKillPct),
    faceoffWinPct: toNumber(statsRow?.faceoffWinPct),
    divisionName: firstValue(
      statsRow?.divisionName,
      standingsRow?.divisionName,
      standingsRow?.divisionAbbrev,
    ),
    conferenceName: firstValue(
      statsRow?.conferenceName,
      standingsRow?.conferenceName,
      standingsRow?.conferenceAbbrev,
    ),
    leagueRank: toInteger(standingsRow?.leagueSequence),
    conferenceRank: toInteger(standingsRow?.conferenceSequence),
    divisionRank: toInteger(standingsRow?.divisionSequence),
    snapshotPayload: {
      stats: statsRow ?? null,
      standings: standingsRow ?? null,
    },
  };
}

function mapTeamSeasonPayload({
  seasonId,
  teamStatsPayload,
  standingsPayload,
}) {
  const standingsLookup = buildStandingsLookup(standingsPayload);
  const rows = [];
  let skipped = 0;
  const touchedTeamIds = new Set();

  for (const statsRow of teamStatsPayload?.data ?? []) {
    const statsTeam = buildTeam(statsRow);
    if (!statsTeam) {
      skipped += 1;
      continue;
    }

    const standingsRow =
      standingsLookup.byTeamId.get(statsTeam.teamId) ??
      standingsLookup.byTriCode.get(statsTeam.triCode);
    const standingsTeam = standingsRow ? buildTeam(standingsRow) : null;
    const team = mergeTeam(statsTeam, standingsTeam);

    rows.push({
      team,
      snapshot: buildTeamSeasonSnapshot({
        seasonId,
        statsRow,
        standingsRow,
        team,
      }),
    });
    touchedTeamIds.add(team.teamId);
  }

  for (const standingsRow of standingsLookup.rows) {
    const team = buildTeam(standingsRow);
    if (!team || touchedTeamIds.has(team.teamId)) continue;
    rows.push({
      team,
      snapshot: buildTeamSeasonSnapshot({
        seasonId,
        statsRow: null,
        standingsRow,
        team,
      }),
    });
  }

  return { rows, skipped };
}

module.exports = {
  buildTeam,
  mergeTeam,
  buildStandingsLookup,
  buildTeamSeasonSnapshot,
  mapTeamSeasonPayload,
};
