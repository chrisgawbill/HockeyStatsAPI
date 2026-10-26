const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapPlayByPlay,
} = require('#slices/schedule/mappers/playByPlayMapper.js');

const HOME_ID = 21; // COL
const AWAY_ID = 25; // DAL

/** One raw play in the NHL play-by-play shape. */
function play(eventId, typeDescKey, period, timeInPeriod, details, extra = {}) {
  return {
    eventId,
    typeDescKey,
    periodDescriptor: { number: period, periodType: period > 3 ? 'OT' : 'REG' },
    timeInPeriod,
    situationCode: '1551',
    details,
    ...extra,
  };
}

// Hand-built in the NHL `gamecenter/{id}/play-by-play` shape: the NHL host
// was unreachable from the build environment when this was written. Replace
// with an excerpt of a recorded OT game once it can be fetched.
const playByPlayPayload = {
  id: 2026020101,
  gameState: 'OFF',
  homeTeam: { id: HOME_ID, abbrev: 'COL' },
  awayTeam: { id: AWAY_ID, abbrev: 'DAL' },
  rosterSpots: [
    {
      teamId: HOME_ID,
      playerId: 11,
      firstName: { default: 'Nathan' },
      lastName: { default: 'MacKinnon' },
    },
    {
      teamId: HOME_ID,
      playerId: 12,
      firstName: { default: 'Cale' },
      lastName: { default: 'Makar' },
    },
    {
      teamId: HOME_ID,
      playerId: 31,
      firstName: { default: 'Mackenzie' },
      lastName: { default: 'Blackwood' },
    },
    {
      teamId: AWAY_ID,
      playerId: 21,
      firstName: { default: 'Jason' },
      lastName: { default: 'Robertson' },
    },
    {
      teamId: AWAY_ID,
      playerId: 22,
      firstName: { default: 'Miro' },
      lastName: { default: 'Heiskanen' },
    },
    {
      teamId: AWAY_ID,
      playerId: 35,
      firstName: { default: 'Jake' },
      lastName: { default: 'Oettinger' },
    },
  ],
  plays: [
    play(
      1,
      'faceoff',
      1,
      '00:00',
      { xCoord: 0, yCoord: 0, eventOwnerTeamId: HOME_ID },
      { homeTeamDefendingSide: 'left' },
    ),
    // Period 1: home defends left, so it already shoots toward +x.
    play(
      2,
      'shot-on-goal',
      1,
      '04:12',
      {
        xCoord: 71,
        yCoord: -12,
        zoneCode: 'O',
        shotType: 'wrist',
        shootingPlayerId: 11,
        goalieInNetId: 35,
        eventOwnerTeamId: HOME_ID,
      },
      { homeTeamDefendingSide: 'left' },
    ),
    play(
      3,
      'missed-shot',
      1,
      '09:40',
      {
        xCoord: -55,
        yCoord: 20,
        zoneCode: 'O',
        shotType: 'slap',
        shootingPlayerId: 22,
        goalieInNetId: 31,
        eventOwnerTeamId: AWAY_ID,
      },
      { homeTeamDefendingSide: 'left', situationCode: '1451' },
    ),
    // Blocked shot: owned by the blocking team (DAL), shot by COL's Makar.
    play(
      4,
      'blocked-shot',
      1,
      '12:05',
      {
        xCoord: 60,
        yCoord: 5,
        zoneCode: 'D',
        shootingPlayerId: 12,
        blockingPlayerId: 22,
        eventOwnerTeamId: AWAY_ID,
      },
      { homeTeamDefendingSide: 'left', situationCode: '1451' },
    ),
    play(
      5,
      'hit',
      1,
      '13:00',
      { xCoord: 90, yCoord: 40, eventOwnerTeamId: HOME_ID },
      { homeTeamDefendingSide: 'left' },
    ),
    // Period 2: ends switch, home defends right.
    play(
      6,
      'goal',
      2,
      '01:30',
      {
        xCoord: -80,
        yCoord: 10,
        zoneCode: 'O',
        shotType: 'snap',
        scoringPlayerId: 11,
        shootingPlayerId: 11,
        goalieInNetId: 35,
        eventOwnerTeamId: HOME_ID,
      },
      { homeTeamDefendingSide: 'right' },
    ),
    play(
      7,
      'shot-on-goal',
      2,
      '15:00',
      {
        zoneCode: 'O',
        shotType: 'wrist',
        shootingPlayerId: 21,
        goalieInNetId: 31,
        eventOwnerTeamId: AWAY_ID,
      },
      { homeTeamDefendingSide: 'right' },
    ),
    play(
      8,
      'some-future-play-type',
      2,
      '16:00',
      { xCoord: 1, yCoord: 1 },
      { homeTeamDefendingSide: 'right' },
    ),
    // Period 3: no defending side on any play; offensive-zone events decide.
    play(9, 'shot-on-goal', 3, '05:00', {
      xCoord: 70,
      yCoord: 0,
      zoneCode: 'O',
      shootingPlayerId: 11,
      goalieInNetId: 35,
      eventOwnerTeamId: HOME_ID,
    }),
    play(
      10,
      'missed-shot',
      3,
      '19:10',
      {
        xCoord: -65,
        yCoord: -8,
        zoneCode: 'O',
        shootingPlayerId: 21,
        eventOwnerTeamId: AWAY_ID,
      },
      { situationCode: '0651' },
    ),
    // Overtime: home defends right again.
    play(
      11,
      'goal',
      4,
      '02:31',
      {
        xCoord: 80,
        yCoord: -4,
        zoneCode: 'O',
        shotType: 'snap',
        scoringPlayerId: 21,
        goalieInNetId: 31,
        eventOwnerTeamId: AWAY_ID,
      },
      { homeTeamDefendingSide: 'right', situationCode: '1331' },
    ),
    {
      ...play(12, 'shot-on-goal', 5, '00:00', {
        xCoord: 75,
        yCoord: 0,
        shootingPlayerId: 11,
        eventOwnerTeamId: HOME_ID,
      }),
      periodDescriptor: { number: 5, periodType: 'SO' },
    },
  ],
};

