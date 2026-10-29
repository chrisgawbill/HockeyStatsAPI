const assert = require('node:assert/strict');
const createError = require('http-errors');
const { beforeEach, test } = require('node:test');

const { makeTestApp, jsonRequest: request } = require('./testApp.js');
const sessionJwt = require('#platform/sessionJwt.js');
const seasons = require('#platform/seasonHelper.js');
const {
  previousWeekStart,
  formatWeekLabel,
  isWeekStart,
  summarizeWeekSchedule,
  normalizeGameRows,
  buildHeadline,
  isClubScheduleCurrent,
  buildWeeklyReport,
} = require('#slices/weeklyPlayerReports/weeklyReportBuilder.js');
const {
  createWeeklyPlayerReportService,
} = require('#slices/weeklyPlayerReports/weeklyPlayerReportService.js');
const {
  createPushNotificationService,
} = require('#slices/pushNotifications/pushNotificationService.js');
const { createPushRouter } = require('#presentation/routes/push.js');
const {
  createFavoritePlayersRouter,
  createWeeklyPlayerReportsRouter,
} = require('#presentation/routes/weeklyPlayerReports.js');

const SECRET = 'test-session-secret';
const CRON = 'cron-secret-value';
// Monday 2026-10-19 09:30 EDT; the report week is Oct 12–18.
const NOW = Date.parse('2026-10-19T13:30:00Z');
const WEEK = '2026-10-12';

const MCDAVID = 8478402;
const SKINNER = 8479973;
const HUGHES = 8480800;
const MATTHEWS = 8479318;

const PROFILES = {
  [MCDAVID]: ['Connor', 'McDavid', 'EDM', 'C'],
  [SKINNER]: ['Stuart', 'Skinner', 'EDM', 'G'],
  [HUGHES]: ['Quinn', 'Hughes', 'VAN', 'D'],
  [MATTHEWS]: ['Auston', 'Matthews', 'TOR', 'C'],
};
for (let id = 1; id <= 11; id += 1) {
  PROFILES[9000000 + id] = ['Depth', `Player${id}`, 'SEA', 'C'];
}

beforeEach(() => {
  process.env.SESSION_JWT_SECRET = SECRET;
  process.env.VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  process.env.CRON_SECRET = CRON;
});

function scheduleGame(id, away, home, gameType = 2, gameState = 'OFF') {
  return {
    id,
    gameType,
    gameState,
    awayTeam: { abbrev: away },
    homeTeam: { abbrev: home },
  };
}

const NORMAL_WEEK = {
  gameWeek: [
    { date: '2026-10-12', games: [] },
    { date: '2026-10-13', games: [scheduleGame(3, 'TOR', 'MTL', 1)] },
    { date: '2026-10-14', games: [scheduleGame(1, 'CGY', 'EDM')] },
    { date: '2026-10-15', games: [] },
    { date: '2026-10-16', games: [scheduleGame(4, 'OTT', 'TOR')] },
    { date: '2026-10-17', games: [] },
    { date: '2026-10-18', games: [scheduleGame(2, 'EDM', 'BOS')] },
  ],
};

/** A club schedule game in the mapped ScheduleGameContract fields the report reads. */
function clubGame(gameId, date, away, home, awayScore, homeScore, extra = {}) {
  return {
    gameId,
    date,
    gameState: 'OFF',
    awayTeam: away,
    homeTeam: home,
    awayScore,
    homeScore,
    periodType: 'REG',
    isPlayoff: false,
    ...extra,
  };
}

/**
 * Club season schedules (mapped) for the favorite teams. EDM: an OT win and a
 * shootout loss in the week, plus games outside it; TOR: a preseason game and
 * a regulation loss; VAN: nothing in the week.
 */
const CLUB_SEASONS = {
  EDM: {
    team: { name: 'Edmonton Oilers', logo: 'https://assets.example/EDM.svg' },
    games: [
      clubGame(90, '2026-10-09', 'VAN', 'EDM', 2, 5),
      clubGame(2, '2026-10-18', 'EDM', 'BOS', 2, 3, { periodType: 'SO' }),
      clubGame(1, '2026-10-14', 'CGY', 'EDM', 3, 4, { periodType: 'OT' }),
      clubGame(95, '2026-10-20', 'EDM', 'SEA', null, null, {
        gameState: 'FUT',
        periodType: null,
      }),
    ],
  },
  TOR: {
    team: { name: 'Toronto Maple Leafs', logo: 'https://assets.example/TOR.svg' },
    games: [
      clubGame(3, '2026-10-13', 'TOR', 'MTL', 2, 1),
      clubGame(4, '2026-10-16', 'OTT', 'TOR', 4, 1),
    ],
  },
  VAN: {
    team: { name: 'Vancouver Canucks', logo: 'https://assets.example/VAN.svg' },
    games: [clubGame(90, '2026-10-09', 'VAN', 'EDM', 2, 5)],
  },
};

const BREAK_WEEK = {
  gameWeek: [
    { date: '2026-10-12', games: [scheduleGame(3, 'TOR', 'MTL', 1)] },
    { date: '2026-10-18', games: [] },
  ],
};

const SKATER_ROWS = [
  {
    playerId: MCDAVID,
    gameId: 1,
    gameDate: '2026-10-14',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'CGY',
    goals: 1,
    assists: 3,
    points: 4,
    plusMinus: 2,
    shots: 5,
    timeOnIcePerGame: 1300,
  },
  {
    playerId: MCDAVID,
    gameId: 2,
    gameDate: '2026-10-18',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'BOS',
    goals: 1,
    assists: 1,
    points: 2,
    plusMinus: -1,
    shots: 6,
    timeOnIcePerGame: 1304,
  },
];

const GOALIE_ROWS = [
  {
    playerId: SKINNER,
    gameId: 2,
    gameDate: '2026-10-18',
    teamAbbrev: 'EDM',
    opponentTeamAbbrev: 'BOS',
    wins: 1,
    losses: 0,
    otLosses: 0,
    saves: 30,
    shotsAgainst: 32,
    goalsAgainst: 2,
    shutouts: 0,
    timeOnIce: 3600,
  },
];

