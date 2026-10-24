const fs = require('fs');
const path = require('path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9100;
const MIN_SECRET_LENGTH = 16;
const ENV_PREFIX = 'env:';

/**
 * Replaces every string of the form "env:NAME" with that environment
 * variable, so secrets can live in a systemd EnvironmentFile instead of the
 * JSON config. Throws naming the variable when it is unset.
 */
function resolveEnvReferences(value, env) {
  if (typeof value === 'string' && value.startsWith(ENV_PREFIX)) {
    const variableName = value.slice(ENV_PREFIX.length);
    const resolved = env[variableName];
    if (!resolved) throw new Error(`Config references unset ${variableName}.`);
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvReferences(item, env));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveEnvReferences(item, env),
      ]),
    );
  }
  return value;
}

/** Throws unless `secret` is a string long enough to be a real secret. */
function requireSecret(secret, label) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`${label} must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
}

/** Throws unless `url` is an http(s) URL. */
function requireHttpUrl(url, label) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`${label} is not a URL.`);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`${label} must be http or https.`);
  }
}

/** Validates one schedule and fills its defaults. */
function parseSchedule(schedule, appId) {
  const label = `apps.${appId}.schedules.${schedule?.id}`;
  if (!schedule?.id || typeof schedule.cron !== 'string') {
    throw new Error(`Every schedule of ${appId} needs an id and a cron.`);
  }
  requireHttpUrl(schedule.url, `${label}.url`);
  if (schedule.token !== undefined) requireSecret(schedule.token, `${label}.token`);
  return {
    id: schedule.id,
    cron: schedule.cron,
    timezone: schedule.timezone ?? 'UTC',
    url: schedule.url,
    method: schedule.method ?? 'POST',
    token: schedule.token ?? null,
    body: schedule.body ?? null,
    timeoutMs: schedule.timeoutMs ?? 120_000,
    retries: schedule.retries ?? 2,
    catchUp: schedule.catchUp === true,
  };
}

/** Validates one app (its token, VAPID keys, event webhook and schedules). */
function parseApp(app) {
  if (!app?.id || !/^[a-z0-9-]+$/.test(app.id)) {
    throw new Error('Every app needs an id of lowercase letters, digits and dashes.');
  }
  requireSecret(app.token, `apps.${app.id}.token`);
  const vapid = app.vapid ?? null;
  if (vapid && (!vapid.publicKey || !vapid.privateKey || !vapid.subject)) {
    throw new Error(`apps.${app.id}.vapid needs publicKey, privateKey and subject.`);
  }
  const events = app.events ?? null;
  if (events) {
    requireHttpUrl(events.url, `apps.${app.id}.events.url`);
    requireSecret(events.token, `apps.${app.id}.events.token`);
  }
  const schedules = (app.schedules ?? []).map((schedule) =>
    parseSchedule(schedule, app.id),
  );
  const scheduleIds = new Set(schedules.map((schedule) => schedule.id));
  if (scheduleIds.size !== schedules.length) {
    throw new Error(`apps.${app.id} has duplicate schedule ids.`);
  }
  return { id: app.id, token: app.token, vapid, events, schedules };
}

/** Parses and validates a config object (already read from JSON). */
function parseConfig(rawConfig, { env = process.env, baseDir = process.cwd() } = {}) {
  const config = resolveEnvReferences(rawConfig, env);
  const apps = (config.apps ?? []).map(parseApp);
  if (apps.length === 0) throw new Error('Config needs at least one app.');
  if (new Set(apps.map((app) => app.id)).size !== apps.length) {
    throw new Error('App ids must be unique.');
  }
  if (new Set(apps.map((app) => app.token)).size !== apps.length) {
    throw new Error('Every app needs its own token.');
  }
  return {
    host: config.listen?.host ?? DEFAULT_HOST,
    port: config.listen?.port ?? DEFAULT_PORT,
    databasePath: path.resolve(baseDir, config.databasePath ?? 'notifier.db'),
    apps,
  };
}

/** Reads the JSON config file at `configPath` and validates it. */
function loadConfig(configPath, env = process.env) {
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return parseConfig(rawConfig, { env, baseDir: path.dirname(configPath) });
}

module.exports = { loadConfig, parseConfig };
