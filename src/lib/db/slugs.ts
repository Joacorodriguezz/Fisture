// Slugs de equipos y ligas en D1 (docs/33 D9). Las reglas puras están en lib/slug.ts.
//
// Pensado para la cuota de lecturas de D1 y las 50 subrequests de Workers Free:
// - los ocupados se leen solo para los slugs base que se van a asignar, con rangos sobre el índice
//   único (y sobre la clave primaria, porque la página busca `slug = ? OR id = ?`): unas pocas filas
//   por nombre, nunca la tabla entera;
// - el backfill procesa un lote acotado por llamada y escribe en db.batch.
import { and, count, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { leagues, teams } from "../../../drizzle/schema";
import { asignarSlugs, basesDeSlug, rangoDeSlug, type FilaSinSlug } from "../slug";
import type { Database } from "./index";

export type TablaConSlug = "teams" | "leagues";

const TABLAS = { teams, leagues } as const;

// 100 parámetros máx. por sentencia en D1 / 4 por slug base (dos rangos)
const BASES_POR_CONSULTA = 25;
// Sentencias por db.batch (como en el sync)
const SENTENCIAS_POR_BATCH = 50;
// Filas por llamada al backfill: ~10 subrequests (lecturas, ocupados, dos batches y el conteo)
export const LOTE_SLUGS = 100;

// Slugs e ids ocupados que podrían chocar con los slugs base dados (la base y todas sus variantes "base-…")
export async function slugsOcupados(db: Database, tabla: TablaConSlug, bases: string[]): Promise<Set<string>> {
  const t = TABLAS[tabla];
  const ocupados = new Set<string>();
  for (let i = 0; i < bases.length; i += BASES_POR_CONSULTA) {
    const rangos = bases.slice(i, i + BASES_POR_CONSULTA).flatMap((base) => {
      const [desde, hasta] = rangoDeSlug(base);
      return [sql`(${t.slug} >= ${desde} AND ${t.slug} < ${hasta})`, sql`(${t.id} >= ${desde} AND ${t.id} < ${hasta})`];
    });
    const filas = await db.select({ id: t.id, slug: t.slug }).from(t).where(or(...rangos));
    for (const f of filas) {
      ocupados.add(f.id);
      if (f.slug) ocupados.add(f.slug);
    }
  }
  return ocupados;
}

// Slugs para filas que todavía no existen o no tienen slug, contra lo ya ocupado en la tabla.
// Una lectura por cada 25 nombres distintos; ninguna si no hay nombres con slug posible.
export async function resolverSlugsNuevos(db: Database, tabla: TablaConSlug, filas: FilaSinSlug[]): Promise<Map<string, string>> {
  const bases = basesDeSlug(filas);
  if (bases.length === 0) return new Map();
  return asignarSlugs(filas, await slugsOcupados(db, tabla, bases));
}

// Escritura condicional: si otra corrida ya le puso slug a la fila, no se pisa (un slug nunca cambia)
function sentenciasDeSlug(db: Database, tabla: TablaConSlug, asignados: Map<string, string>): BatchItem<"sqlite">[] {
  const t = TABLAS[tabla];
  return [...asignados].map(([id, slug]) => db.update(t).set({ slug }).where(and(eq(t.id, id), isNull(t.slug))));
}

export async function guardarSlugs(db: Database, tabla: TablaConSlug, asignados: Map<string, string>): Promise<void> {
  const sentencias = sentenciasDeSlug(db, tabla, asignados);
  for (let i = 0; i < sentencias.length; i += SENTENCIAS_POR_BATCH) {
    await db.batch(sentencias.slice(i, i + SENTENCIAS_POR_BATCH) as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  }
}

// Filas que el backfill puede resolver: sin slug y con al menos una letra o número ASCII en el nombre
// (así slugificar nunca da vacío). Un nombre sin ninguno queda con la URL por id y no cuenta como
// pendiente, para que el backfill termine en `pendientes: 0`.
function pendiente(tabla: TablaConSlug): SQL {
  const t = TABLAS[tabla];
  return and(isNull(t.slug), sql`${t.name} GLOB '*[A-Za-z0-9]*'`)!;
}

async function sinSlug(db: Database, tabla: TablaConSlug, limite: number): Promise<FilaSinSlug[]> {
  if (limite <= 0) return [];
  const t = TABLAS[tabla];
  // Por orden de alta (rowid): ante dos nombres iguales, el slug sin sufijo queda para el que se cargó
  // primero, que es el de la competencia que el sync recorre antes (ligas antes que copas).
  return db
    .select({ id: t.id, name: t.name, country: t.country })
    .from(t)
    .where(pendiente(tabla))
    .orderBy(sql`rowid`)
    .limit(limite);
}

export async function contarPendientes(db: Database): Promise<{ ligas: number; equipos: number }> {
  const [ligas] = await db.select({ n: count() }).from(leagues).where(pendiente("leagues"));
  const [equipos] = await db.select({ n: count() }).from(teams).where(pendiente("teams"));
  return { ligas: Number(ligas?.n ?? 0), equipos: Number(equipos?.n ?? 0) };
}

export interface ResultadoSlugs {
  asignados: { ligas: number; equipos: number };
  // Filas que todavía no tienen slug (y pueden tenerlo): se repite la llamada hasta que sea 0
  pendientes: number;
  pendientesPorTabla: { ligas: number; equipos: number };
}

// Backfill (POST /api/admin/slugs): primero las ligas, después los equipos, hasta `limite` filas por
// llamada. Idempotente: solo toca filas sin slug y nunca cambia uno asignado.
export async function asignarSlugsPendientes(db: Database, limite = LOTE_SLUGS): Promise<ResultadoSlugs> {
  const ligas = await sinSlug(db, "leagues", limite);
  const equipos = await sinSlug(db, "teams", limite - ligas.length);

  const slugsLigas = await resolverSlugsNuevos(db, "leagues", ligas);
  const slugsEquipos = await resolverSlugsNuevos(db, "teams", equipos);
  await guardarSlugs(db, "leagues", slugsLigas);
  await guardarSlugs(db, "teams", slugsEquipos);

  const pendientesPorTabla = await contarPendientes(db);
  return {
    asignados: { ligas: slugsLigas.size, equipos: slugsEquipos.size },
    pendientes: pendientesPorTabla.ligas + pendientesPorTabla.equipos,
    pendientesPorTabla,
  };
}