/** In-memory Postgres stand-in for the weekly report and push statements. */
function fakeDb() {
  const db = {
    favorites: [], // { user_id, player_id, full_name, ..., created_at }
    favoriteTeams: [], // { user_id, team_tri_code, tier, label }
    reports: new Map(), // `${user}:${week}` -> { payload, created_at, read_at }
    ledger: new Set(),
    pushOff: new Set(),
    accountPushOff: new Set(), // user ids with the account-wide switch off
    subs: [], // { id, user_id, endpoint, p256dh, auth }
    nextId: 1,
    clock: 0,
  };
  const key = (userId, weekStart) => `${userId}:${weekStart}`;
  const reportRow = (userId, weekStart) => {
    const storedReport = db.reports.get(key(userId, weekStart));
    return (
      storedReport && { user_id: userId, week_start: weekStart, ...storedReport }
    );
  };
  const client = {
    async query(sql, params = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('INSERT INTO favorite_players')) {
        const [user_id, player_id, full_name, team, position, headshot, limit, league] =
          params;
        const mine = db.favorites.filter((favorite) => favorite.user_id === user_id);
        const existing = mine.find(
          (favorite) => favorite.player_id === String(player_id) && favorite.league === league,
        );
        if (existing) {
          Object.assign(existing, { full_name, team_tri_code: team });
          return { rows: [], rowCount: 1 };
        }
        if (mine.length >= limit) return { rows: [], rowCount: 0 };
        db.clock += 1;
        db.favorites.push({
          user_id,
          player_id: String(player_id),
          league,
          full_name,
          team_tri_code: team,
          position,
          headshot,
          created_at: new Date(Date.UTC(2026, 9, 1, 0, db.clock)),
          tier: 'fan',
          label: null,
          push_muted: false,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE favorite_players') && sql.includes('tier =')) {
        const [user_id, player_id, changeTier, tier, changeLabel, label] = params;
        const favoriteRow = db.favorites.find(
          (favorite) => favorite.user_id === user_id && favorite.player_id === String(player_id),
        );
        if (!favoriteRow) return { rows: [], rowCount: 0 };
        if (changeTier) favoriteRow.tier = tier;
        if (changeLabel) favoriteRow.label = label;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE favorite_players') && sql.includes('push_muted')) {
        const [user_id, player_id, muted] = params;
        const favoriteRow = db.favorites.find(
          (favorite) => favorite.user_id === user_id && favorite.player_id === String(player_id),
        );
        if (favoriteRow) favoriteRow.push_muted = muted;
        return { rows: [], rowCount: favoriteRow ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM favorite_players')) {
        db.favorites = db.favorites.filter(
          (favorite) =>
            !(
              favorite.user_id === params[0] &&
              favorite.player_id === String(params[1]) &&
              favorite.league === params[2]
            ),
        );
        return { rows: [] };
      }
      if (sql.includes('FROM favorite_teams')) {
        return { rows: db.favoriteTeams.filter((favorite) => favorite.league === 'nhl') };
      }
      if (sql.includes("FROM favorite_players\n\t\tWHERE league = 'nhl'")) {
        return { rows: db.favorites.filter((favorite) => favorite.league === 'nhl') };
      }
      if (sql.includes('FROM favorite_players') && sql.includes('WHERE')) {
        return {
          rows: db.favorites.filter(
            (favorite) => String(favorite.user_id) === String(params[0]),
          ),
        };
      }
      if (sql.includes('FROM favorite_players')) {
        return { rows: [...db.favorites] };
      }
      if (sql.includes('INSERT INTO weekly_player_reports')) {
        const [userId, weekStart, payload] = params;
        if (db.reports.has(key(userId, weekStart))) {
          return { rows: [], rowCount: 0 };
        }
        db.reports.set(key(userId, weekStart), {
          payload: JSON.parse(payload),
          created_at: new Date(NOW),
          read_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE weekly_player_reports')) {
        const r = db.reports.get(key(String(params[0]), params[1]));
        if (r) r.read_at ??= new Date(NOW);
        return { rows: [], rowCount: r ? 1 : 0 };
      }
      if (
        sql.includes('INSERT INTO weekly_player_report_pushes') &&
        sql.includes('FROM weekly_player_reports')
      ) {
        for (const k of db.reports.keys()) {
          if (k.startsWith(`${params[0]}:`)) db.ledger.add(k);
        }
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO weekly_player_report_pushes')) {
        const k = key(params[0], params[1]);
        if (db.ledger.has(k)) return { rows: [] };
        db.ledger.add(k);
        return { rows: [{ user_id: params[0] }] };
      }
      if (sql.includes('FROM weekly_player_reports') && sql.includes('LIMIT')) {
        return {
          rows: [...db.reports.keys()]
            .filter((reportKey) => reportKey.startsWith(`${params[0]}:`))
            .map((reportKey) => reportRow(params[0], reportKey.split(':')[1]))
            .sort((reportA, reportB) =>
              reportB.week_start.localeCompare(reportA.week_start),
            )
            .slice(0, params[1]),
        };
      }
      if (sql.includes('FROM weekly_player_reports') && sql.includes('$2')) {
        const row = reportRow(params[0], params[1]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM weekly_player_reports')) {
        return {
          rows: [...db.reports.keys()]
            .filter((reportKey) => reportKey.endsWith(`:${params[0]}`))
            .map((reportKey) => reportRow(reportKey.split(':')[0], params[0])),
        };
      }
      if (sql.includes('SELECT weekly_report_push')) {
        return {
          rows: [{ weekly_report_push: !db.pushOff.has(String(params[0])) }],
        };
      }
      if (sql.includes('UPDATE users SET weekly_report_push')) {
        if (params[1]) db.pushOff.delete(String(params[0]));
        else db.pushOff.add(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes('weekly_report_push = false')) {
        return { rows: [...db.pushOff].map((id) => ({ id })) };
      }
      if (sql.includes('SELECT DISTINCT push_subscriptions.user_id')) {
        return {
          rows: [
            ...new Set(db.subs.map((subscription) => subscription.user_id)),
          ]
            .filter((user_id) => !db.accountPushOff.has(String(user_id)))
            .map((user_id) => ({ user_id })),
        };
      }
      if (sql.includes('DELETE FROM push_subscriptions WHERE id')) {
        db.subs = db.subs.filter(
          (subscription) => subscription.id !== params[0],
        );
        return { rows: [] };
      }
      if (sql.includes('FROM push_subscriptions')) {
        return {
          rows: db.subs.filter(
            (subscription) => String(subscription.user_id) === String(params[0]),
          ),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  db.withTransaction = (fn) => fn(client);
  db.subscribe = (userId, endpoint = `https://push.example.com/${userId}`) =>
    db.subs.push({
      id: db.nextId++,
      user_id: userId,
      endpoint,
      p256dh: 'p',
      auth: 'a',
    });
  return db;
}

function fakeCache() {
  const store = new Map();
  return {
    store,
    CACHE_TYPES: { PLAYER: 'player', SCHEDULE: 'schedule' },
    async getOrFetchCached(type, key, fetcher) {
      const k = `${type}:${key}`;
      if (store.has(k)) return store.get(k);
      const value = await fetcher();
      store.set(k, value);
      return value;
    },
  };
}

function statsClient(rows, calls, fail) {
  return {
    async get(url) {
      calls.push(url);
      if (fail.stats) throw new Error('stats down');
      return { data: { data: rows, total: rows.length } };
    },
  };
}

/**
 * Schedule service stand-in serving CLUB_SEASONS. A team in `staleTeams`
 * serves its cached copy without the week's finals until fetched fresh.
 */
function fakeScheduleService(calls, fail, staleTeams) {
  return {
    async getClubSeason(triCode, seasonId, { fresh = false } = {}) {
      calls.push({ triCode, seasonId, fresh });
      if (fail.teams) throw new Error('club schedule down');
      const clubSeason = CLUB_SEASONS[triCode] ?? {
        team: { name: triCode, logo: null },
        games: [],
      };
      if (!staleTeams.has(triCode) || fresh) return clubSeason;
      return {
        ...clubSeason,
        games: clubSeason.games.map((clubGame) => ({
          ...clubGame,
          gameState: 'FUT',
          homeScore: null,
          awayScore: null,
        })),
      };
    },
  };
}

/** AHL players the fake AHL read service knows; MCDAVID's id doubles as an AHL id. */
const AHL_PLAYER_IDS = new Set([MCDAVID, 777]);

function fakeAhlReadService() {
  return {
    async findPlayerProfile(playerId) {
      if (!AHL_PLAYER_IDS.has(playerId)) throw createError(404, 'Player not found.');
      return { fullName: `AHL ${playerId}`, teamTriCode: 'BEL', position: 'C', headshot: null };
    },
  };
}

function build({ schedule = NORMAL_WEEK, sendImpl, staleTeams = [] } = {}) {
  const db = fakeDb();
  const cache = fakeCache();
  const calls = { nhl: [], skaters: [], goalies: [], clubSeasons: [] };
  const fail = { stats: false, teams: false };
  const nhlApi = {
    axiosNhl: {
      async get(url) {
        calls.nhl.push(url);
        const landing = url.match(/^\/player\/(\d+)\/landing$/);
        if (landing) {
          const profile = PROFILES[landing[1]];
          if (!profile) {
            throw Object.assign(new Error('404'), {
              response: { status: 404 },
            });
          }
          const [first, last, team, position] = profile;
          return {
            data: {
              firstName: { default: first },
              lastName: { default: last },
              currentTeamAbbrev: team,
              position,
              headshot: `https://assets.example/${landing[1]}.png`,
            },
          };
        }
        if (url === `/schedule/${WEEK}`) return { data: schedule };
        if (url.startsWith('/schedule/')) return { data: { gameWeek: [] } };
        throw new Error(`Unexpected NHL URL ${url}`);
      },
    },
    axiosNhlStats: statsClient(
      [
        ...SKATER_ROWS,
        SKATER_ROWS[0], // duplicate from an overlapping page
        { ...SKATER_ROWS[0], playerId: 1, gameId: 9 }, // not favorited
        { ...SKATER_ROWS[0], gameId: 7, gameDate: '2026-10-19' }, // next week
      ],
      calls.skaters,
      fail,
    ),
    axiosNhlGoalie: statsClient(GOALIE_ROWS, calls.goalies, fail),
  };
  const weeklyPlayerReportService = createWeeklyPlayerReportService({
    withTransaction: db.withTransaction,
    nhlApi,
    cache,
    seasons,
    scheduleService: fakeScheduleService(
      calls.clubSeasons,
      fail,
      new Set(staleTeams),
    ),
    ahlReadService: fakeAhlReadService(),
  });
  const sent = [];
  const webPush = {
    sendNotification: async (subscription, payload) => {
      if (sendImpl) await sendImpl(subscription);
      sent.push({ subscription, payload: JSON.parse(payload) });
    },
  };
  const pushNotificationService = createPushNotificationService({
    withTransaction: db.withTransaction,
    sessionJwt,
    afterActionReportService: {
      markRead: async () => {
        throw new Error('not an AAR token');
      },
    },
    weeklyPlayerReportService,
    webPush,
    now: () => NOW,
  });
  const pass = (req, res, next) => next();
  return {
    db,
    cache,
    calls,
    fail,
    sent,
    push: makeTestApp(
      '/api/push',
      createPushRouter({ pushNotificationService, dispatchRateLimiter: pass }),
    ),
    favorites: makeTestApp(
      '/api/favorite-players',
      createFavoritePlayersRouter({ weeklyPlayerReportService }),
    ),
    reports: makeTestApp(
      '/api/weekly-player-reports',
      createWeeklyPlayerReportsRouter({ weeklyPlayerReportService }),
    ),
  };
}

const json = (body) => JSON.stringify(body);
const auth = (userId = 7) => ({
  authorization: `Bearer ${sessionJwt.signSessionToken({ userId })}`,
});
const cron = (secret = CRON) => ({ authorization: `Bearer ${secret}` });

async function favorite(ctx, userId, playerId) {
  return request(ctx.favorites, `/api/favorite-players/${playerId}`, {
    method: 'PUT',
    headers: auth(userId),
  });
}

async function weeklyDispatch(ctx, body) {
  return request(ctx.push, '/api/push/weekly-dispatch', {
    method: 'POST',
    headers: cron(),
    body: body ? json(body) : undefined,
  });
}

/** User 7: three players and a phone; user 8: a VAN-only favorite; user 9: push off. */
async function seedUsers(ctx) {
  for (const id of [MCDAVID, SKINNER, HUGHES, MATTHEWS]) {
    assert.equal((await favorite(ctx, 7, id)).status, 200);
  }
  await favorite(ctx, 8, HUGHES);
  await favorite(ctx, 9, MCDAVID);
  ctx.db.subscribe(7);
  ctx.db.subscribe(8);
  ctx.db.subscribe(9);
  ctx.db.pushOff.add('9');
}

// --- Pure builder ----------------------------------------------------------

test('Eastern week math: previous week across DST, labels, Monday checks, cron window', () => {
  assert.equal(previousWeekStart(NOW), WEEK);
  // Monday 03:00 UTC is still Sunday evening in New York.
  assert.equal(
    previousWeekStart(Date.parse('2026-10-19T03:00:00Z')),
    '2026-10-05',
  );
  // First Monday after DST ends (Nov 1): both cron times map to Oct 26.
  assert.equal(
    previousWeekStart(Date.parse('2026-11-02T13:05:00Z')),
    '2026-10-26',
  );
  assert.equal(
    previousWeekStart(Date.parse('2026-11-02T14:05:00Z')),
    '2026-10-26',
  );
  // First Monday after DST starts (Mar 8, 2026).
  assert.equal(
    previousWeekStart(Date.parse('2026-03-09T13:05:00Z')),
    '2026-03-02',
  );

  // Labels and Monday validation.
  assert.equal(formatWeekLabel(WEEK), 'Oct 12–18');
  assert.equal(formatWeekLabel('2026-09-28'), 'Sep 28–Oct 4');
  assert.equal(formatWeekLabel('2026-12-28'), 'Dec 28–Jan 3');
  assert.equal(isWeekStart(WEEK), true);
  assert.equal(isWeekStart('2026-10-13'), false);
  assert.equal(isWeekStart('2026-02-30'), false);
  assert.equal(isWeekStart('nope'), false);
});

test('schedule summary counts only completed regular-season/playoff games in the week', () => {
  const summary = summarizeWeekSchedule(
    {
      gameWeek: [
        ...NORMAL_WEEK.gameWeek,
        { date: '2026-10-19', games: [scheduleGame(8, 'EDM', 'VAN')] },
        {
          date: '2026-10-15',
          games: [scheduleGame(5, 'SEA', 'VAN', 2, 'FUT')],
        },
        {
          date: '2026-10-15',
          games: [scheduleGame(6, 'SEA', 'LAK', 3, 'FINAL')],
        },
      ],
    },
    WEEK,
  );
  assert.equal(summary.leagueGames, 4);
  assert.equal(summary.gamesByTeam.EDM, 2);
  assert.equal(summary.gamesByTeam.TOR, 1);
  assert.equal(summary.gamesByTeam.MTL, undefined);
  assert.equal(summary.gamesByTeam.VAN, undefined);
  assert.equal(summarizeWeekSchedule(BREAK_WEEK, WEEK).leagueGames, 0);
  assert.equal(summarizeWeekSchedule(null, WEEK).leagueGames, 0);
});

function favoriteOf(playerId) {
  const [first, last, team, position] = PROFILES[playerId];
  return {
    playerId,
    name: `${first} ${last}`,
    teamTriCode: team,
    position,
    headshot: null,
  };
}

test('report lines: skater, goalie, did-not-play, headline', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  const report = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [MCDAVID, SKINNER, HUGHES, MATTHEWS].map(favoriteOf),
    skaterRows: normalizeGameRows([...SKATER_ROWS, SKATER_ROWS[1]], {
      playerIds: [MCDAVID, HUGHES, MATTHEWS],
      weekStart: WEEK,
    }),
    goalieRows: normalizeGameRows(GOALIE_ROWS, {
      playerIds: [SKINNER],
      weekStart: WEEK,
    }),
    schedule,
  });
  assert.equal(report.label, 'Oct 12–18');
  assert.equal(report.weekEnd, '2026-10-18');
  const [mcdavid, skinner, hughes, matthews] = report.players;
  assert.deepEqual(mcdavid.stats, {
    gp: 2,
    goals: 2,
    assists: 4,
    points: 6,
    plusMinus: 1,
    shots: 11,
    toiPerGame: '21:42',
    bestGame: { gameId: 1, text: '1G 3A vs CGY, Oct 14' },
  });
  assert.equal(mcdavid.type, 'skater');
  assert.deepEqual(skinner.stats, {
    gp: 1,
    wins: 1,
    losses: 0,
    otLosses: 0,
    record: '1-0-0',
    savePct: 0.938,
    gaa: 2,
    shutouts: 0,
  });
  assert.equal(skinner.type, 'goalie');
  assert.equal(hughes.played, false);
  assert.equal(hughes.teamGames, 0);
  assert.equal(hughes.stats, null);
  assert.equal(matthews.played, false);
  assert.equal(matthews.teamGames, 1);
  assert.equal(report.headline, 'Connor McDavid: 2G 4A in 2 GP and 1 more');
});

test('traded player, goalie-only and did-not-play headlines, and the per-user skip', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  const traded = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(MCDAVID)],
    skaterRows: [
      { ...SKATER_ROWS[0], teamAbbrev: 'CGY', opponentTeamAbbrev: undefined },
      SKATER_ROWS[1],
    ],
    goalieRows: [],
    schedule,
  });
  assert.deepEqual(traded.players[0].teams, ['CGY', 'EDM']);
  assert.equal(traded.players[0].team, 'EDM');
  // Opponent falls back to the schedule when the stats row lacks it.
  assert.equal(traded.players[0].stats.bestGame.text, '1G 3A vs EDM, Oct 14');

  const goalieOnly = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(SKINNER)],
    skaterRows: [],
    goalieRows: GOALIE_ROWS,
    schedule,
  });
  assert.equal(goalieOnly.headline, 'Stuart Skinner: 1-0-0 in 1 GP');

  const dnp = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(MATTHEWS)],
    skaterRows: [],
    goalieRows: [],
    schedule,
  });
  assert.equal(dnp.headline, 'Your favorite players did not play this week.');

  // No report when neither the favorites nor their teams played.
  assert.equal(
    buildWeeklyReport({
      weekStart: WEEK,
      favorites: [favoriteOf(HUGHES)],
      skaterRows: [],
      goalieRows: [],
      schedule: summarizeWeekSchedule(NORMAL_WEEK, WEEK),
    }),
    null,
  );
});

