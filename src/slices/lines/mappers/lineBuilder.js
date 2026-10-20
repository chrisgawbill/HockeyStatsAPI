/**
 * Pure line builder: raw NHL shift chart rows + raw roster -> LinesContract.
 *
 * Shift rows are typeCode 517; goal events (typeCode 505 / non-null
 * eventDescription) are ignored. Times are 'mm:ss' within a period; each
 * period is placed on its own timeline so intervals never overlap across periods.
 *
 * togetherSeconds is the TRIPLE overlap (all three skaters on the ice at the
 * same instant) for forward lines and the pair overlap for D pairs. Grouping is
 * greedy: lines are chosen by the max sum of pairwise overlaps among players not
 * yet assigned, so line order is pick order (best-matched trio first).
 */

const SHIFT_TYPE_CODE = 517;
const PERIOD_STRIDE = 100000;
const MAX_FORWARD_LINES = 4;
const MAX_DEFENSE_PAIRS = 3;
const MIN_CENTER_FACEOFFS = 3;
const FORWARD_SLOT_ORDER = ['C', 'LW', 'RW'];
const FORWARD_NATURAL = { C: 'C', L: 'LW', R: 'RW' };

/** Parses an "mm:ss" clock string into seconds, or null when it is not one. */
function parseClock(value) {
  if (typeof value !== 'string') return null;
  const clockMatch = value.match(/^(\d+):(\d{2})$/);
  return clockMatch ? Number(clockMatch[1]) * 60 + Number(clockMatch[2]) : null;
}

/** True for a shift-chart row that is an actual shift (not a goal event). */
function isShiftRow(shiftRow) {
  if (!shiftRow || shiftRow.playerId == null) return false;
  if (
    shiftRow.typeCode != null &&
    Number(shiftRow.typeCode) !== SHIFT_TYPE_CODE
  ) {
    return false;
  }
  return shiftRow.eventDescription == null;
}

