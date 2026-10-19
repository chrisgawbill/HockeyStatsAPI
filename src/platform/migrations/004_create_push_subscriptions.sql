CREATE TABLE IF NOT EXISTS push_subscriptions (
	id bigserial PRIMARY KEY,
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	endpoint text NOT NULL,
	p256dh text NOT NULL,
	auth text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx
	ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS after_action_report_pushes (
	user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	game_id bigint NOT NULL,
	sent_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT after_action_report_pushes_pkey PRIMARY KEY (user_id, game_id)
);

ALTER TABLE favorite_teams
	ADD COLUMN IF NOT EXISTS push_muted boolean NOT NULL DEFAULT false;
