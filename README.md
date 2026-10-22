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

The service exposes standings, schedules, game details, teams, rosters, player statistics, stat leaders, diagnostics, team-history AI, and optional Google-authenticated features: board-game streak sync, favorite teams, the After Action Report inbox, favorite players, and the Weekly Player Report.

After Action Reports are computed on request, not by a background job (the hosted service sleeps when idle). For each of the user's favorite teams, the service merges the current season's club schedule (12-hour cache) with the current NHL week (10-minute cache) and reports every completed game that started no more than 12 hours before the team was favorited (so favoriting mid-game or just after the final horn still counts). Only favorites (`favorite_teams`) and read receipts (`after_action_report_reads`) are stored; run `pnpm run db:migrate` to create them.

| Route | Purpose |
| --- | --- |
| `GET /api/favorites` | `{ favorites: [{ triCode, since, pushMuted, tier, label }] }` |
| `PUT /api/favorites/:triCode` / `DELETE /api/favorites/:triCode` | Add or remove a favorite; returns `{ favorites }` (re-PUT keeps tier and label); 409 past 5 teams (accounts already over 5 keep theirs) |
| `PATCH /api/favorites/:triCode` | Body `{ tier?, label? }` (at least one); returns `{ favorites }`; 400 bad tier/label/empty body/bad code, 404 if not a favorite |
| `GET /api/after-action-reports` | `{ reports, unreadCount }`, newest first, at most 25 |
| `POST /api/after-action-reports/:gameId/read` | Mark one report read (204) |
| `POST /api/after-action-reports/read-all` | Mark the whole inbox read |

`GET /api/favorites` and the favorites routes also return `pushMuted: boolean` per favorite. Every favorite team and favorite player also carries a fan category (migration 006, display only: no effect on reports or push): `tier` is `diehard`, `fan` (default for new and existing favorites) or `curious`, and `label` is optional free text (emoji allowed) or `null`. `PATCH` trims the label, caps it at 24 user-perceived characters, and treats `null` or an empty string as clearing it. All of these require `Authorization: Bearer <session token>` from `POST /api/auth/google`. The frontend should consume these routes through its configured `VITE_API_URL`; this repository does not contain frontend or design-library code.

`GET /team/lines/:triCode?season=` returns forward lines, defense pairs and the starting goalie derived from the team's most recent completed game's NHL shift chart (`source: "shifts"`, or `source: "none"` with empty arrays when there is no completed game or the chart is unavailable). Every response is built from a single `gameId`. To keep the NHL call budget low it reuses the existing schedule caches (10-minute current-week cache, 12-hour season cache) and the roster cache, and fetches one shift chart per game from `api.nhle.com` plus one play-by-play per game from `api-web.nhle.com` (about 2 NHL calls per game; faceoffs taken pick each line's center, falling back to roster positions if the play-by-play is unavailable, and only the faceoff plays are cached): official (`OFF`) charts and faceoff data are cached permanently and shared by both teams, while `FINAL`-but-not-official games use a 5-minute cache. Empty charts are never cached permanently, and only raw NHL payloads are cached (lines are computed on read).

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

### Favorite players and the Weekly Player Report

After Action Report pushes also highlight the user's favorite skaters who scored in that game: goals, assists, multi-point games, and hat tricks. Highlights precede the final score; players are matched by NHL player ID against the cached game boxscore, shared across users during dispatch. With no scoring favorites or an unavailable boxscore, the notification shows the final score. Game eligibility and team mute settings are unchanged.

Migration 005 adds `favorite_players` (at most 10 per user), the frozen `weekly_player_reports` (one per user per week, payload stored as JSON so reopening never re-fetches), the sent ledger `weekly_player_report_pushes`, and `users.weekly_report_push` (default on).

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/favorite-players` | session | `{ favorites: [{ playerId, name, teamTriCode, position, headshot, since, tier, label }] }` |
| `PUT /api/favorite-players/:playerId` / `DELETE ...` | session | Add (validated against the NHL player landing, 24-hour cache) or remove; returns `{ favorites }`; 400 bad id, 404 unknown player, 409 past 10; re-PUT keeps tier and label |
| `PATCH /api/favorite-players/:playerId` | session | Body `{ tier?, label? }` (at least one); returns `{ favorites }`; 400 bad tier/label/empty body/bad id, 404 if not a favorite |
| `GET /api/weekly-player-reports` | session | `{ reports, unreadCount }`, newest first, at most 12 |
| `GET /api/weekly-player-reports/:weekStart` | session | One report (404 when none) |
| `POST /api/weekly-player-reports/:weekStart/read` | session | Mark read (204) |
| `GET` / `PUT /api/push/weekly-report` | session | `{ enabled }`; the one on/off switch for the weekly push (400 unless boolean) |
| `POST /api/push/weekly-dispatch` | `Bearer CRON_SECRET` | Optional body `{ weekStart }` (a completed Monday week; default last week). Returns `{ weekStart, skipped?, created, users, sent, removed }`; 502 when the NHL is unavailable (nothing is created) |

A report covers Monday 00:00 to Sunday 23:59 America/New_York. Each report holds `weekStart`, `weekEnd`, `label` (`Oct 13–19`), `headline`, and `players[]` with `playerId`, `name`, `position`, `headshot`, `team`, `teams` (several after a trade), `type` (`skater`/`goalie`), `played`, `teamGames` (the stored team's games that week, for "Did not play"), and `stats`: skaters `{ gp, goals, assists, points, plusMinus, shots, toiPerGame, bestGame: { gameId, text } | null }`, goalies `{ gp, wins, losses, otLosses, record, savePct, gaa, shutouts }`, `null` when the player did not play.

The dispatch fetches the league schedule for the week (`/schedule/{monday}`); if no regular-season or playoff game was completed, it is a league break and returns `{ skipped: "league-break" }` with nothing created or sent. Otherwise it makes one stats REST per-game query for every distinct favorited skater and one for goalies across all users (paged), caches the raw payloads under week-keyed keys, and stores a report for each user unless none of their players or their teams played. Existing reports are never replaced. It then pushes each unread new report once (ledger claimed before sending) to users with a subscribed device and the switch on. Push payload: `{ kind: "weekly-report", title: "Weekly Player Report · Oct 13–19", body: <headline>, weekStart, tag: "wpr-<weekStart>", readToken }`. The read token (`purpose: "wpr-read"`, 30 days) is accepted by `POST /api/push/read`. Subscribing a device seeds this ledger with the user's existing reports. The NHL schedule and stats payload shapes are assumptions; spot-check the first real report.

`.github/workflows/weekly-player-report.yml` runs `bin/weekly-report-cron.js` on Mondays at 13:05 and 14:05 UTC; the script only dispatches at or after 9:00 Eastern, so exactly one run counts in both EDT and EST (the ledger also prevents a second send). It uses the same `CRON_SECRET` and `AAR_PUSH_API_URL` secrets. A manual run always dispatches and accepts an optional `week_start`.

## Deployment

For deployment on this server through Jenkins and systemd, see
[Jenkins setup](docs/jenkins.md).

Recommended Render Web Service commands:

- Build: `pnpm install --frozen-lockfile && python3 -m pip install -r requirements.txt`
- Start: `pnpm start` (applies pending database migrations, then starts the server; no pre-deploy command is needed)

Configure secrets and runtime values in Render's environment settings. Do not commit `.env` or credentials.
