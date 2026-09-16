const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapBroadcasts,
  mapGame,
} = require('#slices/schedule/mappers/scheduleMapper.js');
const {
  mapStandingsTeam,
  resolveTeamId,
} = require('#slices/standings/mappers/standingsMapper.js');
const {
  mapRoster,
  mapRosterPlayer,
} = require('#slices/rosters/mappers/rosterMapper.js');
const {
  mapGoalieSummary,
  mapSkaterSummary,
} = require('#slices/players/mappers/playerMapper.js');
const {
  mapStatLeaders,
} = require('#slices/statLeaders/mappers/statLeaderMapper.js');

test('mapBroadcasts defaults missing broadcast fields', () => {
  const result = mapBroadcasts([{ id: 1, network: 'ESPN' }, null, {}]);

  assert.deepEqual(result, [
    { id: 1, network: 'ESPN', market: '', countryCode: '' },
    { id: null, network: '', market: '', countryCode: '' },
  ]);
});

test('mapGame handles missing venue scores and guarded defaults', () => {
  const result = mapGame(
    {
      id: 2023020001,
      gameState: 'FUT',
      startTimeUTC: '2024-01-01T19:00:00Z',
      homeTeam: { abbrev: 'COL', logo: 'home.svg' },
      awayTeam: { abbrev: 'DAL', logo: 'away.svg' },
      tvBroadcasts: [{ network: 'ALT', market: 'H', countryCode: 'US' }],
      ticketsLink: 'https://tickets.example',
      gameCenterLink: '/gamecenter/2023020001',
      gameType: 2,
    },
    { date: '2024-01-01', dayAbbrev: 'Mon' },
  );

  assert.deepEqual(result, {
    gameId: 2023020001,
    date: '2024-01-01',
    gameTime: '2024-01-01T19:00:00Z',
    dayOfWeek: 'Mon',
    venue: '',
    homeTeam: 'COL',
    homeLogo: 'home.svg',
    homeScore: null,
    awayTeam: 'DAL',
    awayLogo: 'away.svg',
    awayScore: null,
    broadcasts: [{ id: null, network: 'ALT', market: 'H', countryCode: 'US' }],
    ticketLink: 'https://tickets.example',
    gameCenter: '/gamecenter/2023020001',
    isPlayoff: false,
    isPreseason: false,
    playoffRound: null,
    periodType: null,
    seriesWins: null,
    topSeedTeamAbbrev: null,
    bottomSeedTeamAbbrev: null,
    gameState: 'FUT',
  });
});

test('mapGame only exposes ticketLink for future games', () => {
  const result = mapGame(
    {
      id: 2023020002,
      gameState: 'FINAL',
      startTimeUTC: '2024-01-02T19:00:00Z',
      homeTeam: { abbrev: 'COL', score: 4 },
      awayTeam: { abbrev: 'DAL', score: 2 },
      ticketsLink: 'https://tickets.example',
    },
    { date: '2024-01-02', dayAbbrev: 'Tue' },
  );

  assert.equal(result.ticketLink, '');
  assert.equal(result.homeScore, 4);
  assert.equal(result.awayScore, 2);
});

test('mapGame maps playoff fields', () => {
  const result = mapGame(
    {
      id: 2023030123,
      gameState: 'OFF',
      startTimeUTC: '2024-05-01T19:00:00Z',
      gameType: 3,
      periodDescriptor: { periodType: 'REG' },
      homeTeam: { abbrev: 'COL' },
      awayTeam: { abbrev: 'DAL' },
      seriesStatus: {
        round: 2,
        topSeedWins: 3,
        bottomSeedWins: 2,
        topSeedTeamAbbrev: 'COL',
        bottomSeedTeamAbbrev: 'DAL',
      },
    },
    { date: '2024-05-01', dayAbbrev: 'Wed' },
  );

  assert.equal(result.isPlayoff, true);
  assert.equal(result.playoffRound, 2);
  assert.equal(result.periodType, 'REG');
  assert.equal(result.seriesWins, '3-2');
  assert.equal(result.topSeedTeamAbbrev, 'COL');
  assert.equal(result.bottomSeedTeamAbbrev, 'DAL');
});

test('mapGame marks preseason games via gameType 1', () => {
  const result = mapGame(
    {
      id: 2024010001,
      gameState: 'FUT',
      startTimeUTC: '2024-09-22T19:00:00Z',
      gameType: 1,
      homeTeam: { abbrev: 'COL' },
      awayTeam: { abbrev: 'DAL' },
    },
    { date: '2024-09-22', dayAbbrev: 'Sun' },
  );

  assert.equal(result.isPreseason, true);
  assert.equal(result.isPlayoff, false);
});

test('resolveTeamId uses NHL fallback chain', () => {
  assert.equal(resolveTeamId({ teamAbbrev: { default: 'COL' } }), 'COL');
  assert.equal(resolveTeamId({ teamId: { id: 10 } }), 10);
  assert.equal(resolveTeamId({ teamId: 11 }), 11);
  assert.equal(resolveTeamId({ id: 12 }), 12);
  assert.equal(resolveTeamId({ team: { id: 13 } }), 13);
});

