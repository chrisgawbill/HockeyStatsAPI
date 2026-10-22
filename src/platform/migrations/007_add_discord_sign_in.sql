-- Discord sign-in: a user is keyed on either their Google `sub` or their
-- Discord user id. Accounts are not linked across providers.
ALTER TABLE users
	ALTER COLUMN google_sub DROP NOT NULL,
	ADD COLUMN IF NOT EXISTS discord_id text;

ALTER TABLE users
	DROP CONSTRAINT IF EXISTS users_discord_id_unique,
	ADD CONSTRAINT users_discord_id_unique UNIQUE (discord_id),
	DROP CONSTRAINT IF EXISTS users_provider_chk,
	ADD CONSTRAINT users_provider_chk CHECK (google_sub IS NOT NULL OR discord_id IS NOT NULL);
