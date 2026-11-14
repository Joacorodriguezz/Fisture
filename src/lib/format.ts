// Formato de fechas para la UI. Todo se muestra en hora de Buenos Aires,
// sin importar la zona horaria del servidor (Cloudflare corre en UTC).

export const TZ = "America/Argentina/Buenos_Aires";

const LOCALE = "es-AR";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "Sábado 10 de octubre"
export function fechaLarga(date: Date): string {
  const text = new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TZ,
  }).format(date);
  return capitalize(text.replace(",", ""));
}

// "Mié 21 de octubre" (cabecera mobile)
export function fechaMovil(date: Date): string {
  const dia = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: TZ }).format(date).replace(".", "");
  const resto = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", timeZone: TZ }).format(date);
  return `${capitalize(dia)} ${resto}`;
}

// "mié" (tira de días de Hoy)
export function diaSemanaCorto(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: TZ }).format(date).replace(".", "");
}

// "Sáb 10/10"
export function fechaCorta(date: Date): string {
  const dia = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: TZ }).format(date);
  const numeros = new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    timeZone: TZ,
  }).format(date);
  // es-AR separa día y mes con guion; lo mostramos con barra
  return `${capitalize(dia.replace(".", ""))} ${numeros.replace("-", "/")}`;
}

// "15:00"
export function hora(date: Date): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(date);
}

// Hora de fin estimada (partidos de 2 horas)
export function horaFin(date: Date): string {
  return hora(new Date(date.getTime() + 2 * 60 * 60 * 1000));
}

// "10/10 21:07"
export function fechaHora(date: Date): string {
  const fecha = new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "2-digit",
    timeZone: TZ,
  }).format(date);
  return `${fecha.replace("-", "/")} ${hora(date)}`;
}

export function primerNombre(name: string | null | undefined, email: string): string {
  const base = name?.trim() || email.split("@")[0];
  return base.split(" ")[0];
}

export const PROVIDER_LABEL: Record<string, string> = {
  google: "Google Calendar",
  microsoft: "Outlook",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? "calendario";
}

// ---- Días calendario en hora de Buenos Aires (UTC-3, sin horario de verano) ----
const OFFSET_AR_HS = 3;

// "2026-10-16"
export function diaISO(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TZ }).format(date);
}

export function esDiaISO(valor: string | null | undefined): valor is string {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [y, m, d] = valor.split("-").map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  return fecha.getUTCFullYear() === y && fecha.getUTCMonth() === m - 1 && fecha.getUTCDate() === d;
}

// Inicio (incluido) y fin (excluido) del día en Buenos Aires, como instantes UTC
export function rangoDelDia(iso: string): { desde: Date; hasta: Date } {
  const [y, m, d] = iso.split("-").map(Number);
  const desde = new Date(Date.UTC(y, m - 1, d, OFFSET_AR_HS));
  return { desde, hasta: new Date(desde.getTime() + 24 * 60 * 60 * 1000) };
}

export function sumarDias(iso: string, dias: number): string {
  const { desde } = rangoDelDia(iso);
  return diaISO(new Date(desde.getTime() + dias * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000));
}

// ---- Hora por país (docs/33 D4) ----
// Siempre con la zona IANA, nunca con diferencias fijas: Chile, Paraguay, México y España tienen o
// tuvieron horario de verano, y el dato de cada zona lo trae Intl. Argentina va primero.
export interface PaisConZona {
  pais: string;
  zona: string;
}

export const PAISES_HORA: readonly PaisConZona[] = [
  { pais: "Argentina", zona: TZ },
  { pais: "Uruguay", zona: "America/Montevideo" },
  { pais: "Brasil", zona: "America/Sao_Paulo" },
  { pais: "Chile", zona: "America/Santiago" },
  { pais: "Paraguay", zona: "America/Asuncion" },
  { pais: "Bolivia", zona: "America/La_Paz" },
  { pais: "Venezuela", zona: "America/Caracas" },
  { pais: "Colombia", zona: "America/Bogota" },
  { pais: "Perú", zona: "America/Lima" },
  { pais: "Ecuador", zona: "America/Guayaquil" },
  { pais: "México (CDMX)", zona: "America/Mexico_City" },
  { pais: "España (península)", zona: "Europe/Madrid" },
];

export interface HoraEnPaises {
  hora: string;
  paises: string[];
  /** Día calendario respecto del de Argentina: 1 es el día siguiente, -1 el anterior */
  desfaseDias: number;
  /** "lunes": el día de la semana en esos países */
  diaSemana: string;
}

function diaEnZona(date: Date, zona: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zona }).format(date);
}

// Agrupa los países que comparten hora local y día calendario, en el orden de la lista
export function horaPorPais(date: Date, paises: readonly PaisConZona[] = PAISES_HORA): HoraEnPaises[] {
  const diaArgentina = diaISO(date);
  const grupos = new Map<string, HoraEnPaises>();
  for (const { pais, zona } of paises) {
    const dia = diaEnZona(date, zona);
    const horaLocal = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zona }).format(date);
    const clave = `${dia} ${horaLocal}`;
    const grupo = grupos.get(clave);
    if (grupo) {
      grupo.paises.push(pais);
      continue;
    }
    grupos.set(clave, {
      hora: horaLocal,
      paises: [pais],
      desfaseDias: dia === diaArgentina ? 0 : dia > diaArgentina ? 1 : -1,
      diaSemana: new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: zona }).format(date),
    });
  }
  return [...grupos.values()];
}

// "15:00", o "01:00 del lunes" si en esos países el partido cae en otro día que en Argentina
export function horaConDia(grupo: HoraEnPaises): string {
  return grupo.desfaseDias === 0 ? grupo.hora : `${grupo.hora} del ${grupo.diaSemana}`;
}

// "Argentina, Uruguay y Brasil"
export function listaConY(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}
