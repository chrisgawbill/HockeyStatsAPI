CREATE TABLE IF NOT EXISTS favorite_teams (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	team_tri_code text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT favorite_teams_pkey PRIMARY KEY (user_id, team_tri_code),
	CONSTRAINT favorite_teams_tri_code_chk CHECK (team_tri_code ~ '^[A-Z]{3}$')
);

CREATE TABLE IF NOT EXISTS after_action_report_reads (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	game_id bigint NOT NULL,
	read_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT after_action_report_reads_pkey PRIMARY KEY (user_id, game_id)
);
