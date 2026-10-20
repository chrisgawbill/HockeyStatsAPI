-- Fan categories: display-only tier and optional label on each favorite.
-- The app enforces a 24-grapheme label and the same 512-code-point bound, so
-- long emoji sequences (a family emoji is 5+ code points) never reach this check.
ALTER TABLE favorite_teams
	ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'fan',
	ADD COLUMN IF NOT EXISTS label text;

ALTER TABLE favorite_teams
	DROP CONSTRAINT IF EXISTS favorite_teams_tier_chk,
	ADD CONSTRAINT favorite_teams_tier_chk CHECK (tier IN ('diehard', 'fan', 'curious')),
	DROP CONSTRAINT IF EXISTS favorite_teams_label_chk,
	ADD CONSTRAINT favorite_teams_label_chk CHECK (char_length(label) <= 512);

ALTER TABLE favorite_players
	ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'fan',
	ADD COLUMN IF NOT EXISTS label text;

ALTER TABLE favorite_players
	DROP CONSTRAINT IF EXISTS favorite_players_tier_chk,
	ADD CONSTRAINT favorite_players_tier_chk CHECK (tier IN ('diehard', 'fan', 'curious')),
	DROP CONSTRAINT IF EXISTS favorite_players_label_chk,
	ADD CONSTRAINT favorite_players_label_chk CHECK (char_length(label) <= 512);