const mappedGame = mapPlayByPlay(playByPlayPayload);
const eventById = (eventId) =>
  mappedGame.events.find((event) => event.eventId === eventId);

test('mapPlayByPlay keeps the game header and only shots and goals outside the shootout', () => {
  assert.equal(mappedGame.gameId, 2026020101);
  assert.equal(mappedGame.gameState, 'OFF');
  assert.deepEqual(mappedGame.homeTeam, { id: HOME_ID, triCode: 'COL' });
  assert.deepEqual(mappedGame.awayTeam, { id: AWAY_ID, triCode: 'DAL' });
  assert.deepEqual(
    mappedGame.events.map((event) => [event.eventId, event.type]),
    [
      [2, 'shot'],
      [3, 'miss'],
      [4, 'block'],
      [6, 'goal'],
      [7, 'shot'],
      [9, 'shot'],
      [10, 'miss'],
      [11, 'goal'],
    ],
  );
});

test('mapPlayByPlay maps a shot to the full event contract', () => {
  assert.deepEqual(eventById(2), {
    eventId: 2,
    period: 1,
    periodType: 'REG',
    timeInPeriod: '04:12',
    elapsedSeconds: 252,
    type: 'shot',
    teamTriCode: 'COL',
    shooterId: 11,
    shooterName: 'Nathan MacKinnon',
    goalieId: 35,
    x: 71,
    y: -12,
    shotType: 'wrist',
    strength: 'ev',
  });
});

