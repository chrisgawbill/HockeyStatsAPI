const { firstValue, toNumber } = require('#platform/fieldValue.js');
const { buildPlayer } = require('#platform/entityBuilders.js');

/** Returns the raw leader entries for one category, or [] when absent. */
function getLeaderRows(leadersPayload, category) {
  const rawLeaders = leadersPayload?.[category];
  return Array.isArray(rawLeaders) ? rawLeaders : [];
}

/** Builds the player entity for a leader entry; null when it has no usable id. */
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

/**
 * Maps a leaders payload into `{ rows: [{ player, leader }], skipped }`, where
 * `skipped` counts entries without a usable player id.
 */
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
