CREATE TABLE IF NOT EXISTS favorite_players (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	player_id bigint NOT NULL,
	full_name text NOT NULL,
	team_tri_code text,
	position text,
	headshot text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT favorite_players_pkey PRIMARY KEY (user_id, player_id),
	CONSTRAINT favorite_players_player_id_chk CHECK (player_id > 0)
);

CREATE TABLE IF NOT EXISTS weekly_player_reports (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	week_start date NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	read_at timestamptz,
	CONSTRAINT weekly_player_reports_pkey PRIMARY KEY (user_id, week_start)
);

CREATE TABLE IF NOT EXISTS weekly_player_report_pushes (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	week_start date NOT NULL,
	sent_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT weekly_player_report_pushes_pkey PRIMARY KEY (user_id, week_start)
);

ALTER TABLE users
	ADD COLUMN IF NOT EXISTS weekly_report_push boolean NOT NULL DEFAULT true;
