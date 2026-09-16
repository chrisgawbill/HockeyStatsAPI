const { firstValue, toInteger } = require('#platform/fieldValue.js');
const { buildTeam } = require('#platform/entityBuilders.js');

function collectScheduleGames(schedulePayload) {
  if (Array.isArray(schedulePayload?.games)) {
    return schedulePayload.games.map((game) => ({
      rawGame: game,
      gameDate: game.gameDate,
    }));
  }

  const games = [];
  for (const week of schedulePayload?.gameWeek ?? []) {
    for (const rawGame of week.games ?? []) {
      games.push({
        rawGame,
        gameDate: firstValue(rawGame.gameDate, week.date),
      });
    }
  }
  return games;
}

function buildScheduleTeam(rawTeam) {
  return buildTeam(rawTeam, {
    triCode: rawTeam?.abbrev,
    logoUrl: rawTeam?.logo,
  });
}

function buildScheduleGame({
  seasonId,
  rawGame,
  gameDate,
  homeTeam,
  awayTeam,
}) {
  return {
    gameId: toInteger(rawGame.id),
    seasonId,
    gameType: toInteger(rawGame.gameType),
    gameDate,
    startTimeUtc: rawGame.startTimeUTC ?? null,
    gameState: rawGame.gameState ?? null,
    venueName: firstValue(rawGame.venue),
    homeTeamId: homeTeam?.teamId ?? null,
    awayTeamId: awayTeam?.teamId ?? null,
    homeTriCode: firstValue(rawGame.homeTeam?.abbrev, homeTeam?.triCode),
    awayTriCode: firstValue(rawGame.awayTeam?.abbrev, awayTeam?.triCode),
    homeScore: toInteger(rawGame.homeTeam?.score),
    awayScore: toInteger(rawGame.awayTeam?.score),
    periodDescriptor: rawGame.periodDescriptor ?? {},
    broadcasts: rawGame.tvBroadcasts ?? [],
    gamePayload: rawGame,
  };
}

function mapSchedulePayload({ seasonId, schedulePayload }) {
  const rows = [];
  let skipped = 0;

  for (const { rawGame, gameDate } of collectScheduleGames(schedulePayload)) {
    const homeTeam = buildScheduleTeam(rawGame.homeTeam);
    const awayTeam = buildScheduleTeam(rawGame.awayTeam);
    const game = buildScheduleGame({
      seasonId,
      rawGame,
      gameDate,
      homeTeam,
      awayTeam,
    });

    if (!game.gameId) {
      skipped += 1;
      continue;
    }

    rows.push({ homeTeam, awayTeam, game });
  }

  return { rows, skipped };
}

module.exports = {
  collectScheduleGames,
  buildScheduleTeam,
  buildScheduleGame,
  mapSchedulePayload,
};
