/**
 * Pure helpers for the Weekly Player Report: Eastern-time week math, the
 * league-break check, and per-player stat lines. Every NHL payload shape here
 * is an assumption (the NHL hosts are unreachable from dev), so each reader
 * tolerates missing fields instead of throwing.
 */

const REPORT_TIME_ZONE = 'America/New_York';
const COUNTED_GAME_TYPES = new Set([2, 3]);
const COMPLETED_GAME_STATES = new Set(['OFF', 'FINAL']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const easternFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The Eastern-time calendar date (YYYY-MM-DD) and hour (0-23) at an epoch-millisecond instant. */
function easternClock(ms) {
  const partsByType = Object.fromEntries(
    easternFormatter
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${partsByType.year}-${partsByType.month}-${partsByType.day}`,
    hour: Number(partsByType.hour),
  };
}

/** Parses a YYYY-MM-DD date as midnight UTC. */
function parseDay(date) {
  return new Date(`${date}T00:00:00Z`);
}

/** Adds (or subtracts) whole days to a YYYY-MM-DD date. */
function addDays(date, days) {
  const shiftedDay = parseDay(date);
  shiftedDay.setUTCDate(shiftedDay.getUTCDate() + days);
  return shiftedDay.toISOString().slice(0, 10);
}

/** True for a real calendar date (YYYY-MM-DD) that falls on a Monday. */
function isWeekStart(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const day = parseDay(value);
  return (
    !Number.isNaN(day.getTime()) &&
    day.toISOString().slice(0, 10) === value &&
    day.getUTCDay() === 1
  );
}

/** Monday of the last fully completed Monday–Sunday week in Eastern time. */
function previousWeekStart(nowMs) {
  const today = easternClock(nowMs).date;
  const sinceMonday = (parseDay(today).getUTCDay() + 6) % 7;
  return addDays(today, -sinceMonday - 7);
}

/** The Sunday that ends the week starting on `weekStart`. */
function weekEndOf(weekStart) {
  return addDays(weekStart, 6);
}

/** Formats a YYYY-MM-DD date as e.g. "Oct 13". */
function shortDate(date) {
  const day = parseDay(date);
  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
}

/** "Oct 13–19", or "Sep 29–Oct 5" across a month boundary. */
function formatWeekLabel(weekStart) {
  const startDay = parseDay(weekStart);
  const endDay = parseDay(weekEndOf(weekStart));
  const endText =
    startDay.getUTCMonth() === endDay.getUTCMonth()
      ? String(endDay.getUTCDate())
      : shortDate(weekEndOf(weekStart));
  return `${shortDate(weekStart)}–${endText}`;
}

/** Converts to a finite number, treating anything else as 0. */
function toNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Team abbreviation from a schedule team object (or plain string), or null. */
function getTeamAbbrev(team) {
  if (!team) return null;
  if (typeof team === 'string') return team;
  return team.abbrev ?? team.triCode ?? null;
}

/**
 * Completed regular-season and playoff games in the week, from the NHL
 * `/schedule/{date}` payload (`gameWeek: [{ date, games: [...] }]`, assumed).
 * Preseason (gameType 1) and other types never count.
 */
function summarizeWeekSchedule(payload, weekStart) {
  const weekEnd = weekEndOf(weekStart);
  const gamesById = new Map();
  const gamesByTeam = {};
  for (const day of payload?.gameWeek ?? []) {
    const date = String(day?.date ?? '').slice(0, 10);
    if (!date || date < weekStart || date > weekEnd) continue;
    for (const game of day?.games ?? []) {
      const gameId = Number(game?.id ?? game?.gameId);
      if (!Number.isSafeInteger(gameId) || gamesById.has(gameId)) continue;
      if (!COUNTED_GAME_TYPES.has(Number(game?.gameType))) continue;
      if (!COMPLETED_GAME_STATES.has(game?.gameState)) continue;
      const homeTeam = getTeamAbbrev(game.homeTeam);
      const awayTeam = getTeamAbbrev(game.awayTeam);
      gamesById.set(gameId, { gameId, date, homeTeam, awayTeam });
      for (const team of [homeTeam, awayTeam]) {
        if (team) gamesByTeam[team] = (gamesByTeam[team] ?? 0) + 1;
      }
    }
  }
  return { leagueGames: gamesById.size, gamesById, gamesByTeam };
}

/**
 * Normalizes per-game rows from the NHL stats REST summary endpoints
 * (`isGame=true`, assumed field names) and keeps only rows for `playerIds`
 * inside the week. Duplicate (player, game) rows from overlapping pages are
 * dropped.
 */
function normalizeGameRows(payloadRows, { playerIds, weekStart }) {
  const weekEnd = weekEndOf(weekStart);
  const wantedPlayerIds = new Set(playerIds.map(Number));
  const seenKeys = new Set();
  const gameRows = [];
  for (const payloadRow of payloadRows ?? []) {
    const playerId = Number(payloadRow?.playerId);
    const gameId = Number(payloadRow?.gameId);
    const date = String(payloadRow?.gameDate ?? '').slice(0, 10);
    if (!wantedPlayerIds.has(playerId) || !Number.isSafeInteger(gameId)) {
      continue;
    }
    if (!date || date < weekStart || date > weekEnd) continue;
    if (
      payloadRow.gameTypeId !== undefined &&
      !COUNTED_GAME_TYPES.has(Number(payloadRow.gameTypeId))
    ) {
      continue;
    }
    const playerGameKey = `${playerId}:${gameId}`;
    if (seenKeys.has(playerGameKey)) continue;
    seenKeys.add(playerGameKey);
    gameRows.push({ ...payloadRow, playerId, gameId, gameDate: date });
  }
  return gameRows;
}

/** Formats seconds as m:ss. */
function formatToi(seconds) {
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** The opponent in a game row: the row's own field, else derived from the schedule. */
function opponentOf(gameRow, team, gamesById) {
  if (gameRow.opponentTeamAbbrev) return gameRow.opponentTeamAbbrev;
  const game = gamesById.get(gameRow.gameId);
  if (!game) return null;
  return game.homeTeam === team ? game.awayTeam : game.homeTeam;
}

/** The skater's best game of the week by points, then goals, then latest date; null if no points. */
function bestSkaterGame(gameRows, gamesById) {
  const best = [...gameRows].sort(
    (gameA, gameB) =>
      toNumberOrZero(gameB.points) - toNumberOrZero(gameA.points) ||
      toNumberOrZero(gameB.goals) - toNumberOrZero(gameA.goals) ||
      gameB.gameDate.localeCompare(gameA.gameDate),
  )[0];
  if (!best || toNumberOrZero(best.points) <= 0) return null;
  const opponent = opponentOf(best, best.teamAbbrev, gamesById);
  const versus = opponent ? ` vs ${opponent}` : '';
  return {
    gameId: best.gameId,
    text: `${toNumberOrZero(best.goals)}G ${toNumberOrZero(best.assists)}A${versus}, ${shortDate(best.gameDate)}`,
  };
}

/** Totals one numeric field across game rows, counting missing values as 0. */
function sumField(gameRows, field) {
  return gameRows.reduce(
    (total, gameRow) => total + toNumberOrZero(gameRow[field]),
    0,
  );
}

/** Sums a skater's game rows into the week's stat line. */
function skaterStats(gameRows, gamesById) {
  /** Total of a stat field across the games. */
  const sum = (field) => sumField(gameRows, field);
  const gp = gameRows.length;
  return {
    gp,
    goals: sum('goals'),
    assists: sum('assists'),
    points: sum('points'),
    plusMinus: sum('plusMinus'),
    shots: sum('shots'),
    toiPerGame: gp ? formatToi(sum('timeOnIcePerGame') / gp) : null,
    bestGame: bestSkaterGame(gameRows, gamesById),
  };
}

/** Sums a goalie's game rows into the week's stat line (record, save percentage, GAA). */
function goalieStats(gameRows) {
  /** Total of a stat field across the games. */
  const sum = (field) => sumField(gameRows, field);
  const wins = sum('wins');
  const losses = sum('losses');
  const otLosses = sum('otLosses');
  const saves = sum('saves');
  const shotsAgainst = sum('shotsAgainst');
  const toi = sum('timeOnIce');
  return {
    gp: gameRows.length,
    wins,
    losses,
    otLosses,
    record: `${wins}-${losses}-${otLosses}`,
    savePct:
      shotsAgainst > 0
        ? Math.round((saves / shotsAgainst) * 1000) / 1000
        : null,
    gaa:
      toi > 0
        ? Math.round(((sum('goalsAgainst') * 3600) / toi) * 100) / 100
        : null,
    shutouts: sum('shutouts'),
  };
}

/** True when the favorite's position is goalie. */
function isGoalie(favorite) {
  return favorite.position === 'G';
}

/** One-line summary of a player's week, e.g. "2G 1A in 3 GP". */
function performanceLine(player) {
  const { stats } = player;
  if (player.type === 'goalie') return `${stats.record} in ${stats.gp} GP`;
  return `${stats.goals}G ${stats.assists}A in ${stats.gp} GP`;
}

/**
 * Push body: the best skater by points (then goals), else the best goalie by
 * wins, else the first player who played; plus " and N more" for the other
 * players who played.
 */
function buildHeadline(players) {
  const played = players.filter((player) => player.played);
  if (played.length === 0) {
    return 'Your favorite players did not play this week.';
  }
  const scoringSkaters = played
    .filter((player) => player.type === 'skater' && player.stats.points > 0)
    .sort(
      (playerA, playerB) =>
        playerB.stats.points - playerA.stats.points ||
        playerB.stats.goals - playerA.stats.goals,
    );
  const winningGoalies = played
    .filter((player) => player.type === 'goalie' && player.stats.wins > 0)
    .sort((playerA, playerB) => playerB.stats.wins - playerA.stats.wins);
  const topPlayer = scoringSkaters[0] ?? winningGoalies[0] ?? played[0];
  const otherCount = played.length - 1;
  return `${topPlayer.name}: ${performanceLine(topPlayer)}${otherCount > 0 ? ` and ${otherCount} more` : ''}`;
}

/**
 * Builds one user's frozen report, or null when none of the user's favorites
 * played and none of their teams played (the per-user skip).
 *
 * @param {{
 *   weekStart: string,
 *   favorites: { playerId: number, name: string, teamTriCode: string|null, position: string|null, headshot: string|null }[],
 *   skaterRows: any[],
 *   goalieRows: any[],
 *   schedule: ReturnType<typeof summarizeWeekSchedule>,
 * }} input
 */
function buildWeeklyReport({
  weekStart,
  favorites,
  skaterRows,
  goalieRows,
  schedule,
}) {
  const gameRowsByPlayer = new Map();
  for (const gameRow of [...skaterRows, ...goalieRows]) {
    const playerGameRows = gameRowsByPlayer.get(gameRow.playerId) ?? [];
    playerGameRows.push(gameRow);
    gameRowsByPlayer.set(gameRow.playerId, playerGameRows);
  }

  const players = favorites.map((favorite) => {
    const type = isGoalie(favorite) ? 'goalie' : 'skater';
    const gameRows = (gameRowsByPlayer.get(favorite.playerId) ?? []).sort(
      (gameA, gameB) => gameA.gameDate.localeCompare(gameB.gameDate),
    );
    const teams = [
      ...new Set(gameRows.map((gameRow) => gameRow.teamAbbrev).filter(Boolean)),
    ];
    return {
      playerId: favorite.playerId,
      name: favorite.name,
      position: favorite.position,
      headshot: favorite.headshot,
      team: teams[teams.length - 1] ?? favorite.teamTriCode,
      teams: teams.length ? teams : [favorite.teamTriCode].filter(Boolean),
      type,
      played: gameRows.length > 0,
      teamGames: schedule.gamesByTeam[favorite.teamTriCode] ?? 0,
      stats: gameRows.length
        ? type === 'goalie'
          ? goalieStats(gameRows)
          : skaterStats(gameRows, schedule.gamesById)
        : null,
    };
  });

  const anyActivity = players.some(
    (player) => player.played || player.teamGames > 0,
  );
  if (!anyActivity) return null;

  return {
    weekStart,
    weekEnd: weekEndOf(weekStart),
    label: formatWeekLabel(weekStart),
    headline: buildHeadline(players),
    players,
  };
}

module.exports = {
  REPORT_TIME_ZONE,
  easternClock,
  addDays,
  isWeekStart,
  previousWeekStart,
  weekEndOf,
  formatWeekLabel,
  summarizeWeekSchedule,
  normalizeGameRows,
  buildHeadline,
  buildWeeklyReport,
};
