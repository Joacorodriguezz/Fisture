// Métricas de producto para /api/admin/status: solo conteos agregados, nunca ids ni emails.
// Responden "¿funciona?": cuánta gente se registra, cuántos llegan a agregar un partido y cuántos eventos
// mantiene la app. Las bajas no quedan en la base (el borrado es total): se cuentan desde el log
// `account_deleted` (wrangler pages deployment tail o el dashboard de Workers Logs).
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import { FASES, esFase, type Fase } from "../prode/horario";
import { SOURCE_MANUAL } from "../prode/partidos";

const DIA_S = 24 * 60 * 60;

export interface Metricas {
  usuarios: number;
  registrosUltimos7Dias: number;
  registrosUltimos30Dias: number;
  // Siguen al menos un equipo
  usuariosConEquipos: number;
  // Tienen al menos un partido en su calendario (calendar_syncs en synced)
  usuariosConPartidos: number;
  eventosEnCalendarios: number;
  equiposSeguidos: number;
  // Usuarios cuyo calendario perdió acceso y esperan volver a iniciar sesión (docs/17 B4)
  calendariosSinAcceso: number;
  // Piloto del prode (docs/37, docs/38): agregados sin ids, nombres ni códigos de grupo
  prode: MetricasProde;
}

export type PorFase = Record<Fase, number>;

export interface MetricasProde {
  gruposCreados: number;
  // Usuarios distintos con al menos un pronóstico
  participantes: number;
  // Usuarios distintos que pronosticaron en esa fase
  participantesPorFase: PorFase;
  // Pronosticaron en esa fase y en alguna anterior (orden de FASES): señal de retención
  regresanPorFase: PorFase;
  integrantesPorGrupo: { promedio: number; maximo: number };
  // abiertos: el pronóstico sigue abierto; cerrados: ya empezó; conResultado: finished con goles a 90' cargados
  partidos: { abiertos: number; cerrados: number; conResultado: number };
  pronosticos: number;
}

const porFaseVacio = (): PorFase => ({ octavos: 0, cuartos: 0, semifinal: 0, final: 0 });

// Posición de la fase en FASES (1..n), para comparar "anterior" en SQL
const ORDEN_FASE = sql.raw(`CASE fase ${FASES.map((f, i) => `WHEN '${f}' THEN ${i + 1}`).join(" ")} ELSE 0 END`);

async function getMetricasProde(db: Database): Promise<MetricasProde> {
  // Dos consultas: los escalares y un GROUP BY por fase (sin N+1 ni filas por usuario hacia afuera)
  const [fila] = await db.all<Record<string, number | null>>(sql`
    SELECT
      (SELECT COUNT(*) FROM prode_groups) AS grupos,
      (SELECT COUNT(DISTINCT user_id) FROM prode_predictions) AS participantes,
      (SELECT COUNT(*) FROM prode_predictions) AS pronosticos,
      (SELECT AVG(n) FROM (SELECT COUNT(*) AS n FROM prode_group_members GROUP BY group_id)) AS promedio,
      (SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM prode_group_members GROUP BY group_id)) AS maximo,
      (SELECT COUNT(*) FROM prode_matches WHERE closed_at IS NULL) AS abiertos,
      (SELECT COUNT(*) FROM prode_matches WHERE closed_at IS NOT NULL) AS cerrados,
      (SELECT COUNT(*) FROM prode_matches pm JOIN matches m ON m.id = pm.match_id
        WHERE m.status = 'finished'
          AND (CASE WHEN m.source = ${SOURCE_MANUAL} THEN m.home_score ELSE pm.home_goals_90 END) IS NOT NULL
          AND (CASE WHEN m.source = ${SOURCE_MANUAL} THEN m.away_score ELSE pm.away_goals_90 END) IS NOT NULL) AS conResultado
  `);
  const fases = await db.all<{ fase: string; participantes: number; regresan: number }>(sql`
    WITH up AS (
      SELECT DISTINCT p.user_id AS u, pm.fase AS fase, ${ORDEN_FASE} AS ord
      FROM prode_predictions p JOIN prode_matches pm ON pm.match_id = p.match_id
    )
    SELECT fase, COUNT(*) AS participantes,
      SUM(EXISTS (SELECT 1 FROM up a WHERE a.u = up.u AND a.ord < up.ord)) AS regresan
    FROM up GROUP BY fase
  `);
  const participantesPorFase = porFaseVacio();
  const regresanPorFase = porFaseVacio();
  for (const f of fases) {
    if (!esFase(f.fase)) continue;
    participantesPorFase[f.fase] = Number(f.participantes);
    regresanPorFase[f.fase] = Number(f.regresan);
  }
  return {
    gruposCreados: Number(fila.grupos),
    participantes: Number(fila.participantes),
    participantesPorFase,
    regresanPorFase,
    integrantesPorGrupo: { promedio: Math.round(Number(fila.promedio ?? 0) * 100) / 100, maximo: Number(fila.maximo ?? 0) },
    partidos: { abiertos: Number(fila.abiertos), cerrados: Number(fila.cerrados), conResultado: Number(fila.conResultado) },
    pronosticos: Number(fila.pronosticos),
  };
}

export async function getMetricas(db: Database, ahora = Date.now()): Promise<Metricas> {
  // users.created_at está en segundos
  const hoy = Math.floor(ahora / 1000);
  const prode = await getMetricasProde(db);
  const [fila] = await db.all<Record<Exclude<keyof Metricas, "prode">, number>>(sql`
    SELECT
      (SELECT COUNT(*) FROM users) AS usuarios,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${hoy - 7 * DIA_S}) AS registrosUltimos7Dias,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${hoy - 30 * DIA_S}) AS registrosUltimos30Dias,
      (SELECT COUNT(DISTINCT user_id) FROM user_teams) AS usuariosConEquipos,
      (SELECT COUNT(DISTINCT user_id) FROM calendar_syncs WHERE status = 'synced') AS usuariosConPartidos,
      (SELECT COUNT(*) FROM calendar_syncs WHERE status = 'synced') AS eventosEnCalendarios,
      (SELECT COUNT(*) FROM user_teams) AS equiposSeguidos,
      (SELECT COUNT(*) FROM users WHERE calendar_auth_status = 'reauth_required') AS calendariosSinAcceso
  `);
  return {
    usuarios: Number(fila.usuarios),
    registrosUltimos7Dias: Number(fila.registrosUltimos7Dias),
    registrosUltimos30Dias: Number(fila.registrosUltimos30Dias),
    usuariosConEquipos: Number(fila.usuariosConEquipos),
    usuariosConPartidos: Number(fila.usuariosConPartidos),
    eventosEnCalendarios: Number(fila.eventosEnCalendarios),
    equiposSeguidos: Number(fila.equiposSeguidos),
    calendariosSinAcceso: Number(fila.calendariosSinAcceso),
    prode,
  };
}
