-- AHL data from the HockeyTech feed, kept apart from the NHL tables because
-- AHL team and player ids are a separate numbering that can collide with NHL
-- ids. Every table keeps the raw feed row in source_payload.

-- HockeyTech numbers each season (regular season, playoffs, exhibition) with
-- its own id; this maps it to our 8-digit season id and NHL-style game type
-- (1 exhibition, 2 regular season, 3 playoffs).
CREATE TABLE IF NOT EXISTS ahl_seasons (
	hockeytech_season_id integer PRIMARY KEY,
	season_id text NOT NULL,
	game_type integer NOT NULL,
	season_name text NOT NULL,
	start_date date,
	end_date date,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT ahl_seasons_id_format_chk CHECK (season_id ~ '^[0-9]{8}$'),
	CONSTRAINT ahl_seasons_game_type_chk CHECK (game_type IN (1, 2, 3))
);

CREATE INDEX IF NOT EXISTS ahl_seasons_season_idx
	ON ahl_seasons (season_id, game_type);

CREATE TABLE IF NOT EXISTS ahl_teams (
	team_id integer PRIMARY KEY,
	team_code text NOT NULL,
	full_name text,
	city text,
	nickname text,
	division_name text,
	logo_url text,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ahl_players (
	player_id bigint PRIMARY KEY,
	first_name text,
	last_name text,
	full_name text,
	position_code text,
	shoots text,
	catches text,
	birth_date date,
	headshot_url text,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ahl_schedule_games (
	game_id bigint PRIMARY KEY,
	hockeytech_season_id integer NOT NULL
		REFERENCES ahl_seasons (hockeytech_season_id) ON DELETE CASCADE,
	season_id text NOT NULL,
	game_type integer NOT NULL,
	game_date date,
	start_time_utc timestamptz,
	status_code integer,
	game_status text,
	venue_name text,
	home_team_id integer,
	away_team_id integer,
	home_team_code text,
	away_team_code text,
	home_score integer,
	away_score integer,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ahl_schedule_games_season_date_idx
	ON ahl_schedule_games (season_id, game_date);

CREATE TABLE IF NOT EXISTS ahl_roster_entries (
	hockeytech_season_id integer NOT NULL
		REFERENCES ahl_seasons (hockeytech_season_id) ON DELETE CASCADE,
	team_id integer NOT NULL,
	player_id bigint NOT NULL REFERENCES ahl_players (player_id) ON DELETE CASCADE,
	sweater_number integer,
	position_code text,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (hockeytech_season_id, team_id, player_id)
);

-- Raw feed payload per season, team and report (standings, skaters, goalies),
-- like team_stat_reports; league-wide reports use team id 0.
CREATE TABLE IF NOT EXISTS ahl_team_stat_reports (
	hockeytech_season_id integer NOT NULL
		REFERENCES ahl_seasons (hockeytech_season_id) ON DELETE CASCADE,
	team_id integer NOT NULL,
	report text NOT NULL,
	payload jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (hockeytech_season_id, team_id, report)
);
