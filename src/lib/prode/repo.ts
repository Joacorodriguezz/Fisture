// Acceso a D1 del prode (docs/37 §5). SQL directo y explícito: los planes se verifican en
// tests/integration/db/planes-de-consulta.test.ts. Fechas en segundos Unix en la base y Date afuera.
import type { D1Database } from "@cloudflare/workers-types";
import {
  MAX_GRUPOS_POR_USUARIO,
  MAX_MIEMBROS,
  estadoPartido,
  generarCodigo,
  nombreVisible,
  seRevela,
  type EstadoPronostico,
  type FilaTablaCruda,
  type Marcador,
  type PronosticoEntrada,
} from "./reglas";

export type { PronosticoEntrada };

const seg = (d: Date) => Math.floor(d.getTime() / 1000);
const fecha = (s: number) => new Date(s * 1000);
const DIA_S = 86_400;

type Falla<E extends string> = { ok: false; error: E };

// ============================================
// GRUPOS
// ============================================

export interface GrupoDetalle {
  id: string;
  name: string;
  leagueId: string;
  ligaNombre: string;
  ligaLogo: string | null;
  ligaExternalId: string;
  inviteCode: string;
  ownerId: string | null;
  startsAt: Date;
  miembros: number;
  esAdmin: boolean;
}

interface FilaGrupo {
  id: string;
  name: string;
  league_id: string;
  liga_nombre: string;
  liga_logo: string | null;
  liga_external_id: string;
  invite_code: string;
  owner_id: string | null;
  starts_at: number;
  miembros: number;
  mas_antiguo: string | null;
}

// Administra el dueño; sin dueño (borró su cuenta), el miembro más antiguo (docs/37 D8)
function adminDe(fila: Pick<FilaGrupo, "owner_id" | "mas_antiguo">): string | null {
  return fila.owner_id ?? fila.mas_antiguo;
}

const SQL_GRUPO = `SELECT g.id, g.name, g.league_id, l.name AS liga_nombre, l.logo AS liga_logo, l.external_id AS liga_external_id,
    g.invite_code, g.owner_id, g.starts_at,
    (SELECT COUNT(*) FROM prode_members c WHERE c.group_id = g.id) AS miembros,
    (SELECT a.user_id FROM prode_members a WHERE a.group_id = g.id ORDER BY a.joined_at, a.user_id LIMIT 1) AS mas_antiguo
  FROM prode_groups g
  JOIN leagues l ON l.id = g.league_id`;

function aDetalle(fila: FilaGrupo, userId: string): GrupoDetalle {
  return {
    id: fila.id,
    name: fila.name,
    leagueId: fila.league_id,
    ligaNombre: fila.liga_nombre,
    ligaLogo: fila.liga_logo,
    ligaExternalId: fila.liga_external_id,
    inviteCode: fila.invite_code,
    ownerId: fila.owner_id,
    startsAt: fecha(fila.starts_at),
    miembros: fila.miembros,
    esAdmin: adminDe(fila) === userId,
  };
}

// El grupo, solo si el usuario es miembro (si no, null: la página responde 404 sin revelar que existe)
export async function grupoParaMiembro(DB: D1Database, grupoId: string, userId: string): Promise<GrupoDetalle | null> {
  const fila = await DB.prepare(
    `${SQL_GRUPO} JOIN prode_members yo ON yo.group_id = g.id AND yo.user_id = ?2 WHERE g.id = ?1`
  )
    .bind(grupoId, userId)
    .first<FilaGrupo>();
  return fila ? aDetalle(fila, userId) : null;
}

async function cantidadDeGrupos(DB: D1Database, userId: string): Promise<number> {
  const fila = await DB.prepare("SELECT COUNT(*) AS n FROM prode_members WHERE user_id = ?1").bind(userId).first<{ n: number }>();
  return fila?.n ?? 0;
}

function esCodigoRepetido(error: unknown): boolean {
  return /UNIQUE constraint failed: prode_groups\.invite_code/i.test(String((error as Error)?.message ?? error));
}

