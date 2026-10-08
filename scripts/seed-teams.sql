-- Seed teams
-- Run with: npx wrangler d1 execute fisture-db --local --file=scripts/seed-teams.sql

-- Insert teams - Liga Argentina
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-river', 2434, 'River Plate', 'RIV', 'https://media.api-sports.io/football/teams/2434.png', 'league-arg', 'Argentina'),
  ('team-boca', 2436, 'Boca Juniors', 'BOC', 'https://media.api-sports.io/football/teams/2436.png', 'league-arg', 'Argentina'),
  ('team-racing', 2437, 'Racing Club', 'RAC', 'https://media.api-sports.io/football/teams/2437.png', 'league-arg', 'Argentina'),
  ('team-sanlorenzo', 2440, 'San Lorenzo', 'SLO', 'https://media.api-sports.io/football/teams/2440.png', 'league-arg', 'Argentina'),
  ('team-independiente', 2443, 'Independiente', 'IND', 'https://media.api-sports.io/football/teams/2443.png', 'league-arg', 'Argentina'),
  ('team-central', 455, 'Rosario Central', 'CEN', 'https://media.api-sports.io/football/teams/455.png', 'league-arg', 'Argentina'),
  ('team-newells', 456, 'Newells Old Boys', 'NOB', 'https://media.api-sports.io/football/teams/456.png', 'league-arg', 'Argentina'),
  ('team-estudiantes', 457, 'Estudiantes', 'EST', 'https://media.api-sports.io/football/teams/457.png', 'league-arg', 'Argentina'),
  ('team-velez', 458, 'Vélez Sarsfield', 'VEL', 'https://media.api-sports.io/football/teams/458.png', 'league-arg', 'Argentina'),
  ('team-talleres', 459, 'Talleres', 'TAL', 'https://media.api-sports.io/football/teams/459.png', 'league-arg', 'Argentina');

-- Insert teams - Premier League
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-manutd', 33, 'Manchester United', 'MUN', 'https://media.api-sports.io/football/teams/33.png', 'league-eng', 'England'),
  ('team-liverpool', 40, 'Liverpool', 'LIV', 'https://media.api-sports.io/football/teams/40.png', 'league-eng', 'England'),
  ('team-arsenal', 42, 'Arsenal', 'ARS', 'https://media.api-sports.io/football/teams/42.png', 'league-eng', 'England'),
  ('team-mancity', 50, 'Manchester City', 'MCI', 'https://media.api-sports.io/football/teams/50.png', 'league-eng', 'England'),
  ('team-tottenham', 47, 'Tottenham', 'TOT', 'https://media.api-sports.io/football/teams/47.png', 'league-eng', 'England'),
  ('team-chelsea', 49, 'Chelsea', 'CHE', 'https://media.api-sports.io/football/teams/49.png', 'league-eng', 'England');

-- Insert teams - La Liga
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-barcelona', 529, 'Barcelona', 'BAR', 'https://media.api-sports.io/football/teams/529.png', 'league-esp', 'Spain'),
  ('team-realmadrid', 541, 'Real Madrid', 'RMA', 'https://media.api-sports.io/football/teams/541.png', 'league-esp', 'Spain'),
  ('team-atletico', 530, 'Atlético Madrid', 'ATM', 'https://media.api-sports.io/football/teams/530.png', 'league-esp', 'Spain'),
  ('team-sevilla', 536, 'Sevilla', 'SEV', 'https://media.api-sports.io/football/teams/536.png', 'league-esp', 'Spain');

-- Insert teams - Serie A
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-acmilan', 489, 'AC Milan', 'MIL', 'https://media.api-sports.io/football/teams/489.png', 'league-ita', 'Italy'),
  ('team-napoli', 492, 'Napoli', 'NAP', 'https://media.api-sports.io/football/teams/492.png', 'league-ita', 'Italy'),
  ('team-juventus', 496, 'Juventus', 'JUV', 'https://media.api-sports.io/football/teams/496.png', 'league-ita', 'Italy'),
  ('team-inter', 505, 'Inter', 'INT', 'https://media.api-sports.io/football/teams/505.png', 'league-ita', 'Italy');

-- Insert teams - Bundesliga
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-bayern', 157, 'Bayern Munich', 'BAY', 'https://media.api-sports.io/football/teams/157.png', 'league-ger', 'Germany'),
  ('team-dortmund', 165, 'Borussia Dortmund', 'DOR', 'https://media.api-sports.io/football/teams/165.png', 'league-ger', 'Germany'),
  ('team-leverkusen', 168, 'Bayer Leverkusen', 'LEV', 'https://media.api-sports.io/football/teams/168.png', 'league-ger', 'Germany');

-- Insert teams - Ligue 1
INSERT OR REPLACE INTO teams (id, api_id, name, short_name, logo, league_id, country) VALUES
  ('team-psg', 85, 'Paris Saint Germain', 'PSG', 'https://media.api-sports.io/football/teams/85.png', 'league-fra', 'France'),
  ('team-marseille', 81, 'Marseille', 'OLM', 'https://media.api-sports.io/football/teams/81.png', 'league-fra', 'France'),
  ('team-lyon', 80, 'Lyon', 'OL', 'https://media.api-sports.io/football/teams/80.png', 'league-fra', 'France');
