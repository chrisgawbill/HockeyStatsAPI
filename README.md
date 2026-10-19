# HockeyStatsAPI

Independent Express API service for HockeyStatsWebApp. It fetches and maps NHL data, manages the optional filesystem/Postgres cache and normalized domain persistence, serves the board-game auth/streak endpoints, and hosts the team-history AI endpoint.

## Local setup

This service uses Node, pnpm, and Python for the AI endpoint.

```bash
pnpm install
cp .env.example .env
pnpm test
pnpm start
```

The server listens on `PORT`, defaulting to `9000`.

## Database migrations

Set `CACHE_DATABASE_URL` in `.env`, then run:

```bash
pnpm run db:migrate
```

Pending migrations also run automatically on `pnpm start`, before the server listens. When `CACHE_DATABASE_URL` is unset (filesystem-cache mode) the step is skipped; if a migration fails, the process exits non-zero and the server does not start. A Postgres advisory lock keeps concurrent instances from applying the same migration twice, and the connection uses the same SSL settings as the app (`DATABASE_CA_CERT` is required when SSL is on). `pnpm run db:migrate` still works for manual runs and fails if `CACHE_DATABASE_URL` is missing.

`DATABASE_URL` is used for normalized domain persistence when set; otherwise the service falls back to `CACHE_DATABASE_URL`. See `.env.example` for cache, database, AI, diagnostics, CORS-related deployment, and Google auth configuration.

## API

The service exposes standings, schedules, game details, teams, rosters, player statistics, stat leaders, diagnostics, team-history AI, and optional Google-authenticated features: board-game streak sync, favorite teams, and the After Action Report inbox.

After Action Reports are computed on request, not by a background job (the hosted service sleeps when idle). For each of the user's favorite teams, the service merges the current season's club schedule (12-hour cache) with the current NHL week (10-minute cache) and reports every completed game that started no more than 12 hours before the team was favorited (so favoriting mid-game or just after the final horn still counts). Only favorites (`favorite_teams`) and read receipts (`after_action_report_reads`) are stored; run `pnpm run db:migrate` to create them.

| Route | Purpose |
| --- | --- |
| `GET /api/favorites` | `{ favorites: [{ triCode, since }] }` |
| `PUT /api/favorites/:triCode` / `DELETE /api/favorites/:triCode` | Add or remove a favorite; returns `{ favorites }` |
| `GET /api/after-action-reports` | `{ reports, unreadCount }`, newest first, at most 25 |
| `POST /api/after-action-reports/:gameId/read` | Mark one report read (204) |
| `POST /api/after-action-reports/read-all` | Mark the whole inbox read |

`GET /api/favorites` and the favorites routes also return `pushMuted: boolean` per favorite. All of these require `Authorization: Bearer <session token>` from `POST /api/auth/google`. The frontend should consume these routes through its configured `VITE_API_URL`; this repository does not contain frontend or design-library code.

### Web Push for After Action Reports

Migration 004 adds `push_subscriptions`, the sent ledger `after_action_report_pushes`, and `favorite_teams.push_muted`. Push is disabled unless `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` are all set (generate keys with `npx web-push generate-vapid-keys`); `POST /api/push/dispatch` additionally needs `CRON_SECRET`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/push/config` | none | `{ enabled, publicKey }` (`false`/`null` when VAPID env is unset) |
| `POST /api/push/subscriptions` | session | Body `PushSubscription.toJSON()`; upserts by endpoint to the caller and records every report already in the inbox as sent (opt-in never pushes old reports); 204, 400 on bad input, 503 when push is unconfigured |
| `DELETE /api/push/subscriptions` | session | Body `{ endpoint }`; removes only the caller's row; 204 |
| `PUT /api/favorites/:triCode/push-mute` | session | Body `{ muted: boolean }`; returns `{ favorites }`; 404 if not a favorite |
| `POST /api/push/read` | read token | Body `{ token }` from the push payload; marks that game read; 204, 401 on a bad/expired token |
| `POST /api/push/dispatch` | `Bearer CRON_SECRET` | Sends new pushes, returns `{ users, sent, removed }`; 401 bad secret, 503 when unconfigured; rate-limited |

Dispatch refreshes each distinct favorite team's current-week schedule (bypassing the 10-minute cache), then sends one push per game per user (to all of that user's devices) for unread reports that are not in the ledger, started within the last 12 hours, and involve at least one unmuted favorite. The ledger row is claimed before sending, so overlapping runs cannot double send; a 404/410 from the push service deletes that subscription. Read tokens are 30-day JWTs (`purpose: "aar-read"`) signed with `SESSION_JWT_SECRET`; they are rejected as session tokens and vice versa. Nothing runs on a timer inside the API.

The workflow `.github/workflows/after-action-push.yml` runs `bin/aar-push-cron.js` every 10 minutes (16:00-08:59 UTC) and on manual dispatch. The script checks the public NHL scoreboard and only calls the API when a game is live or went final within 4.5 hours (it dispatches anyway if the scoreboard is unreachable). Add the GitHub repository secrets `CRON_SECRET` (same value as the API env) and `AAR_PUSH_API_URL` (the API base URL, no trailing path). Scheduled workflows run only from the default branch (`main`), and GitHub disables them after 60 days without repository activity, so re-enable the workflow from the Actions tab in October when the season restarts.

## Deployment

Recommended Render Web Service commands:

- Build: `pnpm install --frozen-lockfile && python3 -m pip install -r requirements.txt`
- Start: `pnpm start` (applies pending database migrations, then starts the server; no pre-deploy command is needed)

Configure secrets and runtime values in Render's environment settings. Do not commit `.env` or credentials.