// Inserta con un código nuevo; ante la (improbable) colisión del índice único, reintenta
async function conCodigoNuevo<T>(intentar: (codigo: string) => Promise<T>): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await intentar(generarCodigo());
    } catch (error) {
      if (!esCodigoRepetido(error) || intento >= 5) throw error;
    }
  }
}

export async function crearGrupo(
  DB: D1Database,
  datos: { userId: string; nombre: string; ligaId: string; ahora: Date }
): Promise<{ ok: true; id: string; codigo: string } | Falla<"liga_invalida" | "limite_grupos">> {
  const [liga, grupos] = await Promise.all([
    DB.prepare("SELECT id FROM leagues WHERE id = ?1 AND is_active = 1 AND is_featured = 1").bind(datos.ligaId).first(),
    cantidadDeGrupos(DB, datos.userId),
  ]);
  if (!liga) return { ok: false, error: "liga_invalida" };
  if (grupos >= MAX_GRUPOS_POR_USUARIO) return { ok: false, error: "limite_grupos" };

  const id = crypto.randomUUID();
  const ahora = seg(datos.ahora);
  const codigo = await conCodigoNuevo(async (codigo) => {
    await DB.batch([
      DB.prepare(
        "INSERT INTO prode_groups (id, name, league_id, invite_code, owner_id, starts_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
      ).bind(id, datos.nombre, datos.ligaId, codigo, datos.userId, ahora),
      DB.prepare("INSERT INTO prode_members (group_id, user_id, joined_at) VALUES (?1, ?2, ?3)").bind(id, datos.userId, ahora),
    ]);
    return codigo;
  });
  return { ok: true, id, codigo };
}

export interface InvitacionGrupo {
  id: string;
  name: string;
  leagueId: string;
  ligaNombre: string;
  ligaLogo: string | null;
  ligaExternalId: string;
  miembros: number;
  organizador: string | null;
}

// Lo que muestra el link de invitación: nada de ids de usuarios ni emails
export async function grupoPorCodigo(DB: D1Database, codigo: string): Promise<InvitacionGrupo | null> {
  const fila = await DB.prepare(
    `SELECT g.id, g.name, g.league_id, l.name AS liga_nombre, l.logo AS liga_logo, l.external_id AS liga_external_id,
        (SELECT COUNT(*) FROM prode_members c WHERE c.group_id = g.id) AS miembros, u.name AS organizador, g.owner_id
      FROM prode_groups g
      JOIN leagues l ON l.id = g.league_id
      LEFT JOIN users u ON u.id = g.owner_id
      WHERE g.invite_code = ?1`
  )
    .bind(codigo)
    .first<{ id: string; name: string; league_id: string; liga_nombre: string; liga_logo: string | null; liga_external_id: string; miembros: number; organizador: string | null; owner_id: string | null }>();
  if (!fila) return null;
  return {
    id: fila.id,
    name: fila.name,
    leagueId: fila.league_id,
    ligaNombre: fila.liga_nombre,
    ligaLogo: fila.liga_logo,
    ligaExternalId: fila.liga_external_id,
    miembros: fila.miembros,
    organizador: fila.owner_id ? nombreVisible(fila.organizador) : null,
  };
}

export async function esMiembro(DB: D1Database, grupoId: string, userId: string): Promise<boolean> {
  return !!(await DB.prepare("SELECT 1 FROM prode_members WHERE group_id = ?1 AND user_id = ?2").bind(grupoId, userId).first());
}

