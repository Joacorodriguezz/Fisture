-- Seed sample matches for testing
-- These are fictional future matches for testing calendar integration

-- Get team and league IDs first, then insert matches
-- Liga Argentina matches (next 2 weeks)

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-arg-1',
  900001,
  (SELECT id FROM teams WHERE name = 'River Plate' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Boca Juniors' LIMIT 1),
  (SELECT id FROM leagues WHERE name LIKE '%Argentina%' LIMIT 1),
  strftime('%s', 'now', '+3 days', 'start of day', '+20 hours'),
  'Estadio Monumental',
  'scheduled',
  'Fecha 15'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'River Plate')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Boca Juniors');

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-arg-2',
  900002,
  (SELECT id FROM teams WHERE name = 'Racing Club' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'River Plate' LIMIT 1),
  (SELECT id FROM leagues WHERE name LIKE '%Argentina%' LIMIT 1),
  strftime('%s', 'now', '+7 days', 'start of day', '+18 hours'),
  'Estadio Presidente Perón',
  'scheduled',
  'Fecha 16'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'Racing Club')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'River Plate');

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-arg-3',
  900003,
  (SELECT id FROM teams WHERE name = 'Boca Juniors' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Racing Club' LIMIT 1),
  (SELECT id FROM leagues WHERE name LIKE '%Argentina%' LIMIT 1),
  strftime('%s', 'now', '+10 days', 'start of day', '+21 hours'),
  'La Bombonera',
  'scheduled',
  'Fecha 17'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'Boca Juniors')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Racing Club');

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-arg-4',
  900004,
  (SELECT id FROM teams WHERE name = 'River Plate' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Racing Club' LIMIT 1),
  (SELECT id FROM leagues WHERE name LIKE '%Argentina%' LIMIT 1),
  strftime('%s', 'now', '+14 days', 'start of day', '+19 hours'),
  'Estadio Monumental',
  'scheduled',
  'Fecha 18'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'River Plate')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Racing Club');

-- Premier League matches
INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-eng-1',
  900011,
  (SELECT id FROM teams WHERE name = 'Liverpool' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Manchester City' LIMIT 1),
  (SELECT id FROM leagues WHERE name = 'Premier League' LIMIT 1),
  strftime('%s', 'now', '+4 days', 'start of day', '+17 hours'),
  'Anfield',
  'scheduled',
  'Matchweek 12'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'Liverpool')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Manchester City');

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-eng-2',
  900012,
  (SELECT id FROM teams WHERE name = 'Arsenal' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Liverpool' LIMIT 1),
  (SELECT id FROM leagues WHERE name = 'Premier League' LIMIT 1),
  strftime('%s', 'now', '+8 days', 'start of day', '+16 hours'),
  'Emirates Stadium',
  'scheduled',
  'Matchweek 13'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'Arsenal')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Liverpool');

INSERT INTO matches (id, api_id, home_team_id, away_team_id, league_id, date_time, venue, status, round)
SELECT
  'match-eng-3',
  900013,
  (SELECT id FROM teams WHERE name = 'Manchester City' LIMIT 1),
  (SELECT id FROM teams WHERE name = 'Arsenal' LIMIT 1),
  (SELECT id FROM leagues WHERE name = 'Premier League' LIMIT 1),
  strftime('%s', 'now', '+11 days', 'start of day', '+18 hours'),
  'Etihad Stadium',
  'scheduled',
  'Matchweek 14'
WHERE EXISTS (SELECT 1 FROM teams WHERE name = 'Manchester City')
  AND EXISTS (SELECT 1 FROM teams WHERE name = 'Arsenal');
