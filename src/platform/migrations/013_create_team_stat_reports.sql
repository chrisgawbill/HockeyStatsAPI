-- Team-scoped stat reports (team summary, skater summary, Corsi, zone
-- faceoffs, goalie summary) as the raw NHL payloads the team page reads.
-- Refreshed for both teams when the live poll sees a game go official, so the
-- team page reads the database instead of the NHL.
CREATE TABLE IF NOT EXISTS team_stat_reports (
	season_id text NOT NULL,
	team_id integer NOT NULL,
	report text NOT NULL,
	payload jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (season_id, team_id, report)
);

-- Official games the live poll refreshed teams for. The poll keeps seeing an
-- OFF game until the schedule cache refreshes, so a game is claimed once;
-- one whose stats were not caught up yet (caught_up false) can be claimed
-- again after a cool-down.
CREATE TABLE IF NOT EXISTS team_stats_ingested_games (
	game_id bigint PRIMARY KEY,
	caught_up boolean NOT NULL DEFAULT false,
	ingested_at timestamptz NOT NULL DEFAULT now()
);
