export const SUPPORTED_LEAGUES = [
  { apiId: 128, name: "Liga Profesional Argentina", country: "Argentina" },
  { apiId: 39, name: "Premier League", country: "England" },
  { apiId: 140, name: "La Liga", country: "Spain" },
  { apiId: 135, name: "Serie A", country: "Italy" },
  { apiId: 78, name: "Bundesliga", country: "Germany" },
  { apiId: 61, name: "Ligue 1", country: "France" },
] as const;

export type SupportedLeague = (typeof SUPPORTED_LEAGUES)[number];

export function getCurrentSeason(): number {
  // API-Football free plan: temporadas 2022-2024
  // TODO: Cambiar a lógica dinámica con plan pago
  return 2024;
}

export function getLeagueByApiId(apiId: number): SupportedLeague | undefined {
  return SUPPORTED_LEAGUES.find((l) => l.apiId === apiId);
}
