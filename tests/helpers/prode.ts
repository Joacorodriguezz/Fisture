// Escenario base del prode (docs/37): una liga destacada con partidos en todos los estados, una copa
// no destacada y cuatro usuarios. Las fechas son relativas a AHORA (helpers/clock.ts).
import type { D1Database } from "@cloudflare/workers-types";
import { AHORA, DIA_MS, HORA_MS } from "./clock";

export const LIGA = "lpf";
export const COPA = "copa";
export const USUARIOS = ["ana", "beto", "caro", "dani"] as const;

const seg = (d: Date | number) => Math.floor((typeof d === "number" ? d : d.getTime()) / 1000);

export interface PartidoSemilla {
  id: string;
  dentroDeMs: number;
  status?: string;
  local?: number | null;
  visitante?: number | null;
  liga?: string;
}

// Partidos de la liga: abiertos, empezados sin marcar, en juego, terminados, postergado y cancelado
export const PARTIDOS: PartidoSemilla[] = [
  { id: "abierto-1", dentroDeMs: 2 * HORA_MS },
  { id: "abierto-2", dentroDeMs: DIA_MS },
  { id: "abierto-lejos", dentroDeMs: 40 * DIA_MS },
  { id: "empezado", dentroDeMs: -10 * 60_000 },
  { id: "en-juego", dentroDeMs: -HORA_MS, status: "live" },
  { id: "terminado-1", dentroDeMs: -DIA_MS, status: "finished", local: 2, visitante: 1 },
  { id: "terminado-2", dentroDeMs: -2 * DIA_MS, status: "finished", local: 0, visitante: 0 },
  { id: "sin-marcador", dentroDeMs: -3 * DIA_MS, status: "finished", local: null, visitante: null },
  { id: "postergado", dentroDeMs: DIA_MS, status: "postponed" },
  { id: "cancelado", dentroDeMs: -DIA_MS, status: "cancelled" },
  { id: "viejo", dentroDeMs: -60 * DIA_MS, status: "finished", local: 1, visitante: 0 },
  { id: "copa-abierto", dentroDeMs: DIA_MS, liga: COPA },
];

export async function sembrarProde(DB: D1Database, ahora: Date = AHORA, partidos: PartidoSemilla[] = PARTIDOS) {
  const sentencias = [
    DB.prepare("INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES (?1, ?2, ?3, 'Argentina', 2026, 'espn', 1, ?4)").bind(LIGA, "arg.1", "Liga Profesional", 1),
    DB.prepare("INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES (?1, ?2, ?3, 'Argentina', 2026, 'espn', 1, ?4)").bind(COPA, "arg.copa", "Copa Argentina", 0),
    DB.prepare("INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES ('inactiva', 'x.1', 'Liga inactiva', 'Argentina', 2026, 'espn', 0, 1)"),
    DB.prepare("INSERT INTO teams (id, external_id, name, short_name, league_id) VALUES ('river', 't:river', 'River Plate', 'RIV', ?1), ('boca', 't:boca', 'Boca Juniors', 'BOC', ?1)").bind(LIGA),
    ...USUARIOS.map((u, i) =>
      DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES (?1, ?2, ?3, 'google', ?1)").bind(u, `${u}@example.test`, i === 3 ? null : `${u[0].toUpperCase()}${u.slice(1)} Pérez`)
    ),
    ...partidos.map((p) =>
      DB.prepare(
        "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, home_score, away_score, updated_at) VALUES (?1, ?1, 'river', 'boca', ?2, ?3, ?4, ?5, ?6, ?7)"
      ).bind(p.id, p.liga ?? LIGA, seg(ahora.getTime() + p.dentroDeMs), p.status ?? "scheduled", p.local ?? null, p.visitante ?? null, seg(ahora.getTime() - DIA_MS))
    ),
  ];
  await DB.batch(sentencias);
}

// Pronóstico directo en la base (sin pasar por la guarda de cierre), para armar historiales
export async function pronosticoDirecto(DB: D1Database, userId: string, matchId: string, local: number, visitante: number, puntos: number | null = null) {
  const t = seg(AHORA) - 10 * 86_400;
  await DB.prepare(
    "INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, points, scored_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)"
  )
    .bind(userId, matchId, local, visitante, puntos, puntos === null ? null : seg(AHORA), t)
    .run();
}

export { seg };
