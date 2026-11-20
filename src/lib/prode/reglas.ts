// Reglas puras del prode (docs/37 §3): puntaje, cierre de cada partido, validaciones, códigos de
// invitación, nombres visibles y orden de la tabla. Sin I/O: lo usan la API, las páginas y el sync.

// ---- Puntaje (docs/37 D3) ----
export const PUNTOS_EXACTO = 3;
export const PUNTOS_TENDENCIA = 1;

export interface Marcador {
  local: number;
  visitante: number;
}

function signo(n: number): -1 | 0 | 1 {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

export function puntosDe(pronostico: Marcador, resultado: Marcador): number {
  if (pronostico.local === resultado.local && pronostico.visitante === resultado.visitante) return PUNTOS_EXACTO;
  if (signo(pronostico.local - pronostico.visitante) === signo(resultado.local - resultado.visitante)) return PUNTOS_TENDENCIA;
  return 0;
}

// La misma regla en SQL, para el UPDATE del sync (lib/prode/puntuar.ts). Recibe las expresiones de las
// columnas; un test verifica que dé lo mismo que puntosDe para toda la matriz de casos.
export function sqlPuntos(pLocal: string, pVisitante: string, rLocal: string, rVisitante: string): string {
  return `CASE
    WHEN ${pLocal} = ${rLocal} AND ${pVisitante} = ${rVisitante} THEN ${PUNTOS_EXACTO}
    WHEN (${pLocal} > ${pVisitante} AND ${rLocal} > ${rVisitante})
      OR (${pLocal} < ${pVisitante} AND ${rLocal} < ${rVisitante})
      OR (${pLocal} = ${pVisitante} AND ${rLocal} = ${rVisitante}) THEN ${PUNTOS_TENDENCIA}
    ELSE 0 END`;
}

// ---- Cierre (docs/37 D2) ----
export type EstadoPronostico = "abierto" | "cerrado" | "postergado" | "cancelado";

// abierto: se puede cargar. cerrado: empezó (revela lo del grupo). postergado: bloqueado y oculto hasta
// que se reprograme. cancelado: no suma.
export function estadoPartido(match: { status: string | null; dateTime: Date }, ahora: Date): EstadoPronostico {
  const status = match.status ?? "scheduled";
  if (status === "cancelled") return "cancelado";
  if (status === "postponed") return "postergado";
  if (status === "scheduled" && ahora.getTime() < match.dateTime.getTime()) return "abierto";
  return "cerrado";
}

// Lo de los demás se ve solo cuando el partido ya empezó (docs/37 D5)
export function seRevela(estado: EstadoPronostico): boolean {
  return estado === "cerrado";
}

export const GOLES_MAX = 20;

export function validarGoles(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 0 && valor <= GOLES_MAX ? valor : null;
}

// ---- Grupos (docs/37 D6 y D7) ----
export const MAX_MIEMBROS = 50;
export const MAX_GRUPOS_POR_USUARIO = 20;
export const MAX_PRONOSTICOS_POR_REQUEST = 40;
export const NOMBRE_MIN = 3;
export const NOMBRE_MAX = 40;

// Sin I, L, O, 0 ni 1: el código se dicta por teléfono o se copia a mano
export const ALFABETO_CODIGO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LARGO_CODIGO = 8;

export function generarCodigo(): string {
  const n = ALFABETO_CODIGO.length;
  // Muestreo por rechazo: sin sesgo hacia las primeras letras
  const limite = 256 - (256 % n);
  let codigo = "";
  while (codigo.length < LARGO_CODIGO) {
    const bytes = crypto.getRandomValues(new Uint8Array(LARGO_CODIGO * 2));
    for (const b of bytes) {
      if (b < limite && codigo.length < LARGO_CODIGO) codigo += ALFABETO_CODIGO[b % n];
    }
  }
  return codigo;
}

export function normalizarCodigo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const codigo = raw.toUpperCase().replace(/[\s-]/g, "");
  if (codigo.length !== LARGO_CODIGO) return null;
  return [...codigo].every((c) => ALFABETO_CODIGO.includes(c)) ? codigo : null;
}

export function formatearCodigo(codigo: string): string {
  return `${codigo.slice(0, 4)} ${codigo.slice(4)}`;
}

export function normalizarNombreGrupo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Saltos de línea y tabulaciones como espacio (después se colapsan); el resto de los controles se quita
  const nombre = raw.replace(/[\t\n\r]/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return nombre.length >= NOMBRE_MIN && nombre.length <= NOMBRE_MAX ? nombre : null;
}

// «Ana María Gómez» → «Ana G.». Nunca el email (docs/37 D5)
export function nombreVisible(name: string | null | undefined): string {
  const limpio = (name ?? "").trim();
  if (!limpio || limpio.includes("@")) return "Participante";
  const partes = limpio.split(/\s+/);
  const capital = (s: string) => s.charAt(0).toLocaleUpperCase("es") + s.slice(1);
  if (partes.length === 1) return capital(partes[0]);
  return `${capital(partes[0])} ${partes[partes.length - 1].charAt(0).toLocaleUpperCase("es")}.`;
}

// ---- Tabla (docs/37 D4) ----
export interface FilaTablaCruda {
  userId: string;
  name: string | null;
  puntos: number;
  exactos: number;
  aciertos: number;
  jugados: number;
  joinedAt: number;
}

export interface FilaTabla extends FilaTablaCruda {
  posicion: number;
  nombre: string;
  esVos: boolean;
}

export function ordenarTabla(filas: readonly FilaTablaCruda[], yoId: string): FilaTabla[] {
  const ordenadas = [...filas].sort(
    (a, b) => b.puntos - a.puntos || b.exactos - a.exactos || b.aciertos - a.aciertos || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId)
  );
  const empatan = (a: FilaTablaCruda, b: FilaTablaCruda) =>
    a.puntos === b.puntos && a.exactos === b.exactos && a.aciertos === b.aciertos;
  const salida: FilaTabla[] = [];
  ordenadas.forEach((f, i) => {
    const anterior = salida[i - 1];
    const posicion = anterior && empatan(anterior, f) ? anterior.posicion : i + 1;
    salida.push({ ...f, posicion, nombre: nombreVisible(f.name), esVos: f.userId === yoId });
  });
  return salida;
}
