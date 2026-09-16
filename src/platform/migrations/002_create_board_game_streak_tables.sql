CREATE TABLE IF NOT EXISTS users (
	id bigserial PRIMARY KEY,
	google_sub text NOT NULL,
	email text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT users_google_sub_unique UNIQUE (google_sub)
);

CREATE TABLE IF NOT EXISTS board_game_streaks (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	wins jsonb NOT NULL DEFAULT '{}'::jsonb,
	last_win_date text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT board_game_streaks_user_id_unique UNIQUE (user_id)
);
