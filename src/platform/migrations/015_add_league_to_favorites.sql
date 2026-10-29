-- AHL favorites share the NHL favorites lists. AHL tri-codes and player ids
-- are a separate numbering that can match NHL ones, so the league is part of
-- each key. Existing favorites become NHL. AHL team codes are 2-4 letters.
ALTER TABLE favorite_teams
	ADD COLUMN IF NOT EXISTS league text NOT NULL DEFAULT 'nhl',
	DROP CONSTRAINT IF EXISTS favorite_teams_league_chk,
	ADD CONSTRAINT favorite_teams_league_chk CHECK (league IN ('nhl', 'ahl')),
	DROP CONSTRAINT favorite_teams_pkey,
	ADD CONSTRAINT favorite_teams_pkey PRIMARY KEY (user_id, league, team_tri_code),
	DROP CONSTRAINT IF EXISTS favorite_teams_tri_code_chk,
	ADD CONSTRAINT favorite_teams_tri_code_chk CHECK (team_tri_code ~ '^[A-Z]{2,4}$');

ALTER TABLE favorite_players
	ADD COLUMN IF NOT EXISTS league text NOT NULL DEFAULT 'nhl',
	DROP CONSTRAINT IF EXISTS favorite_players_league_chk,
	ADD CONSTRAINT favorite_players_league_chk CHECK (league IN ('nhl', 'ahl')),
	DROP CONSTRAINT favorite_players_pkey,
	ADD CONSTRAINT favorite_players_pkey PRIMARY KEY (user_id, league, player_id);
