// Logger estructurado: una línea JSON por evento (Cloudflare indexa los campos para buscar/filtrar).
// Nunca loguear datos personales ni credenciales: las claves sensibles se enmascaran automáticamente.
import { DrizzleQueryError } from "drizzle-orm";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(context: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  env?: string;
  context?: LogFields;
  now?: () => Date;
  write?: (level: LogLevel, line: string) => void;
}

const ORDEN: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CLAVES_SENSIBLES = /authorization|cookie|token|secret|password|api[_-]?key|private[_-]?key/i;
const MAX_PROFUNDIDAD = 6;

export function defaultLevel(env?: string): LogLevel {
  return env === "production" || env === undefined ? "info" : "debug";
}

// drizzle-orm >= 0.44 envuelve los errores del driver (D1) en DrizzleQueryError, cuyo mensaje y stack
// son "Failed query: <sql>\nparams: <valores>". Los valores pueden ser tokens o datos personales,
// así que nunca se usan tal cual: el SQL (parametrizado) sí se conserva y el error real queda en `cause`.
const MENSAJE_DB_SIN_CAUSA = "Falló una consulta a la base de datos";

// Mensaje apto para mostrar al usuario o guardar en la base. Sin `fallback`, lo que no es Error se pasa a texto.
export function mensajeDeError(error: unknown, fallback?: string): string {
  if (error instanceof DrizzleQueryError) {
    return error.cause instanceof Error ? error.cause.message : MENSAJE_DB_SIN_CAUSA;
  }
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

// Errores propios cuyo mensaje es una constante (nunca lleva datos)
const ERRORES_CON_MENSAJE_FIJO = new Set(["TokenKeyError", "TokenUnreadableError"]);

// Mensajes que son un código de máquina propio (p. ej. "profile_fetch_failed: 403"): no pueden ser un token
const CODIGO_PROPIO = /^[a-z]+(_[a-z]+)+(: \d{3})?$/;

// Para los caminos con tokens (login OAuth, renovación, backfill): `serializeError` redacta por nombre de
// campo, no por contenido, así que un mensaje o stack de una librería puede arrastrar un token. Acá solo
// sale el nombre, el código OAuth (p. ej. invalid_grant), el status y el mensaje de los errores propios.
export function errorSeguro(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "NonError" };
  const { code, status } = error as { code?: unknown; status?: unknown };
  return {
    name: error.name,
    ...(typeof code === "string" && /^[a-z_]{1,40}$/i.test(code) ? { code } : {}),
    ...(typeof status === "number" ? { status } : {}),
    ...(ERRORES_CON_MENSAJE_FIJO.has(error.name) || CODIGO_PROPIO.test(error.message) ? { message: error.message } : {}),
  };
}

export function serializeError(err: Error): Record<string, unknown> {
  if (err instanceof DrizzleQueryError) {
    const message = `Failed query: ${err.query}`;
    const out: Record<string, unknown> = {
      name: "DrizzleQueryError",
      message,
      query: err.query,
      stack: err.stack?.replace(err.message, message),
    };
    if (err.cause !== undefined) {
      out.cause = err.cause instanceof Error ? serializeError(err.cause) : redact(err.cause);
    }
    return out;
  }
  const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack };
  if (err.cause !== undefined) {
    out.cause = err.cause instanceof Error ? serializeError(err.cause) : redact(err.cause);
  }
  return out;
}

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_PROFUNDIDAD) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = CLAVES_SENSIBLES.test(k) ? "[REDACTED]" : redact(v, seen, depth + 1);
  }
  return out;
}

function escribirEnConsola(level: LogLevel, line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = "info", env, context = {}, now = () => new Date(), write = escribirEnConsola } = options;

  function emit(nivel: LogLevel, msg: string, fields: LogFields = {}): void {
    if (ORDEN[nivel] < ORDEN[level]) return;
    const registro = {
      ...(env ? { env } : {}),
      ...(redact(context) as LogFields),
      ...(redact(fields) as LogFields),
      ts: now().toISOString(),
      level: nivel,
      msg,
    };
    write(nivel, JSON.stringify(registro));
  }

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => createLogger({ ...options, context: { ...context, ...extra } }),
  };
}

// Logger para código sin contexto de request (servicios, cron). Nivel info.
export const rootLogger = createLogger();
