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

Migrations live in `src/platform/migrations` and run in filename order. Each is either a `.sql` file or a `.js` module exporting `async up(client)`; both run inside one transaction together with their `schema_migrations` row, so a failure leaves nothing applied.

Migration 009 (`009_add_user_identities.js`) moves sign-in identities into `user_identities` (`provider` `google`/`discord`, `subject`, unique per pair) and drops `users.google_sub`, `users.discord_id` and the plaintext `users.email`. User ids do not change, so favorites, push subscriptions, streaks and reports stay attached. It also encrypts any plaintext email still left from before migration 008 (this replaces the old start-up `db:encrypt-emails` step, which is gone); `EMAIL_ENCRYPTION_KEY` and `EMAIL_LOOKUP_KEY` are needed only when such rows exist, and the migration fails naming those variables otherwise. `email_lookup` becomes unique: where several users share one, the lowest user id keeps it and the others keep only their encrypted email (no accounts are merged).

To roll back 009: take a `pg_dump` before deploying it. If needed, run `node bin/rollback-009.js` (same `.env`, `CACHE_DATABASE_URL` and SSL settings as `db:migrate`; needs `EMAIL_ENCRYPTION_KEY` when emails are stored). In one transaction it restores `google_sub`, `discord_id` and plaintext `email` (decrypted) with their old constraints and index, drops `user_identities` and removes 009 from `schema_migrations`. Then revert the change on `main` and redeploy; otherwise the next start re-applies 009. A user who linked two identities of one provider keeps the oldest, and lookups cleared by 009 stay empty; restore the dump if that matters.

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

`GET /api/favorites` and the favorites routes also return `pushMuted: boolean` per favorite. Every favorite team and favorite player also carries a fan category (migration 006, display only: no effect on reports or push): `tier` is `diehard`, `fan` (default for new and existing favorites) or `curious`, and `label` is optional free text (emoji allowed) or `null`. `PATCH` trims the label, caps it at 24 user-perceived characters, and treats `null` or an empty string as clearing it. All of these require `Authorization: Bearer <session token>` from `POST /api/auth/google` or `POST /api/auth/discord`. The frontend should consume these routes through its configured `VITE_API_URL`; this repository does not contain frontend or design-library code.

