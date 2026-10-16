// Chequeos de integridad de los datos sincronizados. Se ejecutan al final de cada sync;
// los hallazgos se guardan en sync_runs.issues y no bloquean el sync.
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../db";
import type { ConsistencyIssue, IssueSeverity } from "./types";

const MUESTRA = 5;
// Un partido "programado" se considera vencido pasadas 3 h de su inicio
const HORAS_VENCIDO = 3;

interface Chequeo {
  code: string;
  severity: IssueSeverity;
  id: SQL;
  // FROM + WHERE, con el alias que usa `id`
  from: SQL;
}

async function ejecutar(db: Database, c: Chequeo): Promise<ConsistencyIssue | null> {
  const [fila] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${c.from}`);
  const count = Number(fila?.n ?? 0);
  if (count === 0) return null;
  const muestra = await db.all<{ id: string }>(sql`SELECT ${c.id} AS id FROM ${c.from} LIMIT ${MUESTRA}`);
  return { code: c.code, severity: c.severity, count, sample: muestra.map((m) => m.id) };
}

export async function checkConsistency(db: Database, now = Date.now()): Promise<ConsistencyIssue[]> {
  // matches.date_time se guarda en segundos
  const limiteVencido = Math.floor(now / 1000) - HORAS_VENCIDO * 3600;

  const chequeos: Chequeo[] = [
    {
      code: "match_missing_team",
      severity: "error",
      id: sql`m.id`,
      from: sql`matches m
        LEFT JOIN teams h ON h.id = m.home_team_id
        LEFT JOIN teams a ON a.id = m.away_team_id
        WHERE h.id IS NULL OR a.id IS NULL`,
    },
    {
      code: "match_same_team",
      severity: "error",
      id: sql`m.id`,
      from: sql`matches m WHERE m.home_team_id = m.away_team_id`,
    },
    {
      code: "duplicate_match",
      severity: "error",
      id: sql`m.id`,
      from: sql`matches m WHERE m.id IN (
        SELECT MIN(id) FROM matches GROUP BY league_id, home_team_id, away_team_id, date_time HAVING COUNT(*) > 1
      )`,
    },
    {
      code: "stale_scheduled",
      severity: "warn",
      id: sql`m.id`,
      from: sql`matches m WHERE m.status = 'scheduled' AND m.date_time < ${limiteVencido}`,
    },
    {
      code: "finished_without_score",
      severity: "warn",
      id: sql`m.id`,
      from: sql`matches m WHERE m.status = 'finished' AND (m.home_score IS NULL OR m.away_score IS NULL)`,
    },
    {
      code: "empty_league",
      severity: "warn",
      id: sql`l.id`,
      from: sql`leagues l WHERE l.is_active = 1 AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.league_id = l.id)`,
    },
  ];

  const issues: ConsistencyIssue[] = [];
  for (const c of chequeos) {
    const issue = await ejecutar(db, c);
    if (issue) issues.push(issue);
  }
  return issues;
}
