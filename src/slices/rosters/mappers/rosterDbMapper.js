const { firstValue, toInteger } = require('#platform/fieldValue.js');
const { buildPlayer } = require('#platform/entityBuilders.js');

function collectRosterPlayers(rosterPayload) {
  return [
    ...(rosterPayload?.forwards ?? []),
    ...(rosterPayload?.defensemen ?? []),
    ...(rosterPayload?.goalies ?? []),
  ];
}

function buildRosterPlayer(rawPlayer) {
  return buildPlayer(rawPlayer, {
    positionCode: rawPlayer.positionCode,
    headshotUrl: rawPlayer.headshot,
  });
}

function buildRosterEntry({ seasonId, triCode, teamId, rawPlayer, player }) {
  return {
    seasonId,
    triCode,
    teamId: teamId ?? null,
    playerId: player.playerId,
    firstName: player.firstName,
    lastName: player.lastName,
    fullName: player.fullName,
    sweaterNumber: toInteger(rawPlayer.sweaterNumber),
    positionCode: firstValue(rawPlayer.positionCode, player.positionCode),
    positionName: firstValue(rawPlayer.positionName),
    playerPayload: rawPlayer,
  };
}

function mapRosterPayload({ seasonId, triCode, teamId = null, rosterPayload }) {
  const rows = [];
  let skipped = 0;

  for (const rawPlayer of collectRosterPlayers(rosterPayload)) {
    const player = buildRosterPlayer(rawPlayer);
    if (!player) {
      skipped += 1;
      continue;
    }

    rows.push({
      player,
      rosterEntry: buildRosterEntry({
        seasonId,
        triCode,
        teamId,
        rawPlayer,
        player,
      }),
    });
  }

  return { rows, skipped };
}

module.exports = {
  collectRosterPlayers,
  buildRosterPlayer,
  buildRosterEntry,
  mapRosterPayload,
};
