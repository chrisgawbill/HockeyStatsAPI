-- Site-wide traditional rivalries: one row per unordered team pair. The
-- ordered-pair check stores the lower team id first, so it rejects both
-- self-pairs and reversed duplicates.
CREATE TABLE IF NOT EXISTS team_rivalries (
	team_a_id integer NOT NULL REFERENCES teams (team_id) ON DELETE CASCADE,
	team_b_id integer NOT NULL REFERENCES teams (team_id) ON DELETE CASCADE,
	tier text NOT NULL,
	display_name text,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (team_a_id, team_b_id),
	CONSTRAINT team_rivalries_ordered_pair_chk CHECK (team_a_id < team_b_id),
	CONSTRAINT team_rivalries_tier_chk CHECK (tier IN ('primary', 'secondary'))
);

CREATE INDEX IF NOT EXISTS team_rivalries_team_b_idx ON team_rivalries (team_b_id);

-- Team rows normally come from NHL fetches; stub the seeded teams so a fresh
-- database satisfies the foreign keys. Later upserts fill in the rest.
INSERT INTO teams (team_id, tri_code) VALUES
	(1, 'NJD'), (2, 'NYI'), (3, 'NYR'), (4, 'PHI'), (5, 'PIT'), (6, 'BOS'),
	(8, 'MTL'), (9, 'OTT'), (10, 'TOR'), (13, 'FLA'), (14, 'TBL'), (15, 'WSH'),
	(16, 'CHI'), (17, 'DET'), (19, 'STL'), (20, 'CGY'), (21, 'COL'), (22, 'EDM'),
	(23, 'VAN'), (24, 'ANA'), (26, 'LAK'), (28, 'SJS'), (54, 'VGK')
ON CONFLICT (team_id) DO NOTHING;

-- Product Owner-approved initial rivalries (API-ON2-01).
INSERT INTO team_rivalries (team_a_id, team_b_id, tier, display_name)
SELECT LEAST(a, b), GREATEST(a, b), tier, display_name
FROM (VALUES
	(6, 8, 'primary', NULL),
	(8, 10, 'primary', NULL),
	(22, 20, 'primary', 'Battle of Alberta'),
	(5, 4, 'primary', 'Battle of Pennsylvania'),
	(3, 2, 'primary', NULL),
	(16, 17, 'primary', NULL),
	(21, 17, 'primary', NULL),
	(10, 9, 'primary', 'Battle of Ontario'),
	(13, 14, 'primary', 'Battle of Florida'),
	(24, 26, 'primary', 'Freeway Face-Off'),
	(54, 26, 'primary', NULL),
	(6, 10, 'secondary', NULL),
	(3, 1, 'secondary', 'Hudson River Rivalry'),
	(15, 5, 'secondary', NULL),
	(8, 9, 'secondary', NULL),
	(3, 4, 'secondary', NULL),
	(16, 19, 'secondary', NULL),
	(23, 16, 'secondary', NULL),
	(26, 28, 'secondary', NULL)
) AS seed (a, b, tier, display_name)
ON CONFLICT (team_a_id, team_b_id) DO NOTHING;