`GET /team/lines/:triCode?season=` returns forward lines, defense pairs and the starting goalie derived from the team's most recent completed game's NHL shift chart (`source: "shifts"`, or `source: "none"` with empty arrays when there is no completed game or the chart is unavailable). Every response is built from a single `gameId`. To keep the NHL call budget low it reuses the existing schedule caches (10-minute current-week cache, 12-hour season cache) and the roster cache, and fetches one shift chart per game from `api.nhle.com` plus one play-by-play per game from `api-web.nhle.com` (about 2 NHL calls per game; faceoffs taken pick each line's center, falling back to roster positions if the play-by-play is unavailable, and only the faceoff plays are cached): official (`OFF`) charts and faceoff data are cached permanently and shared by both teams, while `FINAL`-but-not-official games use a 5-minute cache. Empty charts are never cached permanently, and only raw NHL payloads are cached (lines are computed on read).

### Sign-in (Google and Discord)

| Route | Body | Response |
| --- | --- | --- |
| `POST /api/auth/google` | `{ credential }` (Google Identity Services ID token) | `{ token, email }` |
| `POST /api/auth/discord` | `{ code, codeVerifier, redirectUri }` | `{ token, email }` |
| `GET /api/auth/me` | `Authorization: Bearer <session token>` | `{ email }` |

Discord uses the authorization code flow with PKCE (scopes `identify email`): the frontend sends the user to Discord with an S256 `code_challenge`, then posts the code with its `codeVerifier` (43-128 characters of `A-Z a-z 0-9 - . _ ~`, RFC 7636) and a `redirectUri` listed in `DISCORD_REDIRECT_URIS`. The API exchanges it with `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET`; the Discord token is never stored or returned. A missing or invalid field is a 400; any provider failure is a 401 with the fixed message `Invalid Google credential.` or `Invalid Discord authorization.`

Each Google or Discord identity maps to one account in `user_identities`. A new identity joins an existing account only when its email is verified (Google `email_verified`, Discord `verified`) and matches that account's verified email; otherwise it gets a new account. An unverified email never links accounts (an unverified Discord email is not stored at all). On a returning sign-in a changed verified email replaces the account's email unless another account already holds it. Emails are stored encrypted (`email_encrypted`) with a keyed hash (`email_lookup`) for matching, and are never logged.

### Web Push for After Action Reports

Migration 004 adds `push_subscriptions`, the sent ledger `after_action_report_pushes`, and `favorite_teams.push_muted`. Push is disabled unless `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` are all set (generate keys with `npx web-push generate-vapid-keys`); `POST /api/push/dispatch` additionally needs `CRON_SECRET`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/push/config` | none | `{ enabled, publicKey }` (`false`/`null` when VAPID env is unset) |
| `POST /api/push/subscriptions` | session | Body `PushSubscription.toJSON()`; upserts by endpoint to the caller. A device new to the account records every report already in the inbox as sent (opt-in never pushes old reports); re-sending a device the account already has (the web app re-syncs on every load) changes nothing else. 204, 400 on bad input, 503 when push is unconfigured |
| `DELETE /api/push/subscriptions` | session | Body `{ endpoint }`; removes only the caller's row; 204 |
| `GET` / `PUT /api/push/notifications` | session | `{ enabled }`; the account-wide switch (migration 010, default on). Off sends nothing to any of the user's devices; turning it back on records the current inbox as sent. 400 unless boolean |
| `PUT /api/favorites/:triCode/push-mute` | session | Body `{ muted: boolean }`; returns `{ favorites }`; 404 if not a favorite |
| `POST /api/push/read` | read token | Body `{ token }` from the push payload; marks that game read; 204, 401 on a bad/expired token |
| `POST /api/push/dispatch` | `Bearer CRON_SECRET` | Sends new pushes, returns `{ users, sent, removed }` (or `{ skipped: "no-active-games", ... }`); 401 bad secret, 503 when unconfigured; rate-limited |
| `POST /api/push/notifier-events` | `Bearer NOTIFIER_CALLBACK_SECRET` | Events from the notifier: `{ type: "subscription.gone", endpoint }` deletes that subscription; unknown types are ignored; 204, 400 without an endpoint, 401 bad secret, 503 when unset |

Both dispatches skip users whose account switch (`GET`/`PUT /api/push/notifications`) is off. Dispatch first checks the public NHL scoreboard (today and yesterday, UTC) and returns `skipped: "no-active-games"` unless a game is live or went final within 4.5 hours of its start; it goes ahead if the scoreboard is unreachable. It then refreshes each distinct favorite team's current-week schedule (bypassing the 10-minute cache), then sends one push per game per user (to all of that user's devices) for unread reports that are not in the ledger, started within the last 12 hours, and involve at least one unmuted favorite. The ledger row is claimed before sending, so overlapping runs cannot double send. If no device got the push (every send failed for a reason other than 404/410, or the notifier could not be reached), the claim is released so the next dispatch tries again; a 404/410 from the push service deletes that subscription. Read tokens are 30-day JWTs (`purpose: "aar-read"`) signed with `SESSION_JWT_SECRET`; they are rejected as session tokens and vice versa. Nothing runs on a timer inside the API.

#### Delivery and scheduling: the notifier

[`notifier/`](notifier/README.md) is a separate, project-agnostic service on the dev server. Its scheduler calls the dispatch routes (replacing the old GitHub Actions cron, which ran late or skipped runs), and its queue retries each push until it is delivered or its 6-hour TTL expires. Set `NOTIFIER_URL` (e.g. `http://127.0.0.1:9100`) and `NOTIFIER_TOKEN` (that app's token in the notifier config) and the API queues pushes there instead of sending them itself. Dedupe keys (`<tag>:u<userId>:s<subscriptionId>`) make a repeated enqueue harmless. Without these variables the API sends directly, once per device, as before. The notifier reports gone subscriptions to `POST /api/push/notifier-events`, so set `NOTIFIER_CALLBACK_SECRET` to the same value as the app's `events.token`. The VAPID keys must match in both places. `CRON_SECRET` is the bearer token the notifier's schedules send.

The schedules in `notifier/notifier.example.json` are:

- `after-action-push`: every 5 minutes, 16:00-08:59 UTC. With the scoreboard gate, a push lands about 5-10 minutes after the final.
- `weekly-player-report`: Mondays at 9:00 and 12:00 America/New_York, with catch-up after downtime. The second run only sends what the first could not, because of the ledger.

To rerun one by hand: `curl -X POST -H "Authorization: Bearer $NOTIFIER_TOKEN" http://127.0.0.1:9100/v1/schedules/weekly-player-report/run`. To pick a week, call `POST /api/push/weekly-dispatch` directly with `{ "weekStart": "YYYY-MM-DD" }` and `Bearer CRON_SECRET`.

### Favorite players and the Weekly Player Report

After Action Report pushes also highlight the user's favorite skaters who scored in that game: goals, assists, multi-point games, and hat tricks. Highlights precede the final score; players are matched by NHL player ID against the cached game boxscore, shared across users during dispatch. With no scoring favorites or an unavailable boxscore, the notification shows the final score. Game eligibility and team mute settings are unchanged.

Migration 005 adds `favorite_players` (at most 10 per user), the frozen `weekly_player_reports` (one per user per week, payload stored as JSON so reopening never re-fetches), the sent ledger `weekly_player_report_pushes`, and `users.weekly_report_push` (default on).

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/favorite-players` | session | `{ favorites: [{ playerId, name, teamTriCode, position, headshot, since, tier, label, pushMuted }] }` |
| `PUT /api/favorite-players/:playerId` / `DELETE ...` | session | Add (validated against the NHL player landing, 24-hour cache) or remove; returns `{ favorites }`; 400 bad id, 404 unknown player, 409 past 10; re-PUT keeps tier and label |
| `PATCH /api/favorite-players/:playerId` | session | Body `{ tier?, label? }` (at least one); returns `{ favorites }`; 400 bad tier/label/empty body/bad id, 404 if not a favorite |
| `PUT /api/favorite-players/:playerId/push-mute` | session | Body `{ muted: boolean }`; whether the player counts in the weekly push (migration 010, default included); returns `{ favorites }`; 400 bad body/id, 404 if not a favorite |
| `GET /api/weekly-player-reports` | session | `{ reports, unreadCount }`, newest first, at most 12 |
| `GET /api/weekly-player-reports/:weekStart` | session | One report (404 when none) |
| `POST /api/weekly-player-reports/:weekStart/read` | session | Mark read (204) |
| `GET` / `PUT /api/push/weekly-report` | session | `{ enabled }`; the one on/off switch for the weekly push (400 unless boolean) |
| `POST /api/push/weekly-dispatch` | `Bearer CRON_SECRET` | Optional body `{ weekStart }` (a completed Monday week; default last week). Returns `{ weekStart, skipped?, created, users, sent, removed }`; 502 when the NHL is unavailable (nothing is created) |

A report covers Monday 00:00 to Sunday 23:59 America/New_York. Each report holds `weekStart`, `weekEnd`, `label` (`Oct 13–19`), `headline`, and `players[]` with `playerId`, `name`, `position`, `headshot`, `team`, `teams` (several after a trade), `type` (`skater`/`goalie`), `played`, `teamGames` (the stored team's games that week, for "Did not play"), and `stats`: skaters `{ gp, goals, assists, points, plusMinus, shots, toiPerGame, bestGame: { gameId, text } | null }`, goalies `{ gp, wins, losses, otLosses, record, savePct, gaa, shutouts }`, `null` when the player did not play.

The dispatch fetches the league schedule for the week (`/schedule/{monday}`); if no regular-season or playoff game was completed, it is a league break and returns `{ skipped: "league-break" }` with nothing created or sent. Otherwise it makes one stats REST per-game query for every distinct favorited skater and one for goalies across all users (paged), caches the raw payloads under week-keyed keys, and stores a report for each user unless none of their players or their teams played. Existing reports are never replaced. It then pushes each unread new report once (ledger claimed before sending) to users with a subscribed device, the account switch on and the weekly switch on. The push describes only the players the user has not muted for the weekly push; when none of those played, the week is claimed without a push, so unmuting later never sends an old week. The stored report always lists every favorite. Push payload: `{ kind: "weekly-report", title: "Weekly Player Report · Oct 13–19", body: <headline>, weekStart, tag: "wpr-<weekStart>", readToken }`. The read token (`purpose: "wpr-read"`, 30 days) is accepted by `POST /api/push/read`. Subscribing a device seeds this ledger with the user's existing reports. The NHL schedule and stats payload shapes are assumptions; spot-check the first real report.

The notifier's `weekly-player-report` schedule calls the weekly dispatch on Monday mornings, Eastern time; see the notifier section above.

## Caching

NHL payloads are cached in Postgres (`app_cache`) when `CACHE_DATABASE_URL` is set, otherwise in `src/cache/` (see `CACHE_STORAGE` in `.env.example`). Each type has a default lifetime (`CACHE_TTLS` in `src/platform/cacheManager.js`: 24 hours for players, rosters, standings, stat leaders and teams, 12 hours for schedules); some reads set a shorter one (5-minute gamecenter and preliminary shift charts, 10-minute current week).

- **Expired entries on a default lifetime** are returned at once while one background request refreshes them, so the first visitor after expiry does not wait on a slow NHL fetch (the league-wide summaries walk several pages). If the refresh fails, the expired copy stays and the next request tries again.
- **Expired entries on a shorter lifetime** (live game data) wait for the refetch; if the NHL call fails, the expired copy is returned instead of an error.
- **Missing entries** are fetched as before, and fail when the NHL call fails.
- **Completed seasons** never expire for standings, stat leaders, team summaries and player summaries, once cached after the season ended (September 1 of its end year, the same rollover as the current-season id). A copy cached while the season was still running is refreshed once more, then kept.

Concurrent requests for the same entry share one NHL fetch. There is no in-memory layer in front of Postgres.

## Deployment

For deployment on this server through Jenkins and systemd, see
[Jenkins setup](docs/jenkins.md).

Recommended Render Web Service commands:

- Build: `pnpm install --frozen-lockfile && python3 -m pip install -r requirements.txt`
- Start: `pnpm start` (applies pending database migrations, then starts the server; no pre-deploy command is needed)

Configure secrets and runtime values in Render's environment settings. Do not commit `.env` or credentials.