// --- Favorite teams (API-WPR-02) --------------------------------------------

const CLUB_SEASONS_BY_TEAM = new Map(Object.entries(CLUB_SEASONS));

/** A favorite team as the dispatch passes it to the builder. */
function favoriteTeamOf(triCode, tier = 'fan', label = null) {
  return { triCode, tier, label };
}

/** A favorite_teams row in the fake database. */
function favoriteTeamRow(userId, triCode, tier = 'fan', label = null, league = 'nhl') {
  return { user_id: userId, team_tri_code: triCode, league, tier, label };
}

const EDM_WEEK_GAMES = [
  {
    gameId: 1,
    date: '2026-10-14',
    opponent: 'CGY',
    isHome: true,
    teamScore: 4,
    opponentScore: 3,
    outcome: 'W',
  },
  {
    gameId: 2,
    date: '2026-10-18',
    opponent: 'BOS',
    isHome: false,
    teamScore: 2,
    opponentScore: 3,
    outcome: 'OTL',
  },
];

const EDM_FORM_GAMES = [
  {
    date: '2026-10-14',
    gameState: 'OFF',
    homeTeam: 'EDM',
    awayTeam: 'CGY',
    homeScore: 4,
    awayScore: 3,
    periodType: 'OT',
  },
  {
    date: '2026-10-18',
    gameState: 'OFF',
    homeTeam: 'BOS',
    awayTeam: 'EDM',
    homeScore: 3,
    awayScore: 2,
    periodType: 'SO',
  },
];

