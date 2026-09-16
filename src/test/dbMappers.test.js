const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  buildPlayer,
  buildTeam,
  splitFullName,
} = require('#platform/entityBuilders.js');
const {
  collectScheduleGames,
  buildScheduleGame,
} = require('#slices/schedule/mappers/scheduleDbMapper.js');
const {
  collectRosterPlayers,
} = require('#slices/rosters/mappers/rosterDbMapper.js');
const {
  buildStatsPlayer,
  buildPlayerStats,
} = require('#slices/players/mappers/playerStatsDbMapper.js');
const {
  getLeaderRows,
  buildLeaderPlayer,
} = require('#slices/statLeaders/mappers/statLeaderDbMapper.js');
const {
  hashPrompt,
} = require('#slices/aiSummaries/mappers/aiSummaryDbMapper.js');

test('entity builders unwrap common NHL team and player shapes', () => {
  assert.deepEqual(splitFullName('Nathan MacKinnon'), {
    firstName: 'Nathan',
    lastName: 'MacKinnon',
  });

  const team = buildTeam({
    id: 21,
    abbrev: 'COL',
    name: { default: 'Colorado Avalanche' },
    logo: 'logo.svg',
  });
  assert.equal(team.teamId, 21);
  assert.equal(team.triCode, 'COL');
  assert.equal(team.fullName, 'Colorado Avalanche');

  const player = buildPlayer({
    id: 29,
    firstName: { default: 'Nathan' },
    lastName: { default: 'MacKinnon' },
    position: 'C',
  });
  assert.equal(player.playerId, 29);
  assert.equal(player.fullName, 'Nathan MacKinnon');
  assert.equal(player.positionCode, 'C');
});

test('schedule db mapper collects weekly games and builds DB shape', () => {
  const collected = collectScheduleGames({
    gameWeek: [
      {
        date: '2024-01-01',
        games: [
          {
            id: 2023020001,
            gameType: 2,
            startTimeUTC: '2024-01-01T19:00:00Z',
            gameState: 'FUT',
            venue: { default: 'Ball Arena' },
            homeTeam: { id: 21, abbrev: 'COL', score: 3 },
            awayTeam: { id: 25, abbrev: 'DAL', score: 2 },
          },
        ],
      },
    ],
  });

  assert.equal(collected.length, 1);
  const game = buildScheduleGame({
    seasonId: '20232024',
    rawGame: collected[0].rawGame,
    gameDate: collected[0].gameDate,
    homeTeam: { teamId: 21, triCode: 'COL' },
    awayTeam: { teamId: 25, triCode: 'DAL' },
  });
  assert.equal(game.gameId, 2023020001);
  assert.equal(game.gameDate, '2024-01-01');
  assert.equal(game.homeScore, 3);
});

test('roster db mapper flattens roster buckets', () => {
  const players = collectRosterPlayers({
    forwards: [{ id: 1 }],
    defensemen: [{ id: 2 }],
    goalies: [{ id: 3 }],
  });

  assert.deepEqual(
    players.map((p) => p.id),
    [1, 2, 3],
  );
});

test('player stats db mapper builds skater and goalie stats shapes', () => {
  const skater = buildStatsPlayer(
    { playerId: 29, skaterFullName: 'Nathan MacKinnon', positionCode: 'C' },
    'skater',
  );
  const skaterStats = buildPlayerStats({
    seasonId: '20232024',
    playerType: 'skater',
    teamId: 21,
    teamScope: '21',
    rawStats: { gamesPlayed: 82, goals: 51, points: 140 },
    player: skater,
  });
  assert.equal(skaterStats.playerId, 29);
  assert.equal(skaterStats.goals, 51);
  assert.equal(skaterStats.teamScope, '21');

  const goalie = buildStatsPlayer(
    { goalieId: 35, goalieFullName: 'Goalie Name', savePct: 0.92 },
    'goalie',
  );
  assert.equal(goalie.playerId, 35);
});

test('stat leader db mapper extracts category rows and player identity', () => {
  const rows = getLeaderRows(
    {
      goals: [
        {
          id: 29,
          firstName: { default: 'Nathan' },
          lastName: { default: 'MacKinnon' },
          value: 51,
        },
      ],
    },
    'goals',
  );

  assert.equal(rows.length, 1);
  const player = buildLeaderPlayer(rows[0]);
  assert.equal(player.playerId, 29);
  assert.equal(player.fullName, 'Nathan MacKinnon');
});

test('ai summary db mapper hashes prompts deterministically', () => {
  assert.equal(hashPrompt('same prompt'), hashPrompt('same prompt'));
  assert.notEqual(hashPrompt('same prompt'), hashPrompt('other prompt'));
  assert.equal(hashPrompt(null), null);
});
