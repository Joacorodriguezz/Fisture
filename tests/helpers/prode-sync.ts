// Datos y respuestas falsas de ESPN para las pasadas del prode (docs/40 D4). Los eventos son sintéticos, con la
// forma que lee el adaptador (los casos reales de ESPN se prueban con las fixtures espn-prode-* en data-sync).
import { leagues, matches, prodeMatches, teams } from "../../drizzle/schema";
import type { Database } from "../../src/lib/db";
import { AHORA } from "./clock";

export interface PartidoSeed {
  id: number;
  liga?: string;
  inicio: number;
  status?: string;
  excluido?: boolean;
}

export interface EventoOpts {
  estado?: string;
  state?: "pre" | "in" | "post";
  goles?: [number, number];
  winner?: "home" | "away";
  tanda?: [number, number];
  inicio?: number;
}

// Partidos de ESPN ya sincronizados y adoptados en el prode
export async function sembrarPartidos(db: Database, partidos: PartidoSeed[]) {
  const sembrarLiga = (liga: string) =>
    db.insert(leagues).values({ id: `l-${liga}`, externalId: liga, name: liga, country: "Argentina", source: "espn", season: 2026 }).onConflictDoNothing();
  await sembrarLiga("arg.1");
  await db.insert(teams).values([
    { id: "t-16", externalId: "espn:16", name: "River Plate", leagueId: "l-arg.1", source: "espn" },
    { id: "t-5", externalId: "espn:5", name: "Boca Juniors", leagueId: "l-arg.1", source: "espn" },
  ]).onConflictDoNothing();
  for (const p of partidos) {
    const liga = p.liga ?? "arg.1";
    await sembrarLiga(liga);
    await db.insert(matches).values({
      id: `m-${p.id}`,
      externalId: `espn:${p.id}`,
      leagueId: `l-${liga}`,
      homeTeamId: "t-16",
      awayTeamId: "t-5",
      dateTime: new Date(p.inicio),
      venue: "Cancha",
      status: p.status ?? "scheduled",
      round: "Fecha guardada",
      source: "espn",
    });
    await db.insert(prodeMatches).values({ matchId: `m-${p.id}`, fase: "cuartos", createdAt: AHORA, excludedAt: p.excluido ? AHORA.getTime() : null });
  }
}

export function evento(id: number, inicio: number, o: EventoOpts = {}) {
  const [local, visitante] = o.goles ?? [2, 1];
  const lado = (homeAway: "home" | "away", i: 0 | 1, team: { id: string; displayName: string }) => ({
    homeAway,
    score: String(i === 0 ? local : visitante),
    winner: o.winner ? o.winner === homeAway : i === 0 ? local > visitante : visitante > local,
    shootoutScore: o.tanda?.[i],
    team,
  });
  return {
    id: String(id),
    date: new Date(o.inicio ?? inicio).toISOString(),
    season: { year: 2026, slug: "quarterfinals" },
    status: { type: { name: o.estado ?? "STATUS_FULL_TIME", state: o.state ?? "post" } },
    competitions: [{ venue: { fullName: "Cancha" }, competitors: [
      lado("home", 0, { id: "16", displayName: "River Plate" }),
      lado("away", 1, { id: "5", displayName: "Boca Juniors" }),
    ] }],
  };
}

// summary de un partido definido por penales: 0-0 en los cuatro períodos y pasa el local
export function resumenPenales() {
  const lado = (homeAway: "home" | "away", id: string, tanda: number) => ({
    homeAway,
    score: "0",
    winner: homeAway === "home",
    shootoutScore: tanda,
    team: { id },
    linescores: [0, 0, 0, 0, tanda].map((v) => ({ displayValue: String(v) })),
  });
  return { header: { competitions: [{ status: { type: { name: "STATUS_FINAL_PEN", state: "post" } }, competitors: [lado("home", "16", 4), lado("away", "5", 2)] }] } };
}

export const PENALES: EventoOpts = { estado: "STATUS_FINAL_PEN", goles: [0, 0], winner: "home", tanda: [4, 2] };
