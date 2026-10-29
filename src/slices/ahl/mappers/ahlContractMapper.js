/**
 * ahlContractMapper
 *
 * Turns raw HockeyTech feed payloads into the same contracts the NHL routes
 * serve (StandingsTeamContract, ScheduleGameContract, RosterContract, the
 * player summaries, StatLeaderContract, the NHL team summary rows and the
 * gamecenter boxscore fields the web app reads), field for field. A field the
 * feed does not have is null, never invented; the README lists them.
 */
const { toInteger, toNumber } = require('#platform/fieldValue.js');
const { GAME_TYPES, mapAhlTeams } = require('#slices/ahl/mappers/ahlMapper.js');

/** NHL position codes for HockeyTech's wing spellings; C, D, G and F pass through. */
const POSITION_CODES = { LW: 'L', RW: 'R' };
const toPositionCode = (position) =>
  POSITION_CODES[position] ?? position ?? null;

/** Parses "MM:SS" (minutes may exceed 59) into seconds, or null. */
function toSeconds(clockText) {
  const match = /^(\d+):(\d{2})$/.exec(clockText ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** `numerator / denominator`, or null when the denominator is missing or 0. */
function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

/** A feed percentage ("30.9") as the NHL's fraction (0.309), or null. */
function percentToFraction(percentText) {
  const percent = toNumber(percentText);
  return percent === null ? null : percent / 100;
}

/** An ISO 8601 time with offset as the NHL's UTC form ("2026-10-02T23:00:00Z"), or null. */
function toUtcTime(isoTime) {
  const time = new Date(isoTime ?? '');
  return Number.isNaN(time.getTime())
    ? null
    : time.toISOString().replace('.000Z', 'Z');
}

/** Short weekday ("Fri") of a YYYY-MM-DD date. */
function shortDayOfWeek(gameDate) {
  return new Date(`${gameDate}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
  });
}

/** `ahl_teams`-style rows of a teams payload, keyed by team id. */
function indexTeamsById(teamsPayload) {
  return new Map(mapAhlTeams(teamsPayload).map((team) => [team.teamId, team]));
}

/** Team rows of the standings `statviewtype` payload, in conference rank order (header rows dropped). */
function listStandingsRows(standingsPayload) {
  return (standingsPayload?.Statviewtype ?? []).filter((row) => row.team_id);
}

/** All player rows of a statviewfeed player table. */
function listStatRows(statTable) {
  return (statTable?.sections ?? []).flatMap((section) =>
    (section.data ?? []).map((statRow) => statRow.row),
  );
}

/** NHL-style overtime and shootout losses together, as `otLosses`. */
function countOtLosses(row) {
  return (
    (toInteger(row.ot_losses) ?? 0) + (toInteger(row.shootout_losses) ?? 0)
  );
}

/**
 * StandingsTeamContract rows from the conference standings view. Division
 * rank is the order within the division across its conference's list; the
 * AHL has no wild card or last-10 league rank.
 */
function mapAhlStandings(standingsPayload, teamsPayload) {
  const teamsById = indexTeamsById(teamsPayload);
  const divisionCounts = new Map();
  return listStandingsRows(standingsPayload).map((row) => {
    const divisionName = row.divisname ?? null;
    const divisionSequence = (divisionCounts.get(divisionName) ?? 0) + 1;
    divisionCounts.set(divisionName, divisionSequence);
    return {
      teamId: row.team_code,
      teamLogo: teamsById.get(toInteger(row.team_id))?.logoUrl ?? null,
      name: row.nickname ?? null,
      conferenceName: row.conference_name ?? null,
      divisionName,
      wins: toInteger(row.wins),
      losses: toInteger(row.losses),
      otLosses: countOtLosses(row),
      points: toInteger(row.points),
      pointPctg: toNumber(row.percentage_full),
      leagueSequence: toInteger(row.overall_rank),
      conferenceSequence: toInteger(row.rank),
      divisionSequence,
      wildcardSequence: null,
      clinchingIndicator: row.clinched ?? null,
      leagueL10Sequence: null,
    };
  });
}

/**
 * NHL team summary rows (stats REST `team/summary`) from the standings view,
 * for one HockeyTech team id or every team. Shots and faceoffs are not in
 * the feed's standings.
 */
function mapAhlTeamSummary(standingsPayload, seasonId, teamId) {
  return listStandingsRows(standingsPayload)
    .filter((row) => !teamId || row.team_id === String(teamId))
    .map((row) => {
      const gamesPlayed = toInteger(row.games_played);
      const goalsFor = toInteger(row.goals_for);
      const goalsAgainst = toInteger(row.goals_against);
      return {
        faceoffWinPct: null,
        gamesPlayed,
        goalsAgainst,
        goalsAgainstPerGame: ratio(goalsAgainst, gamesPlayed),
        goalsFor,
        goalsForPerGame: ratio(goalsFor, gamesPlayed),
        losses: toInteger(row.losses),
        otLosses: countOtLosses(row),
        penaltyKillNetPct: null,
        penaltyKillPct: percentToFraction(row.penalty_kill_pct),
        pointPct: toNumber(row.percentage_full),
        points: toInteger(row.points),
        powerPlayNetPct: null,
        powerPlayPct: percentToFraction(row.power_play_pct),
        regulationAndOtWins:
          (toInteger(row.regulation_wins) ?? 0) + (toInteger(row.ot_wins) ?? 0),
        seasonId: Number(seasonId),
        shotsAgainstPerGame: null,
        shotsForPerGame: null,
        teamFullName: row.name ?? null,
        teamId: toInteger(row.team_id),
        teamShutouts: null,
        ties: null,
        wins: toInteger(row.wins),
        winsInRegulation: toInteger(row.regulation_wins),
        winsInShootout: toInteger(row.shootout_wins),
      };
    });
}

/** NHL game state of a feed game: OFF once final, FINAL while unofficial (status 3), LIVE once started. */
function toGameState(feedGame) {
  if (feedGame.final === '1') return 'OFF';
  if (feedGame.status === '3') return 'FINAL';
  return feedGame.started === '1' ? 'LIVE' : 'FUT';
}

/** REG, OT or SO once a game has started, else null. */
function toPeriodType(feedGame) {
  if (feedGame.started !== '1') return null;
  if (feedGame.shootout === '1') return 'SO';
  return feedGame.overtime === '1' ? 'OT' : 'REG';
}

/**
 * ScheduleGameContract from one modulekit `schedule` game of a HockeyTech
 * season with `gameType`. The feed has no broadcasts, gamecenter link or
 * playoff series status.
 */
function mapAhlScheduleGame(feedGame, gameType, teamsById) {
  const gameState = toGameState(feedGame);
  const hasStarted = feedGame.started === '1';
  const hasStartTime = feedGame.date_tbd !== '1' && feedGame.time_tbd !== '1';
  const isPlayoff = gameType === GAME_TYPES.PLAYOFFS;
  return {
    gameId: toInteger(feedGame.game_id),
    date: feedGame.date_played,
    gameTime: hasStartTime ? toUtcTime(feedGame.GameDateISO8601) : null,
    dayOfWeek: shortDayOfWeek(feedGame.date_played),
    venue: feedGame.venue_name || null,
    homeTeam: feedGame.home_team_code,
    homeLogo: teamsById.get(toInteger(feedGame.home_team))?.logoUrl ?? null,
    homeScore: hasStarted ? toInteger(feedGame.home_goal_count) : null,
    awayTeam: feedGame.visiting_team_code,
    awayLogo: teamsById.get(toInteger(feedGame.visiting_team))?.logoUrl ?? null,
    awayScore: hasStarted ? toInteger(feedGame.visiting_goal_count) : null,
    broadcasts: [],
    ticketLink: gameState === 'FUT' ? feedGame.tickets_url || null : null,
    gameCenter: null,
    isPlayoff,
    isPreseason: gameType === GAME_TYPES.EXHIBITION,
    playoffRound: null,
    periodType: toPeriodType(feedGame),
    seriesWins: null,
    topSeedTeamAbbrev: null,
    bottomSeedTeamAbbrev: null,
    gameState,
  };
}

/** RosterContract from the modulekit `roster` view; staff entries are dropped. */
function mapAhlRosterContract(rosterPayload) {
  const players = (rosterPayload?.Roster ?? [])
    .filter(
      (rosterEntry) =>
        !Array.isArray(rosterEntry) &&
        toInteger(rosterEntry.player_id) !== null &&
        rosterEntry.position,
    )
    .map((rosterPlayer) => ({
      id: toInteger(rosterPlayer.player_id),
      name: rosterPlayer.name,
      number: toInteger(rosterPlayer.tp_jersey_number),
      position: toPositionCode(rosterPlayer.position),
      headshot: rosterPlayer.player_image || null,
    }));
  return { players };
}

/** SkaterSummaryContract rows; goalies in the skater table are dropped. The feed has no faceoffs or TOI. */
function mapAhlSkaterSummary(statTable) {
  return listStatRows(statTable)
    .filter((row) => row.position !== 'G')
    .map((row) => {
      const goals = toInteger(row.goals);
      const shots = toInteger(row.shots);
      return {
        playerId: toInteger(row.player_id),
        name: row.name,
        position: toPositionCode(row.position),
        teamTriCodes: row.team_code ? [row.team_code] : [],
        gamesPlayed: toInteger(row.games_played),
        goals,
        assists: toInteger(row.assists),
        points: toInteger(row.points),
        plusMinus: toInteger(row.plus_minus),
        shots,
        shootingPct: ratio(goals, shots),
        powerPlayGoals: toInteger(row.power_play_goals),
        penaltyMinutes: toInteger(row.penalty_minutes),
        faceoffWinPct: null,
        toiPerGame: null,
      };
    });
}

/** GoalieSummaryContract rows; TOI per game in seconds from total minutes played. */
function mapAhlGoalieSummary(statTable) {
  return listStatRows(statTable).map((row) => {
    const gamesPlayed = toInteger(row.games_played);
    const secondsPlayed = toSeconds(row.minutes_played);
    return {
      goalieId: toInteger(row.player_id),
      name: row.name,
      teamTriCodes: row.team_code ? [row.team_code] : [],
      gamesPlayed,
      wins: toInteger(row.wins),
      losses: toInteger(row.losses),
      otLosses: toInteger(row.ot_losses),
      savePctg: toNumber(row.save_percentage),
      goalsAgainstAverage: toNumber(row.goals_against_average),
      shutouts: toInteger(row.shutouts),
      toiPerGame:
        secondsPlayed === null ? null : ratio(secondsPlayed, gamesPlayed),
    };
  });
}

const LEADER_COUNT = 10;

/** Stat leader categories the feed's player tables can answer: value field and sort order. */
const LEADER_CATEGORIES = {
  skater: {
    goals: { field: 'goals', descending: true },
    assists: { field: 'assists', descending: true },
    points: { field: 'points', descending: true },
  },
  goalie: {
    wins: { field: 'wins', descending: true },
    shutouts: { field: 'shutouts', descending: true },
    savePctg: { field: 'save_percentage', descending: true, qualified: true },
    goalsAgainstAverage: {
      field: 'goals_against_average',
      descending: false,
      qualified: true,
    },
  },
};

/**
 * Goalies with enough games for a rate leader board.
 * shortcut: a third of the most games any goalie has played stands in for the
 * AHL's official qualifying rule; use the feed's own qualified list if they disagree.
 */
function filterQualifiedGoalies(rows) {
  const mostGamesPlayed = Math.max(
    0,
    ...rows.map((row) => toInteger(row.games_played) ?? 0),
  );
  return rows.filter(
    (row) => (toInteger(row.games_played) ?? 0) >= mostGamesPlayed / 3,
  );
}

/**
 * Top-10 StatLeaderContract rows of one category from a league-wide player
 * table; an unknown category (such as faceoffs) has no leaders. Names are
 * split at the first space; the feed has no sweater number or headshot here.
 */
function mapAhlStatLeaders(statTable, playerType, category, teamsPayload) {
  const leaderCategory = LEADER_CATEGORIES[playerType]?.[category];
  if (!leaderCategory) return [];
  const teamsByCode = new Map(
    mapAhlTeams(teamsPayload).map((team) => [team.teamCode, team]),
  );
  // The skater table also lists goalies; the goalie table has no position.
  const rows = listStatRows(statTable).filter(
    (row) =>
      (playerType === 'goalie' || row.position !== 'G') &&
      toNumber(row[leaderCategory.field]) !== null,
  );
  const candidates = leaderCategory.qualified
    ? filterQualifiedGoalies(rows)
    : rows;
  const direction = leaderCategory.descending ? -1 : 1;
  return candidates
    .sort(
      (first, second) =>
        direction *
        (toNumber(first[leaderCategory.field]) -
          toNumber(second[leaderCategory.field])),
    )
    .slice(0, LEADER_COUNT)
    .map((row) => {
      const [firstName, ...lastNames] = (row.name ?? '').split(' ');
      const team = teamsByCode.get(row.team_code);
      return {
        id: toInteger(row.player_id),
        firstName,
        lastName: lastNames.join(' '),
        sweaterNumber: null,
        headshot: null,
        teamAbbrev: row.team_code ?? null,
        teamName: team?.fullName ?? null,
        teamLogo: team?.logoUrl ?? null,
        position: playerType === 'goalie' ? 'G' : toPositionCode(row.position),
        value: toNumber(row[leaderCategory.field]),
      };
    });
}

/** NHL boxscore name ("A. Matthews") from feed player info. */
function toBoxscoreName(info) {
  const initial = info.firstName ? `${info.firstName[0]}. ` : '';
  return { default: `${initial}${info.lastName ?? ''}`.trim() };
}

/** Boxscore skater; the feed has no per-player power-play goals, shifts, giveaways or takeaways, and reports untracked TOI as 0:00. */
function mapBoxscoreSkater({ info, stats }) {
  return {
    playerId: info.id,
    sweaterNumber: info.jerseyNumber ?? null,
    name: toBoxscoreName(info),
    position: toPositionCode(info.position),
    goals: stats.goals,
    assists: stats.assists,
    points: stats.points,
    plusMinus: stats.plusMinus,
    pim: stats.penaltyMinutes,
    hits: stats.hits,
    powerPlayGoals: null,
    sog: stats.shots,
    faceoffWinningPctg: ratio(stats.faceoffWins, stats.faceoffAttempts),
    toi: toSeconds(stats.toi) ? stats.toi : null,
    blockedShots: stats.blockedShots,
    shifts: null,
    giveaways: null,
    takeaways: null,
  };
}

/** NHL goalie decision (W, L, or O for an overtime or shootout loss) from a goalie log result. */
function toDecision(result) {
  if (result === 'W' || result === 'L') return result;
  return /^(OTL|SOL)$/.test(result ?? '') ? 'O' : null;
}

/** Boxscore goalie; the decision comes from the team's goalie log. */
function mapBoxscoreGoalie({ info, stats, starting }, goalieLog) {
  const logEntry = (goalieLog ?? []).find(
    (entry) => entry.info?.id === info.id && entry.result,
  );
  return {
    playerId: info.id,
    sweaterNumber: info.jerseyNumber ?? null,
    name: toBoxscoreName(info),
    position: 'G',
    saveShotsAgainst: `${stats.saves}/${stats.shotsAgainst}`,
    savePctg: ratio(stats.saves, stats.shotsAgainst),
    goalsAgainst: stats.goalsAgainst,
    toi: stats.timeOnIce ?? null,
    starter: starting === 1,
    decision: toDecision(logEntry?.result),
    shotsAgainst: stats.shotsAgainst,
    saves: stats.saves,
    evenStrengthShotsAgainst: null,
    powerPlayShotsAgainst: null,
    shorthandedShotsAgainst: null,
  };
}

/** Boxscore team header; the feed has one logo, so there is no dark logo. */
function mapBoxscoreTeam(feedTeam) {
  return {
    id: feedTeam.info.id,
    abbrev: feedTeam.info.abbreviation,
    commonName: { default: feedTeam.info.nickname },
    score: feedTeam.stats.goals,
    sog: feedTeam.stats.shots,
    logo: feedTeam.info.logo ?? null,
    darkLogo: null,
  };
}

/** Forwards, defense and goalies of one team. */
function mapBoxscoreTeamStats(feedTeam) {
  const skaters = feedTeam.skaters ?? [];
  return {
    forwards: skaters
      .filter((skater) => skater.info.position !== 'D')
      .map(mapBoxscoreSkater),
    defense: skaters
      .filter((skater) => skater.info.position === 'D')
      .map(mapBoxscoreSkater),
    goalies: (feedTeam.goalies ?? []).map((goalie) =>
      mapBoxscoreGoalie(goalie, feedTeam.goalieLog),
    ),
  };
}

/**
 * The NHL gamecenter boxscore fields the web app reads, from the statviewfeed
 * `gameSummary`. The feed has no live clock.
 */
function mapAhlBoxscore(gameSummary) {
  const { details } = gameSummary;
  const periods = gameSummary.periods ?? [];
  let periodType = periods.length > 3 ? 'OT' : 'REG';
  if (gameSummary.hasShootout) periodType = 'SO';
  const gameState = toGameState(details);
  return {
    id: details.id,
    gameState,
    gameDate: details.GameDateISO8601?.slice(0, 10) ?? null,
    startTimeUTC: toUtcTime(details.GameDateISO8601),
    venue: { default: details.venue },
    homeTeam: mapBoxscoreTeam(gameSummary.homeTeam),
    awayTeam: mapBoxscoreTeam(gameSummary.visitingTeam),
    periodDescriptor: {
      number: periods.length + (gameSummary.hasShootout ? 1 : 0),
      periodType,
    },
    clock: null,
    gameOutcome: gameState === 'OFF' ? { lastPeriodType: periodType } : null,
    playerByGameStats: {
      homeTeam: mapBoxscoreTeamStats(gameSummary.homeTeam),
      awayTeam: mapBoxscoreTeamStats(gameSummary.visitingTeam),
    },
  };
}

module.exports = {
  indexTeamsById,
  mapAhlStandings,
  mapAhlTeamSummary,
  mapAhlScheduleGame,
  mapAhlRosterContract,
  mapAhlSkaterSummary,
  mapAhlGoalieSummary,
  mapAhlStatLeaders,
  mapAhlBoxscore,
};
