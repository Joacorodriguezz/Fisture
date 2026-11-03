// Presupuesto de subrequests de una invocación (docs/17 B5, D4).
// Workers Free permite 50 subrequests por invocación y cuentan cada fetch y cada consulta a D1.
// El tope por usuarios y partidos no alcanza: el costo real depende del trabajo de cada uno. Acá se
// mide lo que se gasta (D1 instrumentada y cliente de calendario instrumentado) y el lote se corta
// antes de pasar el tope.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CalendarClient } from "./clients";

// Tope de Workers Free (50) menos un margen para lo que no se instrumenta (renovar un token OAuth, KV)
export const PRESUPUESTO_SUBREQUESTS = 45;
// Se reserva para registrar el run al final: el INSERT y la purga de runs viejos
export const RESERVA_REGISTRO = 3;
// Peor caso de un partido: detalle, fila existente, guardar estado (3 consultas), renovar el token
// (1 consulta y 1 fetch) y crear el evento (hasta 2 fetch: alta y adopción tras un 409)
export const COSTO_MAX_PARTIDO = 8;
// Costo fijo de atender a un usuario: pendientes, equipos con auto-sync, sus partidos, sus estados,
// preferencias y marcarlo como atendido. Para empezar hace falta lugar para al menos un partido.
export const COSTO_FIJO_USUARIO = 6;

export class Presupuesto {
  private gastado = 0;

  constructor(
    readonly total: number,
    readonly reserva = 0
  ) {}

  get usado(): number {
    return this.gastado;
  }

  // Lo que se puede gastar todavía (sin tocar la reserva)
  get restante(): number {
    return Math.max(0, this.total - this.reserva - this.gastado);
  }

  alcanza(costo: number): boolean {
    return this.restante >= costo;
  }

  // Lo ya hecho se cuenta aunque pase el tope: la cuenta tiene que ser fiel a lo que se ejecutó
  gastar(n = 1): void {
    this.gastado += n;
  }
}

// Sentencia D1 que cuenta una subrequest cada vez que se ejecuta. `real` permite a batch() pasarle
// a D1 las sentencias originales.
class SentenciaContada {
  constructor(
    readonly real: D1PreparedStatement,
    private readonly presupuesto: Presupuesto
  ) {}

  bind(...valores: unknown[]) {
    return new SentenciaContada(this.real.bind(...valores), this.presupuesto);
  }
  run() {
    this.presupuesto.gastar();
    return this.real.run();
  }
  all() {
    this.presupuesto.gastar();
    return this.real.all();
  }
  first(...args: unknown[]) {
    this.presupuesto.gastar();
    return (this.real.first as (...a: unknown[]) => Promise<unknown>)(...args);
  }
  raw(...args: unknown[]) {
    this.presupuesto.gastar();
    return (this.real.raw as (...a: unknown[]) => Promise<unknown>)(...args);
  }
}

// D1 que suma al presupuesto cada consulta. Un batch se cuenta por sentencia: es el criterio
// conservador (Cloudflare lo cobra como una sola subrequest).
export function contarD1(DB: D1Database, presupuesto: Presupuesto): D1Database {
  return {
    prepare: (sql: string) => new SentenciaContada(DB.prepare(sql), presupuesto),
    batch: (sentencias: unknown[]) => {
      presupuesto.gastar(sentencias.length);
      return DB.batch(sentencias.map((s) => (s instanceof SentenciaContada ? s.real : s)) as D1PreparedStatement[]);
    },
    exec: (sql: string) => {
      presupuesto.gastar();
      return DB.exec(sql);
    },
    dump: () => DB.dump(),
    withSession: (...args: unknown[]) => (DB.withSession as (...a: unknown[]) => unknown)(...args),
  } as unknown as D1Database;
}

// Cliente de calendario que suma al presupuesto cada llamada de red, falle o no
export function contarCliente(client: CalendarClient, presupuesto: Presupuesto): CalendarClient {
  const contada =
    <A extends unknown[], R>(costo: number, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      presupuesto.gastar(costo);
      return fn(...args);
    };
  return {
    create: contada(2, client.create.bind(client)),
    update: contada(1, client.update.bind(client)),
    remove: contada(1, client.remove.bind(client)),
    overlaps: contada(1, client.overlaps.bind(client)),
  };
}
