const { firstValue, toInteger } = require('#platform/fieldValue.js');

function splitFullName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function nameFromParts(firstName, lastName) {
  return [firstName, lastName].filter(Boolean).join(' ') || null;
}

function buildSeason(seasonId, sourcePayload = {}) {
  return {
    seasonId,
    sourcePayload,
  };
}

function buildTeam(rawTeam = {}, fallback = {}) {
  const teamId = toInteger(
    firstValue(
      fallback.teamId,
      rawTeam.teamId?.id,
      rawTeam.teamId,
      rawTeam.id,
      rawTeam.team?.id,
      rawTeam.teamCommonName?.id,
    ),
  );
  if (!teamId) return null;

  const triCode = firstValue(
    fallback.triCode,
    rawTeam.triCode,
    rawTeam.teamTriCode,
    rawTeam.teamAbbrev,
    rawTeam.teamAbbreviation,
    rawTeam.abbrev,
    rawTeam.team?.abbrev,
    rawTeam.franchiseTriCode,
  );

  return {
    teamId,
    triCode: triCode || String(teamId),
    franchiseId: toInteger(
      firstValue(fallback.franchiseId, rawTeam.franchiseId),
    ),
    fullName: firstValue(
      fallback.fullName,
      rawTeam.fullName,
      rawTeam.teamFullName,
      rawTeam.teamName,
      rawTeam.name,
      rawTeam.team?.name,
    ),
    commonName: firstValue(
      fallback.commonName,
      rawTeam.commonName,
      rawTeam.teamCommonName,
      rawTeam.teamName,
      rawTeam.team?.commonName,
    ),
    placeName: firstValue(
      fallback.placeName,
      rawTeam.placeName,
      rawTeam.teamPlaceName,
    ),
    logoUrl: firstValue(
      fallback.logoUrl,
      rawTeam.logoUrl,
      rawTeam.logo,
      rawTeam.teamLogo,
    ),
    primaryColor: fallback.primaryColor ?? null,
    secondaryColor: fallback.secondaryColor ?? null,
    sourcePayload: rawTeam,
  };
}

function buildPlayer(rawPlayer = {}, fallback = {}) {
  const playerId = toInteger(
    firstValue(
      fallback.playerId,
      rawPlayer.playerId,
      rawPlayer.goalieId,
      rawPlayer.skaterId,
      rawPlayer.id,
    ),
  );
  if (!playerId) return null;

  const firstName = firstValue(fallback.firstName, rawPlayer.firstName);
  const lastName = firstValue(fallback.lastName, rawPlayer.lastName);
  const fullName =
    firstValue(
      fallback.fullName,
      rawPlayer.fullName,
      rawPlayer.skaterFullName,
      rawPlayer.goalieFullName,
      rawPlayer.name,
      nameFromParts(firstName, lastName),
    ) ?? null;
  const split = splitFullName(fullName);

  return {
    playerId,
    firstName: firstName ?? split.firstName,
    lastName: lastName ?? split.lastName,
    fullName,
    headshotUrl: firstValue(
      fallback.headshotUrl,
      rawPlayer.headshot,
      rawPlayer.headshotUrl,
    ),
    heroImageUrl: firstValue(fallback.heroImageUrl, rawPlayer.heroImage),
    birthDate: firstValue(fallback.birthDate, rawPlayer.birthDate),
    nationalityCode: firstValue(
      fallback.nationalityCode,
      rawPlayer.nationalityCode,
    ),
    shootsCatches: firstValue(
      fallback.shootsCatches,
      rawPlayer.shootsCatches,
      rawPlayer.shootsCatchesCode,
    ),
    positionCode: firstValue(
      fallback.positionCode,
      rawPlayer.positionCode,
      rawPlayer.position,
    ),
    sourcePayload: rawPlayer,
  };
}

module.exports = {
  splitFullName,
  nameFromParts,
  buildSeason,
  buildTeam,
  buildPlayer,
};
