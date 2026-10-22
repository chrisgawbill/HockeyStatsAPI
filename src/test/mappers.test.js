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

test('mapGame fills guarded defaults, including broadcasts', () => {
  const broadcasts = mapBroadcasts([{ id: 1, network: 'ESPN' }, null, {}]);

  assert.deepEqual(broadcasts, [
    { id: 1, network: 'ESPN', market: '', countryCode: '' },
    { id: null, network: '', market: '', countryCode: '' },
  ]);

  const mappedGame = mapGame(
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

  assert.deepEqual(mappedGame, {
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

test('mapGame hides tickets after the game and maps playoff and preseason fields', () => {
  const final = mapGame(
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

  assert.equal(final.ticketLink, '');
  assert.equal(final.homeScore, 4);
  assert.equal(final.awayScore, 2);

  const playoff = mapGame(
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

  assert.equal(playoff.isPlayoff, true);
  assert.equal(playoff.playoffRound, 2);
  assert.equal(playoff.periodType, 'REG');
  assert.equal(playoff.seriesWins, '3-2');
  assert.equal(playoff.topSeedTeamAbbrev, 'COL');
  assert.equal(playoff.bottomSeedTeamAbbrev, 'DAL');

  const preseason = mapGame(
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

  assert.equal(preseason.isPreseason, true);
  assert.equal(preseason.isPlayoff, false);
});

test('resolveTeamId and mapStandingsTeam handle NHL field variants', () => {
  assert.equal(resolveTeamId({ teamAbbrev: { default: 'COL' } }), 'COL');
  assert.equal(resolveTeamId({ teamId: { id: 10 } }), 10);
  assert.equal(resolveTeamId({ teamId: 11 }), 11);
  assert.equal(resolveTeamId({ id: 12 }), 12);
  assert.equal(resolveTeamId({ team: { id: 13 } }), 13);

  const mappedTeam = mapStandingsTeam({
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

  assert.equal(mappedTeam.teamId, 'COL');
  assert.equal(mappedTeam.name, 'Avalanche');
  assert.equal(mappedTeam.clinchingIndicator, 'p');

  // The renamed clinchIndicator spelling is accepted too.
  const renamed = mapStandingsTeam({
    teamAbbrev: { default: 'DAL' },
    teamCommonName: { default: 'Stars' },
    clinchIndicator: 'x',
  });

  assert.equal(renamed.clinchingIndicator, 'x');

  // An unresolvable team id maps to null.
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

test('roster mappers guard names and flatten every position bucket', () => {
  const player = mapRosterPlayer({
    id: 1,
    firstName: { default: 'Nathan' },
    sweaterNumber: 29,
    positionCode: 'C',
  });

  assert.deepEqual(player, {
    id: 1,
    name: 'Nathan',
    number: 29,
    position: 'C',
    headshot: '',
  });

  const rosterContract = mapRoster({
    forwards: [{ id: 1, firstName: { default: 'Forward' } }],
    defensemen: [{ id: 2, firstName: { default: 'Defense' } }],
    goalies: [{ id: 3, firstName: { default: 'Goalie' } }],
  });

  assert.deepEqual(
    rosterContract.players.map((player) => player.id),
    [1, 2, 3],
  );
});

test('skater and goalie summaries map defaults and id/percentage variants', () => {
  const skaters = mapSkaterSummary({
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

  assert.equal(skaters[0].faceoffWinPct, null);
  assert.equal(skaters[0].toiPerGame, 1320);
  assert.equal(skaters[1].name, '');
  assert.equal(skaters[1].goals, 0);
  assert.equal(skaters[1].faceoffWinPct, 0.55);

  const goalies = mapGoalieSummary({
    data: [
      {
        goalieId: 35,
        goalieFullName: 'Goalie One',
        gamesPlayed: 50,
        wins: 30,
        losses: 10,
        otLosses: 3,
        savePct: 0.925,
        goalsAgainstAverage: 2.2,
        shutouts: 4,
        timeOnIcePerGame: 3600,
      },
      { playerId: 36, goalieFullName: 'Goalie Two' },
    ],
  });

  assert.equal(goalies[0].goalieId, 35);
  assert.equal(goalies[0].otLosses, 3);
  assert.equal(goalies[0].savePctg, 0.925);
  assert.equal(goalies[0].toiPerGame, 3600);
  assert.equal(goalies[1].goalieId, 36);
  assert.equal(goalies[1].wins, 0);
  assert.equal(goalies[1].otLosses, 0);
  assert.equal(goalies[1].savePctg, null);
});

test('mapStatLeaders guards missing fields and missing categories', () => {
  const leaderContracts = mapStatLeaders(
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

  assert.deepEqual(leaderContracts, [
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

  assert.deepEqual(mapStatLeaders({ goals: [] }, 'assists'), []);
  assert.deepEqual(mapStatLeaders(null, 'goals'), []);
});
