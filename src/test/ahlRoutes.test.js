const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { request } = require('./testApp.js');
const { parseStatviewBody } = require('#platform/ahlApiClient.js');
const { createAhlService } = require('#slices/ahl/ahlService.js');
const { createAhlReadService } = require('#slices/ahl/ahlReadService.js');
const {
  mapAhlStatLeaders,
} = require('#slices/ahl/mappers/ahlContractMapper.js');
const { createStandingsRouter } = require('#presentation/routes/standings.js');
const { createScheduleRouter } = require('#presentation/routes/schedule.js');
const { createTeamRouter } = require('#presentation/routes/team.js');
const { createPlayerRouter } = require('#presentation/routes/player.js');

// Real HockeyTech payloads recorded 2026-10-29, trimmed and with the key removed.
const FIXTURE_DIR = path.join(__dirname, 'fixtures/ahl');
const readFixtureText = (fileName) =>
  fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8');
const readSiteKit = (fileName) => JSON.parse(readFixtureText(fileName)).SiteKit;

// The Toronto Marlies share the Maple Leafs' tri-code.
const MARLIES = {
  id: '335',
  name: 'Toronto Marlies',
  city: 'Toronto',
  code: 'TOR',
  nickname: 'Marlies',
  team_logo_url: 'https://assets.leaguestat.com/ahl/logos/335.png',
};

/** Feed stub serving the fixtures; records each call's view and params. */
function makeFeedStub() {
  const calls = [];
  const fixtureByView = {
    seasons: 'seasons.json',
    schedule: 'schedule.json',
    roster: 'roster.json',
    statviewtype: 'standings.json',
  };
  return {
    calls,
    isAhlFeedConfigured: () => true,
    fetchModulekit: async (view, params) => {
      calls.push({ view, params });
      if (view === 'teamsbyseason') {
        const teamsPayload = readSiteKit('teamsbyseason.json');
        return {
          ...teamsPayload,
          Teamsbyseason: [...teamsPayload.Teamsbyseason, MARLIES],
        };
      }
      return readSiteKit(fixtureByView[view]);
    },
    fetchStatview: async (view, params) => {
      calls.push({ view, params });
      return parseStatviewBody(readFixtureText(`${params.position}.jsonp`))[0];
    },
    fetchGameSummary: async (gameId) => {
      calls.push({ view: 'gameSummary', params: { gameId } });
      return JSON.parse(readFixtureText('gamesummary.json'));
    },
  };
}

/** AHL read service over the real AHL service, with the feed stubbed and nothing stored. */
function makeAhlReadService() {
  const ahlApi = makeFeedStub();
  const ahlService = createAhlService({
    ahlApi,
    cache: {
      CACHE_TYPES: {
        SCHEDULE: 'schedule',
        TEAM: 'team',
        ROSTER: 'roster',
        PLAYER: 'player',
        STANDINGS: 'standings',
        STAT_LEADERS: 'stat-leaders',
      },
      getOrFetchCached: async (type, key, fetcher) => fetcher(),
      readCache: async () => null,
      writeCache: async () => {},
    },
    seasons: { getCurrentSeasonId: () => '20262027' },
    runServiceTask: () => {},
    withTransaction: (callback) =>
      callback({ query: async () => ({ rows: [] }) }),
  });
  return { ahlApi, ahlReadService: createAhlReadService({ ahlService }) };
}

/** NHL service stub: every method answers `{ nhl: <method name> }`. */
function makeNhlStub() {
  return new Proxy(
    {},
    { get: (target, method) => async () => ({ nhl: method }) },
  );
}

/** The four league-capable routers on one app, NHL services stubbed. */
function makeApp() {
  const { ahlApi, ahlReadService } = makeAhlReadService();
  const nhl = makeNhlStub();
  const services = {
    ahlReadService,
    standingsService: nhl,
    scheduleService: nhl,
    teamService: nhl,
    rosterService: nhl,
    lineService: nhl,
    playerStatsService: nhl,
    statLeaderService: nhl,
  };
  const app = express();
  app.use('/standings', createStandingsRouter(services));
  app.use('/schedule', createScheduleRouter(services));
  app.use('/team', createTeamRouter(services));
  app.use('/player', createPlayerRouter(services));
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message });
  });
  return { app, ahlApi };
}

test('NHL routes answer as before without league and with league=nhl', async () => {
  const { app, ahlApi } = makeApp();
  const routes = [
    ['/standings', 'getStandings'],
    ['/schedule', 'getSeasonSchedule'],
    ['/schedule/2025020001', 'getGameBoxscore'],
    ['/schedule/landing/2025020001', 'getGameLanding'],
    ['/team', 'getTeamSummary'],
    ['/team/roster/TOR', 'getRoster'],
    ['/team/schedule/TOR', 'getTeamSchedule'],
    ['/team/lines/TOR', 'getLines'],
    ['/player/skater/summary', 'getSkaterSummary'],
    ['/player/skater/corsi', 'getSkaterCorsi'],
    ['/player/goalie/statLeaders/wins', 'getGoalieLeaders'],
    ['/player/stats/version', 'getStatsVersion'],
  ];
  for (const [route, method] of routes) {
    for (const query of ['', '?league=nhl']) {
      const response = await request(app, `${route}${query}`);
      assert.equal(response.status, 200, `${route}${query}`);
      assert.deepEqual(response.body, { nhl: method });
    }
  }
  assert.equal(ahlApi.calls.length, 0);
});

