/**
 * playByPlayMapper
 *
 * Translates the raw NHL `gamecenter/{id}/play-by-play` payload into the app's
 * PlayByPlayContract: a game's shot attempts and goals, ready for a shot map
 * and a game flow chart. Runs after the cache read, so the cache always holds
 * the raw NHL payload.
 *
 * Coordinates are NHL rink feet from center ice (x -100..100 toward the end
 * boards, y -42.5..42.5 across). The NHL switches ends every period; this
 * mapper rotates them so the HOME team always shoots toward +x (right) and the
 * AWAY team toward -x (left) in every period, overtime included. A period
 * whose ends are flipped has both x and y negated (a 180° turn), which keeps
 * each shot on its own side of the ice. When a period's ends cannot be told,
 * or an event has no coordinates, the event keeps `x`/`y` null so counts and
 * the game flow stay complete.
 *
 * Shootout attempts are left out, and play types other than the four shot
 * kinds are dropped rather than failed.
 */

/**
 * @typedef {Object} PlayByPlayTeamContract
 * @property {number|null} id
 * @property {string|null} triCode
 */

/**
 * @typedef {Object} PlayByPlayEventContract
 * @property {number}      eventId
 * @property {number}      period
 * @property {string|null} periodType     - "REG" or "OT"
 * @property {string|null} timeInPeriod   - "MM:SS" elapsed in the period
 * @property {number|null} elapsedSeconds - seconds since puck drop (20-minute periods)
 * @property {'goal'|'shot'|'miss'|'block'} type
 * @property {string|null} teamTriCode    - the shooting team
 * @property {number|null} shooterId
 * @property {string|null} shooterName
 * @property {number|null} goalieId       - goalie in net, null on an empty net
 * @property {number|null} x              - normalized: home shoots toward +x
 * @property {number|null} y
 * @property {string|null} shotType       - e.g. "wrist", "slap"
 * @property {'ev'|'pp'|'sh'|null} strength - from the shooting team's side
 */

/**
 * @typedef {Object} PlayByPlayContract
 * @property {number|null} gameId
 * @property {string|null} gameState
 * @property {PlayByPlayTeamContract} homeTeam
 * @property {PlayByPlayTeamContract} awayTeam
 * @property {PlayByPlayEventContract[]} events
 */

/** NHL play types this contract keeps, by their contract name. */
const SHOT_EVENT_TYPES = {
  goal: 'goal',
  'shot-on-goal': 'shot',
  'missed-shot': 'miss',
  'blocked-shot': 'block',
};

const PERIOD_SECONDS = 20 * 60;

/**
 * Maps a raw play-by-play payload to the PlayByPlayContract.
 * @param {any} playByPlayPayload
 * @returns {PlayByPlayContract}
 */
function mapPlayByPlay(playByPlayPayload) {
  const homeTeam = mapTeam(playByPlayPayload?.homeTeam);
  const awayTeam = mapTeam(playByPlayPayload?.awayTeam);
  const plays = playByPlayPayload?.plays ?? [];
  const game = {
    homeTeam,
    awayTeam,
    playersById: indexRosterSpots(playByPlayPayload?.rosterSpots),
    homeAttacksRightByPeriod: findHomeAttackingEnds(plays, homeTeam.id),
  };

  const events = plays
    .filter(isMappedShotPlay)
    .map((play) => mapShotEvent(play, game));

  return {
    gameId: playByPlayPayload?.id ?? null,
    gameState: playByPlayPayload?.gameState ?? null,
    homeTeam,
    awayTeam,
    events,
  };
}

/** Reduces a raw payload team to `{ id, triCode }`. */
function mapTeam(rawTeam) {
  return { id: rawTeam?.id ?? null, triCode: rawTeam?.abbrev ?? null };
}

/** Indexes `rosterSpots` by player id as `{ name, teamId }`. */
function indexRosterSpots(rosterSpots = []) {
  const playersById = new Map();
  for (const rosterSpot of rosterSpots) {
    const name = [rosterSpot?.firstName?.default, rosterSpot?.lastName?.default]
      .filter(Boolean)
      .join(' ');
    playersById.set(rosterSpot?.playerId, {
      name: name || null,
      teamId: rosterSpot?.teamId ?? null,
    });
  }
  return playersById;
}

/** True for a shot or goal outside the shootout. */
function isMappedShotPlay(play) {
  return (
    Object.hasOwn(SHOT_EVENT_TYPES, play?.typeDescKey) &&
    play.periodDescriptor?.periodType !== 'SO'
  );
}

/**
 * Works out, per period number, whether the home team attacks the +x end
 * (true), the -x end (false), or cannot be told (missing). The NHL's own
 * `homeTeamDefendingSide` decides when any play in the period has it;
 * otherwise the period's offensive-zone events vote by the side they are on.
 * @returns {Map<number, boolean>}
 */
function findHomeAttackingEnds(plays, homeTeamId) {
  const homeAttacksRightByPeriod = new Map();
  const offensiveZoneVotes = new Map();

  for (const play of plays) {
    const period = play?.periodDescriptor?.number;
    if (period == null) continue;

    const defendingSide = play.homeTeamDefendingSide;
    if (defendingSide === 'left' || defendingSide === 'right') {
      if (!homeAttacksRightByPeriod.has(period)) {
        homeAttacksRightByPeriod.set(period, defendingSide === 'left');
      }
      continue;
    }

    const vote = voteHomeAttacksRight(play, homeTeamId);
    if (vote !== 0) {
      offensiveZoneVotes.set(
        period,
        (offensiveZoneVotes.get(period) ?? 0) + vote,
      );
    }
  }

  for (const [period, voteTotal] of offensiveZoneVotes) {
    if (!homeAttacksRightByPeriod.has(period) && voteTotal !== 0) {
      homeAttacksRightByPeriod.set(period, voteTotal > 0);
    }
  }
  return homeAttacksRightByPeriod;
}