export async function unirseAGrupo(
  DB: D1Database,
  datos: { userId: string; codigo: string; ahora: Date }
): Promise<{ ok: true; grupoId: string; yaEraMiembro: boolean } | Falla<"codigo_inexistente" | "grupo_lleno" | "limite_grupos">> {
  const grupo = await DB.prepare("SELECT id FROM prode_groups WHERE invite_code = ?1").bind(datos.codigo).first<{ id: string }>();
  if (!grupo) return { ok: false, error: "codigo_inexistente" };
  if (await esMiembro(DB, grupo.id, datos.userId)) return { ok: true, grupoId: grupo.id, yaEraMiembro: true };
  if ((await cantidadDeGrupos(DB, datos.userId)) >= MAX_GRUPOS_POR_USUARIO) return { ok: false, error: "limite_grupos" };

  // El tope de miembros va en la misma sentencia: dos uniones a la vez no lo pasan
  const r = await DB.prepare(
    `INSERT INTO prode_members (group_id, user_id, joined_at)
      SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM prode_members WHERE group_id = ?1) < ?4
      ON CONFLICT (group_id, user_id) DO NOTHING`
  )
    .bind(grupo.id, datos.userId, seg(datos.ahora), MAX_MIEMBROS)
    .run();
  if (r.meta.changes > 0) return { ok: true, grupoId: grupo.id, yaEraMiembro: false };
  // Sin cambios: o se llenó, o se unió en paralelo (doble toque)
  return (await esMiembro(DB, grupo.id, datos.userId))
    ? { ok: true, grupoId: grupo.id, yaEraMiembro: true }
    : { ok: false, error: "grupo_lleno" };
}

export interface MiembroGrupo {
  userId: string;
  nombre: string;
  joinedAt: Date;
}

export async function miembrosDeGrupo(DB: D1Database, grupoId: string): Promise<MiembroGrupo[]> {
  const { results } = await DB.prepare(
    `SELECT m.user_id, u.name, m.joined_at FROM prode_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?1 ORDER BY m.joined_at, m.user_id`
  )
    .bind(grupoId)
    .all<{ user_id: string; name: string | null; joined_at: number }>();
  return results.map((r) => ({ userId: r.user_id, nombre: nombreVisible(r.name), joinedAt: fecha(r.joined_at) }));
}

export interface GrupoResumen {
  id: string;
  name: string;
  leagueId: string;
  ligaNombre: string;
  ligaLogo: string | null;
  ligaExternalId: string;
  startsAt: Date;
  miembros: number;
}

export async function misGrupos(DB: D1Database, userId: string): Promise<GrupoResumen[]> {
  const { results } = await DB.prepare(
    `SELECT g.id, g.name, g.league_id, l.name AS liga_nombre, l.logo AS liga_logo, l.external_id AS liga_external_id, g.starts_at,
        (SELECT COUNT(*) FROM prode_members c WHERE c.group_id = g.id) AS miembros
      FROM prode_members yo
      JOIN prode_groups g ON g.id = yo.group_id
      JOIN leagues l ON l.id = g.league_id
      WHERE yo.user_id = ?1
      ORDER BY yo.joined_at DESC, g.id`
  )
    .bind(userId)
    .all<Omit<FilaGrupo, "invite_code" | "owner_id" | "mas_antiguo">>();
  return results.map((f) => ({
    id: f.id,
    name: f.name,
    leagueId: f.league_id,
    ligaNombre: f.liga_nombre,
    ligaLogo: f.liga_logo,
    ligaExternalId: f.liga_external_id,
    startsAt: fecha(f.starts_at),
    miembros: f.miembros,
  }));
}

type ErrorAdmin = "no_miembro" | "no_admin";

async function exigirAdmin(DB: D1Database, grupoId: string, userId: string): Promise<GrupoDetalle | Falla<ErrorAdmin>> {
  const g = await grupoParaMiembro(DB, grupoId, userId);
  if (!g) return { ok: false, error: "no_miembro" };
  if (!g.esAdmin) return { ok: false, error: "no_admin" };
  return g;
}

function esFalla<E extends string>(v: unknown): v is Falla<E> {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
}

export async function regenerarCodigo(DB: D1Database, grupoId: string, userId: string): Promise<{ ok: true; codigo: string } | Falla<ErrorAdmin>> {
  const g = await exigirAdmin(DB, grupoId, userId);
  if (esFalla<ErrorAdmin>(g)) return g;
  const codigo = await conCodigoNuevo(async (codigo) => {
    await DB.prepare("UPDATE prode_groups SET invite_code = ?2 WHERE id = ?1").bind(grupoId, codigo).run();
    return codigo;
  });
  return { ok: true, codigo };
}

