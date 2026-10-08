// Script para poblar datos de prueba localmente
// Ejecutar con: npx wrangler d1 execute fisture-db --local --file=scripts/seed-local.sql

import { initialLeagues } from "../drizzle/seed";

const sampleTeams = [
  // Liga Argentina
  { apiId: 2434, name: "River Plate", shortName: "RIV", leagueApiId: 128, country: "Argentina" },
  { apiId: 2436, name: "Boca Juniors", shortName: "BOC", leagueApiId: 128, country: "Argentina" },
  { apiId: 2437, name: "Racing Club", shortName: "RAC", leagueApiId: 128, country: "Argentina" },
  { apiId: 2440, name: "San Lorenzo", shortName: "SLO", leagueApiId: 128, country: "Argentina" },
  { apiId: 2443, name: "Independiente", shortName: "IND", leagueApiId: 128, country: "Argentina" },
  // Premier League
  { apiId: 33, name: "Manchester United", shortName: "MUN", leagueApiId: 39, country: "England" },
  { apiId: 40, name: "Liverpool", shortName: "LIV", leagueApiId: 39, country: "England" },
  { apiId: 42, name: "Arsenal", shortName: "ARS", leagueApiId: 39, country: "England" },
  { apiId: 50, name: "Manchester City", shortName: "MCI", leagueApiId: 39, country: "England" },
  { apiId: 47, name: "Tottenham", shortName: "TOT", leagueApiId: 39, country: "England" },
  // La Liga
  { apiId: 529, name: "Barcelona", shortName: "BAR", leagueApiId: 140, country: "Spain" },
  { apiId: 541, name: "Real Madrid", shortName: "RMA", leagueApiId: 140, country: "Spain" },
  { apiId: 530, name: "Atlético Madrid", shortName: "ATM", leagueApiId: 140, country: "Spain" },
];

// Generar SQL para insertar datos
function generateSQL(): string {
  let sql = "-- Seed data for testing\n\n";

  // Insert leagues
  for (const league of initialLeagues) {
    sql += `INSERT OR IGNORE INTO leagues (id, api_id, name, country, season, is_active) VALUES ('${crypto.randomUUID()}', ${league.apiId}, '${league.name}', '${league.country}', ${league.season}, 1);\n`;
  }

  sql += "\n";

  // Insert teams (need league id)
  for (const team of sampleTeams) {
    sql += `INSERT OR IGNORE INTO teams (id, api_id, name, short_name, logo, league_id, country)
SELECT '${crypto.randomUUID()}', ${team.apiId}, '${team.name}', '${team.shortName}', 'https://media.api-sports.io/football/teams/${team.apiId}.png', id, '${team.country}'
FROM leagues WHERE api_id = ${team.leagueApiId};\n`;
  }

  return sql;
}

console.log(generateSQL());
