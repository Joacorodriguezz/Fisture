-- Seed data for local testing
-- Run with: npx wrangler d1 execute fisture-db --local --file=scripts/seed-local.sql

-- Insert leagues first
INSERT OR REPLACE INTO leagues (id, api_id, name, country, season, is_active) VALUES
  ('league-arg', 128, 'Liga Profesional Argentina', 'Argentina', 2024, 1),
  ('league-eng', 39, 'Premier League', 'England', 2024, 1),
  ('league-esp', 140, 'La Liga', 'Spain', 2024, 1),
  ('league-ita', 135, 'Serie A', 'Italy', 2024, 1),
  ('league-ger', 78, 'Bundesliga', 'Germany', 2024, 1),
  ('league-fra', 61, 'Ligue 1', 'France', 2024, 1);
