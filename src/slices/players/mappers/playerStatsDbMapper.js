const { firstValue, toInteger, toNumber } = require('#platform/fieldValue.js');
const { buildPlayer } = require('#platform/entityBuilders.js');

function buildStatsPlayer(rawStats, playerType) {
  return buildPlayer(rawStats, {
    playerId:
      playerType === 'goalie'
        ? firstValue(rawStats.goalieId, rawStats.playerId)
        : rawStats.playerId,
    fullName:
      playerType === 'goalie'
        ? rawStats.goalieFullName
        : rawStats.skaterFullName,
    positionCode: rawStats.positionCode,
  });
}

function buildPlayerStats({
  seasonId,
  playerType,
  teamId,
  teamScope,
  rawStats,
  player,
}) {
  return {
    seasonId,
    playerId: player.playerId,
    teamId: teamId ?? toInteger(rawStats.teamId),
    teamScope,
    playerType,
    statScope: 'regular',
    gamesPlayed: toInteger(rawStats.gamesPlayed),
    goals: toInteger(rawStats.goals),
    assists: toInteger(rawStats.assists),
    points: toInteger(rawStats.points),
    shots: toInteger(rawStats.shots),
    plusMinus: toInteger(rawStats.plusMinus),
    penaltyMinutes: toInteger(rawStats.penaltyMinutes),
    timeOnIcePerGame:
      rawStats.timeOnIcePerGame == null
        ? null
        : String(rawStats.timeOnIcePerGame),
    wins: toInteger(rawStats.wins),
    losses: toInteger(rawStats.losses),
    otLosses: toInteger(rawStats.otLosses),
    savePct: toNumber(firstValue(rawStats.savePct, rawStats.savePctg)),
    goalsAgainstAvg: toNumber(rawStats.goalsAgainstAverage),
    statsPayload: rawStats,
  };
}

function mapPlayerStatsPayload({
  seasonId,
  playerType,
  statsPayload,
  teamId = null,
  teamScope = teamId ? String(teamId) : 'all',
}) {
  const rows = [];
  let skipped = 0;

  for (const rawStats of statsPayload?.data ?? []) {
    const player = buildStatsPlayer(rawStats, playerType);
    if (!player) {
      skipped += 1;
      continue;
    }

    rows.push({
      player,
      stats: buildPlayerStats({
        seasonId,
        playerType,
        teamId,
        teamScope,
        rawStats,
        player,
      }),
    });
  }

  return { rows, skipped };
}

module.exports = {
  buildStatsPlayer,
  buildPlayerStats,
  mapPlayerStatsPayload,
};