test('mapStandingsTeam maps clinchingIndicator spelling', () => {
  const result = mapStandingsTeam({
    teamAbbrev: { default: 'COL' },
    teamLogo: 'logo.svg',
    teamCommonName: { default: 'Avalanche' },
    conferenceName: 'Western',
    divisionName: 'Central',
    wins: 50,
    losses: 20,
    otLosses: 5,
    points: 105,
    pointPctg: 0.7,
    leagueSequence: 1,
    conferenceSequence: 1,
    divisionSequence: 1,
    wildcardSequence: 0,
    clinchingIndicator: 'p',
    leagueL10Sequence: 2,
  });

  assert.equal(result.teamId, 'COL');
  assert.equal(result.name, 'Avalanche');
  assert.equal(result.clinchingIndicator, 'p');
});

test('mapStandingsTeam maps clinchIndicator renamed spelling', () => {
  const result = mapStandingsTeam({
    teamAbbrev: { default: 'DAL' },
    teamCommonName: { default: 'Stars' },
    clinchIndicator: 'x',
  });

  assert.equal(result.clinchingIndicator, 'x');
});

test('mapStandingsTeam returns null when team id cannot be resolved', () => {
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    assert.equal(
      mapStandingsTeam({ teamCommonName: { default: 'Unknown' } }),
      null,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('mapRosterPlayer uses guarded name defaults', () => {
  const result = mapRosterPlayer({
    id: 1,
    firstName: { default: 'Nathan' },
    sweaterNumber: 29,
    positionCode: 'C',
  });

  assert.deepEqual(result, {
    id: 1,
    name: 'Nathan',
    number: 29,
    position: 'C',
    headshot: '',
  });
});

test('mapRoster flattens forwards defensemen and goalies', () => {
  const result = mapRoster({
    forwards: [{ id: 1, firstName: { default: 'Forward' } }],
    defensemen: [{ id: 2, firstName: { default: 'Defense' } }],
    goalies: [{ id: 3, firstName: { default: 'Goalie' } }],
  });

  assert.deepEqual(
    result.players.map((player) => player.id),
    [1, 2, 3],
  );
});

test('mapSkaterSummary maps defaults and treats zero faceoff percentage as null', () => {
  const result = mapSkaterSummary({
    data: [
      {
        playerId: 29,
        skaterFullName: 'Nathan MacKinnon',
        positionCode: 'C',
        gamesPlayed: 82,
        goals: 51,
        assists: 89,
        points: 140,
        plusMinus: 35,
        penaltyMinutes: 42,
        faceoffWinPct: 0,
        timeOnIcePerGame: 1320,
      },
      { playerId: 8, faceoffWinPct: 0.55 },
    ],
  });

  assert.equal(result[0].faceoffWinPct, null);
  assert.equal(result[0].toiPerGame, 1320);
  assert.equal(result[1].name, '');
  assert.equal(result[1].goals, 0);
  assert.equal(result[1].faceoffWinPct, 0.55);
});

test('mapGoalieSummary accepts goalieId or playerId', () => {
  const result = mapGoalieSummary({
    data: [
      {
        goalieId: 35,
        goalieFullName: 'Goalie One',
        gamesPlayed: 50,
        wins: 30,
        losses: 10,
        savePct: 0.925,
        goalsAgainstAverage: 2.2,
        shutouts: 4,
        timeOnIcePerGame: 3600,
      },
      { playerId: 36, goalieFullName: 'Goalie Two' },
    ],
  });

  assert.equal(result[0].goalieId, 35);
  assert.equal(result[0].savePctg, 0.925);
  assert.equal(result[0].toiPerGame, 3600);
  assert.equal(result[1].goalieId, 36);
  assert.equal(result[1].wins, 0);
  assert.equal(result[1].savePctg, null);
});

test('mapStatLeaders guards missing default fields', () => {
  const result = mapStatLeaders(
    {
      goals: [
        {
          id: 29,
          sweaterNumber: 29,
          headshot: 'headshot.png',
          teamAbbrev: 'COL',
          teamLogo: 'logo.svg',
          position: 'C',
          value: 51,
        },
      ],
    },
    'goals',
  );

  assert.deepEqual(result, [
    {
      id: 29,
      firstName: '',
      lastName: '',
      sweaterNumber: 29,
      headshot: 'headshot.png',
      teamAbbrev: 'COL',
      teamName: '',
      teamLogo: 'logo.svg',
      position: 'C',
      value: 51,
    },
  ]);
});

test('mapStatLeaders returns empty array when category is missing', () => {
  assert.deepEqual(mapStatLeaders({ goals: [] }, 'assists'), []);
  assert.deepEqual(mapStatLeaders(null, 'goals'), []);
});
