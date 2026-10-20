const fs = require('fs');

/** Reads the CA certificate from DATABASE_CA_CERT, which holds either the PEM text or a file path. */
function getCaCert() {
  const caCertSetting = process.env.DATABASE_CA_CERT;
  if (!caCertSetting) {
    return undefined;
  }

  if (caCertSetting.includes('-----BEGIN CERTIFICATE-----')) {
    return caCertSetting;
  }
  return fs.readFileSync(caCertSetting, 'utf-8');
}

/** Returns the application database URL, falling back to the cache database URL. */
function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.CACHE_DATABASE_URL;
}

/** Builds the pg `ssl` option from env: false when disabled, a verified CA config in production, else undefined. */
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
