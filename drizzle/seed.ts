import type { NewLeague } from "./schema";

export const initialLeagues: NewLeague[] = [
  {
    externalId: "api-football:128",
    source: "api-football",
    name: "Liga Profesional Argentina",
    country: "Argentina",
    season: 2024,
    isActive: true,
  },
  {
    externalId: "api-football:39",
    source: "api-football",
    name: "Premier League",
    country: "England",
    season: 2024,
    isActive: true,
  },
  {
    externalId: "api-football:140",
    source: "api-football",
    name: "La Liga",
    country: "Spain",
    season: 2024,
    isActive: true,
  },
  {
    externalId: "api-football:135",
    source: "api-football",
    name: "Serie A",
    country: "Italy",
    season: 2024,
    isActive: true,
  },
  {
    externalId: "api-football:78",
    source: "api-football",
    name: "Bundesliga",
    country: "Germany",
    season: 2024,
    isActive: true,
  },
  {
    externalId: "api-football:61",
    source: "api-football",
    name: "Ligue 1",
    country: "France",
    season: 2024,
    isActive: true,
  },
];
