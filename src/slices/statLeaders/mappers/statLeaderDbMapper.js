const { firstValue, toNumber } = require('#platform/fieldValue.js');
const { buildPlayer } = require('#platform/entityBuilders.js');

function getLeaderRows(leadersPayload, category) {
  const rows = leadersPayload?.[category];
  return Array.isArray(rows) ? rows : [];
}

function buildLeaderPlayer(rawLeader) {
  return buildPlayer(rawLeader, {
    playerId: rawLeader.id,
    firstName: rawLeader.firstName,
    lastName: rawLeader.lastName,
    fullName: [firstValue(rawLeader.firstName), firstValue(rawLeader.lastName)]
      .filter(Boolean)
      .join(' '),
    headshotUrl: rawLeader.headshot,
    positionCode: rawLeader.position,
  });
}

function mapStatLeaderPayload({
  seasonId,
  playerType,
  category,
  leadersPayload,
  teamScope = 'all',
}) {
  const rows = [];
  let skipped = 0;

  for (const [index, rawLeader] of getLeaderRows(
    leadersPayload,
    category,
  ).entries()) {
    const player = buildLeaderPlayer(rawLeader);
    if (!player) {
      skipped += 1;
      continue;
    }

    rows.push({
      player,
      leader: {
        seasonId,
        playerId: player.playerId,
        playerType,
        category,
        rank: index + 1,
        teamScope,
        value: toNumber(rawLeader.value),
        leaderPayload: rawLeader,
      },
    });
  }

  return { rows, skipped };
}

module.exports = {
  getLeaderRows,
  buildLeaderPlayer,
  mapStatLeaderPayload,
};
