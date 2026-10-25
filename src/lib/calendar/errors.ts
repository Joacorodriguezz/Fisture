// Errores de las APIs de calendario y su clasificación (docs/11-calendario-casos-borde-tdd.md, D4).

export interface CalendarApiErrorOptions {
  reason?: string;
  retryAfter?: number;
}

export class CalendarApiError extends Error {
  readonly status: number;
  readonly reason?: string;
  // Segundos que pide esperar el proveedor (cabecera Retry-After)
  readonly retryAfter?: number;

  constructor(message: string, status: number, options: CalendarApiErrorOptions = {}) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
    this.reason = options.reason;
    this.retryAfter = options.retryAfter;
  }
}

export type CalendarErrorClass = "gone" | "auth" | "rate_limit" | "transient" | "conflict" | "permanent";

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

export function classifyCalendarError(error: unknown): CalendarErrorClass {
  if (error instanceof CalendarApiError) {
    const { status, reason } = error;
    if (status === 401) return "auth";
    if (status === 404 || status === 410) return "gone";
    if (status === 409) return "conflict";
    if (status === 429) return "rate_limit";
    if (status === 403) return reason && RATE_LIMIT_REASONS.has(reason) ? "rate_limit" : "permanent";
    if (status === 408 || status >= 500) return "transient";
    return "permanent";
  }

  // Errores al conseguir el token (lib/auth/tokens.ts y el refresh OAuth)
  const message = error instanceof Error ? error.message : "";
  if (/access token|permission expired|invalid_grant/i.test(message)) return "auth";

  // Cualquier otro error (red, timeout) se trata como transitorio
  return "transient";
}

// Lanza CalendarApiError si la respuesta no es ok. Tolera cuerpos que no son JSON.
export async function throwIfNotOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;

  let message = fallback;
  let reason: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: { message?: string; errors?: { reason?: string }[]; code?: string };
    };
    message = body.error?.message || fallback;
    reason = body.error?.errors?.[0]?.reason ?? body.error?.code;
  } catch {
    // cuerpo vacío o HTML: queda el mensaje por defecto
  }

  const header = Number(response.headers.get("Retry-After"));
  throw new CalendarApiError(message, response.status, {
    reason,
    retryAfter: Number.isFinite(header) && header > 0 ? header : undefined,
  });
}
