-- Migration: 0003_league_teams
-- Description: participación de equipos en competencias. Un equipo puede jugar su liga
-- y varias copas internacionales; teams.league_id queda como "liga de origen".

CREATE TABLE league_teams (
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (league_id, team_id)
);

CREATE INDEX idx_league_teams_team ON league_teams(team_id);

-- Todo equipo ya cargado participa en su liga de origen
INSERT OR IGNORE INTO league_teams (league_id, team_id)
SELECT league_id, id FROM teams;