export async function expulsarMiembro(
  DB: D1Database,
  grupoId: string,
  adminId: string,
  miembroId: string
): Promise<{ ok: true } | Falla<ErrorAdmin | "es_vos">> {
  const g = await exigirAdmin(DB, grupoId, adminId);
  if (esFalla<ErrorAdmin>(g)) return g;
  if (miembroId === adminId) return { ok: false, error: "es_vos" };
  const r = await DB.prepare("DELETE FROM prode_members WHERE group_id = ?1 AND user_id = ?2").bind(grupoId, miembroId).run();
  return r.meta.changes > 0 ? { ok: true } : { ok: false, error: "no_miembro" };
}

export async function borrarGrupo(DB: D1Database, grupoId: string, userId: string): Promise<{ ok: true } | Falla<ErrorAdmin>> {
  const g = await exigirAdmin(DB, grupoId, userId);
  if (esFalla<ErrorAdmin>(g)) return g;
  // Los miembros se van por la cascada; los pronósticos son de cada usuario y no se tocan
  await DB.prepare("DELETE FROM prode_groups WHERE id = ?1").bind(grupoId).run();
  return { ok: true };
}

export async function salirDeGrupo(DB: D1Database, grupoId: string, userId: string): Promise<{ ok: true; grupoBorrado: boolean } | Falla<"no_miembro">> {
  const g = await grupoParaMiembro(DB, grupoId, userId);
  if (!g) return { ok: false, error: "no_miembro" };

  const siguiente = await DB.prepare(
    "SELECT user_id FROM prode_members WHERE group_id = ?1 AND user_id <> ?2 ORDER BY joined_at, user_id LIMIT 1"
  )
    .bind(grupoId, userId)
    .first<{ user_id: string }>();

  if (!siguiente) {
    await DB.prepare("DELETE FROM prode_groups WHERE id = ?1").bind(grupoId).run();
    return { ok: true, grupoBorrado: true };
  }
  await DB.batch([
    // Si sale el dueño, el grupo pasa al miembro más antiguo (docs/37 D8)
    DB.prepare("UPDATE prode_groups SET owner_id = ?3 WHERE id = ?1 AND owner_id = ?2").bind(grupoId, userId, siguiente.user_id),
    DB.prepare("DELETE FROM prode_members WHERE group_id = ?1 AND user_id = ?2").bind(grupoId, userId),
  ]);
  return { ok: true, grupoBorrado: false };
}

// ============================================
// PRONÓSTICOS
// ============================================

export type MotivoRechazo = "cerrado" | "inexistente";

export interface ResultadoGuardado {
  guardados: { partidoId: string; local: number; visitante: number }[];
  borrados: string[];
  rechazados: { partidoId: string; motivo: MotivoRechazo }[];
}

// Condición de partido abierto, en SQL: la guarda va en la misma sentencia que escribe (docs/37 D2).
// `ahora` es el marcador del parámetro con la hora del servidor en segundos.
const abierto = (ahora: string) => `status = 'scheduled' AND date_time > ${ahora}`;

