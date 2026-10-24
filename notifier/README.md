# Notifier

A small, project-agnostic service for the dev server that does two things
reliably for any number of apps:

1. **Web Push delivery queue.** An app posts messages (a browser
   `PushSubscription` plus a payload) and gets `202` once they are stored in
   SQLite. A background worker sends them with that app's VAPID keys and
   retries rate limits, push-service errors, network failures and timeouts
   with exponential backoff (15 s doubling to 30 min, honouring
   `Retry-After`) until the message's TTL runs out. A `404`/`410` from the push
   service is reported back to the app's webhook as `subscription.gone`
   (retried for 24 hours) so the app can delete that subscription.
2. **HTTP scheduler.** Cron-style jobs that call an app URL (for example a
   "dispatch" route) with a bearer token, in any IANA time zone. Failed calls
   are retried a few times, every run is recorded, and a job marked `catchUp`
   runs once at startup if the service was down at its last scheduled time.
   This replaces GitHub Actions cron, which runs late or skips runs under
   load and turns itself off after 60 days without repository activity.

Nothing in here knows about any particular project. Apps are entries in the
config file.

It lives in the HockeyStatsAPI repository for now. It imports nothing from
the API, so it can be moved to its own repository as-is.

## Requirements

Node 22.13 or later (it uses the built-in `node:sqlite`) and pnpm. There are
no native modules.

## Config

`NOTIFIER_CONFIG` (default `./notifier.json`) points to a JSON file; see
`notifier.example.json`. Any string `"env:NAME"` is replaced by that
environment variable, so secrets can live in a systemd `EnvironmentFile`
rather than in the JSON.

| Key | Meaning |
| --- | --- |
| `listen.host` / `listen.port` | Default `127.0.0.1:9100`. Keep it on localhost unless apps run on other machines. |
| `databasePath` | SQLite file, relative to the config file. Default `notifier.db`. |
| `apps[].id` | Lowercase letters, digits and dashes. |
| `apps[].token` | The bearer token this app uses to call the notifier (16+ characters, unique per app). |
| `apps[].vapid` | `{ publicKey, privateKey, subject }`, the same key pair the app's browsers subscribed with. Omit it for an app that only uses schedules. |
| `apps[].events` | Optional `{ url, token }`: where to POST events such as `subscription.gone`, with `Authorization: Bearer <token>`. |
| `apps[].schedules[]` | `{ id, cron, url }` plus optional `timezone` (default `UTC`), `method` (`POST`), `token`, `body` (JSON), `timeoutMs` (120000), `retries` (2; waits 30 s, 2 min, then 5 min), `catchUp` (false). Cron supports an optional seconds field. |

Generate secrets with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## HTTP API

Every route except `/health` needs `Authorization: Bearer <app token>`, and an
app only sees its own messages and schedules.

| Route | Purpose |
| --- | --- |
| `POST /v1/messages` | Body `{ messages: [...] }` (1-500). Each has `subscription` (`PushSubscription.toJSON()`: https `endpoint`, `keys.p256dh`, `keys.auth`), `payload` (object or string, up to 4000 bytes), optional `ttlSeconds` (default 86400, max 28 days), `urgency` (`very-low`/`low`/`normal`/`high`, default `normal`), `topic` (up to 32 URL-safe characters; a newer message with the same topic replaces an undelivered one on the push service), and `dedupeKey` (re-posting a key the app already used returns the original id instead of queueing it again, so an app can safely retry). Returns `202 { ids }`; `409` when the app has no VAPID keys. |
| `GET /v1/messages/:id` | `{ id, status, attempts, createdAt, updatedAt, lastError }`. Status is `queued`, `delivered`, `gone`, `failed` (rejected with a 4xx that retrying cannot fix) or `expired` (TTL or 10 attempts used up). |
| `POST /v1/schedules/:id/run` | Runs one of the app's schedules now and returns `{ outcome, httpStatus, detail }`. |
| `GET /health` | `{ ok, queuedMessages, oldestQueuedAgeSeconds, pendingEvents, schedules: [{ app, id, cron, timezone, nextRunAt, lastRun }] }`. A large `oldestQueuedAgeSeconds` means pushes are stuck. |

Event webhook body: `{ "type": "subscription.gone", "endpoint": "...", "messageId": 1 }`.
A `2xx` response acknowledges it. `408`, `429` and `5xx` are retried, and any
other status drops the event.

Delivery is at least once. If the process dies between a successful send and
recording it, that message is sent again after restart. Give payloads a
notification `tag` so the device shows one notification either way.
Finished messages, events and runs are pruned after 30 days.

## Install on the dev server

```bash
# 1. Code. Clone where the systemd unit expects it, or edit WorkingDirectory.
git clone https://github.com/chrisgawbill/HockeyStatsAPI.git ~/projects/notifier
cd ~/projects/notifier/notifier && pnpm install --frozen-lockfile && pnpm test

# 2. Config and secrets, readable by chris_dev only.
sudo mkdir -p /etc/notifier
sudo cp notifier.example.json /etc/notifier/notifier.json
sudo tee /etc/notifier/notifier.env >/dev/null <<'ENV'
HOCKEYSTATS_NOTIFIER_TOKEN=<new random secret>
HOCKEYSTATS_NOTIFIER_CALLBACK_SECRET=<new random secret>
HOCKEYSTATS_CRON_SECRET=<the API's CRON_SECRET>
HOCKEYSTATS_VAPID_PUBLIC_KEY=<the API's VAPID_PUBLIC_KEY>
HOCKEYSTATS_VAPID_PRIVATE_KEY=<the API's VAPID_PRIVATE_KEY>
HOCKEYSTATS_VAPID_SUBJECT=<the API's VAPID_SUBJECT>
ENV
sudo chown -R chris_dev: /etc/notifier && sudo chmod 600 /etc/notifier/*

# 3. Service. Check that `which node` matches ExecStart first.
sudo cp deploy/notifier.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now notifier
curl -s http://127.0.0.1:9100/health
journalctl -u notifier -f
```

To update: `git pull && pnpm install --frozen-lockfile && sudo systemctl restart notifier`.
A restart is safe because queued work is in SQLite. Back up
`/var/lib/notifier/notifier.db` only if you care about history; queued
messages are short-lived.

## Adding another project

Add an entry under `apps` with its own token (and VAPID keys if it sends
push), point its schedules at its routes, and restart. In the project, POST
to `/v1/messages` instead of calling `web-push` directly, and handle
`subscription.gone` on its events URL.

## Tests

`pnpm test` (Node's test runner; uses an in-memory SQLite database and stub
push/HTTP calls).
