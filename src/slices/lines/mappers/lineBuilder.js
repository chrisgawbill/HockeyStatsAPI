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

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isShiftRow(row) {
  if (!row || row.playerId == null) return false;
  if (row.typeCode != null && Number(row.typeCode) !== SHIFT_TYPE_CODE) {
    return false;
  }
  return row.eventDescription == null;
}

/** Merge sorted-or-not [start,end) intervals into a disjoint sorted list. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (s < e) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

function total(intervals) {
  return intervals.reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** Map playerId -> merged on-ice intervals for one team. */
function buildIntervals(shifts, triCode) {
  const byPlayer = new Map();
  for (const row of shifts ?? []) {
    if (!isShiftRow(row)) continue;
    if (row.teamAbbrev && row.teamAbbrev !== triCode) continue;
    const start = parseClock(row.startTime);
    const end = parseClock(row.endTime);
    const period = Number(row.period);
    if (start == null || end == null || !Number.isFinite(period)) continue;
    if (end <= start) continue;
    const base = period * PERIOD_STRIDE;
    const id = Number(row.playerId);
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push([base + start, base + end]);
  }
  for (const [id, list] of byPlayer) byPlayer.set(id, mergeIntervals(list));
  return byPlayer;
}

function rosterPlayers(rawRoster) {
  const tag = (list, group) =>
    (list ?? []).map((p) => ({
      id: Number(p.id),
      positionCode: p.positionCode,
      shootsCatches: p.shootsCatches,
      group,
    }));
  return new Map(
    [
      ...tag(rawRoster?.forwards, 'F'),
      ...tag(rawRoster?.defensemen, 'D'),
      ...tag(rawRoster?.goalies, 'G'),
    ].map((p) => [p.id, p]),
  );
}

function combinations(items, size) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === size) return out.push([...acc]);
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

/**
 * Greedily group `pool` (sorted by TOI desc) into groups of `size`, each time
 * taking the group with max sum of pairwise overlaps. Ties keep pool order.
 */
function greedyGroups(pool, size, maxGroups, intervals) {
  const pairCache = new Map();
  const pair = (a, b) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!pairCache.has(k)) {
      pairCache.set(k, total(intersect(intervals.get(a), intervals.get(b))));
    }
    return pairCache.get(k);
  };
  let remaining = [...pool];
  const groups = [];
  while (groups.length < maxGroups && remaining.length >= size) {
    let best = null;
    let bestScore = -1;
    for (const combo of combinations(remaining, size)) {
      let score = 0;
      for (let i = 0; i < combo.length; i++) {
        for (let j = i + 1; j < combo.length; j++) {
          score += pair(combo[i], combo[j]);
        }
      }
      if (score > bestScore) {
        best = combo;
        bestScore = score;
      }
    }
    if (!best) break;
    groups.push(best);
    remaining = remaining.filter((id) => !best.includes(id));
  }
  return groups;
}

function together(ids, intervals) {
  let acc = intervals.get(ids[0]);
  for (const id of ids.slice(1)) acc = intersect(acc, intervals.get(id));
  return Math.round(total(acc));
}

/** Pick the slot permutation with the fewest off-position players. */
function assignSlots(ids, slots, naturalSlot, toi) {
  const sorted = [...ids].sort((a, b) => toi.get(b) - toi.get(a));
  let best = null;
  let bestCost = Infinity;
  for (const perm of permutations(slots)) {
    let cost = 0;
    sorted.forEach((id, i) => {
      if (naturalSlot(id) !== perm[i]) cost++;
    });
    if (cost < bestCost) {
      best = perm;
      bestCost = cost;
    }
  }
  const bySlot = new Map(sorted.map((id, i) => [best[i], id]));
  return slots.map((slot) => ({ id: bySlot.get(slot), slot }));
}

// Highest-TOI player prefers the "first" slot tried, so for ties a lone C ends
// up in C and extra centers move to the wings.
const FORWARD_SLOT_ORDER = ['C', 'LW', 'RW'];
const FORWARD_NATURAL = { C: 'C', L: 'LW', R: 'RW' };

function emptyLines() {
  return {
    source: 'none',
    game: null,
    forwardLines: [],
    defensePairs: [],
    goalies: { starterId: null },
  };
}

/**
 * @param {{ shifts: any[], rawRoster: any, triCode: string }} input
 * @returns {{ forwardLines: any[], defensePairs: any[], goalies: { starterId: number|null } } | null}
 *   null when there are no usable shift rows for the team.
 */
function buildLines({ shifts, rawRoster, triCode }) {
  const intervals = buildIntervals(shifts, triCode);
  if (intervals.size === 0) return null;

  const roster = rosterPlayers(rawRoster);
  const toi = new Map([...intervals].map(([id, list]) => [id, total(list)]));
  const onRoster = (group) =>
    [...intervals.keys()]
      .filter((id) => roster.get(id)?.group === group)
      .sort((a, b) => toi.get(b) - toi.get(a));

  const forwards = onRoster('F');
  const defense = onRoster('D');
  const goalies = onRoster('G');

  const forwardNatural = (id) =>
    FORWARD_NATURAL[roster.get(id).positionCode] ?? null;
  const forwardLines = greedyGroups(
    forwards,
    3,
    MAX_FORWARD_LINES,
    intervals,
  ).map((ids) => {
    const players = assignSlots(ids, FORWARD_SLOT_ORDER, forwardNatural, toi);
    const order = ['LW', 'C', 'RW'];
    return {
      players: order.map((slot) => players.find((p) => p.slot === slot)),
      togetherSeconds: together(ids, intervals),
    };
  });

  const defenseNatural = (id) =>
    roster.get(id).shootsCatches === 'R' ? 'RD' : 'LD';
  const defensePairs = greedyGroups(
    defense,
    2,
    MAX_DEFENSE_PAIRS,
    intervals,
  ).map((ids) => ({
    players: assignSlots(ids, ['LD', 'RD'], defenseNatural, toi),
    togetherSeconds: together(ids, intervals),
  }));

  return {
    forwardLines,
    defensePairs,
    goalies: { starterId: goalies.length ? goalies[0] : null },
  };
}

module.exports = {
  buildLines,
  emptyLines,
  isShiftRow,
  parseClock,
  SHIFT_TYPE_CODE,
};