export async function guardarPronosticos(DB: D1Database, userId: string, entradas: PronosticoEntrada[], ahora: Date): Promise<ResultadoGuardado> {
  const salida: ResultadoGuardado = { guardados: [], borrados: [], rechazados: [] };
  // Si se repite un partido, vale el último valor (en el lugar de la primera aparición)
  const porPartido = new Map<string, PronosticoEntrada>();
  for (const e of entradas) porPartido.set(e.partidoId, e);
  const lista = [...porPartido.values()];
  if (lista.length === 0) return salida;

  const t = seg(ahora);
  const marcadores = lista.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await DB.prepare(`SELECT id, status, date_time FROM matches WHERE id IN (${marcadores})`)
    .bind(...lista.map((e) => e.partidoId))
    .all<{ id: string; status: string | null; date_time: number }>();
  const partidos = new Map(results.map((r) => [r.id, r]));

  const aEscribir: PronosticoEntrada[] = [];
  for (const e of lista) {
    const p = partidos.get(e.partidoId);
    if (!p) salida.rechazados.push({ partidoId: e.partidoId, motivo: "inexistente" });
    else if (estadoPartido({ status: p.status, dateTime: fecha(p.date_time) }, ahora) !== "abierto") salida.rechazados.push({ partidoId: e.partidoId, motivo: "cerrado" });
    else aEscribir.push(e);
  }
  if (aEscribir.length === 0) return salida;

  const sentencias = aEscribir.map((e) =>
    e.local === null || e.visitante === null
      ? DB.prepare(
          `DELETE FROM prode_predictions WHERE user_id = ?1 AND match_id = ?2
            AND EXISTS (SELECT 1 FROM matches WHERE id = ?2 AND ${abierto("?3")})`
        ).bind(userId, e.partidoId, t)
      : DB.prepare(
          `INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, points, scored_at, created_at, updated_at)
            SELECT ?1, id, ?3, ?4, NULL, NULL, ?5, ?5 FROM matches WHERE id = ?2 AND ${abierto("?5")}
            ON CONFLICT (user_id, match_id) DO UPDATE SET home_goals = excluded.home_goals, away_goals = excluded.away_goals,
              points = NULL, scored_at = NULL, updated_at = excluded.updated_at`
        ).bind(userId, e.partidoId, e.local, e.visitante, t)
  );
  // Un solo viaje a D1 para todas las escrituras
  const resultados = await DB.batch(sentencias);

  // Un borrado sin cambios (no había nada) igual se informa como borrado si el partido seguía abierto;
  // para distinguirlo de un cierre en el medio se relee el estado después
  const sinCambios = aEscribir.filter((_, i) => resultados[i].meta.changes === 0);
  const cerradosEnElMedio = new Set<string>();
  if (sinCambios.length > 0) {
    const m = sinCambios.map((_, i) => `?${i + 2}`).join(", ");
    const { results: abiertos } = await DB.prepare(`SELECT id FROM matches WHERE id IN (${m}) AND ${abierto("?1")}`)
      .bind(t, ...sinCambios.map((e) => e.partidoId))
      .all<{ id: string }>();
    const siguenAbiertos = new Set(abiertos.map((a) => a.id));
    for (const e of sinCambios) if (!siguenAbiertos.has(e.partidoId)) cerradosEnElMedio.add(e.partidoId);
  }

  for (const e of aEscribir) {
    if (cerradosEnElMedio.has(e.partidoId)) salida.rechazados.push({ partidoId: e.partidoId, motivo: "cerrado" });
    else if (e.local === null || e.visitante === null) salida.borrados.push(e.partidoId);
    else salida.guardados.push({ partidoId: e.partidoId, local: e.local, visitante: e.visitante });
  }
  return salida;
}

export interface EquipoProde {
  id: string;
  name: string;
  shortName: string | null;
  logo: string | null;
}

export interface PartidoParaPronosticar {
  id: string;
  dateTime: Date;
  round: string | null;
  local: EquipoProde;
  visitante: EquipoProde;
  pronostico: Marcador | null;
}

interface FilaPartido {
  id: string;
  date_time: number;
  status: string | null;
  round: string | null;
  home_score: number | null;
  away_score: number | null;
  l_id: string;
  l_name: string;
  l_short: string | null;
  l_logo: string | null;
  v_id: string;
  v_name: string;
  v_short: string | null;
  v_logo: string | null;
  p_local: number | null;
  p_visitante: number | null;
  p_puntos: number | null;
}

const SQL_PARTIDO = `SELECT m.id, m.date_time, m.status, m.round, m.home_score, m.away_score,
    lt.id AS l_id, lt.name AS l_name, lt.short_name AS l_short, lt.logo AS l_logo,
    vt.id AS v_id, vt.name AS v_name, vt.short_name AS v_short, vt.logo AS v_logo,
    p.home_goals AS p_local, p.away_goals AS p_visitante, p.points AS p_puntos
  FROM matches m
  JOIN teams lt ON lt.id = m.home_team_id
  JOIN teams vt ON vt.id = m.away_team_id
  LEFT JOIN prode_predictions p ON p.match_id = m.id AND p.user_id = ?1`;