test('API-WPR-02 Verify: team week records, OT/SO losses, a team with no games, fan-tier order', () => {
  const report = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [],
    favoriteTeams: [
      favoriteTeamOf('VAN'),
      favoriteTeamOf('TOR', 'curious'),
      favoriteTeamOf('EDM', 'diehard', 'Since 84'),
    ],
    skaterRows: [],
    goalieRows: [],
    schedule: summarizeWeekSchedule(NORMAL_WEEK, WEEK),
    clubSeasonsByTeam: CLUB_SEASONS_BY_TEAM,
  });
  assert.deepEqual(
    report.teams.map((team) => team.triCode),
    ['EDM', 'VAN', 'TOR'],
  );
  const [edm, van, tor] = report.teams;
  // An OT win is a W and a shootout loss an OTL; games outside the week and
  // not yet played are left out.
  assert.deepEqual(edm, {
    triCode: 'EDM',
    name: 'Edmonton Oilers',
    logo: 'https://assets.example/EDM.svg',
    tier: 'diehard',
    label: 'Since 84',
    weekGames: EDM_WEEK_GAMES,
    formGames: EDM_FORM_GAMES,
  });
  // No games this week: the team is still listed, with nothing to show.
  assert.deepEqual(van.weekGames, []);
  assert.deepEqual(van.formGames, []);
  assert.equal(van.tier, 'fan');
  // A regulation loss is an L; the preseason game does not count.
  assert.deepEqual(
    tor.weekGames.map((weekGame) => [weekGame.gameId, weekGame.outcome]),
    [[4, 'L']],
  );
  assert.equal(tor.formGames.length, 1);
  assert.equal(report.headline, 'Teams: EDM 1-0-1, TOR 0-1-0.');

  // An overtime playoff loss is an OTL in the week but not a Team Form game.
  const playoffWeek = summarizeWeekSchedule(
    {
      gameWeek: [
        { date: '2026-10-15', games: [scheduleGame(6, 'SEA', 'LAK', 3)] },
      ],
    },
    WEEK,
  );
  const playoffReport = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [],
    favoriteTeams: [favoriteTeamOf('LAK')],
    skaterRows: [],
    goalieRows: [],
    schedule: playoffWeek,
    clubSeasonsByTeam: new Map([
      [
        'LAK',
        {
          team: { name: 'Los Angeles Kings', logo: null },
          games: [
            clubGame(6, '2026-10-15', 'SEA', 'LAK', 3, 2, {
              periodType: 'OT',
              isPlayoff: true,
            }),
          ],
        },
      ],
    ]),
  });
  assert.equal(playoffReport.teams[0].weekGames[0].outcome, 'OTL');
  assert.deepEqual(playoffReport.teams[0].formGames, []);
});