test('home shoots toward +x in every period, flipped periods turned 180 degrees', () => {
  const coordinates = (eventId) => {
    const { x, y } = eventById(eventId);
    return { x, y };
  };
  // Period 1 is already home-right.
  assert.deepEqual(coordinates(2), { x: 71, y: -12 });
  assert.deepEqual(coordinates(3), { x: -55, y: 20 });
  // Period 2 flips: both coordinates negate.
  assert.deepEqual(coordinates(6), { x: 80, y: -10 });
  // Period 3 has no defending side; the home O-zone shot at +x and the away
  // O-zone miss at -x both say home attacks right.
  assert.deepEqual(coordinates(9), { x: 70, y: 0 });
  assert.deepEqual(coordinates(10), { x: -65, y: -8 });
  // Overtime flips like period 2, so the away goal lands at -x.
  assert.deepEqual(coordinates(11), { x: -80, y: 4 });
});

test('a period whose ends cannot be told keeps its events with null coordinates', () => {
  const unknownEnds = mapPlayByPlay({
    ...playByPlayPayload,
    plays: [
      play(1, 'shot-on-goal', 1, '01:00', {
        xCoord: 50,
        yCoord: 3,
        zoneCode: 'N',
        shootingPlayerId: 11,
        eventOwnerTeamId: HOME_ID,
      }),
    ],
  });
  assert.equal(unknownEnds.events.length, 1);
  assert.equal(unknownEnds.events[0].x, null);
  assert.equal(unknownEnds.events[0].y, null);
});

test('an event without coordinates is kept with null x and y', () => {
  const missingCoordinates = eventById(7);
  assert.equal(missingCoordinates.x, null);
  assert.equal(missingCoordinates.y, null);
  assert.equal(missingCoordinates.teamTriCode, 'DAL');
  assert.equal(missingCoordinates.elapsedSeconds, 1200 + 900);
});

test('a blocked shot belongs to the shooter, not the blocking team', () => {
  const blockedShot = eventById(4);
  assert.equal(blockedShot.teamTriCode, 'COL');
  assert.equal(blockedShot.shooterName, 'Cale Makar');
  // 1451: 5 COL skaters against 4, a power play for the shooter.
  assert.equal(blockedShot.strength, 'pp');
});

test('a blocked shot by an unknown shooter falls back to the team opposite the blocker', () => {
  const unknownShooter = mapPlayByPlay({
    ...playByPlayPayload,
    plays: [
      play(
        1,
        'blocked-shot',
        1,
        '01:00',
        {
          xCoord: 60,
          yCoord: 0,
          shootingPlayerId: 999,
          eventOwnerTeamId: AWAY_ID,
        },
        { homeTeamDefendingSide: 'left' },
      ),
    ],
  });
  assert.equal(unknownShooter.events[0].teamTriCode, 'COL');
  assert.equal(unknownShooter.events[0].shooterName, null);
});

test('overtime events carry their period type and run on from 60:00', () => {
  const overtimeGoal = eventById(11);
  assert.equal(overtimeGoal.period, 4);
  assert.equal(overtimeGoal.periodType, 'OT');
  assert.equal(overtimeGoal.elapsedSeconds, 3600 + 151);
  assert.equal(overtimeGoal.shooterName, 'Jason Robertson');
  assert.equal(overtimeGoal.strength, 'ev');
});

test('strength is read from the shooting team side; an extra attacker is not a power play', () => {
  // 1451: DAL has 4 skaters, COL 5.
  assert.equal(eventById(3).strength, 'sh');
  // 0651: DAL pulled its goalie for a sixth skater against 5.
  assert.equal(eventById(10).strength, 'ev');
  const withoutCode = mapPlayByPlay({
    ...playByPlayPayload,
    plays: [{ ...playByPlayPayload.plays[1], situationCode: undefined }],
  });
  assert.equal(withoutCode.events[0].strength, null);
});

test('a game that has not started maps to no events', () => {
  assert.deepEqual(
    mapPlayByPlay({
      id: 2026020200,
      gameState: 'FUT',
      homeTeam: {},
      awayTeam: {},
    }),
    {
      gameId: 2026020200,
      gameState: 'FUT',
      homeTeam: { id: null, triCode: null },
      awayTeam: { id: null, triCode: null },
      events: [],
    },
  );
});