/**
 * +1 when an offensive-zone event places the home team's attacking end at +x,
 * -1 when at -x, 0 when the event says nothing. The zone is from the point of
 * view of the event's owner, so it holds for every play type.
 */
function voteHomeAttacksRight(play, homeTeamId) {
  const { zoneCode, xCoord, eventOwnerTeamId } = play.details ?? {};
  if (zoneCode !== 'O' || !xCoord || eventOwnerTeamId == null) return 0;
  const ownerAttacksRight = xCoord > 0;
  const homeAttacksRight =
    eventOwnerTeamId === homeTeamId ? ownerAttacksRight : !ownerAttacksRight;
  return homeAttacksRight ? 1 : -1;
}

/** Maps one shot or goal play to a PlayByPlayEventContract. */
function mapShotEvent(play, game) {
  const details = play.details ?? {};
  const type = SHOT_EVENT_TYPES[play.typeDescKey];
  const period = play.periodDescriptor?.number ?? null;
  const shooterId = details.scoringPlayerId ?? details.shootingPlayerId ?? null;
  const shooter = game.playersById.get(shooterId);
  const shootingTeam = findShootingTeam(type, details, shooter, game);
  const { x, y } = normalizeCoordinates(
    details,
    game.homeAttacksRightByPeriod.get(period),
  );

  return {
    eventId: play.eventId,
    period,
    periodType: play.periodDescriptor?.periodType ?? null,
    timeInPeriod: play.timeInPeriod ?? null,
    elapsedSeconds: countElapsedSeconds(period, play.timeInPeriod),
    type,
    teamTriCode: shootingTeam?.triCode ?? null,
    shooterId,
    shooterName: shooter?.name ?? null,
    goalieId: details.goalieInNetId ?? null,
    x,
    y,
    shotType: details.shotType ?? null,
    strength: shootingTeam
      ? readStrength(play.situationCode, shootingTeam === game.homeTeam)
      : null,
  };
}

/**
 * The team that took the shot. The shooter's roster spot decides; failing
 * that, the event owner, except on a blocked shot, which the NHL credits to
 * the blocking team.
 */
function findShootingTeam(type, details, shooter, game) {
  const teamId =
    shooter?.teamId ?? findShootingTeamIdFromOwner(type, details, game);
  if (teamId === game.homeTeam.id) return game.homeTeam;
  if (teamId === game.awayTeam.id) return game.awayTeam;
  return null;
}

/** Shooting team id from the event owner (the blocker's team on a block). */
function findShootingTeamIdFromOwner(type, details, game) {
  const ownerTeamId = details.eventOwnerTeamId;
  if (type !== 'block') return ownerTeamId ?? null;
  if (ownerTeamId === game.homeTeam.id) return game.awayTeam.id;
  if (ownerTeamId === game.awayTeam.id) return game.homeTeam.id;
  return null;
}

/**
 * Rotates raw coordinates so the home team shoots toward +x; both null when
 * the event has none or the period's ends are unknown.
 */
function normalizeCoordinates(details, homeAttacksRight) {
  const hasCoordinates =
    Number.isFinite(details.xCoord) && Number.isFinite(details.yCoord);
  if (!hasCoordinates || homeAttacksRight === undefined) {
    return { x: null, y: null };
  }
  if (homeAttacksRight) return { x: details.xCoord, y: details.yCoord };
  return { x: flipSign(details.xCoord), y: flipSign(details.yCoord) };
}

/** Negates a coordinate without producing -0. */
function flipSign(coordinate) {
  return coordinate === 0 ? 0 : -coordinate;
}

/** Seconds since puck drop for "MM:SS" into `period`, or null if unreadable. */
function countElapsedSeconds(period, timeInPeriod) {
  const match = /^(\d+):(\d{2})$/.exec(timeInPeriod ?? '');
  if (period == null || !match) return null;
  const secondsIntoPeriod = Number(match[1]) * 60 + Number(match[2]);
  return (period - 1) * PERIOD_SECONDS + secondsIntoPeriod;
}

/**
 * Strength from the shooting team's side of the NHL situation code, four
 * digits: away goalie, away skaters, home skaters, home goalie. A team whose
 * goalie is pulled counts one skater fewer, so an extra attacker alone is
 * not a power play.
 * @returns {'ev'|'pp'|'sh'|null}
 */
function readStrength(situationCode, isHomeShooter) {
  const match = /^(\d)(\d)(\d)(\d)$/.exec(situationCode ?? '');
  if (!match) return null;
  const [awayGoalies, awaySkaters, homeSkaters, homeGoalies] = match
    .slice(1)
    .map(Number);
  const awayStrength = awayGoalies === 0 ? awaySkaters - 1 : awaySkaters;
  const homeStrength = homeGoalies === 0 ? homeSkaters - 1 : homeSkaters;
  const ownStrength = isHomeShooter ? homeStrength : awayStrength;
  const opposingStrength = isHomeShooter ? awayStrength : homeStrength;
  if (ownStrength > opposingStrength) return 'pp';
  if (ownStrength < opposingStrength) return 'sh';
  return 'ev';
}

module.exports = { mapPlayByPlay };