test('API-WPR-02 Verify: the team line in the headline', () => {
  const edm = { triCode: 'EDM', weekGames: EDM_WEEK_GAMES };
  const dal = {
    triCode: 'DAL',
    weekGames: [
      { outcome: 'W' },
      { outcome: 'L' },
      { outcome: 'L' },
    ],
  };
  const idle = { triCode: 'VAN', weekGames: [] };
  const mcdavid = {
    name: 'Connor McDavid',
    type: 'skater',
    played: true,
    stats: { goals: 2, assists: 4, points: 6, gp: 3 },
  };
  const benched = { name: 'Auston Matthews', type: 'skater', played: false };

  assert.equal(
    buildHeadline([mcdavid, { ...mcdavid, name: 'Zach Hyman' }], [edm, dal]),
    'Connor McDavid: 2G 4A in 3 GP and 1 more. Teams: EDM 1-0-1, DAL 1-2-0.',
  );
  // Teams without games are left out of the line.
  assert.equal(
    buildHeadline([mcdavid], [idle, edm]),
    'Connor McDavid: 2G 4A in 3 GP. Teams: EDM 1-0-1.',
  );
  // No line when no team played: the headline reads as before.
  assert.equal(
    buildHeadline([mcdavid], [idle]),
    'Connor McDavid: 2G 4A in 3 GP',
  );
  assert.equal(buildHeadline([mcdavid]), 'Connor McDavid: 2G 4A in 3 GP');
  // Only teams played.
  assert.equal(
    buildHeadline([benched], [edm, dal]),
    'Your favorite players did not play this week. Teams: EDM 1-0-1, DAL 1-2-0.',
  );
  // No favorite players at all.
  assert.equal(
    buildHeadline([], [edm, dal]),
    'Teams: EDM 1-0-1, DAL 1-2-0.',
  );
});

test('API-WPR-02 Verify: a report with no favorite teams, and team-only reports', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  const noTeams = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(MCDAVID)],
    skaterRows: SKATER_ROWS,
    goalieRows: [],
    schedule,
  });
  assert.deepEqual(noTeams.teams, []);
  assert.equal(noTeams.headline, 'Connor McDavid: 2G 4A in 2 GP');

  // A favorite team that played keeps a report alive when no player did.
  const teamOnly = buildWeeklyReport({
    weekStart: WEEK,
    favorites: [favoriteOf(HUGHES)],
    favoriteTeams: [favoriteTeamOf('TOR')],
    skaterRows: [],
    goalieRows: [],
    schedule,
    clubSeasonsByTeam: CLUB_SEASONS_BY_TEAM,
  });
  assert.equal(
    teamOnly.headline,
    'Your favorite players did not play this week. Teams: TOR 0-1-0.',
  );
  // Nothing played at all: no report.
  assert.equal(
    buildWeeklyReport({
      weekStart: WEEK,
      favorites: [favoriteOf(HUGHES)],
      favoriteTeams: [favoriteTeamOf('VAN')],
      skaterRows: [],
      goalieRows: [],
      schedule,
      clubSeasonsByTeam: CLUB_SEASONS_BY_TEAM,
    }),
    null,
  );
});

test('API-WPR-02: a club schedule missing one of the week finals is not current', () => {
  const schedule = summarizeWeekSchedule(NORMAL_WEEK, WEEK);
  assert.equal(isClubScheduleCurrent('EDM', CLUB_SEASONS.EDM.games, schedule), true);
  assert.equal(isClubScheduleCurrent('VAN', [], schedule), true);
  const beforeSunday = CLUB_SEASONS.EDM.games.map((game) =>
    game.gameId === 2
      ? { ...game, gameState: 'FUT', homeScore: null, awayScore: null }
      : game,
  );
  assert.equal(isClubScheduleCurrent('EDM', beforeSunday, schedule), false);
  assert.equal(isClubScheduleCurrent('EDM', [], schedule), false);
});

// --- Favorites -------------------------------------------------------------

test('favorite players: add, list, remove, validation, auth, and the cap of 10', async () => {
  const ctx = build();
  assert.equal(
    (await request(ctx.favorites, '/api/favorite-players')).status,
    401,
  );
  const added = await favorite(ctx, 7, MCDAVID);
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.favorites, [
    {
      league: 'nhl',
      playerId: MCDAVID,
      name: 'Connor McDavid',
      teamTriCode: 'EDM',
      position: 'C',
      headshot: `https://assets.example/${MCDAVID}.png`,
      since: added.body.favorites[0].since,
      pushMuted: false,
      tier: 'fan',
      label: null,
    },
  ]);
  assert.equal((await favorite(ctx, 7, 'abc')).status, 400);
  assert.equal((await favorite(ctx, 7, 1234)).status, 404);
  const favoritesResponse = await request(ctx.favorites, '/api/favorite-players', {
    headers: auth(7),
  });
  assert.equal(favoritesResponse.body.favorites.length, 1);
  const removed = await request(
    ctx.favorites,
    `/api/favorite-players/${MCDAVID}`,
    { method: 'DELETE', headers: auth(7) },
  );
  assert.deepEqual(removed.body, { favorites: [] });

  // Capped at 10; re-favoriting an existing player does not count.
  for (let id = 1; id <= 10; id += 1) {
    assert.equal((await favorite(ctx, 7, 9000000 + id)).status, 200);
  }
  const eleventh = await favorite(ctx, 7, 9000011);
  assert.equal(eleventh.status, 409);
  assert.match(eleventh.body.error, /at most 10/);
  assert.equal((await favorite(ctx, 7, 9000001)).status, 200);
  // Landing lookups are cached.
  await favorite(ctx, 7, 9000001);
  assert.equal(
    ctx.calls.nhl.filter((url) => url === '/player/9000001/landing').length,
    1,
  );
});