test('an unknown league is a 400 and NHL-only routes are a 404 for league=ahl', async () => {
  const { app } = makeApp();
  assert.equal((await request(app, '/standings?league=xhl')).status, 400);
  assert.equal((await request(app, '/team?league=AHL')).status, 400);
  for (const route of [
    '/team/lines/TOR',
    '/schedule/landing/1029073',
    '/schedule/playbyplay/1029073',
    '/player/skater/corsi',
    '/player/skater/faceoffs',
  ]) {
    const response = await request(app, `${route}?league=ahl`);
    assert.equal(response.status, 404, route);
  }
});

test('standings for league=ahl use the NHL row shape with AHL-only gaps as null', async () => {
  const { app } = makeApp();
  const { status, body } = await request(app, '/standings?league=ahl');
  assert.equal(status, 200);
  assert.equal(body.league, 'ahl');
  assert.deepEqual(body.standings[0], {
    teamId: 'LAV',
    teamLogo: null,
    name: 'Rocket',
    conferenceName: 'Eastern Conference',
    divisionName: 'North Division',
    wins: 7,
    losses: 2,
    otLosses: 0,
    points: 14,
    pointPctg: 0.77778,
    leagueSequence: 2,
    conferenceSequence: 1,
    divisionSequence: 1,
    wildcardSequence: null,
    clinchingIndicator: '',
    leagueL10Sequence: null,
  });
  // Hershey is first in its division (Atlantic), not second in the conference list.
  assert.equal(body.standings[1].divisionSequence, 1);
});

test('?season= resolves past AHL seasons; a season the AHL lacks has empty standings', async () => {
  const { app, ahlApi } = makeApp();
  await request(app, '/standings?league=ahl&season=20252026');
  assert.ok(
    ahlApi.calls.some(
      (call) => call.view === 'statviewtype' && call.params.season_id === 90,
    ),
  );
  const { body } = await request(app, '/standings?league=ahl&season=19001901');
  assert.deepEqual(body, { standings: [], league: 'ahl' });
});

test('schedule for league=ahl maps games to ScheduleGameContracts in UTC', async () => {
  const { app } = makeApp();
  const { body } = await request(app, '/schedule?league=ahl');
  assert.equal(body.league, 'ahl');
  const [finalGame, liveGame, futureGame] = body.games;
  assert.deepEqual(finalGame, {
    gameId: 1029073,
    date: '2026-10-02',
    gameTime: '2026-10-02T23:00:00Z',
    dayOfWeek: 'Fri',
    venue: 'Rocket Arena',
    homeTeam: 'CLE',
    homeLogo: null,
    homeScore: 2,
    awayTeam: 'GR',
    awayLogo: null,
    awayScore: 5,
    broadcasts: [],
    ticketLink: null,
    gameCenter: null,
    isPlayoff: false,
    isPreseason: false,
    playoffRound: null,
    periodType: 'REG',
    seriesWins: null,
    topSeedTeamAbbrev: null,
    bottomSeedTeamAbbrev: null,
    gameState: 'OFF',
  });
  assert.equal(liveGame.gameState, 'LIVE');
  assert.equal(futureGame.gameState, 'FUT');
  assert.equal(futureGame.homeScore, null);
  assert.equal(futureGame.periodType, null);

  const teamSchedule = await request(app, '/team/schedule/HFD?league=ahl');
  assert.deepEqual(
    teamSchedule.body.games.map((game) => game.gameId),
    [1029214],
  );
});

test('boxscore for league=ahl has the gamecenter fields the web app reads', async () => {
  const { app } = makeApp();
  const { status, body } = await request(app, '/schedule/1029073?league=ahl');
  assert.equal(status, 200);
  assert.equal(body.league, 'ahl');
  assert.equal(body.gameState, 'OFF');
  assert.equal(body.startTimeUTC, '2026-10-02T23:00:00Z');
  assert.deepEqual(body.homeTeam, {
    id: 373,
    abbrev: 'CLE',
    commonName: { default: 'Monsters' },
    score: 2,
    sog: 20,
    logo: 'https://assets.leaguestat.com/ahl/logos/373_94.png',
    darkLogo: null,
  });
  assert.deepEqual(body.periodDescriptor, { number: 3, periodType: 'REG' });
  assert.deepEqual(body.gameOutcome, { lastPeriodType: 'REG' });

  const awayStats = body.playerByGameStats.awayTeam;
  assert.equal(awayStats.defense[0].position, 'D');
  assert.equal(awayStats.forwards[0].name.default.split(' ').length, 2);
  assert.equal(awayStats.forwards[0].toi, null);
  const starter = awayStats.goalies.find((goalie) => goalie.starter);
  assert.equal(starter.name.default, 'M. Postava');
  assert.equal(starter.saveShotsAgainst, '18/20');
  assert.equal(starter.savePctg, 0.9);
  assert.equal(starter.decision, 'W');

  assert.equal((await request(app, '/schedule/abc?league=ahl')).status, 404);
});

