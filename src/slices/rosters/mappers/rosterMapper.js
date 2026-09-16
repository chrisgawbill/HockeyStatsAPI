/**
 * rosterMapper
 *
 * Flattens the NHL roster (forwards/defensemen/goalies) into a single, stable
 * list of RosterPlayerContract entries.
 * Field sourcing mirrors react/src/Data/Helpers ../Pages/TeamPage.tsx transformRoster.
 *
 * Scope note: keeps the raw position CODE (C/L/R/D/G). The "Center"/"Left Wing"
 * display labels (POS_MAP) and TOI formatting stay on the frontend. TOI itself
 * comes from a DIFFERENT endpoint (skater/goalie summary), so it is NOT included
 * here — the frontend merges it in by player id.
 */

/**
 * @typedef {Object} RosterPlayerContract
 * @property {number} id
 * @property {string} name          - "firstName.default lastName.default", trimmed
 * @property {number} number        - sweaterNumber (defensive: 0 if missing)
 * @property {string} position      - raw positionCode: C | L | R | D | G
 * @property {string} headshot      - "" if missing
 */

/**
 * @typedef {Object} RosterContract
 * @property {RosterPlayerContract[]} players
 */

/**
 * Map one raw NHL roster player (from any position bucket) into a contract.
 * @param {any} rawPlayer
 * @returns {RosterPlayerContract}
 */
function mapRosterPlayer(rawPlayer) {
  const id = rawPlayer.id;
  const name =
    `${rawPlayer.firstName?.default ?? ''} ${rawPlayer.lastName?.default ?? ''}`.trim();
  const number = rawPlayer.sweaterNumber ?? 0;
  const position = rawPlayer.positionCode ?? '';
  const headshot = rawPlayer.headshot ?? '';

  return { id, name, number, position, headshot };
}

/**
 * Flatten the raw NHL roster into a RosterContract.
 * @param {any} rawRoster - { forwards, defensemen, goalies }
 * @returns {RosterContract}
 */
function mapRoster(rawRoster) {
  const all = [
    ...(rawRoster?.forwards ?? []),
    ...(rawRoster?.defensemen ?? []),
    ...(rawRoster?.goalies ?? []),
  ];
  const players = all.map(mapRosterPlayer);

  return { players };
}

module.exports = { mapRoster, mapRosterPlayer };