test('favorite players: PATCH edits tier/label, validates, 404s, and re-PUT keeps them', async () => {
  const ctx = build();
  const patch = (userId, playerId, body) =>
    request(ctx.favorites, `/api/favorite-players/${playerId}`, {
      method: 'PATCH',
      headers: {
        ...auth(userId),
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(json(body))),
      },
      body: json(body),
    });
  const get = async () =>
    (
      await request(ctx.favorites, '/api/favorite-players', {
        headers: auth(7),
      })
    ).body;

  assert.equal(
    (
      await request(ctx.favorites, `/api/favorite-players/${MCDAVID}`, {
        method: 'PATCH',
      })
    ).status,
    401,
  );
  await favorite(ctx, 7, MCDAVID);

  const tierOnly = await patch(7, MCDAVID, { tier: 'diehard' });
  assert.equal(tierOnly.status, 200);
  assert.deepEqual(Object.keys(tierOnly.body), ['favorites']);
  assert.deepEqual(
    [tierOnly.body.favorites[0].tier, tierOnly.body.favorites[0].label],
    ['diehard', null],
  );
  assert.deepEqual(await get(), tierOnly.body);

  const afterLabelOnlyPatch = await patch(7, MCDAVID, { label: '  Captain  ' });
  assert.deepEqual(
    [afterLabelOnlyPatch.body.favorites[0].tier, afterLabelOnlyPatch.body.favorites[0].label],
    ['diehard', 'Captain'],
  );
  const afterEmojiPatch = await patch(7, MCDAVID, { label: '\u{1F525}\u2764\uFE0F' });
  assert.equal(afterEmojiPatch.body.favorites[0].label, '\u{1F525}\u2764\uFE0F');
  const max = '\u2764\uFE0F'.repeat(24);
  assert.equal((await patch(7, MCDAVID, { label: max })).status, 200);

  // Re-PUT refreshes profile fields but keeps tier and label.
  const afterRefavorite = await favorite(ctx, 7, MCDAVID);
  assert.deepEqual(
    [afterRefavorite.body.favorites[0].tier, afterRefavorite.body.favorites[0].label],
    ['diehard', max],
  );

  for (const clearingBody of [{ label: null }, { label: '' }, { label: '   ' }]) {
    await patch(7, MCDAVID, { label: 'x' });
    const afterClear = await patch(7, MCDAVID, clearingBody);
    assert.equal(afterClear.body.favorites[0].label, null);
    assert.equal(afterClear.body.favorites[0].tier, 'diehard');
  }

  assert.equal((await patch(7, MCDAVID, { tier: 'ultra' })).status, 400);
  assert.equal((await patch(7, MCDAVID, { label: 'a'.repeat(25) })).status, 400);
  assert.equal(
    (await patch(7, MCDAVID, { label: '\u2764\uFE0F'.repeat(25) })).status,
    400,
  );
  assert.equal((await patch(7, MCDAVID, {})).status, 400);
  assert.equal((await patch(7, 'abc', { tier: 'fan' })).status, 400);
  assert.equal((await patch(7, SKINNER, { tier: 'fan' })).status, 404);
  assert.equal((await patch(8, MCDAVID, { tier: 'fan' })).status, 404);
});

// --- Dispatch --------------------------------------------------------------

test('weekly dispatch requires the cron secret and config, and a completed Monday week', async () => {
  const ctx = build();
  const bad = await request(ctx.push, '/api/push/weekly-dispatch', {
    method: 'POST',
    headers: cron('wrong'),
  });
  assert.equal(bad.status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await weeklyDispatch(ctx)).status, 503);

  // A weekStart override must be a completed Monday week.
  process.env.CRON_SECRET = CRON;
  assert.equal(
    (await weeklyDispatch(ctx, { weekStart: '2026-10-13' })).status,
    400,
  );
  // The current week (Oct 19–25) is not finished yet.
  assert.equal(
    (await weeklyDispatch(ctx, { weekStart: '2026-10-19' })).status,
    400,
  );
  assert.equal((await weeklyDispatch(ctx, { weekStart: WEEK })).status, 200);
});

test('normal week: one batched NHL load, reports for active users, one push each, rerun-safe', async () => {
  const ctx = build();
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    weekStart: WEEK,
    created: 2,
    users: 1,
    sent: 1,
    removed: 0,
  });
  // User 8 (VAN only, no VAN games) gets nothing; user 9 has push off.
  assert.deepEqual([...ctx.db.reports.keys()].sort(), [
    `7:${WEEK}`,
    `9:${WEEK}`,
  ]);
  assert.equal(ctx.sent.length, 1);
  const { payload } = ctx.sent[0];
  assert.equal(payload.kind, 'weekly-report');
  assert.equal(payload.title, 'Weekly Player Report · Oct 12–18');
  assert.equal(payload.body, 'Connor McDavid: 2G 4A in 2 GP and 1 more');
  assert.equal(payload.weekStart, WEEK);
  assert.equal(payload.tag, `wpr-${WEEK}`);
  assert.deepEqual(sessionJwt.verifyWeeklyReadToken(payload.readToken), {
    userId: '7',
    weekStart: WEEK,
  });
  // One schedule call, one skater query, one goalie query for all users.
  assert.deepEqual(
    ctx.calls.nhl.filter((url) => url.startsWith('/schedule/')),
    [`/schedule/${WEEK}`],
  );
  assert.equal(ctx.calls.skaters.length, 1);
  assert.equal(ctx.calls.goalies.length, 1);
  const skaterQuery = decodeURIComponent(ctx.calls.skaters[0]);
  assert.match(skaterQuery, /isGame=true/);
  assert.match(skaterQuery, /gameDate>="2026-10-12"/);
  assert.match(skaterQuery, /gameDate<="2026-10-18 23:59:59"/);
  assert.match(skaterQuery, /gameTypeId in \(2,3\)/);
  assert.match(
    skaterQuery,
    new RegExp(`playerId in \\(${MCDAVID},${MATTHEWS},${HUGHES}\\)`),
  );
  assert.match(
    decodeURIComponent(ctx.calls.goalies[0]),
    new RegExp(`playerId in \\(${SKINNER}\\)`),
  );

  // A second run (or the DST twin) creates and sends nothing new, reusing
  // the week-keyed NHL payloads.
  const again = await weeklyDispatch(ctx);
  assert.deepEqual(again.body, {
    weekStart: WEEK,
    created: 0,
    users: 1,
    sent: 0,
    removed: 0,
  });
  assert.equal(ctx.sent.length, 1);
  // Raw NHL payloads came from the week-keyed cache.
  assert.equal(ctx.calls.skaters.length, 1);
});

test('break weeks and NHL failures create and send nothing', async () => {
  const ctx = build({ schedule: BREAK_WEEK });
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.deepEqual(response.body, {
    weekStart: WEEK,
    skipped: 'league-break',
    created: 0,
    users: 0,
    sent: 0,
    removed: 0,
  });
  assert.equal(ctx.db.reports.size, 0);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.calls.skaters.length + ctx.calls.goalies.length, 0);

  // An NHL stats failure is a 502 with nothing written; a retry succeeds.
  const failing = build();
  await seedUsers(failing);
  failing.fail.stats = true;
  const failed = await weeklyDispatch(failing);
  assert.equal(failed.status, 502);
  assert.equal(failing.db.reports.size, 0);
  assert.equal(failing.db.ledger.size, 0);
  assert.equal(failing.sent.length, 0);
  failing.fail.stats = false;
  const retried = await weeklyDispatch(failing);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.sent, 1);
});

