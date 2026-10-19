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

All of these require `Authorization: Bearer <session token>` from `POST /api/auth/google`. The frontend should consume these routes through its configured `VITE_API_URL`; this repository does not contain frontend or design-library code.

## Deployment

Recommended Render Web Service commands:

- Build: `pnpm install --frozen-lockfile && python3 -m pip install -r requirements.txt`
- Start: `pnpm start` (applies pending database migrations, then starts the server; no pre-deploy command is needed)

Configure secrets and runtime values in Render's environment settings. Do not commit `.env` or credentials.