/** Merge sorted-or-not [start,end) intervals into a disjoint sorted list. */
function mergeIntervals(intervals) {
  const sortedIntervals = [...intervals].sort(
    (intervalA, intervalB) => intervalA[0] - intervalB[0],
  );
  const merged = [];
  for (const [start, end] of sortedIntervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The overlap of two disjoint sorted interval lists, as a disjoint sorted list. */
function intersect(intervalsA, intervalsB) {
  const overlaps = [];
  let indexA = 0;
  let indexB = 0;
  while (indexA < intervalsA.length && indexB < intervalsB.length) {
    const start = Math.max(intervalsA[indexA][0], intervalsB[indexB][0]);
    const end = Math.min(intervalsA[indexA][1], intervalsB[indexB][1]);
    if (start < end) overlaps.push([start, end]);
    if (intervalsA[indexA][1] < intervalsB[indexB][1]) indexA++;
    else indexB++;
  }
  return overlaps;
}

/** Total length of a list of intervals. */
function totalLength(intervals) {
  return intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/** Map playerId -> merged on-ice intervals for one team. */
function buildIntervals(shifts, triCode) {
  const intervalsByPlayer = new Map();
  for (const shiftRow of shifts ?? []) {
    if (!isShiftRow(shiftRow)) continue;
    if (shiftRow.teamAbbrev && shiftRow.teamAbbrev !== triCode) continue;
    const start = parseClock(shiftRow.startTime);
    const end = parseClock(shiftRow.endTime);
    const period = Number(shiftRow.period);
    if (start == null || end == null || !Number.isFinite(period)) continue;
    if (end <= start) continue;
    const periodOffset = period * PERIOD_STRIDE;
    const playerId = Number(shiftRow.playerId);
    if (!intervalsByPlayer.has(playerId)) intervalsByPlayer.set(playerId, []);
    intervalsByPlayer
      .get(playerId)
      .push([periodOffset + start, periodOffset + end]);
  }
  for (const [playerId, playerIntervals] of intervalsByPlayer) {
    intervalsByPlayer.set(playerId, mergeIntervals(playerIntervals));
  }
  return intervalsByPlayer;
}

/** Map playerId -> { id, positionCode, shootsCatches, group } for a raw roster (group F, D or G). */
function rosterPlayers(rawRoster) {
  /** Maps raw roster players, tagging each with its position group. */
  const tagWithGroup = (rawPlayers, group) =>
    (rawPlayers ?? []).map((rawPlayer) => ({
      id: Number(rawPlayer.id),
      positionCode: rawPlayer.positionCode,
      shootsCatches: rawPlayer.shootsCatches,
      group,
    }));
  return new Map(
    [
      ...tagWithGroup(rawRoster?.forwards, 'F'),
      ...tagWithGroup(rawRoster?.defensemen, 'D'),
      ...tagWithGroup(rawRoster?.goalies, 'G'),
    ].map((player) => [player.id, player]),
  );
}

/** All `size`-element combinations of `items`, in index order. */
function combinations(items, size) {
  const found = [];
  /** Recursively collects every combination of `size` items starting at `startIndex`. */
  const collect = (startIndex, picked) => {
    if (picked.length === size) return found.push([...picked]);
    for (let index = startIndex; index < items.length; index++) {
      picked.push(items[index]);
      collect(index + 1, picked);
      picked.pop();
    }
  };
  collect(0, []);
  return found;
}

/** All orderings of `items`. */
function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([
      ...items.slice(0, index),
      ...items.slice(index + 1),
    ]).map((rest) => [item, ...rest]),
  );
}

/**
 * Greedily group `pool` (sorted by TOI desc) into groups of `size`, each time
 * taking the group with max sum of pairwise overlaps. Ties keep pool order.
 */
function greedyGroups(pool, size, maxGroups, intervals) {
  const overlapByPair = new Map();
  /** Shared on-ice length for two players, memoized per pair. */
  const pairOverlap = (playerA, playerB) => {
    const pairKey =
      playerA < playerB ? `${playerA}:${playerB}` : `${playerB}:${playerA}`;
    if (!overlapByPair.has(pairKey)) {
      overlapByPair.set(
        pairKey,
        totalLength(intersect(intervals.get(playerA), intervals.get(playerB))),
      );
    }
    return overlapByPair.get(pairKey);
  };
  let remaining = [...pool];
  const groups = [];
  while (groups.length < maxGroups && remaining.length >= size) {
    let bestGroup = null;
    let bestScore = -1;
    for (const candidate of combinations(remaining, size)) {
      let score = 0;
      for (let first = 0; first < candidate.length; first++) {
        for (let second = first + 1; second < candidate.length; second++) {
          score += pairOverlap(candidate[first], candidate[second]);
        }
      }
      if (score > bestScore) {
        bestGroup = candidate;
        bestScore = score;
      }
    }
    if (!bestGroup) break;
    groups.push(bestGroup);
    remaining = remaining.filter((id) => !bestGroup.includes(id));
  }
  return groups;
}

/** Seconds during which every player in `ids` was on the ice at once. */
function togetherSeconds(ids, intervals) {
  let sharedIntervals = intervals.get(ids[0]);
  for (const id of ids.slice(1)) {
    sharedIntervals = intersect(sharedIntervals, intervals.get(id));
  }
  return Math.round(totalLength(sharedIntervals));
}

/** Pick the slot permutation with the fewest off-position players. */
function assignSlots(ids, slots, naturalSlot, toi) {
  const idsByToi = [...ids].sort((idA, idB) => toi.get(idB) - toi.get(idA));
  let bestOrder = null;
  let bestCost = Infinity;
  for (const slotOrder of permutations(slots)) {
    let cost = 0;
    idsByToi.forEach((id, index) => {
      if (naturalSlot(id) !== slotOrder[index]) cost++;
    });
    if (cost < bestCost) {
      bestOrder = slotOrder;
      bestCost = cost;
    }
  }
  const idBySlot = new Map(idsByToi.map((id, index) => [bestOrder[index], id]));
  return slots.map((slot) => ({ id: idBySlot.get(slot), slot }));
}

/**
 * Faceoffs taken (wins + losses) per player. Accepts a Map of playerId ->
 * count, or raw play-by-play plays (non-faceoff plays are ignored).
 */
function faceoffCounts(faceoffs) {
  if (faceoffs instanceof Map) return faceoffs;
  const counts = new Map();
  /** Adds one faceoff to a player's tally; ignores missing ids. */
  const countFaceoff = (playerId) => {
    if (playerId == null) return;
    counts.set(Number(playerId), (counts.get(Number(playerId)) ?? 0) + 1);
  };
  for (const play of Array.isArray(faceoffs) ? faceoffs : []) {
    if (play?.typeDescKey !== 'faceoff') continue;
    countFaceoff(play.details?.winningPlayerId);
    countFaceoff(play.details?.losingPlayerId);
  }
  return counts;
}

/** Fill the wings: natural position, then shooting hand, then TOI order. */
function assignWings(ids, roster, toi) {
  const [firstId, secondId] = [...ids].sort(
    (idA, idB) => toi.get(idB) - toi.get(idA),
  );
  /** Penalty for putting a player in a wing slot: position mismatch dominates, shooting hand breaks ties. */
  const slotCost = (id, slot) => {
    const player = roster.get(id);
    const naturalSlot = FORWARD_NATURAL[player.positionCode];
    const handedSlot = FORWARD_NATURAL[player.shootsCatches];
    return (naturalSlot === slot ? 0 : 100) + (handedSlot === slot ? 0 : 1);
  };
  const firstOnLeftCost = slotCost(firstId, 'LW') + slotCost(secondId, 'RW');
  const firstOnRightCost = slotCost(firstId, 'RW') + slotCost(secondId, 'LW');
  return firstOnRightCost < firstOnLeftCost
    ? { LW: secondId, RW: firstId }
    : { LW: firstId, RW: secondId };
}

/**
 * Picks the line's center: the clear faceoff leader, else (when nobody is a
 * natural center) the best-fitting player by positionCode C, then most
 * faceoffs, then TOI; null when the natural slots suffice.
 */
function pickCenterId(ids, roster, toi, faceoffsTaken, naturalSlot) {
  const byFaceoffs = [...ids].sort(
    (idA, idB) => faceoffsTaken(idB) - faceoffsTaken(idA),
  );
  const hasClearLeader =
    faceoffsTaken(byFaceoffs[0]) >= MIN_CENTER_FACEOFFS &&
    faceoffsTaken(byFaceoffs[0]) > faceoffsTaken(byFaceoffs[1]);
  if (hasClearLeader) return byFaceoffs[0];
  if (ids.some((id) => naturalSlot(id) === 'C')) return null;
  return [...ids].sort(
    (idA, idB) =>
      Number(roster.get(idB).positionCode === 'C') -
        Number(roster.get(idA).positionCode === 'C') ||
      faceoffsTaken(idB) - faceoffsTaken(idA) ||
      toi.get(idB) - toi.get(idA),
  )[0];
}

/**
 * Forward line slots, centered on the faceoff leader when there is one. With no
 * center pick the highest-TOI player is tried in the first slot, so for ties a
 * lone C ends up in C and extra centers move to the wings.
 */
function assignForwardSlots(ids, roster, toi, counts, naturalSlot) {
  /** Faceoffs a player has taken (0 when unknown). */
  const faceoffsTaken = (id) => counts.get(id) ?? 0;
  const centerId = pickCenterId(ids, roster, toi, faceoffsTaken, naturalSlot);
  if (centerId == null) {
    return assignSlots(ids, FORWARD_SLOT_ORDER, naturalSlot, toi);
  }
  const wings = assignWings(
    ids.filter((id) => id !== centerId),
    roster,
    toi,
  );
  return [
    { id: centerId, slot: 'C' },
    { id: wings.LW, slot: 'LW' },
    { id: wings.RW, slot: 'RW' },
  ];
}

/** The LinesContract returned when no lines can be built. */
function emptyLines() {
  return {
    source: 'none',
    game: null,
    forwardLines: [],
    defensePairs: [],
    goalies: { starterId: null },
  };
}

/** Builds the forward lines (LW-C-RW) from the forwards who played. */
function buildForwardLines(forwards, { roster, toi, counts, intervals }) {
  /** A forward's natural slot from his position code, or null. */
  const forwardNatural = (id) =>
    FORWARD_NATURAL[roster.get(id).positionCode] ?? null;
  const lineSlotOrder = ['LW', 'C', 'RW'];
  return greedyGroups(forwards, 3, MAX_FORWARD_LINES, intervals).map(
    (ids) => {
      const players = assignForwardSlots(
        ids,
        roster,
        toi,
        counts,
        forwardNatural,
      );
      return {
        players: lineSlotOrder.map((slot) =>
          players.find((player) => player.slot === slot),
        ),
        togetherSeconds: togetherSeconds(ids, intervals),
      };
    },
  );
}

/** Builds the defense pairs (LD-RD) from the defensemen who played. */
function buildDefensePairs(defense, { roster, toi, intervals }) {
  /** A defenseman's natural slot: right shot is RD, otherwise LD. */
  const defenseNatural = (id) =>
    roster.get(id).shootsCatches === 'R' ? 'RD' : 'LD';
  return greedyGroups(defense, 2, MAX_DEFENSE_PAIRS, intervals).map((ids) => ({
    players: assignSlots(ids, ['LD', 'RD'], defenseNatural, toi),
    togetherSeconds: togetherSeconds(ids, intervals),
  }));
}

/**
 * @param {{ shifts: any[], rawRoster: any, triCode: string, faceoffs?: Map<number, number>|any[] }} input
 *   faceoffs (optional): faceoffs taken per playerId, or raw faceoff plays.
 * @returns {{ forwardLines: any[], defensePairs: any[], goalies: { starterId: number|null } } | null}
 *   null when there are no usable shift rows for the team.
 */
function buildLines({ shifts, rawRoster, triCode, faceoffs }) {
  const intervals = buildIntervals(shifts, triCode);
  if (intervals.size === 0) return null;

  const roster = rosterPlayers(rawRoster);
  const counts = faceoffCounts(faceoffs);
  const toi = new Map(
    [...intervals].map(([id, playerIntervals]) => [
      id,
      totalLength(playerIntervals),
    ]),
  );
  /** Ids of players who played, in the given roster group, most ice time first. */
  const listPlayersInGroup = (group) =>
    [...intervals.keys()]
      .filter((id) => roster.get(id)?.group === group)
      .sort((idA, idB) => toi.get(idB) - toi.get(idA));
  const lineContext = { roster, toi, counts, intervals };

  const goalies = listPlayersInGroup('G');
  return {
    forwardLines: buildForwardLines(listPlayersInGroup('F'), lineContext),
    defensePairs: buildDefensePairs(listPlayersInGroup('D'), lineContext),
    goalies: { starterId: goalies.length ? goalies[0] : null },
  };
}

module.exports = {
  buildLines,
  emptyLines,
  faceoffCounts,
  isShiftRow,
  parseClock,
  SHIFT_TYPE_CODE,
};