test('gone subscriptions are removed; read reports are not pushed', async () => {
  const ctx = build({
    sendImpl: async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    },
  });
  await seedUsers(ctx);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.body.removed, 1);
  assert.equal(response.body.sent, 0);
  assert.equal(
    ctx.db.subs.some((subscription) => subscription.user_id === 7),
    false,
  );

  const ctx2 = build();
  await seedUsers(ctx2);
  await ctx2.db.withTransaction((client) =>
    client.query('INSERT INTO weekly_player_reports', [
      7,
      WEEK,
      json({ label: 'x', headline: 'y', players: [] }),
    ]),
  );
  await request(ctx2.reports, `/api/weekly-player-reports/${WEEK}/read`, {
    method: 'POST',
    headers: auth(7),
  });
  const second = await weeklyDispatch(ctx2);
  assert.equal(second.body.sent, 0);
});

// --- Inbox, read tokens, toggle -------------------------------------------

test('reports list, single report, read receipts, and the push read token', async () => {
  const ctx = build();
  await seedUsers(ctx);
  await weeklyDispatch(ctx);

  const reportsResponse = await request(ctx.reports, '/api/weekly-player-reports', {
    headers: auth(7),
  });
  assert.equal(reportsResponse.status, 200);
  assert.equal(reportsResponse.body.unreadCount, 1);
  assert.equal(reportsResponse.body.reports[0].weekStart, WEEK);
  assert.equal(reportsResponse.body.reports[0].label, 'Oct 12–18');
  assert.equal(reportsResponse.body.reports[0].players.length, 4);
  assert.equal(reportsResponse.body.reports[0].read, false);

  const single = await request(
    ctx.reports,
    `/api/weekly-player-reports/${WEEK}`,
    {
      headers: auth(7),
    },
  );
  assert.equal(single.body.players[0].name, 'Connor McDavid');
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports/2026-10-05', {
        headers: auth(7),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports/2026-10-06', {
        headers: auth(7),
      })
    ).status,
    400,
  );

  const readToken = ctx.sent[0].payload.readToken;
  // A weekly read token is never a session token.
  assert.equal(
    (
      await request(ctx.reports, '/api/weekly-player-reports', {
        headers: { authorization: `Bearer ${readToken}` },
      })
    ).status,
    401,
  );
  assert.throws(() => sessionJwt.verifyReadToken(readToken));
  const read = await request(ctx.push, '/api/push/read', {
    method: 'POST',
    body: json({ token: readToken }),
  });
  assert.equal(read.status, 204);
  const after = await request(ctx.reports, '/api/weekly-player-reports', {
    headers: auth(7),
  });
  assert.equal(after.body.unreadCount, 0);
  // A session token is never a read token.
  const bad = await request(ctx.push, '/api/push/read', {
    method: 'POST',
    body: json({ token: auth(7).authorization.slice(7) }),
  });
  assert.equal(bad.status, 401);
});

test('weekly report push switch: get, set, validate', async () => {
  const ctx = build();
  const get = () =>
    request(ctx.push, '/api/push/weekly-report', { headers: auth(7) });
  assert.deepEqual((await get()).body, { enabled: true });
  const off = await request(ctx.push, '/api/push/weekly-report', {
    method: 'PUT',
    headers: auth(7),
    body: json({ enabled: false }),
  });
  assert.deepEqual(off.body, { enabled: false });
  assert.deepEqual((await get()).body, { enabled: false });
  const bad = await request(ctx.push, '/api/push/weekly-report', {
    method: 'PUT',
    headers: auth(7),
    body: json({ enabled: 'no' }),
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await request(ctx.push, '/api/push/weekly-report')).status,
    401,
  );
});

test('favorite players: push-mute route validates, 404s, and favorites expose pushMuted', async () => {
  const ctx = build();
  await favorite(ctx, 7, MCDAVID);
  const put = (playerId, body, headers = auth(7)) =>
    request(ctx.favorites, `/api/favorite-players/${playerId}/push-mute`, {
      method: 'PUT',
      headers,
      body,
    });
  assert.equal((await put(MCDAVID, json({ muted: true }), {})).status, 401);
  assert.equal((await put(MCDAVID, json({ muted: 'yes' }))).status, 400);
  assert.equal((await put('abc', json({ muted: true }))).status, 400);
  assert.equal((await put(HUGHES, json({ muted: true }))).status, 404);

  const muted = await put(MCDAVID, json({ muted: true }));
  assert.equal(muted.status, 200);
  assert.equal(muted.body.favorites[0].pushMuted, true);
  // Re-favoriting keeps the toggle.
  const again = await favorite(ctx, 7, MCDAVID);
  assert.equal(again.body.favorites[0].pushMuted, true);
});

test('weekly push describes only unmuted players; a week with none of them playing is claimed, not sent', async () => {
  const ctx = build();
  await seedUsers(ctx);
  const mute = (playerId) =>
    request(ctx.favorites, `/api/favorite-players/${playerId}/push-mute`, {
      method: 'PUT',
      headers: auth(7),
      body: json({ muted: true }),
    });
  assert.equal((await mute(MCDAVID)).body.favorites[0].pushMuted, true);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.body.sent, 1);
  assert.equal(ctx.sent[0].payload.body, 'Stuart Skinner: 1-0-0 in 1 GP');
  // The stored report still lists every favorite.
  const stored = ctx.db.reports.get(`7:${WEEK}`).payload;
  const storedPayload = typeof stored === 'string' ? JSON.parse(stored) : stored;
  assert.equal(
    storedPayload.headline,
    'Connor McDavid: 2G 4A in 2 GP and 1 more',
  );

  const allMuted = build();
  await seedUsers(allMuted);
  for (const playerId of [MCDAVID, SKINNER, HUGHES, MATTHEWS]) {
    await request(allMuted.favorites, `/api/favorite-players/${playerId}/push-mute`, {
      method: 'PUT',
      headers: auth(7),
      body: json({ muted: true }),
    });
  }
  const silent = await weeklyDispatch(allMuted);
  assert.equal(silent.body.sent, 0);
  assert.equal(allMuted.sent.length, 0);
  assert.ok(allMuted.db.ledger.has(`7:${WEEK}`));
});

test('the account-wide switch off skips the weekly push', async () => {
  const ctx = build();
  await seedUsers(ctx);
  ctx.db.accountPushOff.add('7');
  const response = await weeklyDispatch(ctx);
  assert.equal(response.body.created, 2);
  assert.equal(response.body.users, 0);
  assert.equal(ctx.sent.length, 0);
});

/** Users 7 and 10 favorite teams: 7 adds EDM (diehard) and VAN to its players; 10 follows only TOR. */
async function seedFavoriteTeams(ctx) {
  ctx.db.favoriteTeams.push(
    favoriteTeamRow(7, 'VAN'),
    favoriteTeamRow(7, 'EDM', 'diehard', 'Since 84'),
    favoriteTeamRow(8, 'VAN'),
    favoriteTeamRow(10, 'TOR', 'curious'),
  );
  ctx.db.subscribe(10);
}

