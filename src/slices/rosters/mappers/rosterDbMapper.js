const { firstValue, toInteger } = require('#platform/fieldValue.js');
const { buildPlayer } = require('#platform/entityBuilders.js');

/** All raw players from the roster's forwards, defensemen and goalies. */
function collectRosterPlayers(rosterPayload) {
  return [
    ...(rosterPayload?.forwards ?? []),
    ...(rosterPayload?.defensemen ?? []),
    ...(rosterPayload?.goalies ?? []),
  ];
}

/** Builds the player entity for a raw roster player. */
function buildRosterPlayer(rawPlayer) {
  return buildPlayer(rawPlayer, {
    positionCode: rawPlayer.positionCode,
    headshotUrl: rawPlayer.headshot,
  });
}

/** Builds a roster_entries entity linking a player to a team and season. */
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

/**
 * Maps a roster payload into `{ rows: [{ player, rosterEntry }], skipped }`, where
 * `skipped` counts players without a usable id.
 */
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
