// Utilidades para los tests de calendario: base sembrada y un cliente de calendario falso.
import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import type { Database } from "../../src/lib/db";
import type { CalendarClient } from "../../src/lib/calendar/clients";
import type { OverlapItem } from "../../src/lib/calendar/event-state";
import type { TestDb } from "./d1";

export const T0 = 1_800_000_000; // epoch en segundos (enero de 2027)

const TABLAS = ["calendar_syncs", "user_teams", "matches", "teams", "leagues", "user_preferences", "users"];

// Dos usuarios (u1, u2 de Google), una liga, dos equipos y los partidos indicados
export async function sembrar(t: TestDb, partidos: string[] = ["m1", "m2", "m3"]) {
  for (const tabla of TABLAS) await t.DB.prepare(`DELETE FROM ${tabla}`).run();
  await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u1','a@a','A','google','g1')").run();
  await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u2','b@b','B','google','g2')").run();
  await t.DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('l1','Liga','AR','e',2026,1)").run();
  for (const id of ["t1", "t2"]) {
    await t.DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, 'l1')").bind(id, `e-${id}`, `Equipo ${id}`).run();
  }
  for (const id of partidos) {
    await t.DB.prepare(
      "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, venue) VALUES (?, ?, 't1','t2','l1', ?, 'scheduled', 'Cancha')"
    ).bind(id, `e-${id}`, T0).run();
  }
}

export async function usuario(db: Database, id = "u1") {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u;
}

export const setMatch = (t: TestDb, id: string, campos: { dateTime?: number; venue?: string | null; status?: string }) => {
  const sets: string[] = [];
  const valores: unknown[] = [];
  if (campos.dateTime !== undefined) (sets.push("date_time = ?"), valores.push(campos.dateTime));
  if (campos.venue !== undefined) (sets.push("venue = ?"), valores.push(campos.venue));
  if (campos.status !== undefined) (sets.push("status = ?"), valores.push(campos.status));
  return t.DB.prepare(`UPDATE matches SET ${sets.join(", ")} WHERE id = ?`).bind(...valores, id).run();
};

export interface FilaSync {
  id: string;
  user_id: string;
  match_id: string;
  status: string;
  external_event_id: string | null;
  synced_date_time: number | null;
  synced_state: string | null;
  synced_venue: string | null;
  error_message: string | null;
}

export async function filas(t: TestDb, where = "1=1"): Promise<FilaSync[]> {
  const { results } = await t.DB.prepare(`SELECT * FROM calendar_syncs WHERE ${where} ORDER BY match_id, user_id`).all<FilaSync>();
  return results;
}

export const fila = async (t: TestDb, matchId: string, userId = "u1") =>
  (await filas(t, `match_id = '${matchId}' AND user_id = '${userId}'`))[0];

export const insertarSync = (
  t: TestDb,
  o: { id: string; match: string; user?: string; status?: string; event?: string | null; synced?: number | null; state?: string | null; venue?: string | null }
) =>
  t.DB.prepare(
    "INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, external_event_id, synced_date_time, synced_state, synced_venue) VALUES (?, ?, ?, 'google', ?, ?, ?, ?, ?)"
  )
    .bind(o.id, o.user ?? "u1", o.match, o.status ?? "synced", o.event === undefined ? `ev-${o.match}` : o.event, o.synced === undefined ? T0 : o.synced, o.state === undefined ? "scheduled" : o.state, o.venue === undefined ? "Cancha" : o.venue)
    .run();

// Cliente de calendario en memoria. El create es idempotente por (usuario, partido), como el real.
export interface EventoFalso {
  title: string;
  start: number; // epoch ms
}

export function clienteFalso() {
  const eventos = new Map<string, EventoFalso>();
  const llamadas = { create: 0, update: 0, remove: 0, overlaps: 0 };
  const fallos: { update?: () => Error | null; create?: () => Error | null; remove?: () => Error | null } = {};
  let solapados: OverlapItem[] = [];

  const client: CalendarClient = {
    async create(_token, match, _prefs, ctx) {
      llamadas.create++;
      const err = fallos.create?.();
      if (err) throw err;
      const id = `ev-${ctx.userId}-${match.match.id}`;
      eventos.set(id, { title: titulo(match), start: match.match.dateTime.getTime() });
      return id;
    },
    async update(_token, eventId, match) {
      llamadas.update++;
      const err = fallos.update?.();
      if (err) throw err;
      eventos.set(eventId, { title: titulo(match), start: match.match.dateTime.getTime() });
    },
    async remove(_token, eventId) {
      llamadas.remove++;
      const err = fallos.remove?.();
      if (err) throw err;
      eventos.delete(eventId);
    },
    async overlaps() {
      llamadas.overlaps++;
      return solapados;
    },
  };

  return {
    client,
    eventos,
    llamadas,
    fallos,
    setSolapados: (items: OverlapItem[]) => (solapados = items),
    total: () => llamadas.create + llamadas.update + llamadas.remove,
  };
}

function titulo(match: { match: { status: string | null }; homeTeam: { name: string }; awayTeam: { name: string } }) {
  const base = `${match.homeTeam.name} vs ${match.awayTeam.name}`;
  return match.match.status === "postponed" ? `[POSTERGADO] ${base}` : base;
}

export const getToken = async () => "token-falso";
