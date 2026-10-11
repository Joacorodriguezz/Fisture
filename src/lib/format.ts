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
