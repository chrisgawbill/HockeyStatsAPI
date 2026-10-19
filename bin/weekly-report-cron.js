#!/usr/bin/env node
/**
 * GitHub Actions entry point for the Monday Weekly Player Report. The
 * workflow fires at 13:05 and 14:05 UTC so one run lands at or after 9:00
 * America/New_York in both EDT and EST; a scheduled run before 9:00 ET (or
 * not on a Monday) exits without calling the API. The API's ledger keeps the
 * second run from sending twice. Manual runs (FORCE=1) always dispatch.
 *
 * Env: CRON_SECRET, AAR_PUSH_API_URL, optional FORCE, optional WEEK_START.
 */
const {
  easternClock,
} = require('../src/slices/weeklyPlayerReports/weeklyReportBuilder.js');

const SEND_HOUR_ET = 9;
const DISPATCH_TIMEOUT_MS = 120 * 1000;

/** True on a Monday at or after 9:00 Eastern. */
function isSendWindow(nowMs = Date.now()) {
  const { date, hour } = easternClock(nowMs);
  const isMonday = new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
  return isMonday && hour >= SEND_HOUR_ET;
}

async function callWeeklyDispatch(baseUrl, secret, weekStart) {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/push/weekly-dispatch`;
  const body = weekStart ? JSON.stringify({ weekStart }) : undefined;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      const text = await response.text();
      if (response.status >= 500) {
        lastError = new Error(
          `weekly dispatch responded ${response.status}: ${text}`,
        );
        console.error(`Attempt ${attempt}: ${lastError.message}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `weekly dispatch responded ${response.status}: ${text}`,
        );
      }
      return JSON.parse(text);
    } catch (error) {
      if (error.message.startsWith('weekly dispatch responded')) throw error;
      lastError = error;
      console.error(`Attempt ${attempt}: ${error.message}`);
    }
  }
  throw lastError;
}

async function main() {
  const secret = process.env.CRON_SECRET;
  const apiUrl = process.env.AAR_PUSH_API_URL;
  if (!secret || !apiUrl) {
    console.error(
      'Missing CRON_SECRET or AAR_PUSH_API_URL. Add both as GitHub repository secrets.',
    );
    process.exit(1);
  }
  const force = process.env.FORCE === '1' || process.env.FORCE === 'true';
  if (!force && !isSendWindow()) {
    console.log('Before Monday 9:00 ET; skipping this run.');
    return;
  }
  const result = await callWeeklyDispatch(
    apiUrl,
    secret,
    process.env.WEEK_START || undefined,
  );
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Weekly dispatch failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { isSendWindow };
