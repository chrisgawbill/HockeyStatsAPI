-- Account-wide push switch (master over every push) and a per-player toggle
-- that decides whether a favorite player counts in the weekly-report push.
ALTER TABLE users
	ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE favorite_players
	ADD COLUMN IF NOT EXISTS push_muted boolean NOT NULL DEFAULT false;