test('an AHL tri-code that matches an NHL one resolves to the AHL team', async () => {
  const { app, ahlApi } = makeApp();
  const { status, body } = await request(app, '/team/roster/TOR?league=ahl');
  assert.equal(status, 200);
  assert.equal(body.league, 'ahl');
  const rosterCall = ahlApi.calls.find((call) => call.view === 'roster');
  assert.equal(rosterCall.params.team_id, '335');
  assert.ok(
    body.players.every((player) => !['LW', 'RW'].includes(player.position)),
  );
  assert.deepEqual(Object.keys(body.players[0]), [
    'id',
    'name',
    'number',
    'position',
    'headshot',
  ]);
  assert.deepEqual((await request(app, '/team/roster/TOR')).body, {
    nhl: 'getRoster',
  });
  assert.equal((await request(app, '/team/roster/XXX?league=ahl')).status, 404);
});

test('team summary for league=ahl is NHL team summary rows from the standings', async () => {
  const { app } = makeApp();
  const { body } = await request(app, '/team/319?league=ahl');
  assert.equal(body.league, 'ahl');
  assert.equal(body.total, 1);
  assert.deepEqual(
    {
      teamFullName: body.data[0].teamFullName,
      teamId: body.data[0].teamId,
      goalsForPerGame: body.data[0].goalsForPerGame,
      powerPlayPct: body.data[0].powerPlayPct,
      shotsForPerGame: body.data[0].shotsForPerGame,
      seasonId: body.data[0].seasonId,
    },
    {
      teamFullName: 'Hershey Bears',
      teamId: 319,
      goalsForPerGame: 27 / 8,
      powerPlayPct: 0.125,
      shotsForPerGame: null,
      seasonId: 20262027,
    },
  );
  assert.equal((await request(app, '/team?league=ahl')).body.total, 2);
  assert.equal((await request(app, '/team/x1?league=ahl')).status, 400);
});

test('player summaries for league=ahl tag each row and read one team when asked', async () => {
  const { app, ahlApi } = makeApp();
  const skaters = (await request(app, '/player/skater/summary?league=ahl'))
    .body;
  assert.ok(skaters.length > 0);
  assert.ok(skaters.every((skater) => skater.league === 'ahl'));
  assert.equal(skaters[0].faceoffWinPct, null);
  assert.equal(skaters[0].shootingPct, skaters[0].goals / skaters[0].shots);

  const goalies = (
    await request(app, '/player/goalie/summary?league=ahl&teamId=307')
  ).body;
  assert.equal(goalies[0].goalieId, 2519);
  assert.equal(goalies[0].toiPerGame, 3600);
  const teamCall = ahlApi.calls.find((call) => call.params?.team === '307');
  assert.equal(teamCall.params.position, 'goalies');
});

test('stat leaders for league=ahl: top 10, rate boards qualified, unknown categories empty', async () => {
  const { app } = makeApp();
  const leaders = (
    await request(app, '/player/skater/statLeaders/points?league=ahl')
  ).body;
  assert.ok(leaders.length <= 10);
  assert.equal(leaders[0].firstName, 'Luke');
  assert.equal(leaders[0].lastName, 'Mittelstadt');
  assert.equal(leaders[0].value, 15);
  assert.equal(leaders[0].league, 'ahl');
  assert.deepEqual(
    (await request(app, '/player/skater/statLeaders/faceoffLeaders?league=ahl'))
      .body,
    [],
  );

  const goalieTable = {
    sections: [
      {
        data: [
          {
            row: {
              player_id: '1',
              name: 'One Game',
              games_played: '1',
              save_percentage: '1.000',
            },
          },
          {
            row: {
              player_id: '2',
              name: 'Starter Goalie',
              games_played: '9',
              save_percentage: '0.920',
            },
          },
        ],
      },
    ],
  };
  const savePctgLeaders = mapAhlStatLeaders(
    goalieTable,
    'goalie',
    'savePctg',
    {},
  );
  assert.deepEqual(
    savePctgLeaders.map((leader) => leader.id),
    [2],
  );
});

test('API-AHL-03: favorites look up AHL teams by tri-code and players in the season stat tables', async () => {
  const { ahlReadService } = makeAhlReadService();

  const { team } = await ahlReadService.findTeam('TOR', '20262027');
  assert.equal(team.name, 'Toronto Marlies');
  await assert.rejects(ahlReadService.findTeam('XYZ', '20262027'), { status: 404 });

  assert.deepEqual(await ahlReadService.findPlayerProfile(10978, '20262027'), {
    fullName: 'Luke Mittelstadt',
    teamTriCode: 'LAV',
    position: 'D',
    headshot: null,
  });
  assert.deepEqual(await ahlReadService.findPlayerProfile(2519, '20262027'), {
    fullName: 'James Reimer',
    teamTriCode: 'HFD',
    position: 'G',
    headshot: null,
  });
  await assert.rejects(ahlReadService.findPlayerProfile(1, '20262027'), { status: 404 });
});