test('API-WPR-02 Verify: dispatch freezes teams[], one club schedule per distinct team, team-only users', async () => {
  const ctx = build();
  await seedUsers(ctx);
  await seedFavoriteTeams(ctx);
  const response = await weeklyDispatch(ctx);
  assert.equal(response.status, 200);
  assert.equal(response.body.created, 3);
  assert.equal(response.body.sent, 2);
  // User 8 (VAN player and team, neither played) still gets nothing.
  assert.deepEqual([...ctx.db.reports.keys()].sort(), [
    `10:${WEEK}`,
    `7:${WEEK}`,
    `9:${WEEK}`,
  ]);

  // One cached club season schedule per distinct favorite team, for the
  // season the week belongs to.
  assert.deepEqual(
    ctx.calls.clubSeasons
      .map(({ triCode, seasonId, fresh }) => `${triCode} ${seasonId} ${fresh}`)
      .sort(),
    ['EDM 20262027 false', 'TOR 20262027 false', 'VAN 20262027 false'],
  );

  // The frozen teams[] the WPR-02 page reads, in fan-tier order.
  const report = ctx.db.reports.get(`7:${WEEK}`).payload;
  assert.deepEqual(report.teams, [
    {
      triCode: 'EDM',
      name: 'Edmonton Oilers',
      logo: 'https://assets.example/EDM.svg',
      tier: 'diehard',
      label: 'Since 84',
      weekGames: EDM_WEEK_GAMES,
      formGames: EDM_FORM_GAMES,
    },
    {
      triCode: 'VAN',
      name: 'Vancouver Canucks',
      logo: 'https://assets.example/VAN.svg',
      tier: 'fan',
      label: null,
      weekGames: [],
      formGames: [],
    },
  ]);
  assert.equal(
    report.headline,
    'Connor McDavid: 2G 4A in 2 GP and 1 more. Teams: EDM 1-0-1.',
  );
  // User 9 has no favorite teams: an empty team list.
  assert.deepEqual(ctx.db.reports.get(`9:${WEEK}`).payload.teams, []);

  const bodiesByEndpoint = Object.fromEntries(
    ctx.sent.map(({ subscription, payload }) => [
      subscription.endpoint,
      payload.body,
    ]),
  );
  assert.deepEqual(bodiesByEndpoint, {
    'https://push.example.com/7':
      'Connor McDavid: 2G 4A in 2 GP and 1 more. Teams: EDM 1-0-1.',
    'https://push.example.com/10': 'Teams: TOR 0-1-0.',
  });

  // A rerun keeps the frozen reports and refetches nothing.
  const again = await weeklyDispatch(ctx);
  assert.equal(again.body.created, 0);
  assert.equal(again.body.sent, 0);
  assert.deepEqual(ctx.db.reports.get(`7:${WEEK}`).payload, report);
});

test('API-WPR-02: a stale club schedule is refetched once; a team schedule failure writes nothing', async () => {
  const stale = build({ staleTeams: ['EDM'] });
  await seedUsers(stale);
  await seedFavoriteTeams(stale);
  const response = await weeklyDispatch(stale);
  assert.equal(response.status, 200);
  assert.deepEqual(
    stale.calls.clubSeasons
      .filter(({ triCode }) => triCode === 'EDM')
      .map(({ fresh }) => fresh),
    [false, true],
  );
  assert.deepEqual(
    stale.db.reports.get(`7:${WEEK}`).payload.teams[0].weekGames,
    EDM_WEEK_GAMES,
  );

  const failing = build();
  await seedUsers(failing);
  await seedFavoriteTeams(failing);
  failing.fail.teams = true;
  const failed = await weeklyDispatch(failing);
  assert.equal(failed.status, 502);
  assert.equal(failing.db.reports.size, 0);
  assert.equal(failing.sent.length, 0);
  failing.fail.teams = false;
  assert.equal((await weeklyDispatch(failing)).body.created, 3);
});

test('API-WPR-02: with every player muted, the weekly push carries the team line only', async () => {
  const ctx = build();
  await seedUsers(ctx);
  await seedFavoriteTeams(ctx);
  for (const playerId of [MCDAVID, SKINNER, HUGHES, MATTHEWS]) {
    await request(ctx.favorites, `/api/favorite-players/${playerId}/push-mute`, {
      method: 'PUT',
      headers: auth(7),
      body: json({ muted: true }),
    });
  }
  await weeklyDispatch(ctx);
  const userSevenPush = ctx.sent.find(
    ({ subscription }) => subscription.endpoint === 'https://push.example.com/7',
  );
  assert.equal(userSevenPush.payload.body, 'Teams: EDM 1-0-1.');
});

// --- Both leagues (API-AHL-03) ----------------------------------------------

test('API-AHL-03 Verify: favorite players share the cap of 10 across leagues and key on league', async () => {
  const ctx = build();
  const favoriteAhl = (playerId) =>
    request(ctx.favorites, `/api/favorite-players/${playerId}?league=ahl`, {
      method: 'PUT',
      headers: auth(7),
    });

  assert.equal((await favoriteAhl(1234)).status, 404);
  assert.equal(
    (await request(ctx.favorites, '/api/favorite-players/777?league=xhl', { method: 'PUT', headers: auth(7) })).status,
    400,
  );
  for (let id = 1; id <= 7; id += 1) {
    assert.equal((await favorite(ctx, 7, 9000000 + id)).status, 200);
  }
  // The same id is a separate favorite in each league.
  assert.equal((await favorite(ctx, 7, MCDAVID)).status, 200);
  assert.equal((await favoriteAhl(MCDAVID)).status, 200);
  const tenth = await favoriteAhl(777);
  assert.equal(tenth.status, 200);
  assert.deepEqual(
    tenth.body.favorites.filter((favorite) => favorite.playerId === MCDAVID).map((favorite) => favorite.league),
    ['nhl', 'ahl'],
  );

  assert.equal((await favorite(ctx, 7, 9000011)).status, 409);
  assert.equal((await favoriteAhl(MCDAVID)).status, 200);
  await request(ctx.favorites, '/api/favorite-players/777?league=ahl', {
    method: 'DELETE',
    headers: auth(7),
  });
  assert.equal((await favorite(ctx, 7, 9000011)).status, 200);
  assert.equal((await favoriteAhl(777)).status, 409);

  const removed = await request(ctx.favorites, `/api/favorite-players/${MCDAVID}?league=ahl`, {
    method: 'DELETE',
    headers: auth(7),
  });
  assert.deepEqual(
    removed.body.favorites.filter((favorite) => favorite.playerId === MCDAVID).map((favorite) => favorite.league),
    ['nhl'],
  );
});

test('API-AHL-03 Verify: the weekly report and its push ignore AHL favorites', async () => {
  const ctx = build();
  await seedUsers(ctx);
  // User 10 favorites only AHL players, including one that shares an NHL id.
  for (const playerId of [777, MCDAVID]) {
    const added = await request(ctx.favorites, `/api/favorite-players/${playerId}?league=ahl`, {
      method: 'PUT',
      headers: auth(10),
    });
    assert.equal(added.status, 200);
  }
  ctx.db.subscribe(10);

  const response = await weeklyDispatch(ctx);
  assert.equal(response.status, 200);
  assert.deepEqual([...ctx.db.reports.keys()].sort(), [`7:${WEEK}`, `9:${WEEK}`]);
  assert.doesNotMatch(decodeURIComponent(ctx.calls.skaters[0]), /777/);
  assert.equal(ctx.sent.length, 1);
});