const equipos = (f: FilaPartido) => ({
  local: { id: f.l_id, name: f.l_name, shortName: f.l_short, logo: f.l_logo },
  visitante: { id: f.v_id, name: f.v_name, shortName: f.v_short, logo: f.v_logo },
});

export const DIAS_PARA_PRONOSTICAR = 30;
export const MAX_PARTIDOS_PARA_PRONOSTICAR = 40;

// Partidos abiertos de la competencia en los próximos 30 días, con el pronóstico del usuario
export async function partidosParaPronosticar(DB: D1Database, userId: string, leagueId: string, ahora: Date): Promise<PartidoParaPronosticar[]> {
  const t = seg(ahora);
  const { results } = await DB.prepare(
    `${SQL_PARTIDO}
      WHERE m.league_id = ?2 AND m.status = 'scheduled' AND m.date_time > ?3 AND m.date_time < ?4
      ORDER BY m.date_time, m.id LIMIT ?5`
  )
    .bind(userId, leagueId, t, t + DIAS_PARA_PRONOSTICAR * DIA_S, MAX_PARTIDOS_PARA_PRONOSTICAR)
    .all<FilaPartido>();
  return results.map((f) => ({
    id: f.id,
    dateTime: fecha(f.date_time),
    round: f.round,
    ...equipos(f),
    pronostico: f.p_local === null || f.p_visitante === null ? null : { local: f.p_local, visitante: f.p_visitante },
  }));
}

export interface Pendiente {
  id: string;
  leagueId: string;
  dateTime: Date;
}

// Partidos abiertos de los próximos 7 días, de las competencias dadas, que el usuario no pronosticó
export async function pendientesDe(DB: D1Database, userId: string, leagueIds: string[], ahora: Date, dias = 7): Promise<Pendiente[]> {
  const ligas = [...new Set(leagueIds)];
  if (ligas.length === 0) return [];
  const t = seg(ahora);
  const marcadores = ligas.map((_, i) => `?${i + 4}`).join(", ");
  const { results } = await DB.prepare(
    `SELECT m.id, m.league_id, m.date_time FROM matches m
      WHERE m.league_id IN (${marcadores}) AND m.status = 'scheduled' AND m.date_time > ?2 AND m.date_time < ?3
        AND NOT EXISTS (SELECT 1 FROM prode_predictions p WHERE p.user_id = ?1 AND p.match_id = m.id)
      ORDER BY m.date_time, m.id LIMIT 200`
  )
    .bind(userId, t, t + dias * DIA_S, ...ligas)
    .all<{ id: string; league_id: string; date_time: number }>();
  return results.map((r) => ({ id: r.id, leagueId: r.league_id, dateTime: fecha(r.date_time) }));
}

// ============================================
// TABLA E HISTORIAL
// ============================================

type GrupoTabla = Pick<GrupoDetalle, "id" | "leagueId" | "startsAt">;

// Puntos de cada miembro en los partidos de la competencia desde el inicio del grupo (docs/37 D4).
// Los pronósticos se buscan por miembro (clave primaria): nunca los de toda la competencia, que crecen
// con cada usuario de la app (el plan lo fija tests/integration/db/planes-de-consulta.test.ts).
function sentenciaTabla(DB: D1Database, grupo: GrupoTabla) {
  return DB.prepare(
    `SELECT mem.user_id AS userId, u.name AS name, mem.joined_at AS joinedAt,
        COALESCE(SUM(p.points), 0) AS puntos,
        COALESCE(SUM(CASE WHEN p.points = 3 THEN 1 ELSE 0 END), 0) AS exactos,
        COALESCE(SUM(CASE WHEN p.points > 0 THEN 1 ELSE 0 END), 0) AS aciertos,
        COUNT(p.points) AS jugados
      FROM prode_members mem
      JOIN users u ON u.id = mem.user_id
      LEFT JOIN prode_predictions p ON p.user_id = mem.user_id AND p.points IS NOT NULL
        AND p.match_id IN (SELECT m.id FROM matches m WHERE m.league_id = ?2 AND m.date_time >= ?3)
      WHERE mem.group_id = ?1
      GROUP BY mem.user_id, u.name, mem.joined_at`
  ).bind(grupo.id, grupo.leagueId, seg(grupo.startsAt));
}

