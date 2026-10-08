-- Fix Argentine teams with correct API-Football IDs
-- Run with: npx wrangler d1 execute fisture-db --local --file=scripts/fix-argentina.sql

-- Delete old Argentine teams
DELETE FROM teams WHERE league_id = 'league-arg';

-- Insert with correct API-Football IDs
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-river', 435, 'River Plate', 'RIV', 'https://media.api-sports.io/football/teams/435.png', 'league-arg', 'Argentina'),
  ('team-boca', 451, 'Boca Juniors', 'BOC', 'https://media.api-sports.io/football/teams/451.png', 'league-arg', 'Argentina'),
  ('team-racing', 442, 'Racing Club', 'RAC', 'https://media.api-sports.io/football/teams/442.png', 'league-arg', 'Argentina'),
  ('team-sanlorenzo', 456, 'San Lorenzo', 'SLO', 'https://media.api-sports.io/football/teams/456.png', 'league-arg', 'Argentina'),
  ('team-independiente', 434, 'Independiente', 'IND', 'https://media.api-sports.io/football/teams/434.png', 'league-arg', 'Argentina'),
  ('team-central', 460, 'Rosario Central', 'CEN', 'https://media.api-sports.io/football/teams/460.png', 'league-arg', 'Argentina'),
  ('team-newells', 458, 'Newells Old Boys', 'NOB', 'https://media.api-sports.io/football/teams/458.png', 'league-arg', 'Argentina'),
  ('team-estudiantes', 436, 'Estudiantes', 'EST', 'https://media.api-sports.io/football/teams/436.png', 'league-arg', 'Argentina'),
  ('team-velez', 468, 'Vélez Sarsfield', 'VEL', 'https://media.api-sports.io/football/teams/468.png', 'league-arg', 'Argentina'),
  ('team-talleres', 459, 'Talleres Córdoba', 'TAL', 'https://media.api-sports.io/football/teams/459.png', 'league-arg', 'Argentina');
