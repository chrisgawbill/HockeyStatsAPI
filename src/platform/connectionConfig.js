var fs = require('fs');

function getCaCert() {
  const raw = process.env.DATABASE_CA_CERT;
  if (!raw) {
    return undefined;
  }

  if (raw.includes('-----BEGIN CERTIFICATE-----')) {
    return raw;
  }
  return fs.readFileSync(raw, 'utf-8');
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.CACHE_DATABASE_URL;
}

function getSslConfig() {
  if (process.env.CACHE_DATABASE_SSL === 'false') {
    return false;
  }

  if (
    process.env.NODE_ENV === 'production' ||
    process.env.CACHE_DATABASE_SSL === 'true'
  ) {
    const ca = getCaCert();
    if (!ca) {
      throw new Error(
        'SSL is enabled but no CA certificate was provided. Please set the DATABASE_CA_CERT environment variable.',
      );
    }

    return { ca, rejectUnauthorized: true };
  }
  return undefined;
}

module.exports = {
  getDatabaseUrl,
  getSslConfig,
};
