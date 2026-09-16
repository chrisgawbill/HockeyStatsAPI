CREATE TABLE IF NOT EXISTS seasons (
	season_id text PRIMARY KEY,
	start_year integer NOT NULL,
	end_year integer NOT NULL,
	regular_season_start date,
	regular_season_end date,
	playoffs_end date,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT seasons_id_format_chk CHECK (season_id ~ '^[0-9]{8}$'),
	CONSTRAINT seasons_years_chk CHECK (
		start_year >= 1900
		AND end_year = start_year + 1
		AND season_id = start_year::text || end_year::text
	)
);

CREATE TABLE IF NOT EXISTS teams (
	team_id integer PRIMARY KEY,
	tri_code text NOT NULL,
	franchise_id integer,
	full_name text,
	common_name text,
	place_name text,
	logo_url text,
	primary_color text,
	secondary_color text,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teams_tri_code_idx ON teams (tri_code);

CREATE TABLE IF NOT EXISTS players (
	player_id bigint PRIMARY KEY,
	first_name text,
	last_name text,
	full_name text,
	headshot_url text,
	hero_image_url text,
	birth_date date,
	nationality_code text,
	shoots_catches text,
	position_code text,
	source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS players_full_name_idx ON players (full_name);

CREATE TABLE IF NOT EXISTS team_season_snapshots (
	season_id text NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
	team_id integer NOT NULL REFERENCES teams (team_id) ON DELETE CASCADE,
	tri_code text NOT NULL,
	games_played integer,
	wins integer,
	losses integer,
	ot_losses integer,
	regulation_wins integer,
	points integer,
	goals_for integer,
	goals_against integer,
	goals_for_per_game numeric,
	goals_against_per_game numeric,
	power_play_pct numeric,
	penalty_kill_pct numeric,
	faceoff_win_pct numeric,
	division_name text,
	conference_name text,
	league_rank integer,
	conference_rank integer,
	division_rank integer,
	snapshot_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (season_id, team_id)
);

CREATE INDEX IF NOT EXISTS team_season_snapshots_tri_code_idx
	ON team_season_snapshots (season_id, tri_code);

CREATE TABLE IF NOT EXISTS schedule_games (
	game_id bigint PRIMARY KEY,
	season_id text NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
	game_type integer,
	game_date date,
	start_time_utc timestamptz,
	game_state text,
	venue_name text,
	home_team_id integer REFERENCES teams (team_id),
	away_team_id integer REFERENCES teams (team_id),
	home_tri_code text,
	away_tri_code text,
	home_score integer,
	away_score integer,
	period_descriptor jsonb NOT NULL DEFAULT '{}'::jsonb,
	broadcasts jsonb NOT NULL DEFAULT '[]'::jsonb,
	game_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT schedule_games_score_chk CHECK (
		(home_score IS NULL OR home_score >= 0)
		AND (away_score IS NULL OR away_score >= 0)
	)
);

CREATE INDEX IF NOT EXISTS schedule_games_season_date_idx
	ON schedule_games (season_id, game_date);

CREATE INDEX IF NOT EXISTS schedule_games_home_team_idx
	ON schedule_games (season_id, home_tri_code);

CREATE INDEX IF NOT EXISTS schedule_games_away_team_idx
	ON schedule_games (season_id, away_tri_code);

CREATE INDEX IF NOT EXISTS schedule_games_state_idx
	ON schedule_games (season_id, game_state);

CREATE TABLE IF NOT EXISTS roster_entries (
	id bigserial PRIMARY KEY,
	season_id text NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
	team_id integer REFERENCES teams (team_id),
	tri_code text NOT NULL,
	player_id bigint NOT NULL REFERENCES players (player_id) ON DELETE CASCADE,
	first_name text,
	last_name text,
	full_name text,
	sweater_number integer,
	position_code text,
	position_name text,
	player_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT roster_entries_sweater_chk CHECK (
		sweater_number IS NULL OR sweater_number >= 0
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS roster_entries_unique_player_team_season_idx
	ON roster_entries (season_id, tri_code, player_id);

CREATE INDEX IF NOT EXISTS roster_entries_player_idx
	ON roster_entries (player_id, season_id);

CREATE TABLE IF NOT EXISTS player_season_stats (
	id bigserial PRIMARY KEY,
	season_id text NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
	player_id bigint NOT NULL REFERENCES players (player_id) ON DELETE CASCADE,
	team_id integer REFERENCES teams (team_id),
	team_scope text NOT NULL DEFAULT 'all',
	player_type text NOT NULL DEFAULT 'unknown',
	stat_scope text NOT NULL DEFAULT 'regular',
	games_played integer,
	goals integer,
	assists integer,
	points integer,
	shots integer,
	plus_minus integer,
	penalty_minutes integer,
	time_on_ice_per_game text,
	wins integer,
	losses integer,
	ot_losses integer,
	save_pct numeric,
	goals_against_avg numeric,
	stats_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT player_season_stats_type_chk CHECK (
		player_type IN ('skater', 'goalie', 'unknown')
	),
	CONSTRAINT player_season_stats_scope_chk CHECK (
		stat_scope IN ('regular', 'playoff', 'all')
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS player_season_stats_unique_scope_idx
	ON player_season_stats (
		season_id,
		player_id,
		player_type,
		stat_scope,
		team_scope
	);

CREATE INDEX IF NOT EXISTS player_season_stats_team_idx
	ON player_season_stats (season_id, team_scope);

CREATE TABLE IF NOT EXISTS stat_leaders (
	id bigserial PRIMARY KEY,
	season_id text NOT NULL REFERENCES seasons (season_id) ON DELETE CASCADE,
	player_id bigint NOT NULL REFERENCES players (player_id) ON DELETE CASCADE,
	player_type text NOT NULL,
	category text NOT NULL,
	rank integer,
	team_scope text NOT NULL DEFAULT 'all',
	value numeric,
	leader_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT stat_leaders_type_chk CHECK (player_type IN ('skater', 'goalie')),
	CONSTRAINT stat_leaders_rank_chk CHECK (rank IS NULL OR rank > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS stat_leaders_unique_player_category_idx
	ON stat_leaders (season_id, player_type, category, team_scope, player_id);

CREATE INDEX IF NOT EXISTS stat_leaders_rank_idx
	ON stat_leaders (season_id, player_type, category, team_scope, rank);

CREATE TABLE IF NOT EXISTS ai_summaries (
	id bigserial PRIMARY KEY,
	team_id integer REFERENCES teams (team_id),
	tri_code text NOT NULL,
	summary_type text NOT NULL DEFAULT 'team_history',
	prompt_version text NOT NULL DEFAULT 'v1',
	model_provider text,
	model_name text,
	prompt_hash text,
	content jsonb NOT NULL,
	source_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_summaries_unique_team_summary_idx
	ON ai_summaries (tri_code, summary_type, prompt_version);
