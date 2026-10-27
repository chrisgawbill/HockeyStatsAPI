-- Rink Quest identities linked to canonical teams and players. Names,
-- positions, current team and headshots stay in teams/players/roster_entries
-- and are joined in at read time; a player's team always comes from the roster.
CREATE TABLE IF NOT EXISTS rink_quest_team_profiles (
	team_id integer PRIMARY KEY REFERENCES teams (team_id) ON DELETE CASCADE,
	primary_identity text NOT NULL,
	secondary_identity text,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT rink_quest_team_profiles_primary_identity_chk CHECK (
		primary_identity IN ('forecheck', 'transition', 'possession', 'physical', 'structure')
	),
	CONSTRAINT rink_quest_team_profiles_secondary_identity_chk CHECK (
		secondary_identity IN ('forecheck', 'transition', 'possession', 'physical', 'structure')
		AND secondary_identity <> primary_identity
	)
);

-- Skaters only: goalies stay team-level identity in the first 2.0 release.
CREATE TABLE IF NOT EXISTS rink_quest_player_profiles (
	player_id bigint PRIMARY KEY REFERENCES players (player_id) ON DELETE CASCADE,
	archetype text NOT NULL,
	appearance_rank smallint NOT NULL,
	enabled boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT rink_quest_player_profiles_archetype_chk CHECK (
		archetype IN (
			'finisher', 'playmaker', 'power_forward',
			'two_way_center', 'mobile_defenseman', 'defensive_anchor'
		)
	),
	-- 1 = headliner, 2 = regular, 3 = occasional: how often a player is
	-- offered, never how strong he plays.
	CONSTRAINT rink_quest_player_profiles_appearance_rank_chk CHECK (
		appearance_rank BETWEEN 1 AND 3
	)
);

-- Product Owner-approved pilot (API-ON2-02). TOR and MTL rows are stubbed by
-- migration 011.
INSERT INTO rink_quest_team_profiles (team_id, primary_identity, secondary_identity) VALUES
	(10, 'possession', 'structure'),
	(8, 'transition', 'forecheck')
ON CONFLICT (team_id) DO NOTHING;

-- Player rows normally come from NHL fetches; stub the seeded players so a
-- fresh database satisfies the foreign key. Roster fetches fill in the rest.
INSERT INTO players (player_id) VALUES
	(8479318), (8477939), (8475166), (8477503), (8482720), (8476853), (8475690), (8476931),
	(8480018), (8481540), (8479339), (8483515), (8483457), (8476875), (8482087)
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO rink_quest_player_profiles (player_id, archetype, appearance_rank) VALUES
	-- TOR
	(8479318, 'finisher', 1),           -- Auston Matthews
	(8477939, 'finisher', 2),           -- William Nylander
	(8475166, 'playmaker', 1),          -- John Tavares
	(8477503, 'playmaker', 2),          -- Max Domi
	(8482720, 'power_forward', 1),      -- Matthew Knies
	(8476853, 'mobile_defenseman', 1),  -- Morgan Rielly
	(8475690, 'defensive_anchor', 1),   -- Chris Tanev
	(8476931, 'defensive_anchor', 2),   -- Jake McCabe
	-- MTL
	(8480018, 'two_way_center', 1),     -- Nick Suzuki
	(8481540, 'finisher', 1),           -- Cole Caufield
	(8479339, 'finisher', 2),           -- Patrik Laine
	(8483515, 'power_forward', 1),      -- Juraj Slafkovsky
	(8483457, 'mobile_defenseman', 1),  -- Lane Hutson
	(8476875, 'mobile_defenseman', 2),  -- Mike Matheson
	(8482087, 'defensive_anchor', 1)    -- Kaiden Guhle
ON CONFLICT (player_id) DO NOTHING;
