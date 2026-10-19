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

const easternParts = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function easternClock(ms) {
  const parts = Object.fromEntries(
    easternParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

function parseDay(date) {
  return new Date(`${date}T00:00:00Z`);
}

function addDays(date, days) {
  const d = parseDay(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date (YYYY-MM-DD) that falls on a Monday. */
function isWeekStart(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const d = parseDay(value);
  return (
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value &&
    d.getUTCDay() === 1
  );
}

/** Monday of the last fully completed Monday–Sunday week in Eastern time. */
function previousWeekStart(nowMs) {
  const today = easternClock(nowMs).date;
  const sinceMonday = (parseDay(today).getUTCDay() + 6) % 7;
  return addDays(today, -sinceMonday - 7);
}

function weekEndOf(weekStart) {
  return addDays(weekStart, 6);
}

function shortDate(date) {
  const d = parseDay(date);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Oct 13–19", or "Sep 29–Oct 5" across a month boundary. */
function formatWeekLabel(weekStart) {
  const start = parseDay(weekStart);
  const end = parseDay(weekEndOf(weekStart));
  const endText =
    start.getUTCMonth() === end.getUTCMonth()
      ? String(end.getUTCDate())
      : shortDate(weekEndOf(weekStart));
  return `${shortDate(weekStart)}–${endText}`;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function abbrev(team) {
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
      const homeTeam = abbrev(game.homeTeam);
      const awayTeam = abbrev(game.awayTeam);
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
  const wanted = new Set(playerIds.map(Number));
  const seen = new Set();
  const rows = [];
  for (const row of payloadRows ?? []) {
    const playerId = Number(row?.playerId);
    const gameId = Number(row?.gameId);
    const date = String(row?.gameDate ?? '').slice(0, 10);
    if (!wanted.has(playerId) || !Number.isSafeInteger(gameId)) continue;
    if (!date || date < weekStart || date > weekEnd) continue;
    if (
      row.gameTypeId !== undefined &&
      !COUNTED_GAME_TYPES.has(Number(row.gameTypeId))
    ) {
      continue;
    }
    const key = `${playerId}:${gameId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...row, playerId, gameId, gameDate: date });
  }
  return rows;
}

function formatToi(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function opponentOf(row, team, gamesById) {
  if (row.opponentTeamAbbrev) return row.opponentTeamAbbrev;
  const game = gamesById.get(row.gameId);
  if (!game) return null;
  return game.homeTeam === team ? game.awayTeam : game.homeTeam;
}

function bestSkaterGame(rows, gamesById) {
  const best = [...rows].sort(
    (a, b) =>
      toNumber(b.points) - toNumber(a.points) ||
      toNumber(b.goals) - toNumber(a.goals) ||
      b.gameDate.localeCompare(a.gameDate),
  )[0];
  if (!best || toNumber(best.points) <= 0) return null;
  const opponent = opponentOf(best, best.teamAbbrev, gamesById);
  const versus = opponent ? ` vs ${opponent}` : '';
  return {
    gameId: best.gameId,
    text: `${toNumber(best.goals)}G ${toNumber(best.assists)}A${versus}, ${shortDate(best.gameDate)}`,
  };
}

function skaterStats(rows, gamesById) {
  const sum = (field) => rows.reduce((t, r) => t + toNumber(r[field]), 0);
  const gp = rows.length;
  return {
    gp,
    goals: sum('goals'),
    assists: sum('assists'),
    points: sum('points'),
    plusMinus: sum('plusMinus'),
    shots: sum('shots'),
    toiPerGame: gp ? formatToi(sum('timeOnIcePerGame') / gp) : null,
    bestGame: bestSkaterGame(rows, gamesById),
  };
}

function goalieStats(rows) {
  const sum = (field) => rows.reduce((t, r) => t + toNumber(r[field]), 0);
  const wins = sum('wins');
  const losses = sum('losses');
  const otLosses = sum('otLosses');
  const saves = sum('saves');
  const shotsAgainst = sum('shotsAgainst');
  const toi = sum('timeOnIce');
  return {
    gp: rows.length,
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

function isGoalie(favorite) {
  return favorite.position === 'G';
}

function performanceLine(player) {
  const s = player.stats;
  if (player.type === 'goalie') return `${s.record} in ${s.gp} GP`;
  return `${s.goals}G ${s.assists}A in ${s.gp} GP`;
}

/**
 * Push body: the best skater by points (then goals), else the best goalie by
 * wins, else the first player who played; plus " and N more" for the other
 * players who played.
 */
function buildHeadline(players) {
  const played = players.filter((p) => p.played);
  if (played.length === 0) {
    return 'Your favorite players did not play this week.';
  }
  const skaters = played
    .filter((p) => p.type === 'skater' && p.stats.points > 0)
    .sort(
      (a, b) =>
        b.stats.points - a.stats.points || b.stats.goals - a.stats.goals,
    );
  const goalies = played
    .filter((p) => p.type === 'goalie' && p.stats.wins > 0)
    .sort((a, b) => b.stats.wins - a.stats.wins);
  const top = skaters[0] ?? goalies[0] ?? played[0];
  const others = played.length - 1;
  return `${top.name}: ${performanceLine(top)}${others > 0 ? ` and ${others} more` : ''}`;
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
  const rowsByPlayer = new Map();
  for (const row of [...skaterRows, ...goalieRows]) {
    const list = rowsByPlayer.get(row.playerId) ?? [];
    list.push(row);
    rowsByPlayer.set(row.playerId, list);
  }

  const players = favorites.map((favorite) => {
    const type = isGoalie(favorite) ? 'goalie' : 'skater';
    const rows = (rowsByPlayer.get(favorite.playerId) ?? []).sort((a, b) =>
      a.gameDate.localeCompare(b.gameDate),
    );
    const teams = [...new Set(rows.map((r) => r.teamAbbrev).filter(Boolean))];
    return {
      playerId: favorite.playerId,
      name: favorite.name,
      position: favorite.position,
      headshot: favorite.headshot,
      team: teams[teams.length - 1] ?? favorite.teamTriCode,
      teams: teams.length ? teams : [favorite.teamTriCode].filter(Boolean),
      type,
      played: rows.length > 0,
      teamGames: schedule.gamesByTeam[favorite.teamTriCode] ?? 0,
      stats: rows.length
        ? type === 'goalie'
          ? goalieStats(rows)
          : skaterStats(rows, schedule.gamesById)
        : null,
    };
  });

  const anyActivity = players.some((p) => p.played || p.teamGames > 0);
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