export async function tablaDeGrupo(DB: D1Database, grupo: GrupoTabla): Promise<FilaTablaCruda[]> {
  const { results } = await sentenciaTabla(DB, grupo).all<FilaTablaCruda>();
  return results;
}

// Las tablas de todos los grupos del usuario en un solo viaje a D1 (/prode)
export async function tablasDeGrupos(DB: D1Database, grupos: GrupoTabla[]): Promise<Map<string, FilaTablaCruda[]>> {
  if (grupos.length === 0) return new Map();
  const resultados = await DB.batch<FilaTablaCruda>(grupos.map((g) => sentenciaTabla(DB, g)));
  return new Map(grupos.map((g, i) => [g.id, resultados[i].results]));
}

export interface PronosticoDeMiembro {
  userId: string;
  nombre: string;
  local: number;
  visitante: number;
  puntos: number | null;
}

export interface PartidoHistorial {
  id: string;
  dateTime: Date;
  round: string | null;
  estado: EstadoPronostico;
  local: EquipoProde;
  visitante: EquipoProde;
  resultado: Marcador | null;
  mio: (Marcador & { puntos: number | null }) | null;
  // Vacío salvo que el partido haya empezado (docs/37 D5)
  grupo: PronosticoDeMiembro[];
}

export const MAX_HISTORIAL = 30;

export async function historialDeGrupo(DB: D1Database, grupo: GrupoTabla, userId: string, ahora: Date): Promise<PartidoHistorial[]> {
  const { results } = await DB.prepare(
    `${SQL_PARTIDO}
      WHERE m.league_id = ?2 AND m.date_time >= ?3 AND m.date_time <= ?4
      ORDER BY m.date_time DESC, m.id DESC LIMIT ?5`
  )
    .bind(userId, grupo.leagueId, seg(grupo.startsAt), seg(ahora), MAX_HISTORIAL)
    .all<FilaPartido>();

  const partidos = results.map((f) => {
    const estado = estadoPartido({ status: f.status, dateTime: fecha(f.date_time) }, ahora);
    return {
      id: f.id,
      dateTime: fecha(f.date_time),
      round: f.round,
      estado,
      ...equipos(f),
      resultado: f.status === "finished" && f.home_score !== null && f.away_score !== null ? { local: f.home_score, visitante: f.away_score } : null,
      mio: f.p_local === null || f.p_visitante === null ? null : { local: f.p_local, visitante: f.p_visitante, puntos: f.p_puntos },
      grupo: [] as PronosticoDeMiembro[],
    };
  });

  // Lo del grupo, solo de los partidos que ya empezaron
  const revelables = partidos.filter((p) => seRevela(p.estado));
  if (revelables.length > 0) {
    const m = revelables.map((_, i) => `?${i + 2}`).join(", ");
    const { results: ajenos } = await DB.prepare(
      `SELECT p.match_id, p.user_id, u.name, p.home_goals, p.away_goals, p.points
        FROM prode_members mem
        JOIN prode_predictions p ON p.user_id = mem.user_id AND p.match_id IN (${m})
        JOIN users u ON u.id = mem.user_id
        WHERE mem.group_id = ?1
        ORDER BY mem.joined_at, mem.user_id`
    )
      .bind(grupo.id, ...revelables.map((p) => p.id))
      .all<{ match_id: string; user_id: string; name: string | null; home_goals: number; away_goals: number; points: number | null }>();
    const porPartido = new Map(revelables.map((p) => [p.id, p]));
    for (const a of ajenos) {
      porPartido.get(a.match_id)?.grupo.push({ userId: a.user_id, nombre: nombreVisible(a.name), local: a.home_goals, visitante: a.away_goals, puntos: a.points });
    }
  }
  return partidos;
}
