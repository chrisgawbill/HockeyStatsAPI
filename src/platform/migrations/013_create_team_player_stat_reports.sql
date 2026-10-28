-- Team-scoped player stat reports (skater summary, Corsi, zone faceoffs,
-- goalie summary) as the raw NHL payloads the team page reads. Refreshed for
-- both teams when the live poll sees a game go official, so the team page
-- reads the database instead of the NHL.
CREATE TABLE IF NOT EXISTS team_player_stat_reports (
	season_id text NOT NULL,
	team_id integer NOT NULL,
	report text NOT NULL,
	payload jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (season_id, team_id, report)
);

-- Official games whose teams' stat reports were refreshed, so the live poll
-- (which keeps seeing an OFF game until the schedule cache refreshes) only
-- refreshes them once.
CREATE TABLE IF NOT EXISTS team_stats_ingested_games (
	game_id bigint PRIMARY KEY,
	ingested_at timestamptz NOT NULL DEFAULT now()
);
